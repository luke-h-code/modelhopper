import type { ChatModelAdapter } from "@assistant-ui/react";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import type { MessageIdMap } from "./messageIds";
import type { Effort } from "./types";
import { abandonAll, awaitDecision, continueId } from "./toolBridge";
import { readThrown } from "./errors";
import {
  cancelRunningTools,
  platformName,
  runTool,
  toolEnv,
  toolsAvailable,
} from "./toolHost";

/**
 * How many times one turn may call a tool before we stop it.
 *
 * Every leg costs a request and a person's attention, and a model looping on
 * a folder it cannot make sense of would otherwise ask forever. Six is enough
 * to look around and answer; a genuine dead end should be reported, not
 * retried indefinitely.
 */
/**
 * How many times one turn may call a tool before it has to ask to keep going.
 *
 * Not a hard stop any more, and not a judgement about how much work the task
 * deserves — it is how far the turn may get before a person is asked again.
 * Running out puts a checkpoint on screen rather than ending the turn, so a
 * long job continues on a click and a model looping on a folder it cannot make
 * sense of stops in front of someone who can see that it is lost.
 *
 * Raising it means raising MAX_HISTORY_MESSAGES and MAX_HISTORY_CHARS in the
 * Edge Function with it: each leg writes two messages, history is dropped
 * oldest-first, and a loop long enough to overflow the budget evicts the
 * user's original question before anything else.
 */
export const MAX_TOOL_LEGS = 20;

/** What the reader is told when a turn declines to carry on. */
const STOPPED_HERE =
  `Stopped here. Everything found so far is above — ask me to carry on and I ` +
  `will pick up from there.`;

interface PendingTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The client's entire connection to the model: post an intent to the Edge
 * Function and render what streams back. Note what is NOT here — no API key,
 * no prompt assembly, no history. The client says "the user typed this in that
 * conversation"; the server decides everything else. That split is what makes
 * a decompiled client harmless.
 *
 * The response is newline-delimited JSON rather than raw text so that an error
 * occurring mid-stream is still reportable.
 *
 * Branching: the client names the message being replied to, and the server
 * hangs the new rows off it. A run whose prompting message already has a
 * database id is a REGENERATE — the user message exists, only a fresh reply is
 * wanted — so no content is sent and nothing is written twice.
 */
export function createChatModelAdapter(
  conversationId: string,
  getPendingAttachmentIds: () => string[],
  onFirstMessage: (text: string) => void,
  ids: MessageIdMap,
  getEffort: () => Effort,
  getToolRoot: () => string | null,
  /** Called when a turn ends, however it ends, so the balance can be re-read. */
  onTurnEnd: () => void,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_assistantMessageId }) {
      // The message this run is answering. On a new turn it was just typed; on
      // a regenerate or an edit it is the user message being (re)answered.
      const prompt = messages.at(-1);
      const promptDbId = ids.toDb(prompt?.id);
      const isRegenerate = promptDbId !== null;

      const text =
        prompt?.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n") ?? "";

      // The first turn promotes the conversation out of draft and names it in
      // the sidebar. Not awaited: the reply matters more than the label, and
      // the row already exists either way.
      if (messages.length <= 1 && text && !isRegenerate) onFirstMessage(text);

      // A new user message hangs off whatever preceded it on THIS branch, which
      // after an edit is not the same as the newest message in the thread.
      const parentDbId = isRegenerate
        ? promptDbId
        : ids.toDb(messages.at(-2)?.id);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired. Sign in again.");

      // Tools exist only in the desktop shell. In a browser the root is null,
      // no folder is sent, and the Edge Function declares no tools at all —
      // the web app never runs anything. What it can now do is say so: a
      // browser turn that asked for work on the user's machine comes back with
      // a notice before the reply rather than prose that quietly ignores the
      // request.
      //
      // Read once, at the top of the turn, and used for every leg of it. The
      // folder named in the system prompt, the folder shown on the approval
      // gate and the folder the command runs in are then the same one even if
      // the reader repoints the chat while a call is waiting on them.
      const capable = toolsAvailable();
      const root = capable ? getToolRoot() : null;
      const platform = capable ? platformName() : null;
      // Probed once per session and cached, so this is a round trip on the
      // first turn only.
      const env = root ? await toolEnv() : null;

      let acc = "";
      let reasoning = "";
      // Fixed text from the server, not the model's. Kept out of `acc` so it
      // is never persisted as part of the reply and never re-read on a
      // reload — it describes this device, and the same thread opened on the
      // desktop app would be showing a stale warning.
      let notice: string | null = null;
      let modelId: string | null = null;
      let appliedEffort: Effort = getEffort();
      let assistantDbId: string | null = null;
      let pending: PendingTool | null = null;
      let firstLeg = true;

      // tool_capable is sent whether or not a folder is open, and that is the
      // point of it. A turn that asks for work on the user's machine is
      // answered with a notice saying where that work can happen, and the
      // honest notice differs: a browser will never have a folder, while a
      // desktop chat is one click away from having one. Without this flag the
      // server cannot tell those two apart.
      const toolFields = root
        ? {
          tool_root: root,
          tool_platform: platform,
          tool_env: env,
          tool_capable: capable,
        }
        : { tool_capable: capable, ...(platform ? { tool_platform: platform } : {}) };

      let body: Record<string, unknown> = isRegenerate
        ? {
          conversation_id: conversationId,
          parent_id: parentDbId,
          effort: getEffort(),
          ...toolFields,
        }
        : {
          conversation_id: conversationId,
          parent_id: parentDbId,
          content: text,
          attachment_ids: getPendingAttachmentIds(),
          effort: getEffort(),
          ...toolFields,
        };

      // Stop has two jobs, and only the first used to happen.
      //
      // A run abandoned mid-approval leaves this generator parked on a promise
      // nobody will resolve, holding its whole closure open — abandonAll
      // denies those. But a command already running is a process on the user's
      // machine that knows nothing about this turn, so aborting the fetch left
      // it going: the reader pressed Stop, the conversation stopped, and their
      // disk carried on being searched.
      abortSignal?.addEventListener("abort", () => {
        abandonAll();
        void cancelRunningTools();
      }, { once: true });

      const snapshot = (toolCall: PendingTool | null) => ({
        content: [{ type: "text" as const, text: acc }],
        metadata: {
          custom: {
            modelId,
            effort: appliedEffort,
            reasoning,
            toolCall,
            notice,
            checkpoint,
          },
        },
      });

      // Set when the reader was asked whether to keep going and said no.
      // Tracked separately because `pending` is cleared at the bottom of every
      // iteration, which is what made the old check for this unreachable.
      let stopped = false;
      // The checkpoint currently on screen, if any. Rendered as its own
      // control rather than as an approval, because it is a different
      // question: not "may this command run" but "is this still worth doing".
      let checkpoint: string | null = null;
      // Legs remaining before the next checkpoint. Refilled on a yes, which is
      // what makes the limit a pause rather than a ceiling.
      let legsLeft = MAX_TOOL_LEGS;

      try {
        // No bound on the loop itself. What bounds it is `legsLeft` reaching
        // zero, which asks the reader whether to carry on — so the only way a
        // turn runs forever is someone choosing to let it, one click at a time.
        for (;;) {
          const res = await fetch(`${FUNCTIONS_URL}/chat`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: abortSignal,
          });

          if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => "");
            const message = readError(detail) ?? `Request failed (${res.status})`;

            // Out of allowance. Not an error in the sense the thread means by
            // one: nothing went wrong, there is simply no more money this
            // month. It ends the turn the same way Stop does — including
            // killing any command still running, because the loop it belonged
            // to is over — and reads as a sentence rather than a red box.
            if (res.status === 402) {
              void cancelRunningTools();
              acc += acc ? `\n\n${message}` : message;
              yield snapshot(null);
              return;
            }

            throw new Error(message);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          pending = null;
          // Each leg is a separate reply and reads as its own paragraph. The
          // text accumulates across all of them, so without this the last
          // sentence of one leg runs straight into the first word of the next:
          // "…any invoice files or relevant data.I will search the working
          // directory…". Inserted on the leg's first token rather than up
          // front, because a leg that only calls a tool contributes no text
          // and must not leave a gap behind it.
          let legHasText = false;
          // Reasoning is per leg, not per turn. It is only ever shown live,
          // under the spinner, so what matters is what the model is thinking
          // NOW — and letting it accumulate across twenty legs would grow an
          // unbounded string to re-render on every token, to display a thought
          // from four commands ago.
          reasoning = "";

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const raw of lines) {
              if (!raw.trim()) continue;

              let evt: {
                type?: string;
                text?: string;
                message?: string;
                message_id?: string | null;
                user_message_id?: string | null;
                model_id?: string;
                effort?: Effort;
                id?: string;
                name?: string;
                input?: unknown;
              };
              try {
                evt = JSON.parse(raw);
              } catch {
                continue;
              }

              if (evt.type === "meta") {
                if (evt.model_id) modelId = evt.model_id;
                if (
                  evt.effort === "fast" || evt.effort === "medium" ||
                  evt.effort === "max"
                ) {
                  appliedEffort = evt.effort;
                }
              } else if (evt.type === "notice" && evt.text) {
                notice = evt.text;
                yield snapshot(null);
              } else if (evt.type === "reasoning" && evt.text) {
                // Shown live under the spinner, then dropped — reasoning is not
                // part of the persisted reply, so it must not enter `acc`.
                reasoning += evt.text;
                yield snapshot(null);
              } else if (evt.type === "delta" && evt.text) {
                if (!legHasText && acc.length > 0) acc += "\n\n";
                legHasText = true;
                acc += evt.text;
                // LocalRuntime expects the full text so far, not just the delta.
                yield snapshot(null);
              } else if (evt.type === "tool_call" && evt.id && evt.name) {
                pending = {
                  id: evt.id,
                  name: evt.name,
                  input: (evt.input ?? {}) as Record<string, unknown>,
                };
              } else if (evt.type === "done") {
                // Record what the server called these rows, so the next turn can
                // name them as a parent. Without this, branching silently starts
                // a new root instead of continuing the thread.
                //
                // Only the first leg wrote the user's own message; later legs
                // write tool results, which the thread never shows.
                if (firstLeg && evt.user_message_id && prompt) {
                  ids.link(prompt.id, evt.user_message_id);
                }
                if (evt.message_id) assistantDbId = evt.message_id;
              } else if (evt.type === "error") {
                throw new Error(evt.message ?? "The reply failed.");
              }
            }
          }

          firstLeg = false;

          // No call, so the model answered and the turn is over.
          if (!pending) break;

          if (!assistantDbId) {
            throw new Error("The reply could not be saved, so it cannot continue.");
          }

          legsLeft -= 1;

          // Out of legs, and the model wants another call. Asked BEFORE the
          // approval gate rather than after it: the result of this call could
          // only be sent on a request that is not going to be made unless the
          // answer is yes, so approving a command first would run something on
          // the reader's machine that nobody would ever read. It happened
          // once, which is why the order matters.
          if (legsLeft <= 0) {
            checkpoint = continueId(assistantDbId);
            yield snapshot(null);

            const carryOn = await awaitDecision(checkpoint);
            checkpoint = null;

            if (carryOn === "deny") {
              stopped = true;
              break;
            }
            legsLeft = MAX_TOOL_LEGS;
          }

          // Everything stops here until a person decides. No request is open and
          // nothing is running; the turn can sit like this indefinitely.
          yield snapshot(pending);
          const decision = await awaitDecision(pending.id);
          yield snapshot(null);

          const outcome = decision === "approve"
            ? await runTool(pending.name, pending.input, root)
            : {
              output:
                "The user declined to run this. Do not try it again; either " +
                "suggest something else or answer without it.",
              isError: true,
            };

          // Killed mid-command by Stop. There is no point sending the result
          // of something the reader just cancelled, and the next fetch would
          // be aborted by the same signal anyway.
          if (abortSignal?.aborted) break;

          body = {
            conversation_id: conversationId,
            parent_id: assistantDbId,
            effort: getEffort(),
            ...toolFields,
            tool_result: {
              tool_use_id: pending.id,
              output: outcome.output,
              is_error: outcome.isError,
            },
          };
          pending = null;
        }

        if (stopped) {
          acc += acc ? `\n\n${STOPPED_HERE}` : STOPPED_HERE;
          yield snapshot(null);
        }

        if (assistantDbId && unstable_assistantMessageId) {
          ids.link(unstable_assistantMessageId, assistantDbId);
        }
      } catch (err) {
        // Anything that is not already an Error — a rejected Tauri call, a
        // runtime's own wrapper — reaches the thread as "[object Object]",
        // which tells the reader nothing and costs a trip through the console
        // to find out. The raw value is logged and a readable one rethrown.
        console.error("[tool loop] run failed:", err);
        throw err instanceof Error ? err : new Error(
          readThrown(err) || "The reply failed. See the console for what was thrown.",
        );
      } finally {
        // In a finally, because a failed turn still spent money — often more
        // than a successful one, since it paid for input tokens and got
        // nothing back.
        onTurnEnd();
      }
    },
  };
}

function readError(body: string): string | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}
