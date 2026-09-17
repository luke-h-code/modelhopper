import { useState } from "react";
import { FolderIcon } from "./icons";
import { chooseFolder, folderName } from "./toolHost";
import type { WorkingFolder } from "./useWorkingFolder";

/**
 * Which folder this conversation's commands run in.
 *
 * It sits in the header because it is the one thing a reader has to know
 * before approving anything: the gate shows the command, and this shows where
 * it lands. A command reviewed without knowing that is not really reviewed.
 *
 * Clicking opens Finder or Explorer and nothing else. There was a panel here
 * with a path, a text field and an explanation, and every part of it was
 * something the platform's own chooser already does — it showed the path worse
 * than Finder does and asked people to type what they could point at.
 *
 * Renders nothing in a browser, and nothing on a phone: `folder.root` is null
 * in both.
 */
export default function WorkingFolderControl({ folder }: { folder: WorkingFolder }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!folder.available || !folder.root) return null;

  const browse = async () => {
    if (busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const picked = await chooseFolder(folder.root);
      // Closed without choosing. Not a failure, and nothing should move.
      if (!picked) return;
      setProblem(await folder.choose(picked));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Amber covers both things worth stopping for: a folder that is not on this
  // machine, and a choice that would not save.
  const wrong = problem ?? missingNote(folder);

  return (
    <button
      className={`folder-chip ${busy ? "is-busy" : ""} ${wrong ? "is-missing" : ""}`}
      disabled={busy}
      title={wrong ?? `Commands run in ${folder.root} — click to change`}
      onClick={() => void browse()}
    >
      <FolderIcon />
      <span className="folder-chip-name">{folderName(folder.root)}</span>
    </button>
  );
}

function missingNote(folder: WorkingFolder): string | null {
  return folder.missing
    ? `${folder.missing} is not on this machine, so commands are running in ${folder.root}. Click to point this chat somewhere else.`
    : null;
}
