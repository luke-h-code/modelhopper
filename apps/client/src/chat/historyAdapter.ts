import type {
  CompleteAttachment,
  ThreadHistoryAdapter,
  ThreadMessage,
} from "@assistant-ui/react";
import { supabase } from "../lib/supabase";
import {
  isToolPlumbing,
  partsToText,
  SIGNED_URL_TTL_SECONDS,
  type AttachmentRow,
  type MessageRow,
} from "./types";
import type { MessageIdMap } from "./messageIds";

/**
 * Loads a thread from Postgres when a conversation is opened.
 *
 * `append` is deliberately a no-op: the Edge Function is the single writer of
 * message rows. Persisting from here as well would double-write every turn and
 * race the streamed text against the stored text.
 *
 * Since migration 0004 a conversation is a tree rather than a list, so rows are
 * handed back with their real parent_id and assistant-ui reconstructs the
 * branches. `headId` picks which branch is shown on open: the one containing
 * the newest message, i.e. wherever the reader last was.
 */
export function createHistoryAdapter(
  conversationId: string,
  ids: MessageIdMap,
): ThreadHistoryAdapter {
  return {
    async load() {
      // Both queries are RLS-scoped, so a conversation that isn't the caller's
      // simply comes back empty rather than erroring.
      const [messageRes, attachmentRes, conversationRes] = await Promise.all([
        supabase
          .from("messages")
          .select("id, role, content, created_at, parent_id, model_id, effort")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true }),
        supabase
          .from("attachments")
          .select("id, message_id, filename, mime_type, storage_path")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true }),
        supabase
          .from("conversations")
          .select("head_message_id")
          .eq("id", conversationId)
          .maybeSingle(),
      ]);

      if (messageRes.error)
        throw new Error(`Could not load thread: ${messageRes.error.message}`);

      const rows = (messageRes.data ?? []) as MessageRow[];

      // A failed attachment query shouldn't cost you the thread — the messages
      // still render, just without their file chips.
      const rawAttachments = ((attachmentRes.data ?? []) as AttachmentRow[])
        // Rows with no message_id are uploads whose turn never completed.
        .filter((a) => a.message_id);

      // One batched call for every thumbnail rather than one per image. A
      // failure here costs the previews, not the thread.
      const signed = new Map<string, string>();
      const imagePaths = rawAttachments
        .filter((a) => a.mime_type.startsWith("image/"))
        .map((a) => a.storage_path);

      if (imagePaths.length > 0) {
        const { data: urls } = await supabase.storage
          .from("chat-files")
          .createSignedUrls(imagePaths, SIGNED_URL_TTL_SECONDS);
        for (const u of urls ?? []) {
          if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl);
        }
      }

      const byMessage = new Map<string, CompleteAttachment[]>();
      for (const a of rawAttachments) {
        const url = signed.get(a.storage_path);
        const list = byMessage.get(a.message_id!) ?? [];
        list.push({
          id: a.id,
          type: a.mime_type.startsWith("image/") ? "image" : "document",
          name: a.filename,
          contentType: a.mime_type,
          status: { type: "complete" },
          // An image part carries the signed URL so the chip can show a
          // thumbnail; anything else falls back to naming the file.
          content: url
            ? [{ type: "image", image: url, filename: a.filename }]
            : [{ type: "text", text: `[attached: ${a.filename}]` }],
        });
        byMessage.set(a.message_id!, list);
      }

      const messages: { parentId: string | null; message: ThreadMessage }[] = [];
      // A message that is only a tool call, or only its result, has nothing to
      // show. Dropping it would orphan whatever came next, so instead its
      // children are redirected onto its parent and the branch stays one
      // chain — the reader sees the question and the answer, not the plumbing
      // between them.
      const collapsed = new Map<string, string | null>();
      for (const row of rows) {
        if (partsToText(row.content) === "" && isToolPlumbing(row.content)) {
          collapsed.set(row.id, row.parent_id);
        }
      }

      const present = new Set(
        rows.filter((r) => !collapsed.has(r.id)).map((r) => r.id),
      );

      const resolveParent = (start: string | null): string | null => {
        let current = start;
        const seen = new Set<string>();
        while (current && collapsed.has(current) && !seen.has(current)) {
          seen.add(current);
          current = collapsed.get(current) ?? null;
        }
        return current && present.has(current) ? current : null;
      };

      for (const row of rows) {
        if (row.role === "system") continue;
        if (collapsed.has(row.id)) continue;

        // Every loaded row is already a database id, so map it to itself. This
        // is what lets the next turn name it as a parent.
        ids.link(row.id, row.id);

        const text = partsToText(row.content);
        const createdAt = new Date(row.created_at);

        const message: ThreadMessage =
          row.role === "assistant"
            ? {
                id: row.id,
                role: "assistant",
                content: [{ type: "text", text }],
                createdAt,
                status: { type: "complete", reason: "stop" },
                metadata: {
                  unstable_state: null,
                  unstable_annotations: [],
                  unstable_data: [],
                  steps: [],
                  custom: {
                    modelId: row.model_id,
                    effort: row.effort,
                  },
                },
              }
            : {
                id: row.id,
                role: "user",
                content: [{ type: "text", text }],
                createdAt,
                attachments: byMessage.get(row.id) ?? [],
                metadata: { custom: {} },
              };

        // A parent that was filtered out (a system message) or is missing would
        // orphan the row, so it is re-rooted rather than dropped.
        const parentId = resolveParent(row.parent_id);

        messages.push({ parentId, message });
      }

      // Restore the branch the reader was last on. The stored head is only a
      // hint: it can name a message that has since been deleted, or predate a
      // reply written by another device, so it is used only if still present.
      const storedHead = conversationRes.data?.head_message_id as
        | string
        | null
        | undefined;

      const headId =
        storedHead && messages.some((m) => m.message.id === storedHead)
          ? storedHead
          // Rows are ascending by created_at, so the last is the newest — the
          // leaf of whichever branch was most recently active.
          : (messages.at(-1)?.message.id ?? null);

      return { messages, headId };
    },

    async append() {
      // Intentionally empty — see the note above.
    },
  };
}
