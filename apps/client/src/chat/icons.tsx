/**
 * Stroke icons sized to the 20px grid the sidebar and header use. They take
 * their colour from `currentColor`, so a parent's hover state is enough.
 */

const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** The panel-collapse glyph: a rounded frame with a divider near the left. */
export function PanelIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  );
}

export function NewChatIcon() {
  return (
    <svg {...base}>
      <path d="M4 20h16" />
      <path d="M14.5 5.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function RegenerateIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V10h-5.5" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <path d="M14.5 5.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * The composer's attach control. Drawn rather than typeset: a "+" character is
 * centred on the font's math axis, not on its em box, so a text plus always
 * sits fractionally high inside a square button however the box is aligned.
 */
export function PlusIcon() {
  return (
    <svg {...base} width={24} height={24} strokeWidth={2}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/** Row overflow menu. */
export function MoreIcon() {
  return (
    <svg {...base} width={18} height={18}>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Downward chevron for the jump-to-latest pill. */
export function ArrowDownIcon() {
  return (
    <svg {...base} width={14} height={14} strokeWidth={2}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  );
}

/** Halt the run: a filled square, the universal stop mark. */
export function StopIcon() {
  return (
    <svg {...base} width={16} height={16} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** A folder, drawn at the same 20px grid — the working-folder chip's mark. */
export function FolderIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <path d="M3 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.2H19a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/**
 * A laptop, for the notice that says a thing only happens on the desktop app.
 * Sized to 15px like FolderIcon, which is the other glyph that appears inline
 * next to a sentence rather than in a control.
 */
export function DesktopIcon() {
  return (
    <svg {...base} width={15} height={15}>
      <rect x="3" y="5" width="18" height="11" rx="2" />
      <path d="M2 19.5h20" />
    </svg>
  );
}
