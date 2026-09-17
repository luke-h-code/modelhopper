export type Role = "user" | "assistant" | "system";
/**
 * "fast" is the default and skips classification entirely, answering from the
 * small fast model. The two thinking levels classify each message and send it
 * to that category's specialist. "max" is offered but currently served at
 * medium. All three notes live in supabase/functions/chat/providers.ts.
 */
export type Effort = "fast" | "medium" | "max";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  role: Role;
  content: TextPart[] | string;
  created_at: string;
  /** Present on assistant replies, and on user turns created after 0006. */
  model_id: string | null;
  effort: Effort | null;
  /** Null for the first message in a thread. Siblings are alternative branches. */
  parent_id: string | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  mime_type: string;
  storage_path: string;
}

/**
 * The bucket is private, so a thumbnail needs a signed URL rather than a public
 * one. Long enough for a working session; short enough that a leaked URL is not
 * a standing grant.
 */
export const SIGNED_URL_TTL_SECONDS = 8 * 60 * 60;

/**
 * Whether a stored message is protocol rather than conversation: a call the
 * model made, or the result that answered it. Those rows are real and the
 * model needs them, but there is nothing in them to put on screen.
 */
export function isToolPlumbing(content: MessageRow["content"]): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      !!part &&
      ((part as { type?: unknown }).type === "tool_use" ||
        (part as { type?: unknown }).type === "tool_result"),
  );
}

/** Message content is stored as an array of parts; flatten it for display. */
export function partsToText(content: MessageRow["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}
