/**
 * assistant-ui mints its own id for every message it creates in-session, while
 * the database mints a different one when the Edge Function writes the row.
 * Branching needs the two reconciled: to say "reply to THIS message" the client
 * has to name the database's id, not its own.
 *
 * Messages loaded from history are registered as identities, since their
 * runtime id already is the database id.
 *
 * Scope is one conversation. Switching conversations remounts the thread and
 * builds a fresh map, so ids from one never leak into another.
 */
export interface MessageIdMap {
  link(runtimeId: string, dbId: string): void;
  /** The database id for a runtime id, or null if it was never persisted. */
  toDb(runtimeId: string | null | undefined): string | null;
}

export function createMessageIdMap(): MessageIdMap {
  const map = new Map<string, string>();
  return {
    link(runtimeId, dbId) {
      map.set(runtimeId, dbId);
    },
    toDb(runtimeId) {
      if (!runtimeId) return null;
      return map.get(runtimeId) ?? null;
    },
  };
}
