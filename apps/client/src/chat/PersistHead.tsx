import { useEffect, useRef } from "react";
import { unstable_useThreadMessageIds } from "@assistant-ui/react";
import { supabase } from "../lib/supabase";
import type { MessageIdMap } from "./messageIds";

/**
 * Records which branch the reader is looking at, so a reload comes back to it.
 *
 * The Edge Function already advances the head whenever it writes a reply, which
 * covers sending, editing and regenerating. This covers the remaining case:
 * moving through the branch picker without sending anything.
 *
 * Renders nothing. Must be mounted inside AssistantRuntimeProvider.
 *
 * `unstable_useThreadMessageIds` is flagged unstable upstream, so this is
 * written to degrade rather than break — if it stops returning ids, the head
 * simply stops being updated and the reader falls back to the newest leaf.
 */
export default function PersistHead({
  conversationId,
  ids,
}: {
  conversationId: string;
  ids: MessageIdMap;
}) {
  const messageIds = unstable_useThreadMessageIds();
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    const leaf = messageIds.at(-1);
    if (!leaf) return;

    // Only messages the server has persisted can be a head; an in-flight reply
    // has no database row to point at yet.
    const dbId = ids.toDb(leaf);
    if (!dbId || dbId === lastWritten.current) return;

    // Debounced: stepping through several branches quickly should write once,
    // not once per click.
    const timer = setTimeout(() => {
      lastWritten.current = dbId;
      void supabase
        .from("conversations")
        .update({ head_message_id: dbId })
        .eq("id", conversationId)
        .then(({ error }) => {
          // A lost hint is not worth surfacing to the reader.
          if (error) console.warn("could not record branch head:", error.message);
        });
    }, 600);

    return () => clearTimeout(timer);
  }, [messageIds, ids, conversationId]);

  return null;
}
