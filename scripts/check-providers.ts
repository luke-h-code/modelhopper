#!/usr/bin/env -S deno run --allow-env --allow-net=api.openai.com,generativelanguage.googleapis.com,api.anthropic.com,api.meta.ai,api.deepinfra.com
//
// Exercise the routing layer from a terminal, without Supabase, without the
// database, and without the client.
//
// This imports the SAME providers.ts the Edge Function uses, so a green run
// here means the real model ids, the real request bodies and the real
// streamDelta/streamReasoning parsers work. (The SSE line-framing below is a
// small reimplementation of the loop in index.ts — that part is generic and is
// not what tends to break.)
//
// Keys are read from the environment. Do not paste them onto the command line:
// an inline `GEMINI_API_KEY=... deno run` lands in your shell history.
//
//   read -rs "GEMINI_API_KEY?Gemini key: " && export GEMINI_API_KEY   # zsh
//
// Network access is scoped to the five provider hosts by the shebang. If you
// have overridden MODEL_BASE_URL / GEMINI_BASE_URL / OPENAI_BASE_URL /
// COMPAT_BASE_URL, add that host to the --allow-net list or Deno will refuse
// the connection by name.
//
// Usage (the shebang carries the permissions, so run it directly):
//   ./scripts/check-providers.ts models              model ids each key can see
//   ./scripts/check-providers.ts ask google "..."    one answer, bypasses routing
//   ./scripts/check-providers.ts ask compat "..."    the Budget path, end to end
//   ./scripts/check-providers.ts classify "..."      category a prompt lands in
//   ./scripts/check-providers.ts smoke               five probes, one per category
//
//   --effort fast|medium|max                         default fast

import {
  type Category,
  classifyConversation,
  FAST_MODEL_ID,
  type Effort,
  hasCredential,
  openModelStream,
  type Provider,
  routeFor,
  standInModel,
  streamDelta,
  streamReasoning,
} from "../supabase/functions/chat/providers.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const OFF = "\x1b[0m";

const args = [...Deno.args];

/** Pull `--effort X` out of the args wherever it appears. */
function takeEffort(): Effort {
  const i = args.indexOf("--effort");
  if (i === -1) return "fast";
  const value = args.splice(i, 2)[1];
  if (value === "medium" || value === "max" || value === "fast") return value;
  throw new Error(`--effort must be fast, medium or max (got ${value})`);
}

const effort = takeEffort();
const [command, ...rest] = args;

// --- model discovery -------------------------------------------------------

/**
 * The point of this command: the model ids in providers.ts are defaults that
 * were written down, not looked up. This asks each provider what it will
 * actually accept, so a 404 on the first real query is caught here instead.
 */
async function listModels() {
  await listOpenAIModels();
  await listGeminiModels();
  await listCompatModels();
  console.log(
    `\n${DIM}Set a corrected id with:  supabase secrets set GEMINI_MODEL_ID=...${OFF}`,
  );
}

async function listOpenAIModels() {
  console.log(`\n${BOLD}OpenAI${OFF} ${DIM}(classifier, science)${OFF}`);
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return console.log(`  ${DIM}OPENAI_API_KEY not set, skipping${OFF}`);

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    return console.log(`  ${RED}${res.status}${OFF} ${await res.text()}`);
  }

  const ids = ((await res.json()).data as Array<{ id: string }>)
    .map((m) => m.id)
    .filter((id) => id.startsWith("gpt") || id.startsWith("o"))
    .sort();
  printIds(ids, Deno.env.get("CLASSIFIER_MODEL_ID") ?? "gpt-5.6-luna");
}

/**
 * The one listing that is routinely needed rather than occasionally: DeepInfra
 * an inference host serves a model under its full upstream path and publishes
 * a new one on every point release, so the id in providers.ts goes stale on
 * someone else's schedule. This is where to read the current one before
 * setting COMPAT_MODEL_ID — and the same page carries the price the
 * model_prices row in 0021 needs.
 *
 * Written against DeepInfra, which is the default host. Point COMPAT_BASE_URL
 * elsewhere and this still works if that host exposes /models; the filter
 * below is the only part that assumes anything.
 */
async function listCompatModels() {
  console.log(`\n${BOLD}Compatible slot${OFF} ${DIM}(Budget)${OFF}`);
  const key = Deno.env.get("COMPAT_API_KEY");
  if (!key) {
    return console.log(`  ${DIM}COMPAT_API_KEY not set, skipping${OFF}`);
  }

  const base = Deno.env.get("COMPAT_BASE_URL") ??
    "https://api.deepinfra.com/v1/openai";
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    return console.log(`  ${RED}${res.status}${OFF} ${await res.text()}`);
  }

  // An inference host's catalogue runs to thousands of models. Narrow it to
  // the family the configured id belongs to, so the list stays readable —
  // derived from that id rather than hardcoded, because which family this
  // slot points at is the whole thing COMPAT_MODEL_ID decides.
  const configured = Deno.env.get("COMPAT_MODEL_ID") ??
    "deepseek-ai/DeepSeek-V4.1-Flash";
  const family = configured.split("/")[0]!.toLowerCase();
  const all = ((await res.json()).data as Array<{ id: string }>)
    .map((m) => m.id)
    .sort();
  // A host that does not use vendor-prefixed ids leaves nothing to match on;
  // printing everything beats printing an empty list and implying no models.
  const ids = all.filter((id) => id.toLowerCase().includes(family));
  printIds(ids.length > 0 ? ids : all, configured);
}

async function listGeminiModels() {
  console.log(`\n${BOLD}Google${OFF} ${DIM}(finance)${OFF}`);
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return console.log(`  ${DIM}GEMINI_API_KEY not set, skipping${OFF}`);

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { headers: { "x-goog-api-key": key } },
  );
  if (!res.ok) {
    return console.log(`  ${RED}${res.status}${OFF} ${await res.text()}`);
  }

  const ids = ((await res.json()).models as Array<
    { name: string; supportedGenerationMethods?: string[] }
  >)
    .filter((m) => m.supportedGenerationMethods?.includes("streamGenerateContent"))
    // The API returns "models/gemini-x"; our config stores the bare id.
    .map((m) => m.name.replace(/^models\//, ""))
    .sort();
  printIds(ids, Deno.env.get("GEMINI_MODEL_ID") ?? "gemini-3.8-flash");
}

function printIds(ids: string[], configured: string) {
  for (const id of ids) {
    const mine = id === configured;
    console.log(`  ${mine ? `${GREEN}* ` : "  "}${id}${mine ? OFF : ""}`);
  }
  console.log(
    ids.includes(configured)
      ? `  ${GREEN}configured id "${configured}" exists${OFF}`
      : `  ${RED}configured id "${configured}" is NOT in this list${OFF}`,
  );
}

// --- one streamed answer ---------------------------------------------------

/**
 * Bypasses the classifier entirely — the point is to prove a provider works
 * before trusting anything upstream of it to choose that provider.
 *
 * Answer text and thinking are printed in different colours so it is obvious
 * whether the reasoning channel is actually producing anything, which is the
 * part most likely to be silently empty.
 */
async function ask(provider: Provider, prompt: string) {
  if (!hasCredential(provider)) {
    console.error(`${RED}No key configured for ${provider}.${OFF}`);
    Deno.exit(1);
  }

  // The compatible slot is not reachable through a category — Budget bypasses
  // the routing table entirely — so its route is built directly, not looked up.
  const route = provider === "compat"
    ? { ...routeFor("other", "n/a"), provider, modelId: standInModel(provider) }
    : routeFor(categoryServedBy(provider), "n/a");
  console.log(
    `${DIM}${provider} · ${route.modelId} · effort=${effort}${OFF}\n`,
  );

  const started = Date.now();
  const res = await openModelStream(route, effort, [
    { role: "user", content: prompt },
  ]);

  if (!res.ok || !res.body) {
    console.error(`${RED}HTTP ${res.status}${OFF}\n${await res.text()}`);
    Deno.exit(1);
  }

  let answer = "";
  let thinking = "";
  let firstByte = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n");
    buffer = events.pop() ?? "";

    for (const evt of events) {
      const trimmed = evt.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const reasoning = streamReasoning(provider, json);
      if (reasoning) {
        thinking += reasoning;
        await Deno.stdout.write(new TextEncoder().encode(CYAN + reasoning + OFF));
      }

      const delta = streamDelta(provider, json);
      if (delta) {
        if (!firstByte) firstByte = Date.now() - started;
        answer += delta;
        await Deno.stdout.write(new TextEncoder().encode(delta));
      }
    }
  }

  console.log(`\n\n${BOLD}--- result ---${OFF}`);
  report("answer text", answer.length > 0, `${answer.length} chars`);
  report(
    "thinking",
    thinking.length > 0,
    thinking.length > 0
      ? `${thinking.length} chars`
      : effort === "fast"
      ? "none — expected, Fast disables thinking"
      : "none — provider exposed no reasoning",
    // A silent reasoning channel is only a failure when we asked for one.
    effort === "fast",
  );
  console.log(`  first answer token after ${firstByte || "—"} ms`);
}

/** Which category routes to this provider, so `ask` reuses the real table. */
function categoryServedBy(provider: Provider): Category {
  const found = (["finance", "science", "coding", "healthcare", "other"] as Category[])
    .find((c) => routeFor(c, "n/a").provider === provider);
  if (!found) throw new Error(`No category routes to ${provider}`);
  return found;
}

function report(label: string, ok: boolean, detail: string, lenient = false) {
  const mark = ok ? `${GREEN}ok  ${OFF}` : lenient ? `${DIM}--  ${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark} ${label.padEnd(12)} ${DIM}${detail}${OFF}`);
}

// --- classification --------------------------------------------------------

async function classify(prompt: string, askTools: boolean, folderOpen: boolean) {
  const route = await classifyConversation(prompt, askTools, folderOpen);

  // A classifier that never ran reports "other" too. Saying so is the whole
  // point — otherwise a missing key reads as a bad prompt.
  if (!route.classified) {
    console.log(`  ${RED}classifier did not run${OFF} ${DIM}(see the error above)${OFF}`);
    return null;
  }

  // Both halves of the verdict, because they fail independently: a subject can
  // be right while the folder answer is wrong, and that is the interesting
  // failure — it is the one that decides whether anything runs.
  const wants = route.toolsWanted ? `${BOLD}+tools${OFF}` : `${DIM}no tools${OFF}`;
  console.log(
    `  ${BOLD}${route.category.padEnd(11)}${OFF}${wants.padEnd(16)} ${DIM}->${OFF} ` +
      `${route.provider} · ${route.modelId} ${DIM}(via ${route.classifierModelId})${OFF}`,
  );
  return { category: route.category, toolsWanted: route.toolsWanted };
}

/** Probes across both prompts, to see whether they actually split. */
async function smoke() {
  // Fail on the credential rather than spending four calls to discover it, and
  // name the variable that is missing.
  if (!hasCredential("openai") && !hasCredential("meta")) {
    console.error(
      `${RED}No classifier credential.${OFF} Export OPENAI_API_KEY ` +
        `${DIM}(or MODEL_API_KEY to exercise the Muse fallback)${OFF} and retry.`,
    );
    Deno.exit(2);
  }
  if (!hasCredential("openai")) {
    console.log(
      `${DIM}OPENAI_API_KEY not set — classifying with the Muse fallback, ` +
        `which is not what production will use.${OFF}`,
    );
  }

  console.log(
    `${DIM}Fast skips classification only when no folder is open, and then ` +
      `always uses ${FAST_MODEL_ID}. Every other turn asks two questions in ` +
      `one call: the subject, and whether it needs the user's files.${OFF}`,
  );

  // [subject, wants the folder?, prompt, where].
  //
  // Three groups, because there are three prompts and each fails differently.
  //
  //   plain  — no folder, Fast. The subject question alone, as it always was.
  //   folder — the desktop app with a folder open. Both directions matter: a
  //            request that needs files must come back +tools, and one that
  //            does not must survive the second question being asked at all.
  //            The second is the expensive mistake — every question becoming a
  //            command to approve.
  //   web    — the browser, on Thinking. Nothing can run, so a +tools verdict
  //            buys the reader the notice instead. Over-firing here is cheap
  //            but annoying; under-firing is the silent failure the notice
  //            exists to prevent, where a request to build a file is answered
  //            with a markdown table and no explanation.
  //
  // The subject must survive a +tools verdict, which is what this feature
  // changed: "build me a spreadsheet of invoices" is finance AND wants the
  // folder, and used to lose the first half entirely.
  type Where = "plain" | "folder" | "web";
  const probes: Array<[Category, boolean, string, Where]> = [
    ["finance", false, "Should I model this lease as debt under IFRS 16?", "plain"],
    ["coding", false, "My React effect fires twice in dev. Why?", "plain"],
    ["healthcare", false, "What does a raised ALT with normal bilirubin suggest?", "plain"],
    // Science against healthcare is the boundary worth probing: both are
    // "biology" to a classifier reading quickly, and they now route to
    // different labs, so a wrong verdict here is visible in the badge.
    ["science", false, "Why is the sky blue at noon and red at sunset?", "plain"],
    ["science", false, "How does CRISPR-Cas9 cut a specific DNA sequence?", "plain"],
    ["other", false, "Suggest a name for a border collie.", "plain"],

    ["finance", true, "Build me a spreadsheet of last quarter's invoices.", "folder"],
    ["other", true, "What's in this folder, and how big are the files?", "folder"],
    ["other", true, "Convert the deck in here to a PDF.", "folder"],
    ["coding", true, "Run the test suite in here and fix what fails.", "folder"],
    ["finance", false, "Should I model this lease as debt under IFRS 16?", "folder"],
    ["healthcare", false, "What does a raised ALT with normal bilirubin suggest?", "folder"],
    ["science", false, "Why is the sky blue at noon and red at sunset?", "folder"],
    ["other", false, "Suggest a name for a border collie.", "folder"],

    ["finance", true, "Build me a spreadsheet of last quarter's invoices.", "web"],
    ["coding", true, "Edit my config file to turn on strict mode.", "web"],
    ["coding", false, "Write me a Python script that renames files by date.", "web"],
    ["finance", false, "Should I model this lease as debt under IFRS 16?", "web"],
    ["science", false, "Why is the sky blue at noon and red at sunset?", "web"],
    ["other", false, "Suggest a name for a border collie.", "web"],
  ];

  let wrong = 0;
  let failed = 0;
  for (const [category, wantsTools, prompt, where] of probes) {
    const label = where === "plain" ? "" : ` ${DIM}[${where}]${OFF}`;
    console.log(`\n${DIM}${prompt}${OFF}${label}`);

    const got = await classify(prompt, where !== "plain", where === "folder");
    if (got === null) {
      failed++;
      continue;
    }

    const misrouted = got.category !== category;
    // "Write me a script" is the probe that matters most here: wanting code is
    // not the same as wanting it run, and a classifier that cannot tell them
    // apart puts a notice on every coding question in the browser.
    const misjudged = got.toolsWanted !== wantsTools;

    if (misrouted || misjudged) {
      wrong++;
      const parts = [
        misrouted ? `subject ${category}` : null,
        misjudged ? (wantsTools ? "should want the folder" : "should NOT want the folder") : null,
      ].filter(Boolean).join(", ");
      console.log(`  ${RED}expected ${parts}${OFF}`);
    }
  }

  // Two different verdicts, because they have two different fixes: a broken
  // classifier is a configuration problem, a misrouted probe is a prompt one.
  if (failed > 0) {
    console.log(
      `\n${RED}The classifier failed on ${failed} of ${probes.length} probes.${OFF} ` +
        `${DIM}This is a key or model-id problem, not a prompt problem — ` +
        `check CLASSIFIER_MODEL_ID against \`models\`.${OFF}`,
    );
  } else if (wrong > 0) {
    console.log(
      `\n${RED}${wrong} of ${probes.length} misrouted.${OFF} ` +
        `${DIM}The classifier ran and disagreed; adjust the prompt it used in ` +
        `providers.ts — plain probes use CLASSIFIER_PROMPT, [folder] ones use ` +
        `TOOL_CLASSIFIER_PROMPT, and [web] ones CAPABILITY_CLASSIFIER_PROMPT.${OFF}`,
    );
  } else {
    console.log(
      `\n${GREEN}All ${probes.length} probes routed as intended.${OFF}`,
    );
  }

  if (failed > 0 || wrong > 0) Deno.exit(1);
}

// --- dispatch --------------------------------------------------------------

const USAGE = `Usage:
  ./scripts/check-providers.ts models
  ./scripts/check-providers.ts ask <openai|google|anthropic|meta|compat> "<prompt>"
  ./scripts/check-providers.ts classify "<prompt>" [--folder|--web]
  ./scripts/check-providers.ts smoke

  --effort fast|medium|max   (default fast)
  --folder                   also ask whether the turn needs the open folder
  --web                      the same question where there is no folder`;

switch (command) {
  case "models":
    await listModels();
    break;
  case "ask": {
    const [provider, ...words] = rest;
    const prompt = words.join(" ");
    if (!provider || !prompt) {
      console.error(USAGE);
      Deno.exit(2);
    }
    await ask(provider as Provider, prompt);
    break;
  }
  case "classify": {
    // A trailing --folder or --web asks the second question too, the way the
    // desktop app and the browser respectively ask it. Bare, this stays the
    // one-word subject call that Fast makes.
    const flags = new Set(rest.filter((word) => word.startsWith("--")));
    const prompt = rest.filter((word) => !word.startsWith("--")).join(" ");
    if (prompt.length === 0) {
      console.error(USAGE);
      Deno.exit(2);
    }
    const folder = flags.has("--folder");
    await classify(prompt, folder || flags.has("--web"), folder);
    break;
  }
  case "smoke":
    await smoke();
    break;
  default:
    console.error(USAGE);
    Deno.exit(2);
}
