import { useEffect, useRef, useState } from "react";
import type { Effort } from "./types";

interface Props {
  value: Effort;
  onChange: (next: Effort) => void;
}

/**
 * "medium" is the wire value; Budget is the word. They differ because the
 * value is stored against every message ever sent and is on a check
 * constraint, so the rename stopped at the label — see the Effort type in
 * providers.ts.
 */
const LABELS: Record<Effort, string> = {
  fast: "Fast",
  medium: "Thinking · Budget",
  max: "Thinking · Max",
};

/**
 * Fast sits at the top level; the two thinking depths are a step behind a
 * "Thinking" row, so the expensive option cannot be picked by accident.
 *
 * Nothing marks that row as expandable visually — the submenu appearing right
 * under it is the affordance. aria-expanded still carries the state, so a
 * screen reader is told what the sighted reader can see.
 *
 * Fast is not only a depth: it answers from the small fast model whatever the
 * conversation was classified as, which is why the notes below name the model
 * rather than only the speed.
 */
export default function EffortControl({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [showDepths, setShowDepths] = useState(value !== "fast");
  const root = useRef<HTMLDivElement>(null);

  // A menu that outlives a click elsewhere would sit over the composer.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (next: Effort) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="effort-control" ref={root}>
      <button
        type="button"
        className="effort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setShowDepths(value !== "fast");
          setOpen((prev) => !prev);
        }}
      >
        {LABELS[value]}
      </button>

      {open && (
        <div className="effort-menu" role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === "fast"}
            className={`effort-option ${value === "fast" ? "is-selected" : ""}`}
            onClick={() => choose("fast")}
          >
            <span className="effort-option-name">Fast</span>
            <span className="effort-option-note">Rapid response</span>
          </button>

          <button
            type="button"
            aria-expanded={showDepths}
            className={`effort-option ${showDepths ? "is-open" : ""}`}
            onClick={() => setShowDepths((prev) => !prev)}
          >
            <span className="effort-option-name">Thinking</span>
            <span className="effort-option-note">
              Reasoning enabled
            </span>
          </button>

          {showDepths && (
            <div className="effort-submenu">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === "medium"}
                className={`effort-option ${value === "medium" ? "is-selected" : ""}`}
                onClick={() => choose("medium")}
              >
                <span className="effort-option-name">Budget</span>
                <span className="effort-option-note">
                  One low-cost model for everything
                </span>
              </button>

              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === "max"}
                className={`effort-option is-warning ${value === "max" ? "is-selected" : ""}`}
                onClick={() => choose("max")}
              >
                <span className="effort-option-name">Max</span>
                <span className="effort-option-note">
                  Routes to best-fit model · can rapidly drain allowance
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
