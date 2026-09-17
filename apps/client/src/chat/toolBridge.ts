/**
 * The wait between a model asking to run something and a person deciding.
 *
 * The run generator in chatModelAdapter pauses on a promise from here; the
 * approval gate in the thread resolves it. Keeping the two ends in a module
 * rather than passing callbacks through message metadata means the gate can be
 * an ordinary component that knows nothing about the runtime.
 *
 * Nothing is held open while this waits: the HTTP request that produced the
 * tool call has already finished, and the next one has not been made. The turn
 * can sit here for as long as the person needs.
 */

export type Decision = "approve" | "deny";

const waiting = new Map<string, (decision: Decision) => void>();

/**
 * The id the continue checkpoint waits on.
 *
 * A checkpoint is the same shape of question as an approval — a person, a
 * promise, two buttons — so it rides the same bridge rather than getting a
 * parallel one. The prefix keeps it from ever colliding with a real
 * tool_use_id, which is a provider's string and never ours.
 */
export function continueId(assistantMessageId: string): string {
  return `continue:${assistantMessageId}`;
}

/** Resolves when the user decides about this call. */
export function awaitDecision(toolUseId: string): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    // A second request for the same id replaces the first. That only happens
    // if a run was abandoned and restarted, and the stale one is never read.
    waiting.get(toolUseId)?.("deny");
    waiting.set(toolUseId, resolve);
  });
}

/** Called by the gate. Unknown ids are ignored — the run already moved on. */
export function decide(toolUseId: string, decision: Decision): void {
  const resolve = waiting.get(toolUseId);
  if (!resolve) return;
  waiting.delete(toolUseId);
  resolve(decision);
}

/**
 * Abandon every pending decision, denying each.
 *
 * Called when a run is cancelled. Without it a generator that has been thrown
 * away stays parked on a promise nobody will ever resolve, holding its whole
 * closure alive.
 */
export function abandonAll(): void {
  for (const resolve of waiting.values()) resolve("deny");
  waiting.clear();
}
