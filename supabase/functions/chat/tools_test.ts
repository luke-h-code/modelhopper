/**
 * `deno test --allow-env supabase/functions/chat/tools_test.ts`
 *
 * No `--allow-net`: none of this should ever reach a network, and the absence
 * of the flag is what proves it.
 *
 * The events replayed below are the shape Anthropic actually streams for a
 * tool call — a text block, then a tool block whose arguments arrive as
 * fragments of JSON. Getting that assembly wrong is the single most likely bug
 * in this feature, and it fails in the worst possible way: a half-parsed
 * command reaching an approval dialog.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  capEffort,
  connectDeadline,
  degradedNotice,
  dropOrphanedToolResults,
  failoverChain,
  flattenToolBlocks,
  hasToolBlocks,
  failoverNotice,
  fallbackRoute,
  grantTools,
  parseVerdict,
  providerForModelId,
  resolveRoute,
  routeFor,
  routeForModelId,
  TOOLS,
  assistantBlocks,
  toAnthropicContent,
  toGeminiParts,
  toolGapNotice,
  toolGapOf,
  toolGapSystemPrompt,
  toOpenAIMessages,
  toolRoute,
  toolSystemPrompt,
  usageFromPayload,
  usageMeter,
} from "./providers.ts";

/** One tool call, streamed the way the API sends it. */
const CALL_EVENTS: Array<Record<string, unknown>> = [
  { type: "message_start" },
  // A text block first, which is the normal case: the model says what it is
  // about to do before asking to do it.
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Let me look at the folder." },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_01ABC", name: "list_dir", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"pa' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'th": "rep' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'orts"}' },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
];

function replay(events: Array<Record<string, unknown>>) {
  const assembler = assistantBlocks("anthropic");
  for (const event of events) assembler.accept(event);
  return assembler.toolCall();
}

function replayBlocks(events: Array<Record<string, unknown>>) {
  const assembler = assistantBlocks("anthropic");
  for (const event of events) assembler.accept(event);
  return assembler.blocks();
}

Deno.test("a streamed call is assembled from its fragments", () => {
  const call = replay(CALL_EVENTS);

  assertEquals(call?.id, "toolu_01ABC");
  assertEquals(call?.name, "list_dir");
  assertEquals(call?.input, { path: "reports" });
});

Deno.test("a thinking block comes back whole, signature included", () => {
  // The bug this exists to prevent: dropping thinking made the SECOND tool
  // call in a turn fail with a 400, because Anthropic requires the assistant
  // message to be echoed complete and unmodified alongside the tool result.
  const blocks = replayBlocks([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "The folder may already " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hold a model." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "BDaL4Vrb" },
    },
    { type: "content_block_stop", index: 0 },
    ...CALL_EVENTS.slice(1),
  ]);

  assertEquals(blocks[0], {
    type: "thinking",
    thinking: "The folder may already hold a model.",
    signature: "BDaL4Vrb",
  });
  // Order is preserved: thinking, then text, then the call.
  assertEquals(blocks.map((block) => block.type), [
    "thinking",
    "text",
    "tool_use",
  ]);
});

Deno.test("the assistant's text survives alongside the call", () => {
  const blocks = replayBlocks(CALL_EVENTS);
  assertEquals(blocks.map((block) => block.type), ["text", "tool_use"]);
  assertEquals(blocks[0]!.text, "Let me look at the folder.");
});

Deno.test("a reply with no call assembles nothing", () => {
  // The text block closes with content_block_stop exactly as the tool block
  // does. Treating that as the end of a call would invent one out of an
  // ordinary answer — and put a dialog in front of the user for a command
  // the model never asked for.
  const call = replay(CALL_EVENTS.slice(0, 4));
  assertEquals(call, null);
});

Deno.test("a call truncated mid-arguments still surfaces, with empty input", () => {
  // A reply cut off by the wall clock can stop between fragments. Better a
  // gate the user can deny than a turn that ends in silence.
  const truncated = [...CALL_EVENTS.slice(0, 7), { type: "content_block_stop", index: 1 }];
  const call = replay(truncated);

  assertEquals(call?.name, "list_dir");
  assertEquals(call?.input, {});
});

Deno.test("a call carrying no arguments at all is still a call", () => {
  const call = replay([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_02", name: "list_dir", input: {} },
    },
    { type: "content_block_stop", index: 0 },
  ]);

  assertEquals(call?.id, "toolu_02");
  assertEquals(call?.input, {});
});

Deno.test("a provider ignores another provider's stream", () => {
  // Each assembler reads one dialect and nothing else. Anthropic's events
  // through Gemini's reader must produce no call at all — inventing one from a
  // shape it does not understand would put a half-read command in front of the
  // user.
  for (const provider of ["google", "openai", "meta"] as const) {
    const assembler = assistantBlocks(provider);
    for (const event of CALL_EVENTS) assembler.accept(event);
    assertEquals(assembler.toolCall(), null, provider);
    assertEquals(assembler.blocks(), [], provider);
  }
});

Deno.test("the continuation fallback still names a real provider", () => {
  // Only reached when a loop is under way whose model id we cannot place — a
  // renamed secret, usually. Anthropic because a loop that lost its model has
  // to continue somewhere, and this is the dialect with the longest service.
  const route = toolRoute();
  assertEquals(route.provider, "anthropic");
  assertEquals(route.category, "tools");
  assertEquals(route.needsTools, true);
  assertEquals(route.classified, false);
});

Deno.test("a route is never born holding tools", () => {
  // Wanting the folder and being given it are separate facts, and only the
  // Edge Function knows whether there is a folder. A route that granted itself
  // tools would hand them to a web turn, which has nothing to run them on.
  for (const category of ["finance", "science", "coding", "healthcare", "other"] as const) {
    assertEquals(routeFor(category, "c").needsTools, false, category);
    assertEquals(routeFor(category, "c", true, true).needsTools, false, category);
    // The want is still recorded, which is what produces the notice.
    assertEquals(routeFor(category, "c", true, true).toolsWanted, true, category);
  }

  // No credential means no tools anywhere, so a fallback must not claim it
  // wants them — the provider it lands on would reject the declaration.
  assertEquals(fallbackRoute("c").needsTools, false);
});

Deno.test("the subject survives a turn that wants the folder", () => {
  // The bug this replaces: "tools" used to be a fifth category, so a request
  // to chart a portfolio stopped being finance and went to Anthropic like
  // every other tool turn. Subject and folder are now answered separately.
  const route = grantTools(routeFor("finance", "c", true, true));
  assertEquals(route.category, "finance");
  assertEquals(route.provider, "google");
  assertEquals(route.needsTools, true);

  const health = grantTools(routeFor("healthcare", "c", true, true));
  assertEquals(health.provider, "anthropic");
  assertEquals(health.needsTools, true);
});

Deno.test("a continuation keeps the tools it was opened with", () => {
  // Every leg re-declares them. A second call is refused otherwise, which is
  // indistinguishable from the model deciding it was finished.
  assertEquals(routeForModelId("claude-opus-5")?.needsTools, true);
});

Deno.test("a loop continues on the model that opened it", () => {
  // A tool_use from one provider cannot be answered by another, so the
  // continuation must never be classified.
  assertEquals(routeForModelId("claude-opus-5")?.provider, "anthropic");
  assertEquals(routeForModelId("gemini-3.8-flash")?.provider, "google");
  assertEquals(routeForModelId("muse-spark-1.3")?.provider, "meta");
  assertEquals(routeForModelId("gpt-5.6-luna")?.provider, "openai");
  assertEquals(routeForModelId("something-else"), null);
  assertEquals(providerForModelId("claude-opus-5"), "anthropic");
});

Deno.test("the tool schemas are ones the API will accept", () => {
  assertEquals(TOOLS.map((tool) => tool.name), ["run_command", "list_dir"]);

  for (const tool of TOOLS) {
    assertEquals(tool.input_schema.type, "object");
    // A description is not decoration — it is how the model decides whether
    // the tool applies at all.
    assertEquals(tool.description.length > 40, true);
  }

  const run = TOOLS[0]!;
  // `purpose` is required so the approval gate always has a headline written
  // for the person deciding, rather than a bare command.
  assertEquals(run.input_schema.required, ["command", "purpose"]);
});

Deno.test("the prompt names the interpreter by absolute path", () => {
  // A spawned process inherits the app's PATH, not the user's shell's, so
  // bare `python3` can find an interpreter with none of these libraries.
  const prompt = toolSystemPrompt("/Users/x/Documents", "macOS", {
    python: "/opt/anaconda3/bin/python3",
    python_version: "Python 3.13.5",
    libraries: ["openpyxl", "pandas"],
  });

  assertEquals(prompt.includes("/opt/anaconda3/bin/python3"), true);
  assertEquals(prompt.includes("Python 3.13.5"), true);
  assertEquals(prompt.includes("openpyxl, pandas"), true);
  assertEquals(prompt.includes("not as"), true);
});

Deno.test("with nothing installed the prompt says so rather than staying quiet", () => {
  const bare = toolSystemPrompt("/tmp/work", "Linux", {
    python: "/usr/bin/python3",
    libraries: [],
  });
  assertEquals(bare.includes("No document libraries are installed"), true);

  const none = toolSystemPrompt("/tmp/work", "Linux", {});
  assertEquals(none.includes("No Python interpreter was found"), true);
});

Deno.test("the system prompt names the folder and the platform", () => {
  const prompt = toolSystemPrompt("/Users/x/Documents", "macOS");
  assertEquals(prompt.includes("/Users/x/Documents"), true);
  assertEquals(prompt.includes("macOS"), true);
  // The model has to know a person is between it and the machine.
  assertEquals(prompt.includes("approved before it runs"), true);
});

// --- the other three dialects ----------------------------------------------
//
// Anthropic was the only provider that could call a tool. These are the three
// that could not, replayed in the shape each actually streams. The failure
// mode is the same one the Anthropic fixtures above guard against — a call
// assembled wrongly reaches a person as a command to approve — so each gets
// the same treatment rather than a smoke test.

/** OpenAI and Meta: a call spread across deltas, keyed by index not by id. */
const OPENAI_CALL_EVENTS: Array<Record<string, unknown>> = [
  { choices: [{ delta: { role: "assistant", content: "" } }] },
  { choices: [{ delta: { content: "Let me look at the folder." } }] },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_abc123",
          type: "function",
          function: { name: "list_dir", arguments: "" },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
    }],
  },
  {
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "rep' } }] },
    }],
  },
  {
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: 'orts"}' } }] },
    }],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

function replayWith(
  provider: "openai" | "meta" | "google",
  events: Array<Record<string, unknown>>,
) {
  const assembler = assistantBlocks(provider);
  for (const event of events) assembler.accept(event);
  return assembler;
}

Deno.test("an OpenAI-format call is assembled from its fragments", () => {
  const assembler = replayWith("openai", OPENAI_CALL_EVENTS);
  const call = assembler.toolCall();

  assertEquals(call?.id, "call_abc123");
  assertEquals(call?.name, "list_dir");
  // The id and the name arrive once, on the first fragment; every later one
  // carries only more argument text. Keying on index is what joins them.
  assertEquals(call?.input, { path: "reports" });
  assertEquals(assembler.blocks().map((b) => b.type), ["text", "tool_use"]);
});

Deno.test("Meta reads the same dialect as OpenAI", () => {
  // They share a wire format, so they share an assembler. If that ever stops
  // being true this is where it shows.
  assertEquals(
    replayWith("meta", OPENAI_CALL_EVENTS).toolCall()?.input,
    { path: "reports" },
  );
});

Deno.test("an OpenAI call with no id still surfaces", () => {
  // A result has to name the call it answers, so a call with no id cannot be
  // answered. Inventing one keeps the gate — and the user's refusal — rather
  // than dropping the turn on the floor.
  const call = replayWith("openai", [
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { name: "list_dir", arguments: "{}" } }],
        },
      }],
    },
  ]).toolCall();

  assertEquals(call?.id, "call_0");
  assertEquals(call?.name, "list_dir");
});

Deno.test("an ordinary OpenAI reply assembles no call", () => {
  const assembler = replayWith("openai", OPENAI_CALL_EVENTS.slice(0, 2));
  assertEquals(assembler.toolCall(), null);
  assertEquals(assembler.blocks(), [{
    type: "text",
    text: "Let me look at the folder.",
  }]);
});

/** Gemini: args arrive whole, and no id is sent at all. */
const GEMINI_CALL_EVENTS: Array<Record<string, unknown>> = [
  {
    candidates: [{
      content: {
        parts: [{ text: "Deciding what to read.", thought: true }],
      },
    }],
  },
  {
    candidates: [{ content: { parts: [{ text: "Let me look at the folder." }] } }],
  },
  {
    candidates: [{
      content: {
        parts: [{
          functionCall: { name: "list_dir", args: { path: "reports" } },
          thoughtSignature: "Cs8BAd",
        }],
      },
    }],
  },
];

Deno.test("a Gemini call is assembled, and given an id it never sent", () => {
  const assembler = replayWith("google", GEMINI_CALL_EVENTS);
  const call = assembler.toolCall();

  assertEquals(call?.name, "list_dir");
  assertEquals(call?.input, { path: "reports" });
  // Gemini sends no id and the whole loop is keyed on one: the approval gate,
  // the stored result, and the check that a client cannot answer a call the
  // model never made.
  assertEquals(typeof call?.id, "string");
  assertEquals(call!.id.length > 0, true);
});

Deno.test("two Gemini legs do not invent the same call id", () => {
  // Each leg of a loop is a separate request and so a separate assembler. A
  // counter alone restarts at 1 every time, which gave a six-leg loop six
  // calls all called "gemcall_1". Nothing rejected it — a result is validated
  // against its own parent message — and the stored thread became unreadable.
  const first = replayWith("google", GEMINI_CALL_EVENTS).toolCall();
  const second = replayWith("google", GEMINI_CALL_EVENTS).toolCall();

  assertEquals(first?.id === second?.id, false);
});

Deno.test("a Gemini thought signature is kept, and its thoughts are not", () => {
  const blocks = replayWith("google", GEMINI_CALL_EVENTS).blocks();

  // Thought summaries are shown live and dropped; only the answer is stored.
  assertEquals(blocks.map((b) => b.type), ["text", "tool_use"]);
  assertEquals(blocks[0]!.text, "Let me look at the folder.");
  // The signature rides back with the call it belongs to, the same way an
  // Anthropic thinking signature does.
  assertEquals(blocks[1]!.thought_signature, "Cs8BAd");
});

// --- sending a loop back out ------------------------------------------------
//
// Everything is STORED in Anthropic's shape whatever produced it, so these
// converters are the second half of each dialect. A call that assembles
// correctly and converts wrongly fails on the leg after the first, which is
// exactly how the reasoning bug in the README was found.

/** One stored assistant turn that called a tool, and the result answering it. */
const STORED_CALL = [
  { type: "text", text: "Looking now." },
  { type: "tool_use", id: "call_abc123", name: "list_dir", input: { path: "." } },
];
const STORED_RESULT = [{
  type: "tool_result",
  tool_use_id: "call_abc123",
  name: "list_dir",
  content: "report.xlsx",
  is_error: false,
}];

Deno.test("OpenAI gets a tool result as its own role, not as a user message", () => {
  // `{role:"user"}` holding a result is rejected: the format has a dedicated
  // role, and a call followed by anything else breaks the conversation.
  const wire = toOpenAIMessages([
    { role: "user", content: "what is in the folder?" },
    { role: "assistant", content: STORED_CALL },
    { role: "user", content: STORED_RESULT },
  ]);

  assertEquals(wire.map((m) => m.role), ["user", "assistant", "tool"]);

  const call = wire[1] as { content: unknown; tool_calls: Array<Record<string, unknown>> };
  assertEquals(call.content, "Looking now.");
  assertEquals(call.tool_calls[0]!.id, "call_abc123");
  // Arguments go back as JSON text, not as the object everything in between
  // was holding.
  assertEquals(
    (call.tool_calls[0]!.function as { arguments: string }).arguments,
    '{"path":"."}',
  );

  assertEquals(wire[2]!.tool_call_id, "call_abc123");
  assertEquals(wire[2]!.content, "report.xlsx");
});

Deno.test("an OpenAI call that said nothing sends null, not an empty string", () => {
  // A model often calls a tool without saying anything first. Some endpoints
  // reject `content: ""` alongside tool_calls.
  const wire = toOpenAIMessages([
    { role: "assistant", content: [STORED_CALL[1]!] },
  ]);
  assertEquals(wire[0]!.content, null);
});

Deno.test("Gemini answers a call by name, because it has no id to answer", () => {
  const call = toGeminiParts(STORED_CALL);
  assertEquals(call[1], {
    functionCall: { name: "list_dir", args: { path: "." } },
  });

  const result = toGeminiParts(STORED_RESULT);
  assertEquals(result, [{
    functionResponse: {
      name: "list_dir",
      response: { output: "report.xlsx" },
    },
  }]);
});

Deno.test("a Gemini result with no name is dropped rather than mis-sent", () => {
  // Rows stored before the name was recorded, from a loop that only Anthropic
  // could have run. Gemini cannot address them, and a functionResponse naming
  // nothing is a 400 that takes the whole turn with it.
  const legacy = toGeminiParts([{
    type: "tool_result",
    tool_use_id: "toolu_01",
    content: "report.xlsx",
  }]);
  assertEquals(legacy, []);
});

Deno.test("Anthropic never sees the fields the other two needed", () => {
  // `name` on a result is for Gemini and `thought_signature` is for Gemini's
  // calls. Anthropic matches on id and rejects unknown fields on the way in.
  const [result] = toAnthropicContent(STORED_RESULT) as Array<Record<string, unknown>>;
  assertEquals(result!.name, undefined);
  assertEquals(result!.tool_use_id, "call_abc123");
  assertEquals(result!.content, "report.xlsx");
});

// --- the two-part verdict ---------------------------------------------------

Deno.test("the classifier's two words are read as subject and folder", () => {
  assertEquals(parseVerdict("coding yes", true), {
    category: "coding",
    toolsWanted: true,
  });
  assertEquals(parseVerdict("finance no", true), {
    category: "finance",
    toolsWanted: false,
  });
  // Case and stray punctuation are the ordinary failure, not the interesting
  // one.
  assertEquals(parseVerdict("  Other YES.\n", true), {
    category: "other",
    toolsWanted: true,
  });
});

Deno.test("the folder answer is only read after the subject", () => {
  // "no" appears inside no subject, but a model that answers in a sentence
  // puts words on both sides. Reading the whole reply would let the subject's
  // own description decide the folder question.
  assertEquals(parseVerdict("Subject: coding. Needs the folder: yes.", true).toolsWanted, true);
  assertEquals(parseVerdict("coding — no, this is just an explanation", true).toolsWanted, false);
});

Deno.test("an ambiguous folder answer is read as no", () => {
  // A missed notice is a turn answered in prose, which is what happened before
  // any of this existed. A spurious one interrupts an ordinary question with a
  // warning about a feature the reader never asked for.
  assertEquals(parseVerdict("coding", true).toolsWanted, false);
  assertEquals(parseVerdict("coding yes no", true).toolsWanted, false);
  assertEquals(parseVerdict("", true).toolsWanted, false);
  // An unrecognised subject is "other" — the model read it and matched none.
  assertEquals(parseVerdict("banana yes", true).category, "other");
});

Deno.test("the folder question is not read when it was not asked", () => {
  // A one-word prompt is still used where the answer cannot matter: Fast with
  // no folder never asks, and must never be handed a stray yes.
  assertEquals(parseVerdict("coding", false).toolsWanted, false);
  assertEquals(parseVerdict("coding yes", false).toolsWanted, false);
});

// --- the notice -------------------------------------------------------------

Deno.test("a turn that wanted the folder and got it has nothing to report", () => {
  const granted = grantTools(routeFor("coding", "c", true, true));
  assertEquals(toolGapOf(granted, true), null);

  // And a turn that never wanted it is not told about a feature it did not ask
  // for, on either kind of device.
  const ordinary = routeFor("coding", "c");
  assertEquals(toolGapOf(ordinary, true), null);
  assertEquals(toolGapOf(ordinary, false), null);
});

Deno.test("the gap says which device the reader is actually on", () => {
  const wanted = routeFor("coding", "c", true, true);

  // A browser: no folder now and none later.
  assertEquals(toolGapOf(wanted, false), "platform");
  // The desktop app with nothing open: one click from working.
  assertEquals(toolGapOf(wanted, true), "no-folder");
});

Deno.test("the notice tells a desktop reader something they can act on", () => {
  const platform = toolGapNotice("platform");
  const noFolder = toolGapNotice("no-folder");

  assertEquals(platform === noFolder, false);
  // Telling someone already using the desktop app to go and get the desktop
  // app is the mistake this pair exists to prevent.
  assertEquals(platform.includes("desktop"), true);
  assertEquals(noFolder.includes("desktop app"), false);
  assertEquals(noFolder.includes("folder"), true);
});

Deno.test("the model is told the same thing the reader was", () => {
  for (const gap of ["platform", "no-folder"] as const) {
    const prompt = toolGapSystemPrompt(gap);
    // Without this the reply contradicts the notice directly above it.
    assertEquals(prompt.includes("no tools"), true);
    assertEquals(prompt.includes("ALREADY been shown"), true);
    // The reply is still supposed to be useful, not an apology.
    assertEquals(prompt.includes("inline"), true);
  }
});

// --- what a turn cost -------------------------------------------------------
//
// These numbers decide whether someone is locked out of the app, so the
// failure mode is worse than a wrong chart: under-count and an allowance never
// runs out, over-count and it runs out early with no way for the user to see
// why. Every provider reports usage at a different moment and under a
// different name, and two of them report nothing at all unless asked.

Deno.test("Anthropic usage is taken from two different events", () => {
  // Input lands once, on message_start, nested inside `message`. Output lands
  // on message_delta and grows until the stream ends.
  const meter = usageMeter("anthropic");
  meter.accept({
    type: "message_start",
    message: { usage: { input_tokens: 1200, output_tokens: 1 } },
  });
  meter.accept({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } });
  meter.accept({ type: "message_delta", usage: { output_tokens: 340 } });

  assertEquals(meter.read(), { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 340 });
});

Deno.test("Gemini bills its thinking as output", () => {
  // thoughtsTokenCount is reported separately from candidatesTokenCount and is
  // charged as output. Dropping it costs a thinking turn most of its price.
  const meter = usageMeter("google");
  meter.accept({
    usageMetadata: {
      promptTokenCount: 900,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 1500,
    },
  });

  assertEquals(meter.read(), { inputTokens: 900, cachedInputTokens: 0, outputTokens: 1700 });
});

Deno.test("a repeated running total is not added up", () => {
  // Gemini repeats a growing total on every chunk. Summing them would bill a
  // fifty-chunk reply fifty times over.
  const meter = usageMeter("google");
  for (const candidates of [50, 120, 300]) {
    meter.accept({
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: candidates },
    });
  }

  assertEquals(meter.read(), { inputTokens: 900, cachedInputTokens: 0, outputTokens: 300 });
});

Deno.test("the OpenAI format reports once, at the end", () => {
  const meter = usageMeter("openai");
  meter.accept({ choices: [{ delta: { content: "working" } }] });
  assertEquals(meter.read(), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

  // The final chunk carries no choices at all, only the summary — and only
  // because the request set stream_options.include_usage.
  meter.accept({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 95 } });
  assertEquals(meter.read(), { inputTokens: 800, cachedInputTokens: 0, outputTokens: 95 });
});

Deno.test("Meta reads the same usage shape as OpenAI", () => {
  const meter = usageMeter("meta");
  meter.accept({ usage: { prompt_tokens: 10, completion_tokens: 20 } });
  assertEquals(meter.read(), { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 });
});

Deno.test("a stream that reported nothing is billed nothing", () => {
  // Every provider, given a stream carrying no usage at all. Zero here means
  // the row is skipped entirely rather than written as a free turn, so a
  // provider that changes its format shows up as missing rows rather than as
  // silently wrong money.
  for (const provider of ["anthropic", "google", "openai", "meta"] as const) {
    const meter = usageMeter(provider);
    meter.accept({ type: "content_block_delta", delta: { text: "x" } });
    meter.accept({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
    assertEquals(meter.read(), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, provider);
  }
});

Deno.test("the classifier's own call is measured too", () => {
  // Small per turn, not small in aggregate: every Thinking turn pays it, and a
  // turn that routes to tools pays it before any of twenty legs.
  assertEquals(
    usageFromPayload({ usage: { prompt_tokens: 420, completion_tokens: 3 } }),
    { inputTokens: 420, cachedInputTokens: 0, outputTokens: 3 },
  );
  // A provider that returns no usage block must read as zero, not NaN — a NaN
  // cost fails the column's check constraint and loses the row.
  assertEquals(usageFromPayload({}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  assertEquals(usageFromPayload(null), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
});

// --- the cache ---------------------------------------------------------------
//
// A tool loop resends the whole history on every leg, so a twenty-leg turn is
// one growing prefix repeated twenty times — exactly what an implicit cache
// absorbs. Billing those repeats at the full rate over-stated a real Gemini run
// by about three times against Google's own dashboard, which is how this was
// found. The providers disagree about whether cached tokens are inside the
// prompt total, and getting that backwards is a silent 2x in either direction.

Deno.test("Gemini's cached tokens come OUT of the prompt total", () => {
  // promptTokenCount includes the cached ones. Counting both would bill the
  // cached share twice: once in full and once at the cached rate.
  const meter = usageMeter("google");
  meter.accept({
    usageMetadata: {
      promptTokenCount: 20_000,
      cachedContentTokenCount: 17_000,
      candidatesTokenCount: 800,
    },
  });

  assertEquals(meter.read(), {
    inputTokens: 3_000,
    cachedInputTokens: 17_000,
    outputTokens: 800,
  });
});

Deno.test("Anthropic's cached tokens are ALREADY outside the prompt total", () => {
  // The opposite convention: input_tokens excludes cache reads, which arrive
  // as their own field. Subtracting here — as Gemini needs — would discount
  // the turn twice over.
  const meter = usageMeter("anthropic");
  meter.accept({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 3_000,
        cache_read_input_tokens: 17_000,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  meter.accept({ type: "message_delta", usage: { output_tokens: 800 } });

  assertEquals(meter.read(), {
    inputTokens: 3_000,
    cachedInputTokens: 17_000,
    outputTokens: 800,
  });
});

Deno.test("Anthropic's cache writes are charged at the full rate", () => {
  // Creating a cache entry costs 1.25x input — above full rate, not below — so
  // it is folded in with full-rate input rather than with the discount.
  const meter = usageMeter("anthropic");
  meter.accept({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 1_000,
        cache_creation_input_tokens: 4_000,
        cache_read_input_tokens: 0,
        output_tokens: 10,
      },
    },
  });

  assertEquals(meter.read().inputTokens, 5_000);
  assertEquals(meter.read().cachedInputTokens, 0);
});

Deno.test("the OpenAI format nests its cache count a level down", () => {
  const meter = usageMeter("openai");
  meter.accept({
    choices: [],
    usage: {
      prompt_tokens: 12_000,
      prompt_tokens_details: { cached_tokens: 9_600 },
      completion_tokens: 300,
    },
  });

  assertEquals(meter.read(), {
    inputTokens: 2_400,
    cachedInputTokens: 9_600,
    outputTokens: 300,
  });
});

Deno.test("a cache count larger than the prompt total cannot go negative", () => {
  // Defensive: a provider reporting these inconsistently would otherwise
  // produce a negative token count, and a negative cost fails the column's
  // check constraint and loses the whole row.
  const meter = usageMeter("google");
  meter.accept({
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 500,
      candidatesTokenCount: 10,
    },
  });

  assertEquals(meter.read().inputTokens, 0);
});

Deno.test("a provider that reports no cache is simply uncached", () => {
  // The common case, and the one that must not regress: no cache fields at all
  // means every input token is charged in full, exactly as before.
  const meter = usageMeter("google");
  meter.accept({
    usageMetadata: { promptTokenCount: 5_000, candidatesTokenCount: 200 },
  });

  assertEquals(meter.read(), {
    inputTokens: 5_000,
    cachedInputTokens: 0,
    outputTokens: 200,
  });
});

// --- failing over ------------------------------------------------------------
//
// A provider that will not answer is not a reason to refuse the turn. Rate
// limits fail over like outages do: somewhere with capacity answering is
// better for the reader than a refusal, and the count of them is what makes
// "ask for a higher limit" a request with a number attached.

/**
 * Run with provider keys present.
 *
 * failoverChain skips providers with no credential, so without this every
 * chain is one entry long and the tests below pass while proving nothing —
 * which is exactly what they did when first written.
 */
function withCredentials(body: () => void): void {
  const keys = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "MODEL_API_KEY",
    "OPENAI_API_KEY",
    "COMPAT_API_KEY",
  ];
  const before = keys.map((key) => [key, Deno.env.get(key)] as const);
  for (const key of keys) Deno.env.set(key, "test-key");
  try {
    body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("a chain is only built from providers we hold a key for", () => {
  // Trying a provider with no credential spends a round trip to be told so,
  // and the reader is watching a spinner throughout.
  const keys = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MODEL_API_KEY", "OPENAI_API_KEY"];
  for (const key of keys) Deno.env.delete(key);
  assertEquals(failoverChain(routeFor("finance", "c")).length, 1);

  withCredentials(() => {
    assertEquals(failoverChain(routeFor("finance", "c")).length, 3);
  });
});

Deno.test("the chain starts with the route that was chosen", () => {
  // The first choice is still the first attempt. Failover is what happens when
  // it will not answer, not a load-balancer.
  const chain = failoverChain(routeFor("finance", "c"));
  assertEquals(chain[0]!.provider, "google");
  assertEquals(chain[0]!.modelId, "gemini-3.8-flash");
});

Deno.test("a stand-in keeps the subject it is standing in for", () => {
  // The turn is still a finance question when Muse answers it, and the route
  // log should say so rather than pretending it was always an `other`.
  withCredentials(() => {
    const chain = failoverChain(routeFor("finance", "c"));
    assertEquals(chain.length > 1, true, "needs stand-ins to be a real test");
    for (const route of chain) {
      assertEquals(route.category, "finance", route.provider);
    }
  });
});

Deno.test("a stand-in is not recorded as a classifier verdict", () => {
  // `classified` means "a classifier chose this". A stand-in was chosen by a
  // failure, and reading the log later that difference is the diagnosis.
  withCredentials(() => {
    const chain = failoverChain(routeFor("coding", "c"));
    assertEquals(chain.length > 1, true, "needs stand-ins to be a real test");
    for (const route of chain.slice(1)) {
      assertEquals(route.classified, false, route.provider);
    }
  });
});

Deno.test("the chain never tries the same provider twice", () => {
  withCredentials(() => {
    for (const category of ["finance", "science", "coding", "healthcare", "other"] as const) {
      const chain = failoverChain(routeFor(category, "c"));
      assertEquals(chain.length > 1, true, category);
      const seen = new Set(chain.map((route) => route.provider));
      assertEquals(seen.size, chain.length, category);
    }
  });
});

Deno.test("the chain is capped", () => {
  // Each attempt is a round trip while somebody watches a spinner. A chain
  // long enough to try everything is indistinguishable from a hang.
  withCredentials(() => {
    for (const category of ["finance", "science", "coding", "healthcare", "other"] as const) {
      assertEquals(failoverChain(routeFor(category, "c")).length <= 3, true, category);
    }
  });
});

Deno.test("a stand-in carries the tools the original was granted", () => {
  // A tools turn that fails over must still be able to run something —
  // otherwise the folder silently stops working whenever a provider blips.
  withCredentials(() => {
    const granted = grantTools(routeFor("coding", "c", true, true));
    const chain = failoverChain(granted);
    assertEquals(chain.length > 1, true, "needs stand-ins to be a real test");
    for (const route of chain) {
      assertEquals(route.needsTools, true, route.provider);
    }
  });
});

Deno.test("the notice says which model was unavailable, not just that one was", () => {
  // "Something went wrong" is what the reader would have assumed anyway. The
  // useful part is which model they did not get, so an answer that reads oddly
  // for the subject has an explanation attached.
  const busy = failoverNotice("anthropic", "rate_limit", "muse-spark-1.3");
  assertEquals(busy.includes("anthropic"), true);
  assertEquals(busy.includes("muse-spark-1.3"), true);
  assertEquals(busy.includes("busy"), true);

  // A rate limit and an outage read differently, because to the reader they
  // mean different things about whether retrying will help.
  const down = failoverNotice("anthropic", "error", "muse-spark-1.3");
  assertEquals(down.includes("busy"), false);
  assertEquals(failoverNotice("google", "timeout", "muse-spark-1.3").includes("in time"), true);
});

Deno.test("the connect deadline stops applying once it is cleared", async () => {
  // The bug this guards: `AbortSignal.timeout()` cannot be switched off. It
  // fires on a wall clock from creation, and a signal handed to fetch stays
  // attached to the RESPONSE BODY — so using one as a connect timeout silently
  // made it a hard cap on the whole turn, aborting replies that were streaming
  // perfectly well. Short tool legs hid it: each leg is a fresh fetch with a
  // fresh deadline, so only long single answers died.
  //
  // Written against the signal rather than against fetch so the suite stays
  // off the network. The property that matters is the one AbortSignal.timeout
  // does not have: clear() has to make it inert.
  const past = connectDeadline(5);
  past.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assertEquals(past.signal.aborted, false, "cleared deadline still fired");

  // And it still fires when it is NOT cleared, or failover never triggers.
  const kept = connectDeadline(5);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assertEquals(kept.signal.aborted, true, "uncleared deadline never fired");
  // Classified as a timeout rather than an error, which is what decides the
  // reason recorded against the route.
  assertEquals((kept.signal.reason as DOMException).name, "TimeoutError");
});

// --- a thread that cannot be sent should degrade, not die -------------------

/** A tool loop as it is STORED: Anthropic's shape, whoever produced it. */
const STORED_LOOP = [
  {
    role: "user" as const,
    content: "what is in this folder?",
  },
  {
    role: "assistant" as const,
    content: [
      { type: "thinking", thinking: "I should look.", signature: "sig" },
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_1", name: "list_dir", input: { path: "." } },
    ],
  },
  {
    role: "user" as const,
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        name: "list_dir",
        content: "a.txt\nb.txt",
        is_error: false,
      },
    ],
  },
];

Deno.test("flattening keeps what the loop found and drops what providers validate", () => {
  assertEquals(hasToolBlocks(STORED_LOOP), true);

  const flat = flattenToolBlocks(STORED_LOOP);
  assertEquals(hasToolBlocks(flat), false, "still carries blocks to reject");
  assertEquals(flat.length, STORED_LOOP.length, "no turn may be lost");

  // The plain message is untouched — flattening is not a rewrite of the chat.
  assertEquals(flat[0]!.content, "what is in this folder?");

  const assistant = flat[1]!.content as string;
  assertEquals(typeof assistant, "string");
  assertEquals(assistant.includes("Let me look."), true, "said text survives");
  assertEquals(assistant.includes("list_dir"), true, "the call survives");
  // Thinking is dropped, not flattened: it is only ever sent back to prove a
  // tool call is intact, which is exactly what is being given up.
  assertEquals(assistant.includes("I should look."), false);
  assertEquals(assistant.includes("sig"), false);

  // The output is the whole point of keeping any of it.
  const result = flat[2]!.content as string;
  assertEquals(result.includes("a.txt"), true);
  assertEquals(result.includes("b.txt"), true);
  assertEquals(result.includes("list_dir"), true);

  // Roles are preserved, or the conversation stops alternating and is rejected
  // for a completely different reason.
  assertEquals(flat.map((m) => m.role), ["user", "assistant", "user"]);
});

Deno.test("flattening survives the parts that have no obvious prose form", () => {
  const flat = flattenToolBlocks([
    { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t", name: "run_command", content: "boom", is_error: true },
        // An attached image is not what providers reject, and dropping it
        // would lose the file the turn is about.
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ],
    },
  ]);

  // A turn that was nothing but thinking still has to say something: an empty
  // message is itself a 400 on some providers.
  assertEquals(flat[0]!.content, "[no output]");

  const parts = flat[1]!.content as Array<Record<string, unknown>>;
  assertEquals(Array.isArray(parts), true, "a kept part forces the array form");
  assertEquals(parts[0]!.type, "text");
  assertEquals((parts[0]!.text as string).includes("failed"), true, "an error reads as one");
  assertEquals(parts[1]!.type, "image", "the attachment survives");
});

Deno.test("a message with no tool blocks is returned unchanged", () => {
  // Flattening runs on a whole thread, so it must be inert on the ordinary
  // part of one — otherwise a single bad turn rewrites the entire chat.
  const plain = [{ role: "user" as const, content: "hello" }];
  assertEquals(hasToolBlocks(plain), false);
  assertEquals(flattenToolBlocks(plain), plain);
});

Deno.test("the degraded notice says what the thread can no longer do", () => {
  // Not "something went wrong". The reader needs to know the thread behaves
  // differently now, or the model's next answer about an earlier step looks
  // like it forgot.
  const notice = degradedNotice();
  assertEquals(notice.includes("summarised"), true);
  assertEquals(notice.includes("still here"), true);
});

Deno.test("a history never opens on a tool result whose call was trimmed away", () => {
  // The exact shape that bricks a thread: trimming cut between the assistant
  // message holding the tool_use and the user message answering it, so the
  // request opens on an answer to a call that is not there.
  const orphaned = [
    STORED_LOOP[2]!, // the result, with its call gone
    { role: "assistant" as const, content: "Two files." },
    { role: "user" as const, content: "and the second one?" },
  ];

  const fixed = dropOrphanedToolResults(orphaned);
  assertEquals(fixed.length, 1, "everything before a usable user turn goes");
  assertEquals(fixed[0]!.content, "and the second one?");
  // Anthropic requires the first message to be `user`. Dropping the result but
  // leaving the assistant reply behind would trade one 400 for another.
  assertEquals(fixed[0]!.role, "user");
});

Deno.test("an intact loop is not trimmed, and the asked turn is never dropped", () => {
  // The guard must be inert on a healthy history, or it silently deletes the
  // tool context every turn and the model forgets what it just ran.
  assertEquals(dropOrphanedToolResults(STORED_LOOP), STORED_LOOP);

  // A turn that IS a tool result is the normal way a loop continues. It is the
  // last message, so there is nothing to trim to and it must survive.
  const continuing = [STORED_LOOP[2]!];
  assertEquals(dropOrphanedToolResults(continuing), continuing);
});

// --- Budget ----------------------------------------------------------------
//
// These run without --allow-net, which is load-bearing rather than incidental:
// the whole claim of Budget is that it reaches a model without asking the
// classifier first. A version that classified would try to open a socket here
// and fail the test by permission, not by assertion.

Deno.test("Budget goes to the compatible slot whatever the message is about", async () => {
  await withCredentialsAsync(async () => {
    for (const prompt of ["rebalance my ISA", "why does this segfault", "hello"]) {
      const route = await resolveRoute("medium", prompt);
      assertEquals(route.provider, "compat");
    }
  });
});

Deno.test("Budget does not ask the classifier", async () => {
  await withCredentialsAsync(async () => {
    const route = await resolveRoute("medium", "rebalance my ISA");
    // Not "the classifier ran and said other" — it never ran at all, and the
    // difference is what the route log reads to tell those two apart.
    assertEquals(route.classified, false);
    assertEquals(route.classifierUsage, undefined);
  });
});

Deno.test("Max keeps the routing Budget gave up", async () => {
  await withCredentialsAsync(async () => {
    // Guards the half of this change that was meant to be a no-op: Max is the
    // old Thinking, unchanged, and nothing about Budget may reach it.
    assertEquals(routeFor("finance", "c").provider, "google");
    assertEquals(routeFor("science", "c").provider, "openai");
    assertEquals(routeFor("coding", "c").provider, "anthropic");
    assertEquals(routeFor("healthcare", "c").provider, "anthropic");
    assertEquals(routeFor("other", "c").provider, "meta");

    // The three demonstration routes each reach a different lab, and coding
    // no longer shares a model with healthcare — which is the whole point of
    // them being separate variables rather than one ANTHROPIC_MODEL_ID.
    assertEquals(routeFor("coding", "c").modelId, "claude-fable-5-1");
    assertEquals(
      routeFor("coding", "c").modelId === routeFor("healthcare", "c").modelId,
      false,
    );
  });
});

Deno.test("Budget falls back to Muse, never to a premium model", () => {
  withCredentials(() => {
    const chain = failoverChain({
      ...routeFor("other", "c"),
      provider: "compat",
      modelId: "deepseek-ai/DeepSeek-V4.1-Flash",
    });

    // Every key is set here, so anthropic and google are both available and
    // both deliberately not used: a Budget turn that fell through to Opus
    // would be billed at the rate the reader chose Budget to avoid.
    assertEquals(chain.map((r) => r.provider), ["compat", "meta"]);
  });
});

Deno.test("Budget with no compatible-slot key answers rather than failing", async () => {
  const before = Deno.env.get("COMPAT_API_KEY");
  Deno.env.delete("COMPAT_API_KEY");
  Deno.env.set("MODEL_API_KEY", "test-key");
  try {
    const route = await resolveRoute("medium", "hello");
    assertEquals(route.provider, "meta");
  } finally {
    if (before === undefined) Deno.env.delete("COMPAT_API_KEY");
    else Deno.env.set("COMPAT_API_KEY", before);
  }
});

/** withCredentials, for the routing entry point that happens to be async. */
async function withCredentialsAsync(body: () => Promise<void>): Promise<void> {
  const keys = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "MODEL_API_KEY",
    "OPENAI_API_KEY",
    "COMPAT_API_KEY",
  ];
  const before = keys.map((key) => [key, Deno.env.get(key)] as const);
  for (const key of keys) Deno.env.set(key, "test-key");
  try {
    await body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}


Deno.test("a demonstration route is capped at low effort, whatever was chosen", () => {
  withCredentials(() => {
    // The cap is what stops a Max turn on these three routes from being
    // billed as one. It is on the route, not on the effort control, so the
    // reader's choice is still what gets stored and shown back to them.
    for (const category of ["finance", "science", "coding"] as const) {
      assertEquals(routeFor(category, "c").effortCap, "fast");
      assertEquals(capEffort("max", routeFor(category, "c").effortCap), "fast");
    }

    // Everything else is uncapped and answers at whatever was asked for.
    for (const category of ["healthcare", "other"] as const) {
      assertEquals(routeFor(category, "c").effortCap, undefined);
      assertEquals(capEffort("max", routeFor(category, "c").effortCap), "max");
    }
  });
});

Deno.test("capEffort lowers and never raises", () => {
  // A cap that raised effort would make a Fast turn on a demonstration route
  // cost more than a Fast turn anywhere else.
  assertEquals(capEffort("fast", "max"), "fast");
  assertEquals(capEffort("medium", "fast"), "fast");
  assertEquals(capEffort("max", "medium"), "medium");
  assertEquals(capEffort("fast", undefined), "fast");
  assertEquals(capEffort("max", undefined), "max");
});
