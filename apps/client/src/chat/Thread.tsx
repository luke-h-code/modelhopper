import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, ReactNode } from "react";
import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  AttachmentPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import { supabase } from "../lib/supabase";
import MarkdownText from "./MarkdownText";
import PersistHead from "./PersistHead";
import { createMessageIdMap } from "./messageIds";
import { createChatModelAdapter, MAX_TOOL_LEGS } from "./chatModelAdapter";
import { createAttachmentAdapter } from "./attachmentAdapter";
import { createHistoryAdapter } from "./historyAdapter";
import { readThrown } from "./errors";
import type { Effort } from "./types";
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  EditIcon,
  PlusIcon,
  RegenerateIcon,
  StopIcon,
} from "./icons";
import { modelName, providerForModel } from "./providerMarks";
import { decide } from "./toolBridge";
import { describeTool } from "./toolHost";
import EffortControl from "./EffortControl";
import type { Allowance } from "./useAllowance";

interface Props {
  /**
   * The pane's own chrome — the working-folder bar and the error banner —
   * rendered inside the drop zone rather than above it, so that a file dropped
   * on the bar attaches and the drop outline frames the whole pane. App owns
   * the markup; only the runtime context it has to sit inside lives here.
   */
  chrome?: ReactNode;
  conversationId: string;
  userId: string;
  displayName: string | null;
  onFirstMessage: (text: string) => void;
  /** The folder this conversation's commands run in. Null in a browser. */
  toolRoot: string | null;  allowance: Allowance;
}

/**
 * Mount this with key={conversationId} — the runtime holds thread state, so a
 * new conversation needs a new runtime rather than a mutated one.
 */
export default function Thread({
  chrome,
  conversationId,
  userId,
  displayName,
  onFirstMessage,
  toolRoot,
  allowance,
}: Props) {
  useSwallowStrayDrops();

  // Attachment ids uploaded by the composer for the turn currently being sent.
  // The model adapter drains this when it posts, so the Edge Function can link
  // the files to the message row it creates.
  const pendingAttachments = useRef<string[]>([]);
  const [effort, setEffort] = useState<Effort>("fast");
  const effortRef = useRef<Effort>("fast");

  // Restored from the thread's own history, not reset to Fast on every open.
  //
  // A thread someone deliberately set to Thinking is a thread about something
  // that needed it, and silently answering tomorrow's question with the fast
  // model is a change nobody has reason to notice — the control shows Fast,
  // and Fast is what they last saw it set to on some other conversation.
  //
  // Read from `messages.effort`, which already records what every turn used,
  // rather than a column on the conversation: a second copy of a fact the
  // database already holds is a thing that can disagree with it. The
  // (conversation_id, created_at) index from 0001 makes this the same lookup
  // the thread does anyway.
  //
  // Not awaited and not blocking: the composer opens on the default and
  // corrects itself a moment later, which is a better failure than a control
  // that cannot be used until a query comes back.
  useEffect(() => {
    if (!conversationId) return;
    let live = true;

    void (async () => {
      const { data } = await supabase
        .from("messages")
        .select("effort")
        .eq("conversation_id", conversationId)
        .not("effort", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const stored = data?.effort;
      if (!live) return;
      if (stored === "fast" || stored === "medium" || stored === "max") {
        effortRef.current = stored;
        setEffort(stored);
      }
    })();

    return () => {
      live = false;
    };
  }, [conversationId]);

  // Re-read when the conversation changes, which is the cheapest moment that
  // reliably follows a turn finishing. Polling would be the obvious
  // alternative and is not worth a request every few seconds for a number that
  // moves by pennies.
  // Owned by the workspace so the sidebar meter and this share one read.
  // Refreshed whenever a turn ends, which is the cheapest moment that reliably
  // follows money being spent — polling is not worth a request every few
  // seconds for a number that moves by pennies.
  const refreshAllowance = allowance.refresh;

  // Through a ref, not the adapter's arguments: changing the folder mid-chat
  // must not rebuild the runtime, which would throw away the thread on screen.
  // The next turn reads it, the one already running keeps the folder its
  // approval was given for.
  const rootRef = useRef<string | null>(toolRoot);
  rootRef.current = toolRoot;

  // Reconciles assistant-ui's in-session message ids with the database ids the
  // Edge Function assigns. Branching needs it: naming a parent means naming the
  // database's id. One map per conversation, rebuilt on remount.
  const ids = useMemo(() => createMessageIdMap(), []);

  const drainAttachments = useCallback(() => {
    const ids = pendingAttachments.current;
    pendingAttachments.current = [];
    return ids;
  }, []);

  const trackAttachment = useCallback((id: string) => {
    pendingAttachments.current.push(id);
  }, []);

  const chatModel = useMemo(
    () =>
      createChatModelAdapter(
        conversationId,
        drainAttachments,
        onFirstMessage,
        ids,
        () => effortRef.current,
        () => rootRef.current,
        refreshAllowance,
      ),
    [conversationId, drainAttachments, onFirstMessage, ids, refreshAllowance],
  );

  const runtime = useLocalRuntime(chatModel, {
    adapters: {
      history: useMemo(
        () => createHistoryAdapter(conversationId, ids),
        [conversationId, ids],
      ),
      attachments: useMemo(
        () => createAttachmentAdapter(conversationId, userId, trackAttachment),
        [conversationId, userId, trackAttachment],
      ),
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PersistHead conversationId={conversationId} ids={ids} />
      {/* Files dropped anywhere over this pane are attached to the next
          message — the working-folder bar included, which is why App passes its
          chrome down instead of rendering it above this. The sidebar is outside
          the zone and so is deliberately not a drop target. */}
      <ComposerPrimitive.AttachmentDropzone className="drop-zone">
      {chrome}
      <ThreadPrimitive.Root className="chat-thread flex h-full flex-col">
        <ThreadPrimitive.Viewport className="thread-viewport relative flex-1 overflow-y-auto px-4 py-7 md:px-8">
          {/* 1.3125rem is three quarters of the 1.75rem this used to be. A tool
              loop writes a message per leg, so the gap that read as breathing
              room between two turns read as a hole between twenty. */}
          <div className="mx-auto w-full max-w-[52rem] space-y-[1.3125rem]">
            <ThreadPrimitive.Empty>
              <div className="thread-empty pt-24 text-center">
                <h3>
                  {displayName ? `Hey, ${displayName}. Ready to dive in?` : "Ready when you are."}
                </h3>
                <p className="mt-2 text-sm text-ink-soft">
                  ModelHopper routes queries to the best-fit model.
                </p>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
                EditComposer,
              }}
            />
          </div>

          {/* Disabled — so invisible — whenever the viewport is already at the
              bottom, which is most of the time. Pulled down past the viewport's
              own padding so it sits just clear of the disclaimer below. */}
          <div className="sticky bottom-0 -mb-5 flex justify-center pt-2">
            <ThreadPrimitive.ScrollToBottom className="jump-latest">
              <ArrowDownIcon />
              Jump to latest
            </ThreadPrimitive.ScrollToBottom>
          </div>
        </ThreadPrimitive.Viewport>

        {/* pt-1, not pt-4: the gap between the jump-to-latest pill and the
            disclaimer is this padding plus the 8px the pill floats above the
            boundary, so the top padding is the only number that sets it. The
            composer's own distance from the window bottom is pb-4, untouched. */}
        <div className="composer-dock px-4 pt-1 pb-4 md:px-8">
          <p className="composer-disclosure mx-auto w-full max-w-[48rem]">
            {/* The running balance lives in the sidebar meter. This says the
                one thing the meter cannot: that the composer is disabled and
                why. */}
            {allowance.exhausted
              ? `You have used this month's allowance${
                allowance.resetsAt
                  ? `. It resets on ${allowance.resetsAt.toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                  })}`
                  : ""
              }.`
              : "ModelHopper routes you to AI. Check important info."}
          </p>
          <ComposerPrimitive.Root className="composer mx-auto w-full max-w-[48rem] p-2">
            <div className="flex flex-wrap gap-1.5 empty:hidden">
              <ComposerPrimitive.Attachments>
                {({ attachment }) => (
                  <span className="attachment-chip flex max-w-48 items-center gap-1 px-2 py-1 text-xs">
                    <span className="truncate">{attachment.name}</span>
                    <AttachmentPrimitive.Remove
                      className="text-ink-soft hover:text-danger"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ✕
                    </AttachmentPrimitive.Remove>
                  </span>
                )}
              </ComposerPrimitive.Attachments>
            </div>

            <div className="flex items-center gap-2">
              <ComposerPrimitive.AddAttachment
                className="attach-button shrink-0"
                aria-label="Attach a file"
                title="Attach, paste or drop a file — images, PDF, text, CSV"
              >
                <PlusIcon />
              </ComposerPrimitive.AddAttachment>

              <PasteAwareInput />

              <EffortControl
                value={effort}
                onChange={(next) => {
                  effortRef.current = next;
                  setEffort(next);
                }}
              />

              <ThreadPrimitive.If running={false}>
                {/* Disabled is a courtesy, not the control: the Edge Function
                    refuses the request regardless, and a client that ignored
                    this would only unlock a button whose every press is
                    refused server-side. */}
                <ComposerPrimitive.Send
                  className="send-button send-round shrink-0 text-base disabled:opacity-30"
                  aria-label="Send"
                  disabled={allowance.exhausted}
                  title={allowance.exhausted
                    ? "This month's allowance is used up"
                    : undefined}
                >
                  <span aria-hidden>↑</span>
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>

              <ThreadPrimitive.If running>
                {/* Same blue disc as Send, in the same place — one control
                    that changes meaning, rather than the pill reflowing. */}
                <ComposerPrimitive.Cancel
                  className="send-button send-round shrink-0"
                  aria-label="Stop generating"
                  title="Stop"
                >
                  <StopIcon />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>

      {/* Always mounted, shown by CSS while a drag is over the zone — the
          primitive puts data-dragging on the wrapper above. aria-hidden
          because a drag the reader is performing needs no announcement. */}
      <div className="drop-veil" aria-hidden>
        <span className="drop-veil-label">Drop to attach</span>
      </div>
      </ComposerPrimitive.AttachmentDropzone>
    </AssistantRuntimeProvider>
  );
}

/**
 * Swallow drops that land outside the drop zone.
 *
 * Without this the webview treats a stray file as a navigation and replaces
 * the app with the file's contents, losing whatever was typed. It attaches
 * nothing; it only makes a missed drop a no-op.
 */
function useSwallowStrayDrops() {
  useEffect(() => {
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
}

/**
 * The composer input, plus files pasted straight into it.
 *
 * A clipboard carrying files also carries a text rendering of them — a
 * spreadsheet arrives as both a file and a tab-separated blob — so when there
 * are files, the default text paste is suppressed and only the files are
 * taken. A paste with no files falls through untouched.
 */
function PasteAwareInput() {
  const aui = useAui();

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) return;

      event.preventDefault();
      const composer = aui.thread.composer();
      for (const file of files) {
        // Rejections surface through the composer's own attachment error
        // handling, the same as the + button.
        void composer.addAttachment(file);
      }
    },
    [aui],
  );

  return (
    <ComposerPrimitive.Input
      rows={1}
      placeholder="Send a message…"
      onPaste={onPaste}
      className="max-h-40 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none"
    />
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user-message group flex flex-col items-end gap-1.5">
      {/* Empty for messages without files, and `empty:hidden` collapses the gap. */}
      <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5 empty:hidden">
        <MessagePrimitive.Attachments>
          {({ attachment }) => <AttachmentChip attachment={attachment} />}
        </MessagePrimitive.Attachments>
      </div>

      <div className="user-bubble max-w-[88%] px-4 py-3 text-sm whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>

      <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Branches />
        <ActionBarPrimitive.Root hideWhenRunning className="flex">
          <ActionBarPrimitive.Edit
            className="message-action"
            aria-label="Edit message"
            title="Edit"
          >
            <EditIcon />
          </ActionBarPrimitive.Edit>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * An image shows as a thumbnail, anything else as a named chip.
 *
 * The thumbnail URL is a short-lived signed one produced when the file is
 * uploaded or the thread is loaded — the bucket is private, so there is no
 * public URL to fall back on. If it has expired the img fails and the chip
 * falls back to the filename rather than showing a broken image.
 */
function AttachmentChip({
  attachment,
}: {
  attachment: { name: string; type: string; content?: readonly unknown[] };
}) {
  const [broken, setBroken] = useState(false);

  const image = (attachment.content ?? []).find(
    (p): p is { type: "image"; image: string } =>
      !!p && typeof p === "object" && (p as { type?: string }).type === "image",
  );

  if (image && !broken) {
    return (
      <img
        src={image.image}
        alt={attachment.name}
        title={attachment.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className="attachment-image h-24 w-24 object-cover"
      />
    );
  }

  return (
    <span className="attachment-chip flex max-w-48 items-center gap-1 px-2 py-1 text-xs">
      <span aria-hidden>{attachment.type === "image" ? "🖼" : "📄"}</span>
      <span className="truncate">{attachment.name}</span>
    </span>
  );
}

/**
 * Editing a message does not overwrite it — assistant-ui forks the thread, and
 * since 0004 that fork is persisted as a sibling under the same parent. Both
 * versions stay in the database and the branch picker moves between them.
 */
function EditComposer() {
  return (
    <ComposerPrimitive.Root className="edit-composer ml-auto w-full max-w-[88%] p-2">
      <ComposerPrimitive.Input
        autoFocus
        className="max-h-60 w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
      />
      <div className="flex justify-end gap-2 pt-1">
        <ComposerPrimitive.Cancel className="text-action px-3 py-1.5 text-xs">
          Cancel
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className="send-button px-3 py-1.5 text-xs font-semibold disabled:opacity-40">
          Send
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

/** Hidden entirely until a message actually has more than one version. */
function Branches() {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className="flex items-center gap-0.5 text-xs text-ink-soft"
    >
      <BranchPickerPrimitive.Previous
        className="message-action disabled:opacity-30"
        aria-label="Previous version"
      >
        ‹
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next
        className="message-action disabled:opacity-30"
        aria-label="Next version"
      >
        ›
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

/**
 * Spinner plus whatever reasoning the provider is willing to expose, shown
 * only while this message is still being generated. Anthropic and Gemini both
 * return a summary of their thinking; the OpenAI-compatible Muse endpoint may
 * return nothing, and Fast disables thinking outright — in either case this is
 * a bare "Thinking…", which is the honest reading of "working, no commentary".
 */
/**
 * Both providers summarise their thinking as `**Heading** body`, repeatedly,
 * in one growing string. Split it back into the sections it was written as.
 *
 * Worth doing rather than printing the raw text: the asterisks survive to the
 * screen otherwise, and — more usefully — the most recent heading is a
 * ready-made one-line status. "Designing Spreadsheet Structure" is exactly
 * what a reader wants from a progress line, and the model writes it for free.
 */
function thoughtSections(raw: string): Array<{ heading: string | null; body: string }> {
  // A capturing split alternates: text, heading, text, heading, …
  const pieces = raw.split(/\*\*(.+?)\*\*/g);
  const sections: Array<{ heading: string | null; body: string }> = [];

  const lead = pieces[0]?.trim() ?? "";
  if (lead) sections.push({ heading: null, body: lead });

  for (let i = 1; i < pieces.length; i += 2) {
    sections.push({
      heading: pieces[i]!.trim(),
      body: (pieces[i + 1] ?? "").trim(),
    });
  }

  return sections;
}

/** The one line shown while collapsed. */
function thoughtHeadline(sections: ReturnType<typeof thoughtSections>): string {
  const last = sections.at(-1);
  if (!last) return "Thinking…";
  if (last.heading) return last.heading;

  // No heading yet — the opening of a summary, or a provider that does not use
  // them. The last sentence is the part still changing.
  const sentences = last.body.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.at(-1) ?? "Thinking…";
}

/**
 * Spinner plus what the model is doing, collapsed to a line and expandable.
 *
 * This has now been wrong in both directions. One clipped line hid the
 * explanation the reader needs most, because the next thing on screen is a
 * command to approve. The whole thought instead buried the reply under
 * paragraphs of raw thinking — several screens of it, asterisks and all,
 * pushing the answer off the bottom.
 *
 * So: a live heading by default, the detail on a click. The summary keeps
 * updating while collapsed, so it still reads as progress rather than as a
 * spinner that might be stuck.
 */
function ThinkingRow() {
  // Two selectors returning primitives: a selector that built an object would
  // return a new reference every render and defeat the store's equality check.
  const running = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  const reasoning = useAuiState((state) =>
    typeof state.message.metadata.custom.reasoning === "string"
      ? state.message.metadata.custom.reasoning
      : ""
  );
  // A turn parked on an approval or a checkpoint is still "running" as far as
  // the runtime is concerned — it is sitting on a promise nobody has resolved.
  // Saying "Thinking…" there is a lie with a cost: the reader waits for a
  // spinner that will never finish, because the thing it is waiting for is
  // them. The gate below says what is actually wanted, so this gets out of its
  // way rather than competing with it.
  const waitingOnUser = useAuiState((state) => {
    const custom = state.message.metadata.custom;
    return !!custom.toolCall || typeof custom.checkpoint === "string";
  });

  const [open, setOpen] = useState(false);

  if (!running || waitingOnUser) return null;

  const thought = reasoning.trim();
  const sections = thought ? thoughtSections(thought) : [];
  const headline = thought ? thoughtHeadline(sections) : "Thinking…";
  // Nothing to expand into until there is more than the line already shown.
  const hasDetail = sections.some((s) => s.body.length > 0);

  return (
    <div className="thinking" aria-live="polite">
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <span className="thinking-spinner" aria-hidden />
        <span className="thinking-text">{headline}</span>
        {hasDetail && (
          <span className={`thinking-chevron${open ? " is-open" : ""}`} aria-hidden>
            ›
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className="thinking-detail">
          {sections.map((section, i) => (
            <div className="thinking-section" key={i}>
              {section.heading && (
                <p className="thinking-heading">{section.heading}</p>
              )}
              {section.body && <p className="thinking-body">{section.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A run that threw renders as an empty assistant turn otherwise — the user
 * message stays on screen and nothing follows it, which reads as the app
 * hanging rather than failing. The Edge Function's own message is shown,
 * because "Conversation not found" and "Could not route conversation" point at
 * very different problems and the reader cannot see the logs.
 */
function ErrorRow() {
  // Primitive selectors only, for the reason given on ThinkingRow.
  const failed = useAuiState((state) => {
    const status = state.message.status;
    return status?.type === "incomplete" && status.reason === "error";
  });
  const detail = useAuiState((state) => {
    const status = state.message.status;
    return status?.type === "incomplete" && status.reason === "error"
      ? errorText(status.error)
      : "";
  });

  if (!failed) return null;

  return (
    <div className="message-error" role="alert">
      <span className="message-error-mark" aria-hidden>
        !
      </span>
      <span className="message-error-text">{detail}</span>
      <ActionBarPrimitive.Reload className="text-action" aria-label="Try again">
        Try again
      </ActionBarPrimitive.Reload>
    </div>
  );
}

/** Whatever was thrown, reduced to one readable line. */
function errorText(value: unknown): string {
  // Thrown Errors stringify as "Error: the actual message".
  return readThrown(value).replace(/^Error:\s*/, "").trim() || "The reply failed.";
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant-message group flex flex-col items-start gap-1">
      <ErrorRow />
      <PlatformNotice />
      <div className="assistant-bubble max-w-[92%] text-sm">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>

      {/* Below the reply, not above it. A tool loop writes a paragraph per leg,
          so an indicator pinned to the top drifts further from the thing it is
          describing with every leg — the reader ends up watching a spinner
          several screens away from the sentence it belongs to. At the bottom it
          stays where the next words will appear. */}
      <ThinkingRow />

      <ToolGate />
      <ContinueGate />

      {/* Actions reveal on hover and on keyboard focus; the model that answered
          stays visible, pushed to the right of the same row. */}
      <div className="message-footer flex w-full max-w-[92%] items-center gap-1">
        <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Branches />
          <ActionBarPrimitive.Root hideWhenRunning className="flex gap-1">
            <ActionBarPrimitive.Copy
              className="message-action group/copy"
              aria-label="Copy reply"
              title="Copy"
            >
              <span className="contents group-data-[copied]/copy:hidden">
                <CopyIcon />
              </span>
              <span className="hidden group-data-[copied]/copy:contents">
                <CheckIcon />
              </span>
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload
              className="message-action"
              aria-label="Regenerate reply"
              title="Regenerate"
            >
              <RegenerateIcon />
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </div>

        <AssistantModelBadge />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * What this device cannot do, said by the app rather than by the model.
 *
 * Shown above the reply when a turn asked for work on the user's computer
 * somewhere that cannot do it — the web app, or a desktop chat with no folder
 * open. The text is fixed and arrives from the Edge Function; the model that
 * answers is told the same thing, so the reply below reads as a considered
 * answer rather than as a contradiction of the line above it.
 *
 * Deliberately not a part of the message. It describes the device the question
 * was asked on, not the answer, so it does not survive a reload and does not
 * follow the thread onto another machine — where it would be a lie.
 */
function PlatformNotice() {
  const notice = useAuiState((state) => {
    const value = state.message.metadata.custom.notice;
    return typeof value === "string" && value.length > 0 ? value : null;
  });

  if (!notice) return null;

  return (
    <div className="platform-notice max-w-[92%]" role="note">
      <span className="platform-notice-mark" aria-hidden>
        <DesktopIcon />
      </span>
      <p className="platform-notice-text">{notice}</p>
    </div>
  );
}

/**
 * The checkpoint: the turn has used its run of tool calls and is asking whether
 * to keep going.
 *
 * Deliberately not an error and not an approval. Nothing has gone wrong and
 * nothing is waiting to run — the question is only whether this is still worth
 * doing, which is a judgement the person watching can make and the model
 * cannot. A model that has lost the thread looks exactly like one making
 * progress from the inside; from out here, twenty commands that found nothing
 * is obvious.
 *
 * The turn holds here with no request open, the same way an approval does, so
 * it can sit unanswered for as long as the reader needs.
 */
function ContinueGate() {
  const id = useAuiState((state) => {
    const value = state.message.metadata.custom.checkpoint;
    return typeof value === "string" && value.length > 0 ? value : null;
  });

  const [answered, setAnswered] = useState<string | null>(null);

  // A second checkpoint in one turn — twenty more calls later — must not show
  // up already answered.
  useEffect(() => {
    if (id) setAnswered(null);
  }, [id]);

  if (!id) return null;

  const answer = (decision: "approve" | "deny") => {
    setAnswered(decision);
    decide(id, decision);
  };

  return (
    <div className="continue-gate" role="group" aria-label="Keep going?">
      <p className="continue-gate-text">
        Still working — {MAX_TOOL_LEGS} tool calls since I last asked. Keep going?
      </p>
      <div className="continue-gate-foot">
        {answered === null
          ? (
            <>
              <button
                className="tool-gate-btn is-approve"
                onClick={() => answer("approve")}
              >
                Continue
              </button>
              <button className="tool-gate-btn" onClick={() => answer("deny")}>
                Stop
              </button>
            </>
          )
          : (
            <span className="tool-gate-done">
              {answered === "approve" ? "Carrying on…" : "Stopped"}
            </span>
          )}
      </div>
    </div>
  );
}

/**
 * The approval gate: the model has asked to run something, and nothing happens
 * until this is answered.
 *
 * Shown in full rather than summarised. A summarised command is an
 * unreviewable one, and the whole safety argument for running model-written
 * code on someone's own machine rests on them being able to read it first.
 */
function ToolGate() {
  const call = useAuiState((state) => {
    const value = state.message.metadata.custom.toolCall;
    return value && typeof value === "object"
      ? (value as { id: string; name: string; input: Record<string, unknown> })
      : null;
  });

  const [answered, setAnswered] = useState<string | null>(null);

  // A fresh call clears the previous answer, so a second request in the same
  // turn is not shown as already decided.
  useEffect(() => {
    if (call) setAnswered(null);
  }, [call?.id]);

  if (!call) return null;

  const described = describeTool(call.name, call.input);

  const answer = (decision: "approve" | "deny") => {
    setAnswered(decision);
    decide(call.id, decision);
  };

  return (
    <div className="tool-gate" role="group" aria-label="Approve this action">
      <div className="tool-gate-head">
        <span className="tool-gate-dot" aria-hidden />
        <span className="tool-gate-purpose">{described.headline}</span>
        <code className="tool-gate-name">{call.name}</code>
      </div>

      {/* Verbatim. A command the reader cannot see in full is one they cannot
          meaningfully approve. */}
      <pre className="tool-gate-body">{described.body}</pre>

      <div className="tool-gate-foot">
        {answered === null
          ? (
            <>
              <button
                className="tool-gate-btn is-approve"
                onClick={() => answer("approve")}
              >
                Approve
              </button>
              <button
                className="tool-gate-btn"
                onClick={() => answer("deny")}
              >
                Deny
              </button>
            </>
          )
          : (
            <span className="tool-gate-done">
              {answered === "approve" ? "Approved — running…" : "Denied"}
            </span>
          )}
      </div>
    </div>
  );
}

/** The model that produced this reply, bottom-right of the message. */
function AssistantModelBadge() {
  const modelId = useAuiState((state) => {
    const value = state.message.metadata.custom.modelId;
    return typeof value === "string" ? value : null;
  });

  // Shown once per run of the same model, on the LAST message of that run.
  //
  // A tool loop writes a message per leg, so badging every one repeated
  // "Gemini 3.8 Flash" down the whole thread and said nothing — a label that
  // never changes carries no information. What is worth knowing is where the
  // answer changed hands, and routing is per message, so that can happen
  // mid-thread.
  //
  // The last message of a run rather than the first, because the badge sits at
  // the foot of a message: there it reads as a footer for everything above it,
  // where marking the first would read as "only this one was Gemini". A run
  // that is still streaming is always the last, so the model answering right
  // now is always named.
  const endsRun = useAuiState((state) => {
    const current = state.message.metadata.custom.modelId;
    if (typeof current !== "string") return false;

    const messages = state.thread.messages;
    const index = messages.findIndex((message) => message.id === state.message.id);
    if (index === -1) return true;

    for (let i = index + 1; i < messages.length; i++) {
      const later = messages[i];
      if (later?.role !== "assistant") continue;
      const next = later.metadata?.custom?.modelId;
      // The next answer along decides it: same model means this one is mid-run
      // and says nothing new; anything else — including a message too new to
      // have been named yet — is a break worth marking.
      return next !== current;
    }

    // Nothing after it, so this is where the thread currently ends.
    return true;
  });

  // Nothing is known until the server's meta event names the model. A generic
  // "Assistant" chip in the meantime is a placeholder that says less than the
  // empty space it occupies, and it appears at exactly the moment the reader
  // is watching for the answer.
  if (!modelId || !endsRun) return null;

  const provider = providerForModel(modelId);
  const Mark = provider.mark;

  return (
    <span className="model-badge" title={`Answered by ${provider.label}`}>
      <span className="model-badge-mark" style={{ color: provider.tint }}>
        <Mark />
      </span>
      {modelName(modelId)}
    </span>
  );
}
