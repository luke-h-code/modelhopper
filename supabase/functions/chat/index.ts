// POST /functions/v1/chat
//
// The only privileged component in the system. It holds every provider key —
// MODEL_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY — owns
// prompt construction, owns model selection, and owns message persistence. The
// client sends an intent ("say this in that conversation"), never a prompt, and
// never learns which key served it.
//
// Routing is decided per message in providers.ts: Fast goes straight to the
// fast model, Thinking classifies the message first. Nothing about the choice
// is stored on the conversation — messages.model_id records what answered.
//
// The classifier answers two questions in one call: the subject, and whether
// the turn needs the user's files. The subject picks the model; the second
// answer decides whether that model is handed the tools. They are separate
// because folding them together meant every turn that touched the folder lost
// its subject and went to one provider regardless of what it was about.
//
// Auth: JWT verification is left ON, so the Supabase gateway rejects
// unauthenticated calls before this code runs. We then build a Supabase client
// carrying the CALLER'S token rather than a service-role key, so every query
// below is still constrained by RLS. A bug in this file cannot read another
// user's conversation.
//
// Request: { conversation_id, parent_id?, content?, attachment_ids?,
//            tool_root?, tool_platform?, tool_result? }
//   content present      -> a new turn: a user message is written under
//                           parent_id.
//   tool_result present  -> the user approved a call and this is its output.
//                           parent_id names the assistant message that asked;
//                           the result is written as a user message under it
//                           and the loop continues on the same model.
//   both absent          -> a regenerate: parent_id must already name a user
//                           message, and a fresh assistant reply branches off
//                           it.
//
// tool_root is the folder the desktop shell has open. Its presence is what
// turns tools on at all, so the web app — which sends no folder — is
// unaffected.
//
// tool_capable says whether the client COULD run one, folder or not. It exists
// for the turn that asks for work on a machine there isn't one of: the web app
// is told the feature lives in the desktop app, a desktop chat with no folder
// open is told to pick one, and both are told by this function rather than by
// the model, so the sentence is the same every time.
//
// Response: newline-delimited JSON, one object per line.
//   {"type":"delta","text":"..."}          incremental assistant text
//   {"type":"reasoning","text":"..."}      incremental thinking, when the
//                                         provider exposes any
//   {"type":"tool_call","id":"toolu_..",   the model wants to run something;
//    "name":"list_dir","input":{...}}      nothing runs until the user agrees
//   {"type":"notice","reason":"platform",  this turn wanted the user's machine
//    "text":"..."}                         and there isn't one here; fixed
//                                         text, shown before the reply
//   {"type":"done","message_id":"uuid",    reply persisted, stream finished
//    "user_message_id":"uuid"|null}        so the client can map its own ids
//   {"type":"error","message":"..."}       failed; may arrive mid-stream
//
// Disconnecting does not cancel the reply. If the reader closes the app or
// drops the connection, the worker keeps draining the model and stores the
// finished answer, so the thread has it on the next open. See cancel() below.
// Note this is store-and-find, not resume: reopening part-way through shows
// whatever was saved at the disconnect, and the rest appears on a later load.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type Effort,
  type ModelMessage,
  openModelStream,
  connectDeadline,
  degradedNotice,
  dropOrphanedToolResults,
  flattenToolBlocks,
  hasToolBlocks,
  resolveRoute,
  type RouteChoice,
  type Provider,
  routeForModelId,
  streamDelta,
  streamReasoning,
  type Usage,
  usageMeter,
  assistantBlocks,
  failoverChain,
  failoverNotice,
  type FailoverReason,
  grantTools,
  type ToolGap,
  toolGapNotice,
  toolGapSystemPrompt,
  toolGapOf,
  toolRoute,
  TOOLS,
  type ToolEnv,
  toolSystemPrompt,
} from "./providers.ts";

// Spend guards. These live server-side precisely because the client cannot be
// trusted to respect them.
// Sized against the tool loop, which is what actually fills a prompt here.
// A turn may run 20 legs (MAX_TOOL_LEGS in chatModelAdapter.ts) and each leg
// writes two rows — the result and the reply that asked for it — so 40 of
// these messages can be tool traffic from a single turn. At 40 total, a long
// loop evicted the user's own question, because history is dropped
// oldest-first: the model ended up reading a pile of command output with no
// memory of what it had been asked to do. Keep both above what one loop can
// produce, or raising the leg count makes long turns worse rather than better.
const MAX_HISTORY_MESSAGES = 80;
// 20 legs x MAX_TOOL_OUTPUT_CHARS is 400k of tool output before anything the
// user typed is counted. This is a ceiling, not a target — an ordinary chat
// never approaches it — but a loop that hits it costs real money on every
// remaining leg, because the whole history is resent each time.
const MAX_HISTORY_CHARS = 500_000;
const MAX_INPUT_CHARS = 32_000;
const MAX_FILES_PER_TURN = 4;
const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
// Text is inlined into the prompt rather than uploaded, so it is capped by
// characters as well as bytes to keep it inside the history budget.
const MAX_INLINE_TEXT_BYTES = 1024 * 1024;
const MAX_INLINE_TEXT_CHARS = 40_000;

// What the model API actually accepts as an image. Deliberately a list rather
// than an "image/*" prefix test: SVG, BMP and TIFF are images but are rejected
// upstream, and one rejected part fails the entire request.
const MODEL_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

type Part = { type: "text"; text: string } | Record<string, unknown>;

interface ChatRequest {
  conversation_id?: unknown;
  parent_id?: unknown;
  content?: unknown;
  attachment_ids?: unknown;
  effort?: unknown;
  /** Set by the desktop shell when a working folder is open. */
  tool_root?: unknown;
  tool_platform?: unknown;
  /**
   * Whether the client is a shell that COULD run a command, sent whether or
   * not a folder is open.
   *
   * Distinct from tool_root, and the distinction is the whole point: a browser
   * sends false and is told the feature lives in the desktop app, while a
   * desktop chat nobody has pointed anywhere sends true and is told to pick a
   * folder. Telling the second reader to go and get the desktop app they are
   * already using is worse than saying nothing.
   */
  tool_capable?: unknown;
  /** What the shell found installed, so the model stops guessing at it. */
  tool_env?: unknown;
  /** Set when this turn carries the output of a tool the user approved. */
  tool_result?: unknown;
}

interface ToolResult {
  tool_use_id: string;
  output: string;
  is_error: boolean;
}

// A tool's output is inlined into the prompt, so it is capped like any other
// text the model has to read.
const MAX_TOOL_OUTPUT_CHARS = 20_000;

function parseToolResult(value: unknown): ToolResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) {
    return null;
  }
  const output = typeof raw.output === "string" ? raw.output : "";
  return {
    tool_use_id: raw.tool_use_id,
    output: output.length > MAX_TOOL_OUTPUT_CHARS
      ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[truncated]`
      : output,
    is_error: raw.is_error === true,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The runtime injects the project's public key, but the variable name has
 * changed across Supabase versions (SUPABASE_ANON_KEY, then a
 * SUPABASE_PUBLISHABLE_KEYS JSON map). Accept whichever is present.
 */
function publishableKey(): string {
  const single = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (single) return single;

  const map = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (map) {
    try {
      const parsed = JSON.parse(map) as Record<string, string>;
      const key = parsed["default"] ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      // fall through
    }
  }
  throw new Error("No Supabase publishable key in the environment");
}

// --- spend ------------------------------------------------------------------

/**
 * Micro-USD per million tokens, as read from `model_prices`.
 *
 * Dollars, not pounds: that is what the providers publish and bill in, so it
 * is what a price can be checked against. The single conversion to GBP happens
 * in the `allowance_balance` view and nowhere else.
 *
 * Cached for the life of the worker. Prices move slowly and a boot is cheap,
 * so this trades "a price change takes effect on the next cold start" for one
 * fewer query on every single turn.
 */
let priceCache:
  | Map<string, { input: number; cached: number; output: number }>
  | null = null;

async function prices(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<Map<string, { input: number; cached: number; output: number }>> {
  if (priceCache) return priceCache;

  const { data, error } = await supabase
    .from("model_prices")
    .select(
      "model_id, input_micro_usd_per_mtok, cached_input_micro_usd_per_mtok, output_micro_usd_per_mtok",
    );

  if (error) {
    // Charging nothing is the safe direction to fail in: an under-billed turn
    // is a reporting problem, while a failed price lookup that blocked the
    // turn would make an unrelated outage look like an empty wallet.
    console.error("price lookup failed:", error.message);
    return new Map();
  }

  type PriceRow = {
    model_id: string;
    input_micro_usd_per_mtok: number | string;
    cached_input_micro_usd_per_mtok: number | string | null;
    output_micro_usd_per_mtok: number | string;
  };

  priceCache = new Map(
    ((data ?? []) as PriceRow[]).map((row) => [
      row.model_id as string,
      {
        input: Number(row.input_micro_usd_per_mtok),
        // Null means "no cached rate recorded", and cached tokens then fall
        // back to the full rate below — over-billing rather than under, which
        // is the right way to be wrong about a model nobody has priced.
        cached: Number(row.cached_input_micro_usd_per_mtok ?? 0),
        output: Number(row.output_micro_usd_per_mtok),
      },
    ]),
  );
  return priceCache;
}

/** What one call cost, in micro-USD. A model with no price costs nothing. */
function costOf(
  table: Map<string, { input: number; cached: number; output: number }>,
  modelId: string,
  usage: Usage,
): number {
  const price = table.get(modelId);
  if (!price) return 0;
  // A model with no cached rate is charged the full one for cached tokens.
  const cachedRate = price.cached > 0 ? price.cached : price.input;
  const micros = (usage.inputTokens * price.input +
    usage.cachedInputTokens * cachedRate +
    usage.outputTokens * price.output) / 1_000_000;
  // Never negative, never fractional: the column is a bigint with a >= 0
  // check, and a rejected insert would lose the whole record of the spend.
  return Math.max(0, Math.round(micros));
}

/**
 * Write one row per model call.
 *
 * Never throws and never awaited by anything the reader is waiting on. A
 * failure to record a cost must not cost them the turn they already paid for —
 * it is a reporting gap, and the console line is how it gets noticed.
 */
async function recordUsage(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  messageId: string | null,
  kind: "classify" | "reply" | "tool_leg",
  modelId: string,
  usage: Usage,
  table: Map<string, { input: number; cached: number; output: number }>,
): Promise<void> {
  if (
    usage.inputTokens === 0 && usage.cachedInputTokens === 0 &&
    usage.outputTokens === 0
  ) return;

  try {
    const { error } = await supabase.from("usage_events").insert({
      user_id: userId,
      message_id: messageId,
      kind,
      model_id: modelId,
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      output_tokens: usage.outputTokens,
      cost_micro_usd: costOf(table, modelId, usage),
    });
    if (error) console.error("usage insert failed:", error.message);
  } catch (err) {
    // Called from inside the stream loop, where a throw would abort the very
    // reply it is trying to bill for.
    console.error("usage insert threw:", err);
  }
}

/** Micro-pounds left this month, or null if the balance could not be read. */
async function remainingMicros(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("allowance_status");
  if (error) {
    // Unreadable balance lets the turn through. The alternative is that a
    // database hiccup looks to every user like being out of credit, which is
    // a worse failure than one turn of overspend.
    console.error("allowance lookup failed:", error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const left = row?.remaining_micros;
  return typeof left === "number" ? left : Number(left ?? 0);
}

function line(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

function fail(message: string, status: number, origin: string | null) {
  return new Response(JSON.stringify({ type: "error", message }), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return fail("Method not allowed", 405, origin);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return fail("Missing authorization", 401, origin);

  // RLS-scoped client: acts as the caller, not as an admin.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    publishableKey(),
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return fail("Not authenticated", 401, origin);
  const userId = userData.user.id;

  // --- the allowance -------------------------------------------------------
  //
  // Before the message is written, before the classifier runs, before a token
  // is bought. Every turn and every leg of a tool loop comes through here, so
  // one check in one place covers both "send a new message" and "continue the
  // loop" — there is no second door.
  //
  // A turn can only be refused once it has already gone over, never before:
  // nothing knows what a reply will cost until it has been generated. So the
  // balance can end a month up to one leg below zero, and the test is "is
  // there anything left" rather than "can this be afforded".
  const priceTable = await prices(supabase);
  const left = await remainingMicros(supabase);

  if (left !== null && left <= 0) {
    return fail(
      "You have used this month's allowance. It resets on the 1st.",
      402,
      origin,
    );
  }

  // --- validate input ------------------------------------------------------

  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, origin);
  }

  const conversationId = body.conversation_id;
  const content = body.content;

  if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) {
    return fail("conversation_id must be a UUID", 400, origin);
  }

  // Absent content means "regenerate the reply to parent_id". Anything present
  // must still be a usable string, so an empty one is rejected rather than
  // silently treated as a regenerate.
  // Three kinds of turn now, not two. A tool turn also arrives without
  // content, so it has to be recognised before the regenerate test or every
  // approved tool call would re-answer the previous question instead.
  const toolResult = parseToolResult(body.tool_result);
  const isToolTurn = toolResult !== null;
  const isRegenerate = !isToolTurn && (content === undefined || content === null);

  const toolRoot = typeof body.tool_root === "string" && body.tool_root.length > 0
    ? body.tool_root
    : null;
  const toolPlatform = typeof body.tool_platform === "string"
    ? body.tool_platform
    : "unknown";
  // Nothing here is a security control: commands run in the client, on the
  // caller's own machine, so a forged flag buys an attacker the right to be
  // offered tools by their own app. It decides which sentence the reader sees.
  const toolCapable = body.tool_capable === true;
  const toolEnv: ToolEnv | undefined =
    body.tool_env && typeof body.tool_env === "object"
      ? body.tool_env as ToolEnv
      : undefined;

  const effort: Effort = body.effort === "medium" || body.effort === "max"
    ? body.effort
    : "fast";

  if (!isRegenerate && !isToolTurn) {
    if (typeof content !== "string" || content.trim().length === 0) {
      return fail("content must be a non-empty string", 400, origin);
    }
    if (content.length > MAX_INPUT_CHARS) {
      return fail(`content exceeds ${MAX_INPUT_CHARS} characters`, 413, origin);
    }
  }

  let parentId: string | null = null;
  if (body.parent_id !== undefined && body.parent_id !== null) {
    if (typeof body.parent_id !== "string" || !UUID_RE.test(body.parent_id)) {
      return fail("parent_id must be a UUID", 400, origin);
    }
    parentId = body.parent_id;
  }

  if ((isRegenerate || isToolTurn) && parentId === null) {
    return fail("parent_id is required when content is omitted", 400, origin);
  }

  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter(
      (id): id is string => typeof id === "string" && UUID_RE.test(id),
    )
    : [];

  // --- persist the user's message ------------------------------------------
  //
  // RLS enforces conversation ownership here. If the caller forged a
  // conversation_id belonging to someone else, this insert fails and we stop.

  // The leaf the assistant's reply will hang off: either a user message written
  // now, or — on a regenerate — one that already exists.
  let promptMessageId: string;
  let newUserMessageId: string | null = null;

  // The model the loop must continue on. A tool_use from one provider cannot
  // be answered by another, so this overrides the classifier entirely.
  let continuationModelId: string | null = null;

  if (isToolTurn) {
    // The parent is the assistant message that asked for this call. Checking
    // that it actually contains this tool_use_id is what stops a client
    // inventing a result for a call the model never made.
    const { data: parent, error: parentErr } = await supabase
      .from("messages")
      .select("id, role, content, model_id")
      .eq("id", parentId)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (parentErr || !parent) {
      console.error("tool parent lookup failed:", parentErr?.message);
      return fail("Message not found", 403, origin);
    }
    if (parent.role !== "assistant") {
      return fail("parent_id must name an assistant message", 400, origin);
    }
    const asked = toolPartsOf(parent.content).some(
      (part) => part.type === "tool_use" && part.id === toolResult.tool_use_id,
    );
    if (!asked) {
      return fail("No such tool call on that message", 400, origin);
    }

    continuationModelId = typeof parent.model_id === "string"
      ? parent.model_id
      : null;

    // The name of the call this answers, copied off the parent.
    //
    // Anthropic matches a result to its call by id and needs none of this.
    // Gemini matches by NAME and never sent an id at all, so without it a
    // second leg of a Gemini loop has nothing to address its answer to. Taken
    // from the parent rather than from the client: the client could say
    // anything, and the parent has just been proved to contain this call.
    const askedName = toolPartsOf(parent.content).find(
      (part) => part.type === "tool_use" && part.id === toolResult.tool_use_id,
    )?.name;

    const resultParts: Part[] = [{
      type: "tool_result",
      tool_use_id: toolResult.tool_use_id,
      content: toolResult.output,
      is_error: toolResult.is_error,
      ...(typeof askedName === "string" ? { name: askedName } : {}),
    }];

    const { data: resultRow, error: resultErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: "user",
        content: resultParts,
        parent_id: parentId,
        effort,
      })
      .select("id")
      .single();

    if (resultErr || !resultRow) {
      console.error("tool result insert failed:", resultErr?.message);
      return fail("Conversation not found", 403, origin);
    }

    promptMessageId = resultRow.id as string;
    newUserMessageId = promptMessageId;
  } else if (isRegenerate) {
    // Confirm the parent is a user message in this conversation. RLS scopes
    // the lookup, so someone else's message id simply isn't found.
    const { data: existing, error: lookupErr } = await supabase
      .from("messages")
      .select("id, role")
      .eq("id", parentId)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (lookupErr || !existing) {
      console.error("regenerate parent lookup failed:", lookupErr?.message);
      return fail("Message not found", 403, origin);
    }
    if (existing.role !== "user") {
      return fail("parent_id must name a user message", 400, origin);
    }
    promptMessageId = existing.id as string;
  } else {
    // An omitted parent means "append to this conversation", not "start a new
    // root". Defaulting to null would silently fork the thread whenever the
    // client could not resolve a parent — a cancelled stream never delivers the
    // done event, so its ids never reach the client's map — and the reader
    // would see their history vanish. The server already tracks the current
    // leaf, so use it.
    if (parentId === null) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("head_message_id")
        .eq("id", conversationId)
        .maybeSingle();
      parentId = (conv?.head_message_id as string | null) ?? null;
    }

    const userParts: Part[] = [{ type: "text", text: content as string }];

    const { data: userMessage, error: insertErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        user_id: userId,
      role: "user",
      content: userParts,
      parent_id: parentId,
      effort,
      })
      .select("id")
      .single();

    // Also the path taken when parent_id belongs to another conversation — the
    // 0004 trigger raises, and the caller learns nothing about what exists.
    if (insertErr || !userMessage) {
      console.error("user message insert failed:", insertErr?.message);
      return fail("Conversation not found", 403, origin);
    }
    promptMessageId = userMessage.id as string;
    newUserMessageId = promptMessageId;
  }

  // Link any files uploaded from the composer to the message they arrived with.
  if (attachmentIds.length > 0 && newUserMessageId) {
    const { error: linkErr } = await supabase
      .from("attachments")
      .update({ message_id: newUserMessageId })
      .in("id", attachmentIds)
      .eq("conversation_id", conversationId)
      .is("message_id", null);
    if (linkErr) console.error("attachment link failed:", linkErr.message);
  }

  // --- build the prompt ----------------------------------------------------

  // Walk the ancestor chain rather than taking the last N rows by created_at.
  // Since 0004 a conversation is a tree: after an edit, created_at order
  // interleaves sibling branches, so the model would be shown both versions of
  // the same turn. The ancestor path is the single branch the reader is on.
  const { data: recent, error: historyErr } = await supabase
    .rpc("message_ancestors", {
      leaf: promptMessageId,
      max_depth: MAX_HISTORY_MESSAGES,
    });

  if (historyErr || !recent) {
    console.error("history load failed:", historyErr?.message);
    return fail("Could not load conversation", 500, origin);
  }

  // Already oldest-first from the RPC.
  const history = recent as Array<
    { id: string; role: string; content: unknown }
  >;

  const files = await loadTurnFiles(supabase, attachmentIds);

  let budget = MAX_HISTORY_CHARS;
  let modelMessages: ModelMessage[] = [];

  // Walk backwards so that if the budget runs out we drop the OLDEST turns.
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!;
    const text = partsToText(row.content);
    const toolParts = toolPartsOf(row.content);

    // A tool result row carries no text at all, and dropping it would leave
    // the model looking at a call it never got an answer to.
    if (!text && toolParts.length === 0) continue;

    const stored = Array.isArray(row.content)
      ? row.content as Array<Record<string, unknown>>
      : null;

    const cost = toolParts.length > 0 && stored
      ? JSON.stringify(stored).length
      : text.length;
    if (cost > budget) break;
    budget -= cost;

    const isLast = row.id === promptMessageId;

    let content: ModelMessage["content"];
    if (toolParts.length > 0 && stored) {
      // Echoed exactly as stored, in the order it arrived. Rebuilding the
      // message — reordering blocks, dropping the thinking that preceded a
      // tool call — is what the API rejects.
      content = isLast && files.length > 0 ? [...stored, ...files] : stored;
    } else {
      content = isLast && files.length > 0
        ? [{ type: "text", text }, ...files]
        : text;
    }

    modelMessages.unshift({
      role: row.role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  // Never start the history on a tool result whose call was trimmed away: the
  // provider rejects it, and because the blocks are stored, so is every later
  // message in the thread. See dropOrphanedToolResults.
  modelMessages = dropOrphanedToolResults(modelMessages);

  // Routed per message, not per conversation: Fast goes straight to the fast
  // model, Thinking classifies THIS message and sends it to that category's
  // specialist. A regenerate re-routes from the same user message, so a thread
  // is free to move between models as its subject moves.
  const promptText = partsToText(
    history.find((row) => row.id === promptMessageId)?.content,
  );
  let route: RouteChoice;
  try {
    if (continuationModelId) {
      // Continuing a loop the model already opened. Classifying here could
      // hand a tool_use from one provider to another, which no provider
      // accepts.
      route = routeForModelId(continuationModelId) ?? toolRoute();
    } else {
      // A working folder does not mean this turn wants it. The classifier is
      // asked a second question alongside the subject — does this need the
      // folder? — and the answer decides whether tools are declared, not which
      // model answers. Routing by subject is unchanged either way: a request
      // to chart a portfolio is still finance, and now goes to the finance
      // model holding the tools rather than to Opus holding them instead.
      route = await resolveRoute(effort, promptText, !!toolRoot);

      // Granted here rather than in the router, because only this function
      // knows there is a real folder behind the request.
      if (toolRoot && route.toolsWanted) route = grantTools(route);
    }
  } catch (err) {
    console.error("routing failed:", err);
    return fail("Could not route this message", 502, origin);
  }

  // Billed the moment it is known, not at the end of the turn: the classifier
  // has already run and already cost money, and a stream that fails later must
  // not take the record of it with it.
  if (route.classifierUsage) {
    void recordUsage(
      supabase,
      userId,
      null,
      "classify",
      route.classifierModelId,
      route.classifierUsage,
      priceTable,
    );
  }

  /**
   * A turn that wanted the machine, somewhere there isn't one.
   *
   * Deterministic on purpose. The reader gets a fixed sentence from this app
   * rather than a model's paraphrase of its own limits, and the model that is
   * about to answer is told the same fact so the reply does not contradict the
   * line directly above it by offering to create the file anyway.
   *
   * Never set on a continuation: a loop that is already running had tools by
   * definition.
   */
  const toolGap: ToolGap | null = continuationModelId
    ? null
    : toolGapOf(route, toolCapable);

  // --- call the selected model --------------------------------------------

  let upstream: Response | null = null;
  let failedOver: { from: string; reason: FailoverReason } | null = null;

  // The chain is [first choice, then stand-ins]. A continuation has no chain:
  // a tool_use from one provider cannot be answered by another, because the
  // history it would be handed is full of blocks in the first one's dialect.
  // If the model that opened a loop is down, the honest outcome is to stop.
  const attempts = continuationModelId ? [route] : failoverChain(route);

  // Whether the structured tool blocks have already been given up on, and
  // whether that is what finally failed. The index is stepped by hand because
  // a degraded retry goes back to the SAME candidate rather than the next one.
  let degraded = false;
  let malformed = false;
  let index = 0;

  while (index < attempts.length) {
    const candidate = attempts[index]!;
    // Tools travel with every leg of a loop, not just the first: the model
    // needs them declared again to be allowed to call another one.
    //
    // Gated on the route having asked for them rather than on the folder
    // being open. A coding question routes to Opus too, and handing it the
    // user's folder uninvited is how a turn that wanted an explanation ends
    // up proposing a command.
    //
    // No longer gated on the provider: all four dialects are implemented, so
    // whichever model the subject chose — or stood in for it — gets them.
    const toolOptions = toolRoot && candidate.needsTools
      ? {
        tools: TOOLS,
        system: toolSystemPrompt(
          toolRoot ?? "the working folder",
          toolPlatform,
          toolEnv,
        ),
      }
      // No tools, but possibly something to say about why not.
      : toolGap
      ? { system: toolGapSystemPrompt(toolGap) }
      : undefined;

    const deadline = connectDeadline();
    let reason: FailoverReason | null = null;

    try {
      const response = await openModelStream(
        candidate,
        effort,
        modelMessages,
        toolOptions,
        deadline.signal,
      );

      if (response.ok && response.body) {
        upstream = response;
        route = candidate;
        break;
      }

      // Upstream error bodies can echo request content; log, don't forward.
      const detail = await response.text().catch(() => "");
      console.error(`model error [${candidate.provider}]:`, response.status, detail);

      // A rate limit fails over like anything else. It is the provider saying
      // "not from you, not right now", and somewhere with capacity answering
      // is better for the reader than a refusal — while the count of these is
      // what turns "ask for a higher limit" into a request with a number on it.
      if (response.status === 429) reason = "rate_limit";
      else if (response.status >= 500) reason = "error";
      else {
        // 4xx that is not a rate limit is not a provider problem. It is a
        // request this app built wrongly — a bad model id, a revoked key, or
        // most often a history whose tool blocks do not satisfy the provider.
        // Another provider would reject it too, so failing over is a round
        // trip spent proving that.
        //
        // But the tool blocks are STORED, so "this request is malformed" means
        // every later message in the thread is malformed as well. Giving up
        // here is what killed a conversation permanently and then told the
        // reader to try again shortly.
        //
        // So before giving up: one retry with the tool calls rewritten as
        // prose. The model loses the ability to chain onto an earlier call,
        // and keeps every fact that was in it. Same model — a stand-in would
        // change two things at once and teach nothing about which mattered.
        if (!degraded && hasToolBlocks(modelMessages)) {
          degraded = true;
          modelMessages = flattenToolBlocks(modelMessages);
          console.warn(
            `retrying ${candidate.provider} with tool history flattened ` +
              `after ${response.status}`,
          );
          continue;
        }
        malformed = true;
        break;
      }
    } catch (err) {
      reason = deadline.signal.aborted ? "timeout" : "error";
      console.error(`model request failed [${candidate.provider}]:`, err);
    } finally {
      // On EVERY way out of the attempt, the success `break` included. This
      // line is the fix: leaving the timer running is what used to abort the
      // body of a reply that was streaming perfectly well.
      deadline.clear();
    }

    if (!reason) break;

    // Remember only the FIRST provider that failed. That is the one the reader
    // was supposed to get and the one worth asking for more capacity.
    if (!failedOver) failedOver = { from: candidate.provider, reason };

    if (index === attempts.length - 1) {
      console.error(`every provider failed; last was ${candidate.provider}`);
    }
    index++;
  }

  if (!upstream || !upstream.body) {
    // Two different failures, and telling them apart is the difference between
    // useful advice and a lie. A provider being down or busy is temporary and
    // trying again is the right move. A request the provider will not accept —
    // after the flattened retry has also been refused — is a property of this
    // conversation's stored content, and no amount of waiting changes it.
    return malformed
      ? fail(
        "This conversation can't be continued — something in its history is " +
          "no longer accepted. Please start a new one.",
        422,
        origin,
      )
      : fail(
        "No model could answer right now. Please try again shortly.",
        503,
        origin,
      );
  }

  // --- stream back, then persist -------------------------------------------

  // Hoisted so the cancel() handler below can still save the partial reply if
  // the client goes away mid-stream (closed tab, dropped connection, app
  // backgrounded on mobile). Losing a half-written answer the user already
  // paid for is worse than storing a truncated one.
  let full = "";
  let assistantId: string | null = null;

  // Whether the reader is still there. Once they are gone the generation
  // continues — see cancel() — but nothing is written to a controller that no
  // longer has anywhere to put it.
  let clientGone = false;

  // Resolves when the read loop has finished, however it finished. cancel()
  // hands this to waitUntil so the worker outlives the response.
  let finished!: () => void;
  const streamDone = new Promise<void>((resolve) => {
    finished = resolve;
  });

  /**
   * Write what has arrived so far: an insert the first time, an update to the
   * same row after that.
   *
   * Serialised through a chain because the disconnect path saves twice — once
   * immediately, so a worker killed mid-generation still leaves the partial
   * answer behind, and once when the reply finishes. Two overlapping calls
   * would otherwise both see a null id and insert two replies.
   */
  let saving: Promise<string | null> = Promise.resolve(null);
  let savedLength = -1;

  // Assembled while streaming, then stored on the assistant message so the
  // call survives a reload and can be matched against the result that answers
  // it. Declared out here because `save` closes over it.
  let toolCall: { id: string; name: string; input: unknown } | null = null;

  // The assistant's content exactly as it streamed. Stored instead of the
  // plain text whenever a tool was called, because Anthropic requires the
  // whole turn — thinking blocks and their signatures included — to come back
  // with the tool result, and rejects the request with a 400 if any is missing.
  let assistantContent: Array<Record<string, unknown>> | null = null;

  const save = (): Promise<string | null> => {
    saving = saving.then(async () => {
      // The verbatim blocks already contain the text, so it is not added again.
      const parts: Part[] = toolCall && assistantContent
        ? assistantContent as Part[]
        : [];
      const text = parts.length > 0 ? "" : full;

      // A turn can be a tool call and nothing else — the model often asks
      // before it says anything — so emptiness is judged on both.
      if (text.trim().length === 0 && parts.length === 0) return assistantId;

      // The disconnect path asks again after the loop has already stored the
      // finished text; there is nothing to write the second time. A tool call
      // arriving after that save is a real change, so it re-writes.
      const unchanged = full.length === savedLength && !toolCall;
      if (unchanged) return assistantId;
      savedLength = full.length;

      if (assistantId) {
        await updateAssistant(supabase, assistantId, text, parts);
        return assistantId;
      }

      assistantId = await persistAssistant(
        supabase,
        conversationId,
        userId,
        text,
        promptMessageId,
        route.modelId,
        effort,
        parts,
      );
      // Logged once, against the reply it explains. Not awaited and never
      // allowed to throw: a failure to record why a turn was routed must not
      // cost the reader the turn itself.
      if (assistantId) {
        void logRoute(
          supabase,
          conversationId,
          userId,
          assistantId,
          route,
          effort,
          failedOver,
        );
      }
      return assistantId;
    });
    return saving;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Enqueueing onto a cancelled controller throws, which would abort the
      // very loop that is trying to finish the answer.
      const emit = (obj: unknown) => {
        if (!clientGone) controller.enqueue(line(obj));
      };

      emit({ type: "meta", model_id: route.modelId, effort });

      // Before the first token, so the reader has the explanation in front of
      // them while the answer is still arriving rather than after it. It is
      // not persisted: it describes the device this turn was asked on, and the
      // same thread opened on the desktop app tomorrow would be telling a lie.
      //
      // Both can apply at once — a web turn that wanted the folder AND whose
      // provider was down — so they are joined rather than one overwriting the
      // other on the client.
      const notices: string[] = [];
      if (toolGap) notices.push(toolGapNotice(toolGap));
      if (degraded) notices.push(degradedNotice());
      if (failedOver) {
        notices.push(
          failoverNotice(failedOver.from as Provider, failedOver.reason, route.modelId),
        );
      }
      if (notices.length > 0) {
        emit({
          type: "notice",
          reason: failedOver ? "failover" : degraded ? "degraded" : toolGap,
          text: notices.join(" "),
        });
      }

      const assistant = assistantBlocks(route.provider);
      const meter = usageMeter(route.provider);
      // One usage row per stream, whichever way the stream ends.
      let billed = false;
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
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

            try {
              const json = JSON.parse(payload) as Record<string, unknown>;
              const delta = streamDelta(route.provider, json);
              if (typeof delta === "string" && delta.length > 0) {
                full += delta;
                emit({ type: "delta", text: delta });
              }

              // Reasoning is shown while the reply is being composed but is
              // never persisted — only the answer is part of the thread.
              const thinking = streamReasoning(route.provider, json);
              if (thinking) emit({ type: "reasoning", text: thinking });

              // Every block is kept verbatim, not just the tool call: a
              // thinking block has to go back with the tool result or the
              // next request is rejected. Nothing is read back until the
              // stream ends, because reading closes whatever block is open.
              assistant.accept(json);
              meter.accept(json);
            } catch {
              // A partial or non-JSON keepalive frame; skip it.
            }
          }
        }

        assistantContent = assistant.blocks();
        toolCall = assistant.toolCall();

        // A 200 that produced nothing at all. Not an error anywhere — the
        // request succeeded, the stream ended, and the reader gets an empty
        // bubble with a model badge on it. Without this line there is nothing
        // in the logs to distinguish it from a reply that simply had no text,
        // which cost a debugging session on the day the Gemini dialect landed.
        if (full.length === 0 && !toolCall) {
          console.warn(
            `${route.provider}/${route.modelId} streamed no text and no tool ` +
              `call (category ${route.category}, effort ${effort}, ` +
              `tools ${route.needsTools ? "declared" : "not declared"})`,
          );
        }

        const savedId = await save();

        billed = true;
        // Recorded here rather than in save(), which can run twice — once on
        // disconnect and again when the reply finishes — and would bill the
        // turn twice over. This runs on the one path that ends a stream.
        //
        // A leg that called a tool is billed as a leg, which is what makes the
        // cost of a twenty-step loop legible as twenty rows rather than one.
        await recordUsage(
          supabase,
          userId,
          savedId,
          toolCall ? "tool_leg" : "reply",
          route.modelId,
          meter.read(),
          priceTable,
        );

        // Before done, so the client has the call in hand the moment the run
        // ends and can put the approval gate straight on screen.
        if (toolCall) {
          emit({
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            message_id: savedId,
          });
        }
        emit({
          type: "done",
          message_id: savedId,
          user_message_id: newUserMessageId,
          model_id: route.modelId,
          effort,
        });
      } catch (err) {
        console.error("stream failed:", err);
        // Save whatever arrived before the failure so the thread isn't lost.
        const savedId = await save();

        // A turn that broke halfway still bought its input tokens. Skipping
        // this would make every failure free, which is the wrong way round:
        // the money is gone either way, and a month of quiet failures would
        // silently spend an allowance that never appeared to move.
        if (!billed) {
          billed = true;
          await recordUsage(
            supabase,
            userId,
            savedId,
            toolCall ? "tool_leg" : "reply",
            route.modelId,
            meter.read(),
            priceTable,
          );
        }

        emit({ type: "error", message: "The reply was interrupted" });
      } finally {
        // Only close a controller the reader is still attached to; closing a
        // cancelled one throws and would mask whatever ended the loop.
        if (!clientGone) controller.close();
        finished();
      }
    },

    /**
     * Fired when the reader disconnects — a closed window, a killed app, a
     * dropped connection.
     *
     * The reply is NOT abandoned. The read loop above keeps draining the model
     * and keeps appending to `full`; only the writes to this controller stop.
     * waitUntil keeps the worker alive until that loop ends, so a question
     * asked and then walked away from is still answered in full and is waiting
     * in the thread on the next open.
     *
     * The partial is saved immediately as well, before the drain is awaited:
     * if the platform kills the worker part-way — a long answer can outlive
     * the wall-clock budget — what had already arrived survives, rather than
     * the whole reply being lost in pursuit of the rest of it.
     */
    cancel() {
      clientGone = true;

      // Started before waitUntil is reached, not inside the call: `a?.b(x)`
      // does not evaluate x when a is nullish, so building the promise in the
      // argument would mean no save at all on a runtime without waitUntil.
      const pending = (async () => {
        await save();
        await streamDone;
        await save();
        console.log("finished a reply the client had disconnected from");
      })().catch((err) => {
        // The usage row is written by the read loop above, which keeps going
        // after a disconnect — walking away from a turn does not make it free.
        console.error("background completion failed:", err);
      });

      const runtime = (globalThis as {
        EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
      }).EdgeRuntime;

      runtime?.waitUntil(pending);
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

// --- helpers ---------------------------------------------------------------

/** The tool_use and tool_result parts of a stored message, in order. */
function toolPartsOf(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return type === "tool_use" || type === "tool_result";
  });
}

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: "text"; text: string } =>
        !!p && typeof p === "object" && (p as Part).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Record what was decided about one turn, next to the reply it produced.
 *
 * `messages.model_id` already says which model answered. This says why: the
 * category, whether a classifier produced it or it was a default, and whether
 * the turn was handed the user's folder. When a reply comes back on a model
 * that looks wrong, the difference between those two is the diagnosis.
 *
 * Written as the caller, not with a service-role key — the insert is granted
 * to authenticated and the policy pins the row to a conversation they own.
 */
async function logRoute(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversationId: string,
  userId: string,
  messageId: string,
  route: RouteChoice,
  effort: Effort,
  /** The provider that would have answered, when a stand-in did instead. */
  failedOver: { from: string; reason: string } | null,
): Promise<void> {
  const { error } = await supabase.from("conversation_routes").insert({
    conversation_id: conversationId,
    user_id: userId,
    message_id: messageId,
    category: route.category,
    provider: route.provider,
    model_id: route.modelId,
    classifier_model_id: route.classifierModelId,
    classified: route.classified,
    needs_tools: route.needsTools,
    effort,
    fallback_from: failedOver?.from ?? null,
    fallback_reason: failedOver?.reason ?? null,
  });

  if (error) console.error("route log insert failed:", error.message);
}

async function persistAssistant(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversationId: string,
  userId: string,
  text: string,
  parentId: string,
  modelId: string,
  effort: Effort,
  extraParts: Part[] = [],
): Promise<string | null> {
  if (text.trim().length === 0 && extraParts.length === 0) return null;
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: [
        ...(text.trim().length > 0 ? [{ type: "text", text }] : []),
        ...extraParts,
      ],
      parent_id: parentId,
      model_id: modelId,
      effort,
    })
    .select("id")
    .single();

  if (error) {
    console.error("assistant message insert failed:", error.message);
    return null;
  }

  const assistantId = data.id as string;

  // Advance the remembered branch so a reload comes back to this reply rather
  // than to whichever sibling happens to be newest. Best-effort: failing to
  // record the hint must not fail the turn the reader already paid for.
  const { error: headErr } = await supabase
    .from("conversations")
    .update({ head_message_id: assistantId })
    .eq("id", conversationId);
  if (headErr) console.error("head update failed:", headErr.message);

  return assistantId;
}

/** Replaces a stored reply's text — used when a disconnected run finishes. */
async function updateAssistant(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  id: string,
  text: string,
  extraParts: Part[] = [],
): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .update({
      content: [
        ...(text.trim().length > 0 ? [{ type: "text", text }] : []),
        ...extraParts,
      ],
    })
    .eq("id", id);

  if (error) console.error("assistant message update failed:", error.message);
}

/**
 * Download this turn's attachments and turn them into model content parts.
 *
 * The bucket is private, so these reads are themselves RLS-checked: a path
 * outside the caller's own prefix simply returns nothing.
 *
 * Three kinds, because the API accepts three different shapes — verified
 * empirically against api.meta.ai, not assumed:
 *   images  -> {type:"image_url"}  (JPEG, PNG, GIF, WebP, ICO only)
 *   PDFs    -> {type:"file"} with a data: URL in file.file_data
 *   text    -> inlined as a plain text part, which needs no file support
 *
 * Anything else is skipped rather than sent, because an unsupported part makes
 * the API reject the WHOLE request — one stray SVG would fail the entire turn.
 */
async function loadTurnFiles(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  attachmentIds: string[],
): Promise<Array<Record<string, unknown>>> {
  if (attachmentIds.length === 0) return [];

  const { data: rows, error } = await supabase
    .from("attachments")
    .select("storage_path, mime_type, size, filename")
    .in("id", attachmentIds)
    .limit(MAX_FILES_PER_TURN);

  if (error || !rows) {
    console.error("attachment lookup failed:", error?.message);
    return [];
  }

  const out: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const mime = String(row.mime_type ?? "").toLowerCase();
    const kind = MODEL_IMAGE_TYPES.has(mime)
      ? "image"
      : mime === "application/pdf"
      ? "pdf"
      : mime.startsWith("text/")
      ? "text"
      : null;

    if (!kind) {
      console.warn(`skipping unsupported attachment type: ${mime}`);
      continue;
    }

    const cap = kind === "text" ? MAX_INLINE_TEXT_BYTES : MAX_INLINE_FILE_BYTES;
    if (row.size > cap) {
      console.warn(`skipping oversized ${kind} attachment: ${row.size} bytes`);
      continue;
    }

    const { data: blob, error: dlErr } = await supabase.storage
      .from("chat-files")
      .download(row.storage_path);
    if (dlErr || !blob) {
      console.error("attachment download failed:", dlErr?.message);
      continue;
    }

    if (kind === "text") {
      // Truncated rather than dropped: a long CSV is still useful in part, and
      // the reader is told what happened instead of being silently ignored.
      const raw = await blob.text();
      const body = raw.length > MAX_INLINE_TEXT_CHARS
        ? raw.slice(0, MAX_INLINE_TEXT_CHARS) + "\n\n[truncated]"
        : raw;
      out.push({
        type: "text",
        text: `Attached file "${row.filename}":\n\n${body}`,
      });
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dataUrl = `data:${mime};base64,${base64(bytes)}`;

    out.push(
      kind === "image"
        ? { type: "image_url", image_url: { url: dataUrl } }
        : {
          type: "file",
          file: { filename: row.filename, file_data: dataUrl },
        },
    );
  }

  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
