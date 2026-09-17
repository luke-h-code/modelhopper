import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import { useSession } from "./auth/useSession";
import SignIn from "./auth/SignIn";
import ConversationList from "./chat/ConversationList";
import Thread from "./chat/Thread";
import { useConversations } from "./chat/useConversations";
import { useAllowance } from "./chat/useAllowance";
import { useWorkingFolder } from "./chat/useWorkingFolder";
import WorkingFolderControl from "./chat/WorkingFolderControl";
import { NewChatIcon, PanelIcon } from "./chat/icons";

export default function App() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="app-loading flex h-full items-center justify-center">
        <span className="route-pulse" aria-hidden />
        <span>Loading workspace…</span>
      </div>
    );
  }

  if (!session) return <SignIn />;

  return <Workspace userId={session.user.id} email={session.user.email ?? null} />;
}

/**
 * A first name for the greeting. OTP sign-in collects no profile, so the email
 * local part is all there is: "ada.lovelace" -> "Ada".
 */
function nameFromEmail(email: string | null): string | null {
  const local = email?.split("@")[0];
  if (!local) return null;
  const first = local.split(/[._-]/)[0];
  if (!first || first.length < 2 || /\d/.test(first)) return null;
  return first[0]!.toUpperCase() + first.slice(1).toLowerCase();
}

function Workspace({ userId, email }: { userId: string; email: string | null }) {
  const {
    conversations,
    loading,
    error,
    create,
    remove,
    rename,
    promote,
  } = useConversations(userId);

  const displayName = useMemo(() => nameFromEmail(email), [email]);

  const [activeId, setActiveId] = useState<string | null>(null);

  // One balance for the whole workspace: the sidebar shows it, the thread
  // refreshes it when a turn ends. Two hook instances would be two independent
  // reads, and the one on screen would be the stale one.
  const allowance = useAllowance(activeId);
  // Open beside the thread on desktop; closed on phones, where it is a drawer
  // that would otherwise cover the conversation on load.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 767px)").matches,
  );

  const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

  // Open the most recent conversation once the list arrives. A draft counts as
  // active, so this cannot pull the reader out of one they just opened.
  useEffect(() => {
    if (!activeId && conversations.length > 0) {
      setActiveId(conversations[0]!.id);
    }
  }, [conversations, activeId]);

  // The row is written now so uploads and messages have something to reference;
  // it stays a draft, and so out of the sidebar, until the first message.
  const handleCreate = useCallback(async () => {
    const row = await create();
    if (!row) return;
    setActiveId(row.id);
    // Only the phone drawer covers the thread, so only it needs to close —
    // on desktop the sidebar stays exactly as the reader left it.
    if (isPhone()) setSidebarOpen(false);
  }, [create]);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await remove(id);
      if (ok && id === activeId) setActiveId(null);
    },
    [remove, activeId],
  );

  // The message that earns a draft its place in the sidebar.
  const handleFirstMessage = useCallback(
    (text: string) => {
      if (activeId) void promote(activeId, text);
    },
    [activeId, promote],
  );

  // Read here rather than inside the thread so the header can name the folder
  // and the thread can run in it from the same source. In a browser every
  // field on this is inert and nothing below renders.
  const folder = useWorkingFolder(activeId);

  // The bar and the error banner both render INSIDE the thread's drop zone
  // when a conversation is open, so a file dropped anywhere in this pane —
  // the bar included — attaches, and the drop outline frames the whole pane
  // rather than starting below the bar. The drop zone lives inside Thread
  // because it needs the assistant runtime's context, which is why this is a
  // node passed down rather than markup left here.
  const paneChrome = (
    <>
      {/* One slim bar for both breakpoints. The reopen controls appear only
          while the sidebar is collapsed, mirroring what it already shows. */}
      <header className="workspace-header">
        {!sidebarOpen && (
          <>
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
              title="Open sidebar"
              className="ghost-button"
            >
              <PanelIcon />
            </button>
            <button
              onClick={handleCreate}
              aria-label="New conversation"
              title="New conversation"
              className="ghost-button"
            >
              <NewChatIcon />
            </button>
          </>
        )}
        {/* Centred, and about the folder rather than the conversation. The
            title was already on screen twice — in the sidebar, selected, and
            in the browser tab — while the folder is the one thing here that
            changes what a turn can DO and has no other home. */}
        <div className="workspace-centre">
          {folder.available && (
            <>
              <span className="workspace-label">Working Directory:</span>
              <WorkingFolderControl folder={folder} />
            </>
          )}
        </div>
      </header>

      {error && (
        <p role="alert" className="error-banner px-4 py-2 text-sm">
          {error}
        </p>
      )}
    </>
  );

  return (
    <div className="app-shell flex h-full">
      {/* Sidebar: an overlay drawer on phones, a collapsible column from md up. */}
      <aside
        className={`sidebar-panel fixed inset-y-0 left-0 z-20 w-[17rem] transition-transform md:static ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:hidden"
        }`}
      >
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          loading={loading}
          onSelect={(id) => {
            setActiveId(id);
            // Only the phone drawer covers the thread, so only it must close.
            if (isPhone()) setSidebarOpen(false);
          }}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onRename={rename}
          onSignOut={() => void supabase.auth.signOut()}
          onToggleSidebar={() => setSidebarOpen(false)}
          allowance={allowance}
        />
      </aside>

      {sidebarOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-10 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      )}

      <main className="workspace-main flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <Thread
            key={activeId}
            chrome={paneChrome}
            conversationId={activeId}
            userId={userId}
            displayName={displayName}
            onFirstMessage={handleFirstMessage}
            toolRoot={folder.root}
            allowance={allowance}
          />
        ) : (
          <>
            {paneChrome}
            <div className="empty-state flex flex-1 items-center justify-center p-6 text-center">
              <div className="max-w-md">
                <p className="eyebrow">No active conversation</p>
                <h2>Select a conversation<br />or open a new channel.</h2>
                <p className="mt-4 text-sm text-ink-soft">Every request is routed to the model best equipped to answer it.</p>
                <button
                  onClick={handleCreate}
                  className="primary-button mt-7 px-5 py-3 text-sm font-semibold"
                >
                  Start a conversation <span aria-hidden>↗</span>
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
