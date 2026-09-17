import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
  Attachment,
} from "@assistant-ui/react";
import { supabase } from "../lib/supabase";
import { SIGNED_URL_TTL_SECONDS } from "./types";

const BUCKET = "chat-files";
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Uploads composer attachments to a private bucket.
 *
 * Path layout: chat-files/{user_id}/{conversation_id}/{uuid}
 *
 * The leading user_id segment is not decoration — the Storage RLS policy pins
 * it to auth.uid(), so the path itself is the authorisation check. A client
 * that tampers with the prefix gets rejected by Postgres, not by this file.
 *
 * `send()` runs before the message row exists, so the attachment row is written
 * with a null message_id and the Edge Function links it afterwards.
 */
export function createAttachmentAdapter(
  conversationId: string,
  userId: string,
  trackUploaded: (attachmentId: string) => void,
): AttachmentAdapter {
  return {
    // Deliberately not "image/*": SVG, BMP and TIFF are images the model API
    // rejects, and one rejected part fails the whole turn. This list mirrors
    // MODEL_IMAGE_TYPES in the Edge Function — keep the two in step.
    accept: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
    ].join(","),

    async add({ file }): Promise<PendingAttachment> {
      if (file.size > MAX_BYTES) {
        throw new Error(
          `${file.name} is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.`,
        );
      }
      return {
        id: crypto.randomUUID(),
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },

    async send(attachment): Promise<CompleteAttachment> {
      const file = attachment.file;
      if (!file) throw new Error("Attachment has no file.");

      const path = `${userId}/${conversationId}/${crypto.randomUUID()}`;

      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });
      if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

      const { data: row, error: rowErr } = await supabase
        .from("attachments")
        .insert({
          conversation_id: conversationId,
          user_id: userId,
          storage_path: path,
          filename: file.name,
          mime_type: file.type || "application/octet-stream",
          size: file.size,
        })
        .select("id")
        .single();

      if (rowErr || !row) {
        // Don't leave an orphaned object behind if the row insert failed.
        await supabase.storage.from(BUCKET).remove([path]);
        throw new Error(`Could not record attachment: ${rowErr?.message}`);
      }

      trackUploaded(row.id);

      // Images carry a signed URL so the chip shows a thumbnail immediately,
      // matching what historyAdapter produces on reload. The bucket is
      // private, so a public URL is not an option.
      let preview: string | null = null;
      if (file.type.startsWith("image/")) {
        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        preview = signed?.signedUrl ?? null;
      }

      return {
        ...attachment,
        status: { type: "complete" },
        content: preview
          ? [{ type: "image", image: preview, filename: file.name }]
          : [{ type: "text", text: `[attached: ${file.name}]` }],
      };
    },

    async remove(attachment: Attachment) {
      // Only removes it from the composer; nothing has been uploaded yet.
      void attachment;
    },
  };
}
