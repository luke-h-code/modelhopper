import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { ConversationRow } from "./types";

const TITLE_MAX = 60;

export function useConversations(userId: string) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The sidebar is this query. Drafts — conversations opened but never sent to
   * — are excluded here rather than filtered in the UI, so a reload shows the
   * same history as a fresh sign-in on another device.
   */
  /** Resolves true when the load failed, so the caller can decide to retry. */
  const refresh = useCallback(async (): Promise<boolean> => {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, created_at, updated_at")
      .eq("is_draft", false)
      .order("updated_at", { ascending: false });

    if (error) {
      setError(error.message);
      setLoading(false);
      return true;
    }

    setConversations((data ?? []) as ConversationRow[]);
    // Cleared on success, so a retry that works takes the banner with it.
    setError(null);
    setLoading(false);
    return false;
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Retried once, after a beat. The first load can fail for reasons that
    // have nothing to do with the reader and are gone a second later — a
    // token used in the same moment it was minted comes back "JWT issued at
    // future" when the REST node's clock is a hair behind the auth node's,
    // which is most likely on a fresh sign-in, which is exactly when someone
    // opens the app for the first time.
    //
    // Before this, one such failure was permanent: nothing re-ran the query
    // for the life of the session, so the sidebar said "No conversations yet"
    // to somebody with a hundred of them, under a red banner quoting a JWT.
    void (async () => {
      const failed = await refresh();
      if (failed && live) timer = setTimeout(() => void refresh(), 1500);
    })();

    // A refreshed token is the other moment a failed load becomes loadable,
    // and it arrives on its own schedule rather than on ours.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") void refresh();
    });

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, [refresh]);

  /**
   * Inserts the row. `id` is supplied by the caller for a conversation the UI
   * has already opened as a draft — the client picks the uuid so the thread can
   * exist on screen, and in the storage paths its attachments use, before
   * anything is written down.
   */
  /**
   * Opens a conversation. The row is written immediately — attachments and
   * messages both reference it — but as a draft, so it stays out of the
   * sidebar until `promote` is called with the reader's first message.
   */
  const create = useCallback(async () => {
    // At most one draft per person. Clicking "New conversation" twice should
    // not leave a row behind each time, and a draft is empty by definition —
    // reopening the existing one is indistinguishable from a fresh insert, so
    // this bounds the drafts table without ever deleting anything.
    const { data: existing } = await supabase
      .from("conversations")
      .select("id, title, created_at, updated_at")
      .eq("is_draft", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return existing as ConversationRow;

    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId })
      .select("id, title, created_at, updated_at")
      .single();

    if (error || !data) {
      setError(error?.message ?? "Could not create conversation");
      return null;
    }
    return data as ConversationRow;
  }, [userId]);

  const remove = useCallback(
    async (id: string) => {
      // Delete the files first. The attachments rows cascade away with the
      // conversation, but Storage objects do not — dropping the rows first
      // would strand the files in the bucket with nothing left pointing at
      // them. For a business tool that is a data-retention problem, not just
      // wasted space.
      const prefix = `${userId}/${id}`;
      const { data: files } = await supabase.storage
        .from("chat-files")
        .list(prefix);

      if (files && files.length > 0) {
        const { error: rmErr } = await supabase.storage
          .from("chat-files")
          .remove(files.map((f) => `${prefix}/${f.name}`));
        if (rmErr) {
          setError(`Could not delete attachments: ${rmErr.message}`);
          return false;
        }
      }

      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", id);
      if (error) {
        setError(error.message);
        return false;
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
      return true;
    },
    [userId],
  );

  /** Renames a conversation to whatever the user typed. */
  const rename = useCallback(async (id: string, next: string) => {
    const title = next.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX);
    if (!title) return false;

    // Optimistic: the sidebar is the only reader, and a failure restores it.
    let previous: string | undefined;
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        previous = c.title;
        return { ...c, title };
      }),
    );

    const { error } = await supabase
      .from("conversations")
      .update({ title })
      .eq("id", id);

    if (error) {
      setError(error.message);
      if (previous !== undefined) {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: previous! } : c)),
        );
      }
      return false;
    }
    return true;
  }, []);

  /**
   * Turns a draft into a listed conversation, naming it after the message that
   * earned it the place. One statement, so a conversation cannot appear in the
   * sidebar under the placeholder title.
   *
   * Guarded on is_draft rather than on the title: that makes it idempotent, so
   * a resend or a retry does not rename a conversation the reader has since
   * renamed themselves.
   */
  const promote = useCallback(async (id: string, text: string) => {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (!trimmed) return;
    const title =
      trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;

    const { data, error } = await supabase
      .from("conversations")
      .update({ title, is_draft: false })
      .eq("id", id)
      .eq("is_draft", true)
      .select("id, title, created_at, updated_at")
      .maybeSingle();

    if (error) {
      setError(error.message);
      return;
    }
    // No row means it was already promoted — a second message, or a retry.
    if (!data) return;

    setConversations((prev) => [
      data as ConversationRow,
      ...prev.filter((c) => c.id !== id),
    ]);
  }, []);

  return {
    conversations,
    loading,
    error,
    refresh,
    create,
    remove,
    rename,
    promote,
  };
}
