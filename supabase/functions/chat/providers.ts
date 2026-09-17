// Model selection and the per-provider wire formats.
//
// Five providers are reachable. A cheap non-reasoning classifier reads the
// first message of a conversation and picks one of four categories; the
// category fixes the model for the life of that conversation (see
// getOrCreateRoute in index.ts).
//
// Routing is a two-level decision, taken fresh for every message:
//
//   Fast      -> the fast model. No classifier call at all.
//   Budget    -> the OpenAI-compatible slot, whatever the subject. No
//                classifier call either, unless a working folder is open —
//                see resolveRoute for why that one question still gets asked.
//   Max       -> classify THIS message, then:
//                  finance             -> Google, Gemini Flash
//                  coding, healthcare  -> Anthropic, Claude Opus
//                  everything else     -> Meta, Muse Spark
//
// Budget and Max are the two halves of what used to be one "Thinking" mode.
// Max kept all of its routing; Budget kept none of it, and exists to put a
// floor under what a turn can cost.
//
// Classification is per message rather than per conversation, so a thread that
// opens on a coding question and turns to a finance one moves with it. What
// served each turn is recorded on the message itself.
//
// Every model id is an environment variable with a default, because these
// names move faster than this file does. Set them as function secrets:
//
//   supabase secrets set OPENAI_API_KEY=... GEMINI_API_KEY=... ANTHROPIC_API_KEY=...
//   supabase secrets set COMPAT_API_KEY=...
//   supabase secrets set CLASSIFIER_MODEL_ID=... GEMINI_MODEL_ID=... ANTHROPIC_MODEL_ID=...
//   supabase secrets set COMPAT_MODEL_ID=... COMPAT_REASONING_EFFORT=...

/**
 * "medium" is Budget in the interface. The wire value was left alone on
 * purpose: it is stored on every message ever sent, and on a check constraint
 * (0007_effort_levels.sql), so renaming it would mean a backfill to change a
 * word the reader never sees. The label lives in EffortControl.tsx.
 */
export type Effort = "fast" | "medium" | "max";
/**
 * "tools" is not a subject the way the others are — it is the answer to a
 * different question, asked only when a working folder is open: does this turn
 * need to touch the user's files? It is a category because that keeps the
 * decision to one classifier call rather than two.
 */
export type Category =
  | "finance"
  | "science"
  | "coding"
  | "healthcare"
  | "other"
  | "tools";
export type Provider =
  | "openai"
  | "google"
  | "anthropic"
  | "meta"
  | "compat";

export interface RouteChoice {
  category: Category;
  provider: Provider;
  modelId: string;
  /**
   * The hardest this route is ever asked to think, whatever the reader chose.
   *
   * Set on the demonstration routes so that picking Max shows which model
   * answers without paying Max prices to find out. Absent on every other
   * route, which means the reader's own choice is used unchanged.
   *
   * It caps rather than sets: a route capped at "fast" that a reader asked
   * for Fast is still Fast, not upgraded.
   */
  effortCap?: Effort;
  classifierModelId: string;
  /**
   * Whether the category came from the classifier. False covers both "it
   * errored" and "Fast, which never asks" — nothing downstream needs to tell
   * those apart now that routes are decided per message and never stored.
   */
  classified: boolean;
  /**
   * Whether this turn should be given the tools. False for every route that
   * did not ask for them, which is what stops a coding question that happens
   * to land on Opus from being handed the user's folder as well.
   */
  needsTools: boolean;
  /**
   * Whether the classifier judged that this turn WANTED the folder, regardless
   * of whether it could have it.
   *
   * The pair is the whole point. `toolsWanted && needsTools` is a desktop turn
   * that gets to run something; `toolsWanted && !needsTools` is the same
   * request made where there is no machine to run it on — the web app, or a
   * desktop chat that has not been pointed at a folder — and that is the case
   * the reader has to be told about rather than quietly answered in prose.
   */
  toolsWanted: boolean;
  /**
   * What the classifier call itself cost, when one was made.
   *
   * Small per turn and not small in aggregate: every Thinking turn pays it,
   * and a turn that routes to tools pays it before any of twenty legs. It is
   * billed as its own usage row so the cost of routing is visible rather than
   * hidden inside the reply it chose.
   */
  classifierUsage?: Usage;
}

/**
 * Why a turn that wanted the folder is not getting it. Null when nothing is
 * amiss — either tools were not wanted, or they were wanted and granted.
 */
export type ToolGap = "platform" | "no-folder";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

// --- model ids -------------------------------------------------------------

const MUSE_BASE_URL = Deno.env.get("MODEL_BASE_URL") ?? "https://api.meta.ai/v1";
const MUSE_MODEL_ID = Deno.env.get("MODEL_ID") ?? "muse-spark-1.3";
const ANTHROPIC_MODEL_ID = Deno.env.get("ANTHROPIC_MODEL_ID") ?? "claude-opus-5";

/**
 * The three demonstration routes — coding and science — and why they are
 * separate variables rather than reuses of the two above.
 *
 * They exist to show that the routing table is a real decision and not a
 * label: a coding question and a healthcare question both reach Anthropic,
 * but they no longer reach the same model. Pointing the router at a different
 * coding model must not silently change what a healthcare turn answers with,
 * which is exactly what reusing ANTHROPIC_MODEL_ID would have done.
 *
 * Both are capped at low effort in ROUTES — see `effortCap`.
 */
const CODING_MODEL_ID = Deno.env.get("CODING_MODEL_ID") ?? "claude-fable-5-1";
const SCIENCE_MODEL_ID = Deno.env.get("SCIENCE_MODEL_ID") ?? "gpt-6-astra";
const GEMINI_MODEL_ID = Deno.env.get("GEMINI_MODEL_ID") ?? "gemini-3.8-flash";
const CLASSIFIER_MODEL_ID = Deno.env.get("CLASSIFIER_MODEL_ID") ?? "gpt-5.6-luna";

/**
 * What Budget answers with.
 *
 * The default is DeepSeek hosted on DeepInfra, which is a choice rather than
 * a dependency: COMPAT_BASE_URL, COMPAT_API_KEY and COMPAT_MODEL_ID point
 * this slot at anything that speaks the OpenAI chat-completions API —
 * another host, another model, or something running locally.
 *
 * The id is a full upstream path because inference hosts serve models under
 * one, and it moves whenever the upstream publishes a point release. Read the
 * current one off the host and set COMPAT_MODEL_ID rather than editing this
 * default; a wrong id comes back as a 404 on the first Budget turn, not at
 * deploy time.
 */
const COMPAT_MODEL_ID = Deno.env.get("COMPAT_MODEL_ID") ??
  "deepseek-ai/DeepSeek-V4.1-Flash";

/**
 * The model Fast answers from. The same one that classifies, by default —
 * being small and non-reasoning is exactly what both jobs want — but a
 * separate variable, because they are separate jobs and pointing the router at
 * a different classifier should not silently change what Fast answers with.
 */
export const FAST_MODEL_ID = Deno.env.get("FAST_MODEL_ID") ?? CLASSIFIER_MODEL_ID;

const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") ??
  "https://api.openai.com/v1";
const GEMINI_BASE_URL = Deno.env.get("GEMINI_BASE_URL") ??
  "https://generativelanguage.googleapis.com/v1beta";

/**
 * DeepInfra's OpenAI-compatible surface — the same wire format Muse uses, so
 * the two share a client. The `/v1/openai` suffix is the compatible one;
 * DeepInfra's own native API lives elsewhere and does not stream the same way.
 */
const COMPAT_BASE_URL = Deno.env.get("COMPAT_BASE_URL") ??
  "https://api.deepinfra.com/v1/openai";

/**
 * The classifier is a routing decision, not an answer, so it runs with
 * reasoning switched off — latency here is paid on every first message.
 * Overridable because the accepted values differ across model generations
 * ("none" and "minimal" are both in circulation); an unrecognised value is
 * retried without the field rather than failing the turn.
 */
const CLASSIFIER_REASONING = Deno.env.get("CLASSIFIER_REASONING_EFFORT") ?? "none";

/**
 * Log the raw usage object each provider actually sends.
 *
 * `supabase secrets set USAGE_DEBUG=1`, run one turn, read the logs, unset it.
 *
 * Cost here is reconstructed from token counts rather than reported by the
 * provider, so it is only ever as right as the fields it reads. Documentation
 * describes what an API should return; this shows what it did. It is the only
 * way to settle a question like "does implicit caching populate
 * cachedContentTokenCount, or only explicit caching?" — which decides whether
 * a whole tool loop is billed correctly or at ten times the rate.
 */
const USAGE_DEBUG = Deno.env.get("USAGE_DEBUG") === "1";

// --- effort ----------------------------------------------------------------

/**
 * What each level actually asks the provider for.
 *
 * `max` is pinned one notch below the top while the setting is being tested,
 * so choosing it cannot run up a bill. The user's choice is still what gets
 * stored, so unpinning later is a one-line change with no data to backfill.
 */
const ANTHROPIC_EFFORT: Record<Effort, "low" | "medium" | "high" | "max"> = {
  fast: "low",
  medium: "medium",
  max: "medium", // TODO: "max" once the allowance work lands
};

/**
 * Gemini's thinking budget, in tokens. 0 disables thinking entirely; -1 hands
 * the decision to the model. Flash defaults to thinking, so "fast" has to say
 * zero explicitly or it would not be fast.
 */
const GEMINI_THINKING_BUDGET: Record<Effort, number> = {
  fast: 0,
  medium: -1,
  max: -1, // pinned alongside ANTHROPIC_EFFORT.max
};

/**
 * How hard this slot's model is asked to think — a real parameter, not a
 * sentence in the system prompt asking nicely.
 *
 * The difference is not cosmetic. Thinking tokens are billed as output, at
 * $0.60/Mtok, so this is the single largest lever on what a Budget turn costs
 * and it should be a setting rather than a request the model may decline.
 *
 * High by default, which is a deliberate choice about what Budget is for:
 * cheap per token rather than shallow. A Budget turn that thinks hard still
 * costs a fraction of the same turn on Opus.
 *
 * Overridable because the accepted values are not settled, and differ by host
 * as well as by model: DeepInfra's reasoning docs describe the string enum
 * none/low/medium/high while its V4.1-Flash page advertises a continuous
 * 1-100, and a different host may take neither. A value the endpoint rejects
 * is retried without the field rather than failing the turn, the same way the
 * classifier handles it — which is what lets one default serve every host.
 */
const COMPAT_REASONING = Deno.env.get("COMPAT_REASONING_EFFORT") ?? "high";

const MUSE_EFFORT: Record<Effort, string> = {
  fast:
    "Use low reasoning effort. Answer directly and concisely without extended deliberation.",
  medium:
    "Use medium reasoning effort. Balance answer quality with speed and concision.",
  max:
    "Use medium reasoning effort. Balance answer quality with speed and concision.",
};

// --- tools -----------------------------------------------------------------

/**
 * A tool the client can execute, declared once and serialised per provider.
 *
 * Every provider can carry them now — OpenAI, Meta and the compatible slot
 * share one
 * format, Gemini has functionDeclarations, Anthropic has its own — and each
 * has both a request shape (openAITools, geminiTools) and a stream parser
 * (blocksFor) to match.
 *
 * Only the Anthropic loop has been proven against real work, because until
 * Budget existed it was the only one a tool turn could reach: ROUTES.tools
 * still sends every Max turn wanting the folder to Opus. Budget is the first
 * path that runs the OpenAI-format loop end to end, so that is the one to
 * watch when a tool call comes back malformed.
 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "run_command",
    description:
      "Run a shell command with the user's working folder as the current " +
      "directory. This is how you actually do things: read and edit files, " +
      "and build documents and spreadsheets with whatever is installed " +
      "(python3 with openpyxl, for example). The user is shown the command " +
      "in full and must approve it before anything runs.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The command, run through a shell. Paths are relative to the " +
            "working folder. Multi-line scripts are fine; a heredoc is often " +
            "clearer than a long one-liner.",
        },
        purpose: {
          type: "string",
          description:
            "One short line, written for the person deciding whether to " +
            "approve this. Say what it does and to which file.",
        },
      },
      required: ["command", "purpose"],
    },
  },
  {
    name: "list_dir",
    description:
      "List the files and folders directly inside a path in the user's working folder. " +
      "Use it to find out what actually exists before reasoning about it.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Relative to the working folder. Use "." for the folder itself.',
        },
      },
      required: ["path"],
    },
  },
];

/**
 * What the model is told about the machine it is operating on.
 *
 * The model cannot see any of this, and guessing costs a whole round trip: a
 * model that assumes GNU coreutils on macOS fails on its first command. The
 * approval sentence is here too — a command arrives in front of a person who
 * has to decide about it in a second or two, and unexplained commands get
 * denied or, worse, waved through.
 */
export interface ToolEnv {
  shell?: string;
  python?: string | null;
  python_version?: string | null;
  libraries?: string[];
}

export function toolSystemPrompt(
  root: string,
  platform: string,
  env?: ToolEnv,
): string {
  const lines = [
    `You can operate on a folder on the user's computer using the tools provided.`,
    `The working folder is ${root} on ${platform}. Paths are relative to it.`,
  ];

  // Naming the interpreter by absolute path is the point. A spawned process
  // inherits the app's PATH, not the user's shell's, so bare `python3` can
  // find an interpreter with none of the libraries below installed.
  if (env?.python) {
    lines.push(
      `Python is at ${env.python}${
        env.python_version ? ` (${env.python_version})` : ""
      }. Call it by that full path, not as \`python3\`.`,
    );
    lines.push(
      env.libraries && env.libraries.length > 0
        ? `Available libraries: ${env.libraries.join(", ")}. Nothing else is installed, and you cannot install anything.`
        : `No document libraries are installed, and you cannot install any — say so rather than writing a command that will fail.`,
    );
  } else {
    lines.push(
      `No Python interpreter was found, so plain shell commands are all that is available.`,
    );
  }

  lines.push(
    `Every command is shown to the user in full and must be approved before it runs, so keep each one to a single clear step and say in the purpose field what it does.`,
    `If a command fails, read the exit code and stderr and try something different rather than repeating it.`,
    `Check what exists before writing to it — overwriting the user's file is not undoable.`,
    // Both of these are lessons from one turn that spent every leg it had
    // looking for files that were not there and never wrote a word, so it
    // ended as an empty reply with nothing to show for six approvals.
    `Always write a line of text alongside a tool call saying what you are doing and why. A reply that is nothing but a tool call gives the user an empty message to look at.`,
    `The user is asked whether to carry on every twenty tool calls, so do not spend them exploring. Prefer one command that answers the question to several that narrow it down, and if two or three attempts have not found what you need, stop and tell the user what you did find and what you need from them — being asked to approve a twenty-first command that is still looking is the failure here, not running out.`,
  );

  return lines.join(" ");
}

// --- the "not here" notice -------------------------------------------------
//
// A turn can want the folder in a place that has none. Two different places,
// and they are not the same problem: a browser will never have one, and a
// desktop chat that has not been pointed anywhere is one click from having
// one. Saying "only on desktop" to someone already on the desktop is worse
// than saying nothing.
//
// Both sentences are fixed strings rather than something the model writes.
// That is deliberate: this is the app reporting its own limits, and a model
// asked to explain them will sometimes apologise, sometimes hedge, and
// sometimes offer to do it anyway.

const NOTICE_PLATFORM =
  "Running commands and editing files on your computer is a desktop-app " +
  "feature, so it is not available here. Nothing in this chat can reach your " +
  "machine, and that will not change on this device — the answer below is " +
  "written out in full instead, for you to run or save yourself.";

const NOTICE_NO_FOLDER =
  "This chat has not been pointed at a working folder, so there is nowhere " +
  "to run this. Choose a folder from the header and ask again, and the same " +
  "request can be carried out on your machine. Until then the answer below " +
  "is written out in full instead.";

/** What the reader is shown. Fixed text, never the model's paraphrase. */
export function toolGapNotice(gap: ToolGap): string {
  return gap === "platform" ? NOTICE_PLATFORM : NOTICE_NO_FOLDER;
}

/**
 * The same fact, told to the model that is about to answer.
 *
 * Without this the reply fights the notice directly above it: the model offers
 * to create the file, says it has created the file, or asks which folder to
 * put it in. It is also told the user has already been informed, because the
 * failure mode of telling a model about a limitation is a reply that opens
 * with two paragraphs of apology for it.
 */
export function toolGapSystemPrompt(gap: ToolGap): string {
  const where = gap === "platform"
    ? "This turn is running somewhere without access to the user's computer — the web app, not the desktop app."
    : "The user is on the desktop app but has not opened a working folder, so there is no folder to act in.";

  return [
    `The user has asked for something that would normally be done by running a command or writing a file on their computer.`,
    where,
    `You have no tools this turn: you cannot run anything, read anything from disk, or create any file.`,
    `The user has ALREADY been shown a short notice saying so, immediately above your reply. Do not restate it, do not apologise for it, and do not open by explaining what you cannot do.`,
    `Answer as usefully as the situation allows instead: give the complete file contents, the full script, or the exact commands they can run themselves, inline and ready to copy.`,
    `Never claim to have created, saved, modified or run anything.`,
  ].join(" ");
}

/** Which provider serves this model id, for continuing a tool loop. */
export function providerForModelId(modelId: string): Provider | null {
  if (modelId === ANTHROPIC_MODEL_ID) return "anthropic";
  if (modelId === GEMINI_MODEL_ID) return "google";
  if (modelId === MUSE_MODEL_ID) return "meta";
  if (modelId === COMPAT_MODEL_ID) return "compat";
  if (modelId === FAST_MODEL_ID || modelId === CLASSIFIER_MODEL_ID) {
    return "openai";
  }
  return null;
}

/** The route a tool loop must continue on: whichever model opened it. */
export function routeForModelId(modelId: string): RouteChoice | null {
  const provider = providerForModelId(modelId);
  if (!provider) return null;
  return {
    category: "tools",
    provider,
    modelId,
    classifierModelId: CLASSIFIER_MODEL_ID,
    classified: false,
    // A continuation exists only because a tool was called, and the model
    // needs them declared again to be allowed to call another.
    needsTools: true,
    toolsWanted: true,
  };
}

/**
 * The tool-capable route, named directly.
 *
 * Reached two ways: the classifier judged a turn to need the folder, and a
 * loop already under way whose model we could not otherwise identify. Anthropic
 * because it is still the only provider whose dialect is implemented —
 * `tools_test.ts` fails the day that stops being true.
 */
export function toolRoute(): RouteChoice {
  return {
    category: "tools",
    provider: "anthropic",
    modelId: ANTHROPIC_MODEL_ID,
    classifierModelId: CLASSIFIER_MODEL_ID,
    classified: false,
    needsTools: true,
    toolsWanted: true,
  };
}

/**
 * Why a provider was abandoned for another one.
 *
 * Kept apart because the two have different remedies and only one of them is
 * a problem with the provider: a rate limit means this app is asking for more
 * than its quota and should ask for a bigger one, while an error or a timeout
 * means the provider is down and there is nothing to do but go elsewhere.
 * Counting them separately is what turns "ask Anthropic for more capacity"
 * into a request with a number attached.
 */
export type FailoverReason = "rate_limit" | "error" | "timeout";

/**
 * Where a turn goes when its first choice will not answer.
 *
 * Order is fixed rather than per-category. A failover has already given up on
 * answering with the best model for the subject — that decision was made the
 * moment the first choice failed — so what is left is a preference for
 * capability, ending at Muse because it is the fallback everywhere else too.
 *
 * Capped deliberately. Each attempt costs a round trip while someone watches a
 * spinner, and a chain long enough to try everything is indistinguishable from
 * a hang.
 */
const FAILOVER_ORDER: Provider[] = ["anthropic", "google", "meta"];

/**
 * Budget's own chain, which is deliberately one deep and deliberately cheap.
 *
 * A Budget turn that fell through to Anthropic would be answered well and
 * billed at roughly the rate the reader chose Budget to avoid — a surprise on
 * the invoice rather than on the screen, which is the worse of the two. Muse
 * is the one stand-in near enough in price for that not to happen; past it
 * the turn fails and says so.
 */
const BUDGET_FAILOVER_ORDER: Provider[] = ["meta"];
const MAX_ATTEMPTS = 3;

/**
 * The model each provider answers with when it is standing in for another.
 *
 * Exported for check-providers.ts, which needs a model id for a provider
 * without going through a category — and the compatible slot has none, by
 * design.
 */
export function standInModel(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_MODEL_ID;
    case "google":
      return GEMINI_MODEL_ID;
    case "openai":
      return FAST_MODEL_ID;
    case "compat":
      return COMPAT_MODEL_ID;
    default:
      return MUSE_MODEL_ID;
  }
}

/**
 * The route to try, then the routes to try if it will not answer.
 *
 * The category is carried across unchanged: the turn is still a finance
 * question even when Gemini is down and Muse is answering it, and the route
 * log should say so rather than pretending it was always an `other`.
 */
export function failoverChain(route: RouteChoice): RouteChoice[] {
  const chain = [route];
  const order = route.provider === "compat"
    ? BUDGET_FAILOVER_ORDER
    : FAILOVER_ORDER;

  for (const provider of order) {
    if (chain.length >= MAX_ATTEMPTS) break;
    if (provider === route.provider) continue;
    if (!hasCredential(provider)) continue;

    chain.push({
      ...route,
      provider,
      modelId: standInModel(provider),
      // Not a classifier verdict about this model — it is a stand-in, and the
      // subject was decided before anything failed.
      classified: false,
    });
  }

  return chain;
}

/** What the reader is told when their turn was answered by a stand-in. */
export function failoverNotice(
  from: Provider,
  reason: FailoverReason,
  modelId: string,
): string {
  const why = reason === "rate_limit"
    ? "is busy right now"
    : reason === "timeout"
    ? "did not respond in time"
    : "is not responding";

  return `The model this would normally use (${from}) ${why}, ` +
    `so ${modelName(modelId)} answered instead. The answer below may differ ` +
    `from what you would usually get for this question.`;
}

/**
 * Said when the tool history had to be flattened to get an answer at all.
 *
 * Worth telling the reader, because the thread genuinely behaves differently
 * afterwards: the model can still read what the earlier commands found, but it
 * can no longer chain a new call onto one of them. Without this, the next
 * thing it says about an earlier step looks like it forgot.
 */
export function degradedNotice(): string {
  return "Some earlier steps in this conversation could no longer be sent as " +
    "tool calls, so they were summarised as text. Everything they found is " +
    "still here, but this thread can no longer build on those calls directly.";
}

/** A readable name for a model id, for the notice above. */
function modelName(modelId: string): string {
  return modelId;
}

// --- routing ---------------------------------------------------------------

const ROUTES: Record<
  Category,
  { provider: Provider; modelId: string; effortCap?: Effort }
> = {
  // The three demonstration routes. Each goes to a different lab, and each is
  // capped at low effort: the point being shown is that the subject picks the
  // model, and paying Max prices to show it would be paying for the wrong
  // half of the demonstration. Remove `effortCap` to let Max mean Max.
  finance: { provider: "google", modelId: GEMINI_MODEL_ID, effortCap: "fast" },
  science: { provider: "openai", modelId: SCIENCE_MODEL_ID, effortCap: "fast" },
  coding: { provider: "anthropic", modelId: CODING_MODEL_ID, effortCap: "fast" },
  healthcare: { provider: "anthropic", modelId: ANTHROPIC_MODEL_ID },
  other: { provider: "meta", modelId: MUSE_MODEL_ID },
  // Not a classifier verdict any more — see CATEGORIES. It survives as the
  // category recorded against a tool-loop continuation, whose real subject was
  // decided on an earlier leg and is not worth re-classifying to recover.
  tools: { provider: "anthropic", modelId: ANTHROPIC_MODEL_ID },
};

/**
 * What the classifier may answer as a subject.
 *
 * "tools" is deliberately absent. It used to be a fifth option here, which
 * meant a turn that wanted the folder lost its subject entirely — every such
 * turn went to Anthropic no matter what it was about. The folder question is
 * now asked alongside the subject rather than instead of it, so a request to
 * chart a portfolio is finance AND wants the folder, and goes to the finance
 * model with the tools attached.
 */
const CATEGORIES: Category[] = [
  "finance",
  "science",
  "coding",
  "healthcare",
  "other",
];

/** The subject list, shared by all three prompt variants. */
const SUBJECTS =
  `finance — markets, investing, valuation, accounting, banking, debt, tax, corporate finance, economics.
science — physics, chemistry, materials, astronomy, earth and climate science, mathematics, and biology that is not about treating a person.
coding — software, programming, debugging, APIs, infrastructure, data engineering, anything containing code.
healthcare — medicine, symptoms, diagnosis, treatment, drugs, biology of the body, clinical or public health.
other — anything else.`;

/**
 * The subject on its own.
 *
 * No longer reached from `resolveRoute`: the only turn that would want it —
 * Fast with no folder — does not classify at all, so every classifier call
 * production makes now asks both questions. It is kept because
 * `check-providers.ts classify` uses it to ask the subject question in
 * isolation, which is how you tell a subject problem from a folder-question
 * problem when a probe comes back wrong.
 */
const CLASSIFIER_PROMPT =
  `You route a request to a specialist model. Reply with exactly one word from this list and nothing else:

${SUBJECTS}

Pick the single best fit. If two apply, pick the one the answer will mostly consist of. If none clearly apply, reply other.`;

/**
 * The subject question and the folder question, asked together.
 *
 * Two words, not one. Asking them separately would double the latency on every
 * turn; folding the folder into the subject list — which is what this used to
 * do — throws the subject away on exactly the turns that do the most work.
 *
 * The second word is described by what the turn would *do*, because the
 * failure that matters is the quiet one: a request to build a spreadsheet read
 * as prose, answered as a markdown table, and the folder never touched. The
 * opposite mistake is cheap — the user sees a command and declines it.
 */
const TOOL_CLASSIFIER_PROMPT =
  `You route a request to a specialist model, and you decide whether it needs the user's computer.

The user has opened a folder on their computer, and the model can read and write files in it by running commands the user approves.

Reply with exactly two words, separated by a space, and nothing else.

The first word is the subject:

${SUBJECTS}

The second word is yes or no — does answering this properly require that folder? Reading, creating, editing, converting, inspecting or organising files; building a spreadsheet or document; running a script; or answering a question that can only be settled by looking at what is actually on disk.

Answer yes whenever the result would be better as a file than as a message, or whenever it depends on what is in the folder. A question that merely mentions a document, without needing it opened, is no.

Example replies: "finance yes", "coding no", "other yes".`;

/**
 * The same two questions where there is no folder to use — the web app, or a
 * desktop chat nobody has pointed anywhere.
 *
 * Asked so the reader can be TOLD, not so anything can be run. The wording is
 * hypothetical for a reason: a classifier shown the folder-open prompt in a
 * browser answers about a folder that does not exist, and reads "no" more
 * often because there is visibly nothing there.
 */
const CAPABILITY_CLASSIFIER_PROMPT =
  `You route a request to a specialist model, and you decide whether it is asking for work on the user's own computer.

Reply with exactly two words, separated by a space, and nothing else.

The first word is the subject:

${SUBJECTS}

The second word is yes or no — would answering this properly mean running a command on the user's computer or creating, reading or editing a file in a folder of theirs? Building a spreadsheet or document as a file, running a script, inspecting what is on their disk, editing their existing files.

Answer no if the request can be answered completely in a message, even a long one containing code the user could run themselves. Wanting code is not the same as wanting it run.

Example replies: "coding yes", "finance no", "other no".`;

/** The env var holding the credential each provider needs. */
const KEY_VAR: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  meta: "MODEL_API_KEY",
  compat: "COMPAT_API_KEY",
};

export function hasCredential(provider: Provider): boolean {
  return !!Deno.env.get(KEY_VAR[provider]);
}

function requireKey(provider: Provider): string {
  const key = Deno.env.get(KEY_VAR[provider]);
  if (!key) throw new Error(`${KEY_VAR[provider]} is not set`);
  return key;
}

/** The route a category resolves to, given today's environment. */
export function routeFor(
  category: Category,
  classifierModelId: string,
  classified = true,
  toolsWanted = false,
): RouteChoice {
  const target = ROUTES[category];
  return {
    category,
    ...target,
    classifierModelId,
    classified,
    // Wanting the folder and being given it are now separate facts. The caller
    // decides whether this turn is somewhere that can honour it; `grantTools`
    // below is the only thing that turns the second one on.
    needsTools: false,
    toolsWanted,
  };
}

/**
 * Hand this route the tools.
 *
 * Separate from routeFor because the decision belongs to the caller: only the
 * Edge Function knows whether a folder is open, and only it knows the request
 * came from a shell that can actually run something. A route is never born
 * holding tools.
 */
export function grantTools(route: RouteChoice): RouteChoice {
  return { ...route, needsTools: true, toolsWanted: true };
}

/** Where a turn wanted the folder and is not getting it, if anywhere. */
export function toolGapOf(
  route: RouteChoice,
  platformCapable: boolean,
): ToolGap | null {
  if (!route.toolsWanted || route.needsTools) return null;
  return platformCapable ? "no-folder" : "platform";
}

/**
 * The entire routing decision for one turn, and the only entry point the Edge
 * Function needs.
 *
 * Fast does not classify — that is the point of it, and it saves the classifier
 * round trip on top of picking the quicker model. Budget does not classify
 * either, for the same reason and one more: there is nothing for a subject to
 * decide when every subject goes to the same model. Max classifies this
 * message and sends it to that category's specialist.
 */
export async function resolveRoute(
  effort: Effort,
  text: string,
  folderOpen = false,
): Promise<RouteChoice> {
  // Three ways a turn reaches the classifier, and two ways it does not.
  //
  // A folder being open always classifies, whatever the effort: "does this
  // need your files?" is not the same question as "how hard should I think?",
  // and Fast is the default, so skipping it would mean tools never fire unless
  // the reader first found and changed the effort control.
  //
  // Max always classifies, which it already did — the folder question now
  // rides along on that call, which is what lets the web app say "not here"
  // instead of silently answering a request to build a file with prose.
  //
  // Fast with no folder is the one that does not, and it is the common case on
  // the web. It stays exactly as cheap as it was: zero classifier calls. The
  // cost is that a Fast web turn asking for a file gets no notice, only an
  // answer — which is what it got before this existed.
  if (effort === "fast" && !folderOpen) return withCredential(fastRoute());

  // Budget with no folder is the other zero-classifier path, and for a
  // stronger reason than Fast's: Fast skips the call to be quick, Budget skips
  // it because the answer could not change anything. Every subject lands on
  // the same model, so asking which subject this is would be a round trip
  // spent to learn something nothing reads.
  if (effort === "medium" && !folderOpen) return withCredential(budgetRoute());

  // Every path that gets this far asks both questions. Which of the two
  // two-part prompts it uses is the only thing left to decide, and that is
  // what `folderOpen` settles: a folder that exists, or one that would have to.
  const classified = await classifyConversation(text, true, folderOpen);

  // Fast keeps its own model for everything the folder is not wanted for.
  // Classifying was only ever about the tools; it does not turn Fast into
  // Max for a turn that merely happened to be about finance.
  if (effort === "fast" && !classified.toolsWanted) {
    return withCredential({
      ...fastRoute(),
      classified: classified.classified,
      // The call was still made and still cost something, even though its
      // verdict was not used to pick the model.
      classifierUsage: classified.classifierUsage,
    });
  }

  // Budget with a folder open. The classifier ran to answer one question —
  // does this turn need the user's files? — and that answer is kept. The
  // subject it named is kept too, but only as a label: it is what the route
  // log and the spend breakdown say this message was about, not a vote on
  // which model answers it. Budget means this one model whatever the subject,
  // same way a failover keeps its category while changing its provider.
  if (effort === "medium") {
    return withCredential({
      ...budgetRoute(),
      category: classified.category,
      classified: classified.classified,
      toolsWanted: classified.toolsWanted,
      classifierModelId: classified.classifierModelId,
      classifierUsage: classified.classifierUsage,
    });
  }

  return withCredential(classified);
}

/**
 * Where every Budget turn goes.
 *
 * Written out rather than read from ROUTES because it is not a category
 * decision at all — no subject reaches it and no subject can move it, which is
 * the one property Budget has to keep to be worth having.
 */
function budgetRoute(): RouteChoice {
  return {
    category: "other",
    provider: "compat",
    modelId: COMPAT_MODEL_ID,
    // Budget never asks, so there is no classifier model to name. The fast
    // model id stands in, as it does for Fast: this field is what the usage
    // row is written against, and a null here would lose the turn's own row.
    classifierModelId: FAST_MODEL_ID,
    classified: false,
    needsTools: false,
    toolsWanted: false,
  };
}

function fastRoute(): RouteChoice {
  return {
    category: "other",
    provider: "openai",
    modelId: FAST_MODEL_ID,
    classifierModelId: FAST_MODEL_ID,
    // Not a classifier verdict about the subject; Fast never asks for one.
    classified: false,
    needsTools: false,
    toolsWanted: false,
  };
}

/**
 * Last gate before a turn is sent: a route naming a provider we hold no key
 * for is downgraded to the fallback rather than failing. The category is kept
 * so the logs still say what this message was judged to be.
 */
function withCredential(route: RouteChoice): RouteChoice {
  if (hasCredential(route.provider)) return route;

  console.warn(
    `no ${route.provider} credential for a ${route.category} message; ` +
      "falling back to Muse",
  );
  return {
    ...fallbackRoute(route.classifierModelId),
    category: route.category,
    classifierUsage: route.classifierUsage,
    // Carried across so a turn that wanted the folder still says so. The
    // fallback cannot grant it — needsTools stays false — but the reader is
    // still owed the notice, and losing the flag here is how they would
    // silently stop getting one.
    toolsWanted: route.toolsWanted,
  };
}

/**
 * Where a turn goes when the chosen provider has no credential, or the
 * classifier could not run. Deliberately written out rather than read from
 * ROUTES: this is the safety net, and a safety net that moves whenever the
 * routing table is edited is not one — even though ROUTES.other happens to
 * name the same model today.
 *
 * `needsTools` is cleared so nothing downstream declares tools to a provider
 * we have no key for. Every provider can carry them now, but the fallback is
 * reached precisely when the intended one could not be reached at all.
 */
export function fallbackRoute(classifierModelId: string): RouteChoice {
  return {
    category: "other",
    provider: "meta",
    modelId: MUSE_MODEL_ID,
    classifierModelId,
    classified: true,
    needsTools: false,
    toolsWanted: false,
  };
}

/**
 * Reads the message and names a subject, and — when asked — whether the turn
 * wants the user's computer.
 *
 * Runs on the OpenAI model when that key is configured, and falls back to the
 * Muse endpoint otherwise so the router keeps working with a partial set of
 * credentials.
 *
 * Two different things both end up as "other", and the caller needs to tell
 * them apart: the classifier read the message and judged it uncategorised
 * (classified: true), or the classifier never ran (classified: false). Only
 * the first is a decision worth acting on.
 */
export async function classifyConversation(
  text: string,
  askTools = false,
  folderOpen = false,
): Promise<RouteChoice> {
  const useOpenAI = hasCredential("openai");
  const classifierModelId = useOpenAI ? CLASSIFIER_MODEL_ID : MUSE_MODEL_ID;
  const prompt = !askTools
    ? CLASSIFIER_PROMPT
    : folderOpen
    ? TOOL_CLASSIFIER_PROMPT
    : CAPABILITY_CLASSIFIER_PROMPT;

  if (!useOpenAI && !hasCredential("meta")) {
    console.error("no classifier credential: set OPENAI_API_KEY or MODEL_API_KEY");
    return routeFor("other", classifierModelId, false);
  }

  let answer = "";
  let usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  try {
    const result = useOpenAI
      ? await classifyWithOpenAI(text, prompt, askTools)
      : await classifyWithMuse(text, prompt, askTools);
    answer = result.answer;
    usage = result.usage;
  } catch (err) {
    console.error("classifier failed:", err);
    return routeFor("other", classifierModelId, false);
  }

  const verdict = parseVerdict(answer, askTools);
  return {
    ...routeFor(verdict.category, classifierModelId, true, verdict.toolsWanted),
    classifierUsage: usage,
  };
}

/**
 * Pull a subject and a yes/no out of whatever the classifier actually said.
 *
 * Written to survive a model that ignores the format, because one eventually
 * will. The subject is matched anywhere in the reply rather than only at the
 * start, so "coding yes" and "Subject: coding. Tools: yes." both work; an
 * unmatched subject is "other", which is what "I recognised none of these"
 * means. The folder answer defaults to NO on anything ambiguous — a missed
 * notice is a turn answered in prose, which is what happens today anyway,
 * while a spurious one interrupts an ordinary question with a warning about a
 * feature the reader never asked for.
 */
export function parseVerdict(
  answer: string,
  askTools: boolean,
): { category: Category; toolsWanted: boolean } {
  const clean = answer.trim().toLowerCase();
  const category = CATEGORIES.find((c) => clean.includes(c)) ?? "other";

  if (!askTools) return { category, toolsWanted: false };

  // Only the part after the subject can be the answer to the second question.
  // Searching the whole reply would read the "no" in "not sure" — or, worse,
  // find "yes" inside a subject the model spelled out in a sentence.
  const at = clean.indexOf(category);
  const tail = at === -1 ? clean : clean.slice(at + category.length);
  const yes = /\byes\b/.test(tail);
  const no = /\bno\b/.test(tail);

  return { category, toolsWanted: yes && !no };
}

async function classifyWithOpenAI(
  text: string,
  prompt: string,
  askTools = false,
): Promise<{ answer: string; usage: Usage }> {
  const key = requireKey("openai");

  const send = (withReasoning: boolean) =>
    fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL_ID,
        // Newer chat/completions models reject max_tokens in favour of this.
        // Two words need more room than one, and a reply cut off after
        // "coding" would read as a no to a question that was answered yes.
        max_completion_tokens: askTools ? 32 : 16,
        ...(withReasoning ? { reasoning_effort: CLASSIFIER_REASONING } : {}),
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text },
        ],
      }),
    });

  let response = await send(true);

  // A model that has never had a reasoning stage rejects the field outright.
  // Retrying without it costs one round trip on a misconfiguration and keeps
  // the router working across model generations.
  if (response.status === 400) {
    const detail = await response.text();
    if (detail.includes("reasoning_effort")) {
      console.warn("classifier does not accept reasoning_effort; retrying");
      response = await send(false);
    } else {
      throw new Error(`Classifier request failed: 400 ${detail}`);
    }
  }

  if (!response.ok) {
    throw new Error(
      `Classifier request failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = await response.json();
  return {
    answer: String(payload?.choices?.[0]?.message?.content ?? "")
      .trim()
      .toLowerCase(),
    usage: usageFromPayload(payload),
  };
}

async function classifyWithMuse(
  text: string,
  prompt: string,
  askTools = false,
): Promise<{ answer: string; usage: Usage }> {
  const key = requireKey("meta");

  const response = await fetch(`${MUSE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MUSE_MODEL_ID,
      stream: false,
      temperature: 0,
      max_tokens: askTools ? 24 : 8,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Classifier request failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = await response.json();
  return {
    answer: String(payload?.choices?.[0]?.message?.content ?? "")
      .trim()
      .toLowerCase(),
    usage: usageFromPayload(payload),
  };
}

// --- calling the chosen model ----------------------------------------------

/**
 * What a turn is given on top of its messages.
 *
 * Both halves are independently optional, which is new. `tools` without
 * `system` never happens — a model handed run_command with nothing telling it
 * which folder or which Python is a model that guesses — but `system` without
 * `tools` is now an ordinary case: it is how a turn that wanted the folder
 * somewhere there isn't one is told so.
 */
export interface ToolOptions {
  tools?: ToolSpec[];
  system?: string;
}

/**
 * How long to wait for a provider to start answering before giving up on it.
 *
 * A provider that is down usually hangs rather than returning 503, and without
 * a deadline the turn waits until the platform kills the worker — which looks
 * to the reader exactly like the app being broken, and never gives failover a
 * chance to try somewhere else.
 *
 * Thirty seconds, not twelve. A continuation carrying a long tool loop back to
 * the provider is a large upload, and some providers do not send headers until
 * the first token is ready — with thinking on, that is not fast. Thirty still
 * catches a provider that is simply down.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * A deadline that covers the connect and then gets out of the way.
 *
 * This exists because `AbortSignal.timeout()` cannot be switched off. It fires
 * on a wall clock from the moment it is created, and the signal handed to
 * fetch stays attached to the response body afterwards — so using one here
 * was not a connect timeout at all. It was a hard cap on the whole turn, and
 * every reply that took longer than the timeout to stream was aborted in the
 * middle of streaming. Short tool legs hid it for weeks, because each leg is a
 * fresh fetch with a fresh deadline.
 *
 * `clear()` on the way past the headers means the body streams for as long as
 * the model wants to talk. Nothing is aborted after that point: a stream that
 * stalls mid-reply holds the worker until the platform's own limit, which is
 * the lesser of the two problems — the alternative was cutting healthy answers
 * off at a fixed length.
 */
export function connectDeadline(ms: number = CONNECT_TIMEOUT_MS): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("connect timeout", "TimeoutError")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Trim the front of a history until it can legally open a request.
 *
 * A tool result is stored as a USER message carrying tool_result blocks, and
 * the call it answers is in the assistant message just before it. History is
 * assembled newest-first and truncated when the character budget or the
 * ancestor depth runs out, so the cut can land between those two — leaving a
 * result addressed to a call the model cannot see. Every provider rejects that
 * with a 400, and Gemini is the most exposed of the four because it matches a
 * result to its call by NAME, with no id at all.
 *
 * The damage is not one turn. The blocks are stored, so every later message in
 * the thread rebuilds the same invalid prefix and is rejected the same way:
 * the conversation stops working permanently while telling the reader to try
 * again shortly.
 *
 * Leading assistant messages go too. Anthropic requires the first message to
 * be `user`, so shifting a result off the front without this would trade one
 * 400 for another.
 *
 * Only the front is trimmed, and that is sufficient: the assembly walks a
 * contiguous run backwards, so it can only ever lose a prefix. The last
 * message is never dropped — it is the turn being asked about.
 */
export function dropOrphanedToolResults(messages: ModelMessage[]): ModelMessage[] {
  let start = 0;
  while (start < messages.length - 1) {
    const first = messages[start]!;
    const answersAMissingCall = Array.isArray(first.content) &&
      first.content.some((part) =>
        !!part && typeof part === "object" &&
        (part as { type?: unknown }).type === "tool_result"
      );
    if (!answersAMissingCall && first.role === "user") break;
    start++;
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * Does this history carry structured tool blocks the provider has to validate?
 */
export function hasToolBlocks(messages: ModelMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) =>
      !!part && typeof part === "object" &&
      ((part as { type?: unknown }).type === "tool_use" ||
        (part as { type?: unknown }).type === "tool_result")
    )
  );
}

/**
 * The same conversation, with every tool call and result rewritten as prose.
 *
 * Structured tool blocks are the fragile part of a request. They have to
 * reference each other correctly, arrive in the right order, keep the thinking
 * block that preceded them, and — on Gemini, which sends no call id — match by
 * name. A history that violates any of that is rejected with a 400, and
 * because the blocks are STORED, the rejection repeats on every later message
 * in the thread. The conversation stops working permanently.
 *
 * Prose has none of those constraints. Flattening loses the model's ability to
 * treat an earlier call as a real call — it cannot refer back to it by id, and
 * a provider will not thread a new result onto it — but it keeps every fact
 * that was in the loop, and it is accepted by all four providers. A thread that
 * degrades is worth a great deal more than a thread that is dead.
 *
 * Thinking blocks are dropped rather than flattened. They are only ever sent
 * back to satisfy the provider that a tool call is intact, which is precisely
 * what is being given up here, and their signatures are checked.
 */
export function flattenToolBlocks(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;

    const lines: string[] = [];
    // Anything that is not text, thinking or a tool block — an image or a PDF
    // attached to this turn — survives as itself. It is not what providers
    // reject, and dropping it would lose the file the turn is about.
    const kept: Array<Record<string, unknown>> = [];

    for (const raw of message.content) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;

      switch (part.type) {
        case "text":
          if (typeof part.text === "string" && part.text.trim()) {
            lines.push(part.text);
          }
          break;
        case "thinking":
        case "redacted_thinking":
          break;
        case "tool_use": {
          const name = typeof part.name === "string" ? part.name : "a tool";
          lines.push(`[ran ${name}: ${stringifyToolInput(part.input)}]`);
          break;
        }
        case "tool_result": {
          const name = typeof part.name === "string" ? part.name : "the tool";
          const body = typeof part.content === "string" ? part.content : "";
          lines.push(
            part.is_error
              ? `[${name} failed: ${body}]`
              : `[output of ${name}:\n${body}]`,
          );
          break;
        }
        default:
          kept.push(part);
      }
    }

    // An empty message is itself a 400 on some providers, so a turn that was
    // nothing but a thinking block still says something.
    const text = lines.join("\n").trim() || "[no output]";
    return {
      role: message.role,
      content: kept.length > 0 ? [{ type: "text", text }, ...kept] : text,
    };
  });
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

export function openModelStream(
  route: Pick<RouteChoice, "provider" | "modelId" | "effortCap">,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  /**
   * Aborts the request if the provider has not answered yet.
   *
   * Must stop applying once the headers arrive, or it caps the reply instead
   * of the connect — a signal handed to fetch stays attached to the response
   * body. Build it with `connectDeadline()`, which can be switched off.
   */
  signal?: AbortSignal,
): Promise<Response> {
  // Applied here rather than in resolveRoute because the reader's own choice
  // is what gets stored against the message and shown back to them. The cap
  // changes what this one call asks the provider for, and nothing else: a
  // capped Max turn still reads as Max in the route log and the breakdown,
  // which is the truth — Max is what was chosen and what picked the model.
  const asked = capEffort(effort, route.effortCap);

  switch (route.provider) {
    case "anthropic":
      return callAnthropic(route.modelId, asked, messages, options, signal);
    case "google":
      return callGemini(route.modelId, asked, messages, options, signal);
    case "openai":
      return callOpenAI(route.modelId, asked, messages, options, signal);
    case "compat":
      return callCompat(route.modelId, asked, messages, options, signal);
    default:
      return callMuse(route.modelId, asked, messages, options, signal);
  }
}

/** Effort levels cheapest first, so a cap can be compared rather than assumed. */
const EFFORT_ORDER: Effort[] = ["fast", "medium", "max"];

/**
 * The lower of what was chosen and what the route allows.
 *
 * A cap that raised effort would be a strange thing to call a cap, and would
 * make a Fast turn on a demonstration route cost more than a Fast turn
 * anywhere else.
 */
export function capEffort(chosen: Effort, cap?: Effort): Effort {
  if (!cap) return chosen;
  return EFFORT_ORDER.indexOf(cap) < EFFORT_ORDER.indexOf(chosen) ? cap : chosen;
}

/**
 * The tool list in each provider's own dialect.
 *
 * One declaration, four serialisations. They differ only in packaging — a
 * name, a description and a JSON Schema — but nothing accepts another's shape,
 * and a rejected declaration comes back as a 400 with no hint that tools were
 * the reason.
 */
function openAITools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function geminiTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
  }];
}

export interface AssembledToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Rebuilds the assistant's content array exactly as it was streamed.
 *
 * Not a nicety. When a tool result goes back, Anthropic requires the assistant
 * message to be echoed complete and unmodified — thinking blocks, signatures
 * and all — and rejects the request with a 400 if any of it is missing. This
 * app had always dropped reasoning on the floor, which is correct for an
 * ordinary reply and fatal the moment a second tool call follows a first.
 *
 * So the blocks are collected verbatim rather than re-derived: whatever came
 * down the wire is what goes back up.
 */
export function assistantBlocks(provider: Provider): {
  accept(payload: Record<string, unknown>): void;
  blocks(): Array<Record<string, unknown>>;
  toolCall(): AssembledToolCall | null;
} {
  return provider === "anthropic"
    ? anthropicBlocks()
    : provider === "google"
    ? geminiBlocks()
    : openAIBlocks();
}

/**
 * Anthropic's own shape, which is also the shape everything is STORED in.
 *
 * The other two assemblers below translate into this as they read, so a stored
 * message means one thing regardless of which model produced it and `index.ts`
 * has a single format to validate tool_use_ids against.
 */
function anthropicBlocks() {
  const out: Array<Record<string, unknown>> = [];
  let open: Record<string, unknown> | null = null;
  let args = "";

  const close = () => {
    if (!open) return;
    if (open.type === "tool_use") open.input = parseToolInput(args);
    out.push(open);
    open = null;
    args = "";
  };

  return {
    accept(payload: Record<string, unknown>) {
      if (payload.type === "content_block_start") {
        close();
        const block = payload.content_block;
        if (block && typeof block === "object") {
          open = { ...block as Record<string, unknown> };
          args = "";
        }
        return;
      }

      if (payload.type === "content_block_delta" && open) {
        const delta = payload.delta as Record<string, unknown> | undefined;
        const kind = delta?.type;

        if (kind === "text_delta" && typeof delta?.text === "string") {
          open.text = `${open.text ?? ""}${delta.text}`;
        } else if (kind === "thinking_delta" && typeof delta?.thinking === "string") {
          open.thinking = `${open.thinking ?? ""}${delta.thinking}`;
        } else if (kind === "signature_delta" && typeof delta?.signature === "string") {
          // Unsigned thinking is rejected on the way back in, so the signature
          // matters as much as the text it signs.
          open.signature = `${open.signature ?? ""}${delta.signature}`;
        } else if (kind === "input_json_delta" && typeof delta?.partial_json === "string") {
          args += delta.partial_json;
        }
        return;
      }

      if (payload.type === "content_block_stop") close();
    },

    blocks() {
      close();
      return out;
    },

    toolCall() {
      close();
      return firstToolUse(out);
    },
  };
}

/**
 * OpenAI and Meta, which share a format.
 *
 * Calls arrive spread across deltas and keyed by `index`, not by id: the id
 * and the name turn up on the first fragment and every later fragment carries
 * only more `arguments` text. Keying the map on index rather than on id is
 * what makes that work — and is why a delta whose index is missing is treated
 * as index 0 rather than dropped.
 */
function openAIBlocks() {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const assemble = (): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    if (text.length > 0) out.push({ type: "text", text });
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        type: "tool_use",
        // A call with no id is not answerable — the result has nowhere to
        // point — so one is invented rather than losing the call.
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseToolInput(call.args),
      });
    }
    return out;
  };

  return {
    accept(payload: Record<string, unknown>) {
      const choices = payload.choices as Array<{
        delta?: {
          content?: unknown;
          tool_calls?: Array<{
            index?: unknown;
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>;
        };
      }> | undefined;

      const delta = choices?.[0]?.delta;
      if (!delta) return;

      if (typeof delta.content === "string") text += delta.content;
      if (!Array.isArray(delta.tool_calls)) return;

      for (const fragment of delta.tool_calls) {
        const index = typeof fragment.index === "number" ? fragment.index : 0;
        const entry = calls.get(index) ?? { id: "", name: "", args: "" };

        if (typeof fragment.id === "string" && fragment.id) entry.id = fragment.id;
        const fn = fragment.function;
        if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
        if (typeof fn?.arguments === "string") entry.args += fn.arguments;

        calls.set(index, entry);
      }
    },

    blocks: assemble,
    toolCall: () => firstToolUse(assemble()),
  };
}

/**
 * Gemini, whose calls arrive whole rather than in fragments — `args` is an
 * object in one part, not a JSON string spread over several.
 *
 * Two things it alone needs. It sends no call id, and the whole loop is keyed
 * on one, so an id is synthesised here; it is opaque everywhere except
 * `toGeminiParts`, which needs the NAME back to answer the call, and gets it
 * from the stored tool_result rather than by unpicking this string.
 *
 * And a part carrying a call may carry a `thoughtSignature` that has to be
 * echoed with it, the same way an Anthropic thinking block does. It is kept on
 * the block rather than dropped, for the same reason.
 */
function geminiBlocks() {
  const out: Array<Record<string, unknown>> = [];
  let text = "";
  // Unique across the conversation, not just within this reply. The counter
  // alone resets every request, so a six-leg loop produced six calls all
  // called "gemcall_1" — which validated fine, because a result is checked
  // against its own parent message, and made the stored thread unreadable.
  const turn = crypto.randomUUID().slice(0, 8);
  let calls = 0;

  const assemble = (): Array<Record<string, unknown>> =>
    text.length > 0 ? [{ type: "text", text }, ...out] : [...out];

  return {
    accept(payload: Record<string, unknown>) {
      const candidates = payload.candidates as Array<{
        content?: {
          parts?: Array<{
            text?: unknown;
            thought?: unknown;
            thoughtSignature?: unknown;
            functionCall?: { name?: unknown; args?: unknown };
          }>;
        };
      }> | undefined;

      const parts = candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return;

      for (const part of parts) {
        const call = part.functionCall;
        if (call && typeof call.name === "string") {
          calls += 1;
          const block: Record<string, unknown> = {
            type: "tool_use",
            id: `gemcall_${turn}_${calls}`,
            name: call.name,
            input: call.args && typeof call.args === "object" ? call.args : {},
          };
          if (typeof part.thoughtSignature === "string") {
            block.thought_signature = part.thoughtSignature;
          }
          out.push(block);
          continue;
        }

        // Thought summaries are shown live and never persisted; only the
        // answer is part of the thread.
        if (part.thought === true) continue;
        if (typeof part.text === "string") text += part.text;
      }
    },

    blocks: assemble,
    toolCall: () => firstToolUse(assemble()),
  };
}

/**
 * The one call a turn is allowed to make.
 *
 * Every provider can batch several and every one of them is asked not to,
 * because batched calls mean batched approvals — the fastest route to someone
 * clicking through without reading. A model that batches anyway has the extras
 * ignored here rather than in front of the user.
 */
function firstToolUse(
  blocks: Array<Record<string, unknown>>,
): AssembledToolCall | null {
  const call = blocks.find((block) => block.type === "tool_use");
  if (!call || typeof call.id !== "string" || typeof call.name !== "string") {
    return null;
  }
  return { id: call.id, name: call.name, input: call.input ?? {} };
}

/**
 * Arguments arrive as JSON, but not necessarily complete: a truncated reply
 * can stop mid-object. An unparseable call becomes an empty one so the gate
 * still appears and the user can deny it, rather than the turn dying silently.
 */
function parseToolInput(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error("tool arguments did not parse:", raw.slice(0, 200));
    return {};
  }
}

/**
 * Tokens in, tokens out — the only two numbers a turn is billed on.
 *
 * Every provider reports them at a different moment and under a different
 * name, and two of them report nothing at all unless the request asks (see
 * `stream_options` in the OpenAI-format calls below). Getting this wrong is
 * silent: the turn works, the reply is fine, and the spend is simply missing.
 */
export interface Usage {
  /** Input tokens charged at the FULL rate — cached ones are not in here. */
  inputTokens: number;
  /**
   * Input tokens served from the provider's cache, charged at the cached rate.
   *
   * Split out because this app is unusually cache-heavy: a tool loop resends
   * the whole history on every leg, so a twenty-leg turn is one growing prefix
   * repeated twenty times, which is precisely what an implicit cache absorbs.
   * Billing those at the full rate over-stated one real Gemini run by about
   * three times.
   */
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Accumulates usage across a stream.
 *
 * Every provider reports CUMULATIVE totals rather than increments — Anthropic
 * splits them across two events, Gemini repeats a growing total on each chunk,
 * the OpenAI format sends one final summary — so this keeps the highest value
 * it has seen rather than adding them up. Summing would multiply a Gemini turn
 * by its number of chunks.
 */
export function usageMeter(provider: Provider): {
  accept(payload: Record<string, unknown>): void;
  read(): Usage;
} {
  let input = 0;
  let cached = 0;
  let output = 0;

  const keep = (nextIn: unknown, nextCached: unknown, nextOut: unknown) => {
    if (typeof nextIn === "number" && nextIn > input) input = nextIn;
    if (typeof nextCached === "number" && nextCached > cached) cached = nextCached;
    if (typeof nextOut === "number" && nextOut > output) output = nextOut;
  };

  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  // Once per stream. Anthropic reports twice and Gemini on every chunk; the
  // first one carries the shape, which is all this is for.
  let logged = false;
  const show = (raw: unknown) => {
    if (!USAGE_DEBUG || logged || !raw) return;
    logged = true;
    console.log(`usage[${provider}] ${JSON.stringify(raw)}`);
  };

  return {
    accept(payload) {
      if (provider === "anthropic") {
        // Anthropic is the odd one out: `input_tokens` EXCLUDES cache reads
        // and cache writes, which arrive as their own fields. Subtracting here
        // the way the other two need would double-discount the turn.
        const read = (usage: Record<string, unknown> | undefined) => {
          if (!usage) return;
          show(usage);
          // Cache CREATION is billed ABOVE the full rate — 1.25x on a
          // five-minute TTL, 2x on an hour — so it is folded in with full-rate
          // input rather than with the discount. That under-bills a cache
          // write by a quarter, and is moot while this app sets no
          // cache_control breakpoints and Anthropic therefore caches nothing.
          const full = num(usage.input_tokens) + num(usage.cache_creation_input_tokens);
          keep(full, usage.cache_read_input_tokens, usage.output_tokens);
        };

        if (payload.type === "message_start") {
          const message = payload.message as
            | { usage?: Record<string, unknown> }
            | undefined;
          read(message?.usage);
          return;
        }
        read(payload.usage as Record<string, unknown> | undefined);
        return;
      }

      if (provider === "google") {
        const meta = payload.usageMetadata as Record<string, unknown> | undefined;
        if (!meta) return;
        show(meta);
        // promptTokenCount INCLUDES the cached ones, so the full-rate share is
        // what is left after taking them out. Never below zero: a provider
        // that reports these inconsistently must not produce a negative cost.
        const cachedNow = num(meta.cachedContentTokenCount);
        const fullNow = Math.max(0, num(meta.promptTokenCount) - cachedNow);
        // Thinking is billed as output and reported separately, so a turn that
        // thought hard would otherwise be costed as though it had not.
        const outNow = num(meta.candidatesTokenCount) + num(meta.thoughtsTokenCount);
        keep(fullNow, cachedNow, outNow);
        return;
      }

      // OpenAI and Meta: prompt_tokens includes the cached ones, the same way
      // Gemini's does, with the breakdown nested a level down.
      const usage = payload.usage as Record<string, unknown> | undefined;
      if (!usage) return;
      show(usage);
      const details = usage.prompt_tokens_details as
        | Record<string, unknown>
        | undefined;
      const cachedNow = num(details?.cached_tokens);
      const fullNow = Math.max(0, num(usage.prompt_tokens) - cachedNow);
      keep(fullNow, cachedNow, usage.completion_tokens);
    },

    read: () => ({
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
    }),
  };
}

/** Usage from a non-streamed OpenAI-format reply — the classifier's own call. */
export function usageFromPayload(payload: unknown): Usage {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const details = usage?.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cached = num(details?.cached_tokens);

  return {
    inputTokens: Math.max(0, num(usage?.prompt_tokens) - cached),
    cachedInputTokens: cached,
    outputTokens: num(usage?.completion_tokens),
  };
}

/** The answer text in one streamed event, or null if it carries none. */
export function streamDelta(
  provider: Provider,
  payload: Record<string, unknown>,
): string | null {
  if (provider === "anthropic") {
    const delta = payload.delta as { type?: unknown; text?: unknown } | undefined;
    return payload.type === "content_block_delta" && delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ? delta.text
      : null;
  }

  if (provider === "google") return geminiParts(payload, false);

  const choices = payload.choices as Array<{
    delta?: { content?: unknown };
  }> | undefined;
  const text = choices?.[0]?.delta?.content;
  return typeof text === "string" ? text : null;
}

/**
 * Reasoning text, where the provider exposes any.
 *
 *   Anthropic — thinking_delta blocks, once display is set to summarized.
 *   Google    — content parts flagged thought:true, once includeThoughts is on.
 *   OpenAI-compatible — a reasoning_content field on the delta.
 *
 * Providers that expose nothing simply return null and the UI shows a bare
 * spinner, which is the honest representation of "working, no commentary".
 */
export function streamReasoning(
  provider: Provider,
  payload: Record<string, unknown>,
): string | null {
  if (provider === "anthropic") {
    const delta = payload.delta as
      | { type?: unknown; thinking?: unknown }
      | undefined;
    return payload.type === "content_block_delta" &&
        delta?.type === "thinking_delta" && typeof delta.thinking === "string"
      ? delta.thinking
      : null;
  }

  if (provider === "google") return geminiParts(payload, true);

  const choices = payload.choices as Array<{
    delta?: { reasoning_content?: unknown; reasoning?: unknown };
  }> | undefined;
  const delta = choices?.[0]?.delta;
  const text = delta?.reasoning_content ?? delta?.reasoning;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * Gemini packs answer text and thought summaries into the same parts array,
 * separated only by a `thought` flag, and a single chunk can hold several of
 * each. Pull one side out and join it.
 */
function geminiParts(
  payload: Record<string, unknown>,
  wantThoughts: boolean,
): string | null {
  const candidates = payload.candidates as Array<{
    content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
  }> | undefined;

  const parts = candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((part) => (part.thought === true) === wantThoughts)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");

  return text.length > 0 ? text : null;
}

function callMuse(
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  return callOpenAICompatible(
    { provider: "meta", baseUrl: MUSE_BASE_URL, effortPrompts: MUSE_EFFORT },
    modelId,
    effort,
    messages,
    options,
    signal,
  );
}

/**
 * The second OpenAI-compatible slot, DeepSeek on DeepInfra by default.
 *
 * Nothing here is tied to either. A compatible host takes the same body Muse
 * does, down to `stream_options`; what differs is the host, the key and how
 * effort is asked for, which is exactly what the shared client below is
 * parameterised on. So this is a config rather than a second implementation,
 * and a fix to the streaming body reaches both slots.
 */
function callCompat(
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  return callOpenAICompatible(
    {
      provider: "compat",
      baseUrl: COMPAT_BASE_URL,
      reasoningEffort: COMPAT_REASONING,
    },
    modelId,
    effort,
    messages,
    options,
    signal,
  );
}

interface CompatibleEndpoint {
  provider: Provider;
  baseUrl: string;
  /**
   * How to ask for less or more deliberation, in whichever of the two ways
   * this host understands. Muse takes a sentence because it takes nothing
   * else; this slot takes the parameter, which is the one that actually binds.
   * Exactly one of these is set.
   */
  effortPrompts?: Record<Effort, string>;
  reasoningEffort?: string;
}

/**
 * The OpenAI chat-completions wire format, for the hosts that merely speak it
 * rather than being OpenAI. Kept apart from callOpenAI, which sends
 * `reasoning_effort` — a field these two do not reliably accept, and a
 * rejected field is a 400 that loses the turn.
 */
function callOpenAICompatible(
  endpoint: CompatibleEndpoint,
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const key = requireKey(endpoint.provider);

  const send = (withReasoning: boolean) =>
    fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        // Without this the stream carries no usage at all and the turn is
        // recorded as free. It costs one extra chunk at the end.
        stream_options: { include_usage: true },
        ...(withReasoning && endpoint.reasoningEffort
          ? { reasoning_effort: endpoint.reasoningEffort }
          : {}),
        ...openAIToolFields(options),
        messages: [
          // The effort instruction and anything else this turn needs to be
          // told are one system message, not two: some OpenAI-compatible
          // endpoints keep only the first.
          {
            role: "system",
            content: joinSystem(
              endpoint.effortPrompts?.[effort],
              options?.system,
            ),
          },
          ...toOpenAIMessages(messages),
        ],
      }),
    });

  return sendWithReasoningFallback(send, endpoint);
}

/**
 * Sends the request, and sends it again without `reasoning_effort` if that is
 * what the endpoint objected to.
 *
 * The same trade the classifier makes: one wasted round trip on a
 * misconfiguration, against a turn that dies because a host wanted a number
 * where it was given a word. Worth more here than there, because the accepted
 * shape genuinely differs between DeepInfra's platform docs and its own model
 * pages, and a Budget turn is the only kind a reader sees.
 *
 * Only a 400 naming the field is retried. Every other failure is returned
 * untouched for the failover chain to read — a 429 retried here would be a
 * rate limit answered by asking twice.
 */
async function sendWithReasoningFallback(
  send: (withReasoning: boolean) => Promise<Response>,
  endpoint: CompatibleEndpoint,
): Promise<Response> {
  const response = await send(true);
  if (response.status !== 400 || !endpoint.reasoningEffort) return response;

  // Reading the body ends this response, which is safe only because a 400
  // carries no stream anybody is waiting on.
  const detail = await response.text();
  if (!detail.includes("reasoning_effort")) {
    return new Response(detail, { status: 400, headers: response.headers });
  }

  console.warn(
    `${endpoint.provider} rejected reasoning_effort=${endpoint.reasoningEffort}; ` +
      "retrying without it. Set COMPAT_REASONING_EFFORT to a value it accepts.",
  );
  return send(false);
}

function callOpenAI(
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const key = requireKey("openai");
  const reasoningEffort = effort === "fast" ? "low" : "medium";
  const system = options?.system;

  return fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      stream: true,
      reasoning_effort: reasoningEffort,
      // See callMuse: no usage is reported unless the request asks for it.
      stream_options: { include_usage: true },
      ...openAIToolFields(options),
      messages: system
        ? [{ role: "system", content: system }, ...toOpenAIMessages(messages)]
        : toOpenAIMessages(messages),
    }),
  });
}

/** The tool half of an OpenAI-format request body, or nothing. */
function openAIToolFields(options?: ToolOptions): Record<string, unknown> {
  if (!options?.tools || options.tools.length === 0) return {};
  return {
    tools: openAITools(options.tools),
    tool_choice: "auto",
    // One call per response — see firstToolUse.
    parallel_tool_calls: false,
  };
}

function joinSystem(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part && part.length > 0).join("\n\n");
}

function callAnthropic(
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const key = requireKey("anthropic");
  const tools = options?.tools;

  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 16_000,
      stream: true,
      // Without display:"summarized" the thinking blocks stream empty, which
      // is the default on current models — the UI would show a silent pause.
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: ANTHROPIC_EFFORT[effort] },
      ...(options?.system ? { system: options.system } : {}),
      ...(tools && tools.length > 0
        ? {
          tools,
          // One call per response. All four providers can batch several, and
          // batched calls mean batched approvals — which is the fastest route
          // to someone clicking through without reading.
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
        }
        : {}),
      messages: messages.map((message) => ({
        role: message.role,
        content: toAnthropicContent(message.content),
      })),
    }),
  });
}

/**
 * Gemini takes its key in a header rather than the query string, so it stays
 * out of request logs and proxy access logs. `alt=sse` makes the response a
 * `data:`-prefixed event stream, which is the shape index.ts already parses.
 */
function callGemini(
  modelId: string,
  effort: Effort,
  messages: ModelMessage[],
  options?: ToolOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const key = requireKey("google");
  const budget = GEMINI_THINKING_BUDGET[effort];
  const tools = options?.tools;

  return fetch(
    `${GEMINI_BASE_URL}/models/${modelId}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      signal,
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: toGeminiParts(message.content),
        })),
        ...(options?.system
          ? { systemInstruction: { parts: [{ text: options.system }] } }
          : {}),
        ...(tools && tools.length > 0
          ? {
            tools: geminiTools(tools),
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          }
          : {}),
        generationConfig: {
          thinkingConfig: {
            thinkingBudget: budget,
            // Asking for summaries when the budget is zero is contradictory,
            // and some versions reject the pair.
            includeThoughts: budget !== 0,
          },
        },
      }),
    },
  );
}

// --- content conversion ----------------------------------------------------

export function toAnthropicContent(
  content: ModelMessage["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;

  return content.flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string") return [part];

    // Everything is stored in Anthropic's own shape, whichever model produced
    // it, so a tool call and its result travel back unchanged here and are
    // converted in toOpenAIMessages and toGeminiParts instead. `name` is
    // carried on a stored tool_result for the benefit of Gemini, which matches
    // results by name; Anthropic matches by id and ignores it.
    if (part.type === "tool_use") return [part];
    if (part.type === "tool_result") {
      const { name: _name, thought_signature: _sig, ...rest } = part;
      return [rest];
    }

    if (part.type === "image_url") {
      const imageUrl = part.image_url as { url?: unknown } | undefined;
      const parsed = parseDataUrl(imageUrl?.url);
      return parsed
        ? [{
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        }]
        : [];
    }

    if (part.type === "file") {
      const file = part.file as {
        filename?: unknown;
        file_data?: unknown;
      } | undefined;
      const parsed = parseDataUrl(file?.file_data);
      return parsed
        ? [{
          type: "document",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
          title: typeof file?.filename === "string" ? file.filename : undefined,
        }]
        : [];
    }

    return [];
  });
}

/**
 * Canonical messages as the OpenAI format wants them, which is the one place
 * a single stored message can become more than one wire message.
 *
 * A tool result is not a user message here. OpenAI and Meta both want it as
 * its own role — `{role:"tool", tool_call_id}` — and reject a conversation
 * where a call is followed by anything else, so the user row that holds the
 * result is split out rather than sent as prose. A result whose call was never
 * made is dropped for the same reason.
 */
export function toOpenAIMessages(
  messages: ModelMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const toolResults = message.content.filter((p) => p.type === "tool_result");
    const toolUses = message.content.filter((p) => p.type === "tool_use");
    const rest = message.content.filter(
      (p) => p.type !== "tool_result" && p.type !== "tool_use",
    );

    // Results first: they answer the message before this one, and anything
    // else on the row was written after.
    for (const result of toolResults) {
      if (typeof result.tool_use_id !== "string") continue;
      out.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: typeof result.content === "string" ? result.content : "",
      });
    }

    if (toolUses.length > 0) {
      const text = rest
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("");

      out.push({
        role: "assistant",
        // Null rather than "" — an empty string is a reply that said nothing,
        // and some endpoints reject it alongside tool_calls.
        content: text.length > 0 ? text : null,
        tool_calls: toolUses.map((call) => ({
          id: typeof call.id === "string" ? call.id : "",
          type: "function",
          function: {
            name: typeof call.name === "string" ? call.name : "",
            // Back to the string it arrived as. The object is what everything
            // in between wanted; the wire wants JSON text.
            arguments: JSON.stringify(call.input ?? {}),
          },
        })),
      });
      continue;
    }

    if (rest.length === 0) continue;

    // Attachments are already stored in this format — image_url and file are
    // OpenAI's own shapes, which is why nothing is converted here.
    out.push({ role: message.role, content: rest });
  }

  return out;
}

/**
 * Gemini has one attachment shape for every binary — inlineData — so images
 * and PDFs converge here rather than splitting the way they do upstream.
 */
export function toGeminiParts(
  content: ModelMessage["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ text: part.text }];
    }

    if (part.type === "tool_use" && typeof part.name === "string") {
      const call: Record<string, unknown> = {
        functionCall: {
          name: part.name,
          args: part.input && typeof part.input === "object" ? part.input : {},
        },
      };
      // Echoed back with the call it belongs to, the same way an Anthropic
      // thinking signature is. Absent on a turn that did not think.
      if (typeof part.thought_signature === "string") {
        call.thoughtSignature = part.thought_signature;
      }
      return [call];
    }

    // Gemini answers a call by NAME, not by id — it never sent one. The name
    // is written onto the result when it is stored, precisely so this does not
    // have to go looking back up the history for the call it answers.
    if (part.type === "tool_result") {
      const name = typeof part.name === "string" ? part.name : null;
      if (!name) return [];
      return [{
        functionResponse: {
          name,
          response: {
            output: typeof part.content === "string" ? part.content : "",
            ...(part.is_error === true ? { error: true } : {}),
          },
        },
      }];
    }

    const source = part.type === "image_url"
      ? (part.image_url as { url?: unknown } | undefined)?.url
      : part.type === "file"
      ? (part.file as { file_data?: unknown } | undefined)?.file_data
      : null;

    const parsed = parseDataUrl(source);
    return parsed
      ? [{ inlineData: { mimeType: parsed.mediaType, data: parsed.data } }]
      : [];
  });
}

function parseDataUrl(value: unknown): { mediaType: string; data: string } | null {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mediaType: match[1]!, data: match[2]! } : null;
}
