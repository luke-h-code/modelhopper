import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ConversationRow } from "./types";
import { MoreIcon, NewChatIcon, PanelIcon, SearchIcon } from "./icons";
import {
  type Allowance,
  fetchModelSpend,
  formatCount,
  formatMicros,
  type ModelSpend,
} from "./useAllowance";

interface Props {
  allowance: Allowance;
  conversations: ConversationRow[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onSignOut: () => void;
  onToggleSidebar: () => void;
}

/**
 * What is left of this month's allowance, above the account row.
 *
 * Always visible rather than only when low. A number that appears when it is
 * nearly gone is a warning, and the point of this one is to be watchable while
 * it moves — a twenty-leg loop on Opus is a visible bite out of it, and seeing
 * that happen is the whole reason to show a balance rather than a receipt.
 *
 * It re-reads whenever a turn ends, so it falls as the money is spent rather
 * than on the next reload.
 */
function AllowanceMeter({ allowance }: { allowance: Allowance }) {
  const { remainingMicros, grantMicros, resetsAt, exhausted } = allowance;
  const [open, setOpen] = useState(false);

  // Nothing at all until the first read lands. A "£0.00" that means "not
  // loaded yet" is worse than a gap, because it reads as the bad news.
  if (remainingMicros === null || grantMicros <= 0) return null;

  const fraction = Math.max(0, Math.min(1, remainingMicros / grantMicros));
  const resets = resetsAt?.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });

  return (
    <div className={`allowance${exhausted ? " is-spent" : ""}`}>
      <button
        type="button"
        className="allowance-button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        title={resets ? `Resets ${resets}` : undefined}
      >
        <div className="allowance-line">
          <span className="allowance-amount">
            {exhausted ? "No allowance left" : `${formatMicros(remainingMicros)} left`}
          </span>
          <span className="allowance-resets">{open ? "Close" : resets}</span>
        </div>
        <div
          className="allowance-track"
          role="meter"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Allowance remaining this month"
        >
          <div className="allowance-fill" style={{ width: `${fraction * 100}%` }} />
        </div>
      </button>

      {open && <SpendBreakdown />}
    </div>
  );
}

/**
 * Where the month's money went, by model.
 *
 * By model rather than by conversation because that is the actionable cut: the
 * models differ by more than twenty times per token, so "most of it went to
 * Opus" tells you what to change, where "most of it went to Tuesday" does not.
 *
 * Cached tokens are called out separately. They are the reason a twenty-leg
 * loop is affordable at all — the same history resent twenty times is mostly
 * cache hits at a tenth of the price — and without the line it looks as though
 * the token counts and the cost disagree.
 */
function SpendBreakdown() {
  const [rows, setRows] = useState<ModelSpend[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchModelSpend().then((next) => {
      if (live) setRows(next);
    });
    return () => {
      live = false;
    };
  }, []);

  if (rows === null) return <p className="spend-empty">Loading…</p>;
  if (rows.length === 0) return <p className="spend-empty">Nothing spent yet.</p>;

  return (
    <div className="spend">
      {rows.map((row) => (
        <div className="spend-row" key={row.model}>
          <div className="spend-head">
            {/* Named and converted by the view. Nothing here decides what a
                model is called or what it cost. */}
            <span className="spend-model">{row.model}</span>
            <span className="spend-cost">{formatMicros(row.costMicroGbp)}</span>
          </div>
          <div className="spend-detail">
            {formatCount(row.calls)} {row.calls === 1 ? "use" : "uses"}
            {" · "}
            {formatCount(row.inputTokens + row.cachedInputTokens)} toks in
            {" · "}
            {formatCount(row.outputTokens)} toks out
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A sidebar title that scrolls itself into view on hover.
 *
 * The overflow can only be measured from the live element, so the distance and
 * a duration proportional to it are written to custom properties that the
 * keyframes read. Titles that already fit clear the properties, which leaves
 * the animation at its 0s default — a no-op rather than a twitch.
 */
function ScrollingTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties>();

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow < 2) {
      setStyle(undefined);
      return;
    }
    setStyle({
      "--shift": `-${overflow}px`,
      // Roughly 45px a second, with a floor so short overruns stay readable.
      "--dur": `${Math.max(1.1, overflow / 45).toFixed(2)}s`,
    } as CSSProperties);
  }, []);

  return (
    <span ref={ref} className="conv-title" onPointerEnter={measure} style={style}>
      <span className="conv-title-inner">{text}</span>
    </span>
  );
}

/** Inline rename. Enter commits, Escape and blur both leave the title alone. */
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <input
      autoFocus
      className="rename-field"
      value={value}
      aria-label="Conversation title"
      onChange={(event) => setValue(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}

/**
 * Per-row overflow menu.
 *
 * Rename used to be a double-click on the title, which is undiscoverable and
 * collides with double-clicking to select a word. Both actions now live behind
 * the same control, and delete is one of them rather than a permanently
 * visible button one row's width from the conversation it destroys.
 */
/**
 * Roughly how tall the popup is, used to decide whether it opens up or down.
 *
 * A constant rather than a measurement because the menu is always the same two
 * items. Measuring would mean rendering it somewhere invisible first, which is
 * a lot of machinery to learn a number that only changes if someone adds a
 * third option — and if they do, this is wrong by one row and the menu opens
 * downward slightly too often, which is a nudge rather than a bug.
 */
const ROW_MENU_HEIGHT = 80;

function RowMenu({
  onRename,
  onDelete,
  label,
}: {
  onRename: () => void;
  onDelete: () => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  // Where to draw the popup, in viewport coordinates. Null while closed.
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  /**
   * Measure the trigger and decide which way the menu opens.
   *
   * The conversation list scrolls, and a scrolling box clips what hangs out of
   * it — so a menu on the last row was cut off by the bottom of the sidebar.
   * The popup is therefore rendered into `document.body` rather than into the
   * row, which takes it out of the clipping box entirely. `position: fixed`
   * alone would not have done it: the sidebar panel carries a transform for
   * its slide-in, and a transform makes it the containing block for fixed
   * descendants, so the coordinates would have been measured against the
   * viewport and applied against the panel.
   */
  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;

    const below = window.innerHeight - rect.bottom;
    // Right-aligned with the trigger, the way it was when it was a child of it.
    const right = window.innerWidth - rect.right;

    setAt(
      below < ROW_MENU_HEIGHT
        ? { bottom: window.innerHeight - rect.top + 4, right }
        : { top: rect.bottom + 4, right },
    );
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu is no longer inside this component's DOM, so it has to be
      // asked about separately or clicking an item would close the menu
      // before the item's own handler ran.
      if (trigger.current?.contains(target)) return;
      if (menu.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Closed rather than followed. The coordinates are measured once, so a
    // scroll would leave the popup floating beside nothing — and re-measuring
    // on every scroll frame is a lot of work to keep a menu glued to a row the
    // reader has evidently stopped looking at. `capture` because the list
    // scrolls, not the window, and a scroll event on it does not bubble.
    const onScroll = () => setOpen(false);

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const toggle = () => {
    if (!open) place();
    setOpen((prev) => !prev);
  };

  return (
    <div className="row-menu">
      <button
        ref={trigger}
        className={`conversation-more ${open ? "is-open" : ""}`}
        aria-label={`Options for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreIcon />
      </button>

      {open && at && createPortal(
        <div
          ref={menu}
          className="row-menu-list"
          role="menu"
          style={{ top: at.top, bottom: at.bottom, right: at.right }}
        >
          <button
            role="menuitem"
            className="row-menu-item"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          <button
            role="menuitem"
            className="row-menu-item is-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function ConversationList({
  allowance,
  conversations,
  activeId,
  loading,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onSignOut,
  onToggleSidebar,
}: Props) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Titles are already in memory, so filtering needs no round trip.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(needle));
  }, [conversations, query]);

  return (
    <div className="conversation-panel flex h-full flex-col">
      <div className="sidebar-top">
        <span className="brand-mark">
          Model<span>Hopper</span>
        </span>
        <button
          onClick={onToggleSidebar}
          className="ghost-button"
          aria-label="Close sidebar"
          title="Close sidebar"
        >
          <PanelIcon />
        </button>
      </div>

      <div className="px-2 pb-1">
        <button onClick={onCreate} className="nav-row">
          <NewChatIcon />
          <span>New conversation</span>
        </button>
      </div>

      <div className="px-2 pb-1">
        <div className="search-field">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search conversations"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversations">
        <p className="section-label">Chats</p>

        {loading && <p className="sidebar-note">Loading…</p>}
        {!loading && conversations.length === 0 && (
          <p className="sidebar-note">No conversations yet.</p>
        )}
        {!loading && conversations.length > 0 && visible.length === 0 && (
          <p className="sidebar-note">No chats match “{query.trim()}”.</p>
        )}

        <ul className="conversation-list">
          {visible.map((c) => (
            <li key={c.id} className="group relative">
              {editingId === c.id ? (
                <RenameField
                  initial={c.title}
                  onCancel={() => setEditingId(null)}
                  onCommit={async (next) => {
                    setEditingId(null);
                    if (next !== c.title) await onRename(c.id, next);
                  }}
                />
              ) : (
                <>
                  <button
                    onClick={() => onSelect(c.id)}
                    aria-current={c.id === activeId ? "true" : undefined}
                    className={`conversation-item ${c.id === activeId ? "is-active" : ""}`}
                  >
                    <ScrollingTitle text={c.title} />
                  </button>
                  <RowMenu
                    label={c.title}
                    onRename={() => setEditingId(c.id)}
                    onDelete={() => onDelete(c.id)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="account-strip">
        <AllowanceMeter allowance={allowance} />
        <button onClick={onSignOut} className="nav-row">
          <span className="account-avatar" aria-hidden />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}
