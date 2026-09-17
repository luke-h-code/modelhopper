import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { defaultRoot, toolsAvailable, validateRoot } from "./toolHost";

export interface WorkingFolder {
  /** True only in the desktop shell. In a browser nothing below is rendered. */
  available: boolean;
  /** The folder this conversation will run commands in, once resolved. */
  root: string | null;
  /** Set once a stored folder turned out not to exist on this machine. */
  missing: string | null;
  /** Resolves to an error message, or null if the folder was accepted. */
  choose: (path: string) => Promise<string | null>;
}

/**
 * Which folder one conversation works in.
 *
 * The column is nullable and null means "the machine's default", which is why
 * the default is never written down: writing it would freeze today's answer
 * into a row that outlives the machine it was true on. A conversation has a
 * folder of its own only once someone picked one.
 *
 * The stored path is checked against the filesystem before it is used. A path
 * saved on a laptop and read on a desktop is the ordinary case for an account
 * that syncs, and the honest thing to do with one that is not there is say so
 * and fall back — not send the model a folder it will fail in on the first
 * command.
 */
export function useWorkingFolder(conversationId: string | null): WorkingFolder {
  const available = toolsAvailable();

  const [fallback, setFallback] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  // Guards against a slow load for a conversation the reader has already left
  // landing on top of the one they are now looking at.
  const currentId = useRef(conversationId);
  currentId.current = conversationId;

  // Read inside `choose`, where the state value would be the one captured when
  // the callback was made rather than the one the machine resolved.
  const fallbackRef = useRef<string | null>(null);
  fallbackRef.current = fallback;

  useEffect(() => {
    if (!available) return;
    void defaultRoot().then(setFallback);
  }, [available]);

  useEffect(() => {
    if (!available || !conversationId) return;
    let live = true;
    setChosen(null);
    setMissing(null);

    void (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("tool_root")
        .eq("id", conversationId)
        .maybeSingle();

      const stored = (data?.tool_root as string | null | undefined) ?? null;
      if (!live || currentId.current !== conversationId || !stored) return;

      const check = await validateRoot(stored);
      if (!live || currentId.current !== conversationId) return;

      if (check.ok) setChosen(check.path);
      else setMissing(stored);
    })();

    return () => {
      live = false;
    };
  }, [available, conversationId]);

  const choose = useCallback(
    async (path: string): Promise<string | null> => {
      if (!conversationId) return "Open a conversation first.";

      const check = await validateRoot(path);
      if (!check.ok) return check.reason;

      // Choosing the machine's own default stores null rather than the path it
      // resolved to. That is how a conversation goes back to being unpinned —
      // and it keeps today's default out of a row that will outlive this
      // machine, where the same path may name nothing.
      const pinned = check.path === fallbackRef.current ? null : check.path;

      // Shown immediately: the check already proved the folder is there, and
      // the write only decides whether it survives a reload.
      setChosen(pinned);
      setMissing(null);

      const { error } = await supabase
        .from("conversations")
        .update({ tool_root: pinned })
        .eq("id", conversationId);

      return error ? `Chosen, but not saved: ${error.message}` : null;
    },
    [conversationId],
  );

  return {
    available,
    root: chosen ?? fallback,
    missing,
    choose,
  };
}
