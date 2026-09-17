/**
 * The desktop shell's side of tool execution.
 *
 * Tools exist only where there is a filesystem to point them at, so everything
 * here is behind `toolsAvailable()`. In a browser it returns false, the client
 * sends no working folder, and the Edge Function never declares any tools —
 * so the web app is not a degraded version of this, it is the app it already
 * was.
 *
 * Talking to Tauri through `__TAURI_INTERNALS__` rather than `@tauri-apps/api`
 * is deliberate: it is the same call the package makes, and it keeps a new
 * dependency out of the client for a slice whose whole point is to find out
 * whether the idea works.
 */

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

function internals(): TauriInternals | null {
  const host = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return typeof host.__TAURI_INTERNALS__?.invoke === "function"
    ? host.__TAURI_INTERNALS__
    : null;
}

export function toolsAvailable(): boolean {
  return internals() !== null;
}

/** The OS the commands will run on, so the model stops guessing at it. */
export function platformName(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "macOS";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return "an unknown platform";
}

let rootPromise: Promise<string | null> | null = null;

/**
 * Where a conversation works when it has not been pointed anywhere.
 *
 * Asked for once and remembered: it is a property of the machine, not of the
 * conversation, so every chat that has not chosen its own folder shares it.
 */
export function defaultRoot(): Promise<string | null> {
  if (rootPromise) return rootPromise;

  const host = internals();
  if (!host) {
    rootPromise = Promise.resolve(null);
    return rootPromise;
  }

  rootPromise = host
    .invoke("tool_root")
    .then((value) => (typeof value === "string" ? value : null))
    .catch((err) => {
      console.error("could not resolve the working folder:", err);
      return null;
    });

  return rootPromise;
}

export type RootCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Ask the machine whether a path is a folder it can work in, and what that
 * folder really is.
 *
 * Two jobs at once. It rejects what someone typed wrong, and it canonicalises
 * what they chose so the stored value is already resolved. It is also how a
 * path saved on one computer is found to be missing on another — the same
 * account opened on a second machine reads a folder that may not be there, and
 * this is what turns that into a fallback rather than a failed turn.
 */
export async function validateRoot(path: string): Promise<RootCheck> {
  const host = internals();
  if (!host) return { ok: false, reason: "Tools are not available in this app." };

  try {
    const resolved = await host.invoke("validate_root", { path });
    return typeof resolved === "string"
      ? { ok: true, path: resolved }
      : { ok: false, reason: "That folder could not be resolved." };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/**
 * Open the platform's own folder chooser and return what was picked.
 *
 * `null` means the chooser was closed without choosing, which is not a failure
 * — it should leave the conversation pointed where it already was. A real
 * problem throws, with the message the shell wrote.
 *
 * Desktop only: there is no folder picker on iOS or Android, and nothing to
 * pick for. On a phone the command refuses and the control that calls it is
 * not rendered in the first place.
 */
export async function chooseFolder(start: string | null): Promise<string | null> {
  const host = internals();
  if (!host) throw new Error("Tools are not available in this app.");

  const picked = await host.invoke("choose_folder", { start });
  return typeof picked === "string" ? picked : null;
}

/** The last segment, which is what a person calls the folder. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export interface ToolEnv {
  shell?: string;
  python?: string | null;
  python_version?: string | null;
  libraries?: string[];
}

let envPromise: Promise<ToolEnv | null> | null = null;

/**
 * What is installed, asked once per session.
 *
 * Worth a round trip at startup because the alternative is the model
 * proposing a command that needs openpyxl, the user approving it, and both of
 * them finding out from a traceback.
 */
export function toolEnv(): Promise<ToolEnv | null> {
  if (envPromise) return envPromise;

  const host = internals();
  if (!host) {
    envPromise = Promise.resolve(null);
    return envPromise;
  }

  envPromise = host
    .invoke("probe_env")
    .then((value) => (value && typeof value === "object" ? value as ToolEnv : null))
    .catch((err) => {
      console.error("could not probe the environment:", err);
      return null;
    });

  return envPromise;
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

/**
 * Run one approved call and return what to send back to the model.
 *
 * Failures come back as `isError` with the real message rather than being
 * thrown. That string is the whole self-correction mechanism: a model told
 * "no such path in the working folder: reports/" will list the parent and try
 * again, where one told "the tool failed" can only guess.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  root: string | null,
): Promise<ToolOutcome> {
  const host = internals();
  if (!host) {
    return { output: "Tools are not available in this app.", isError: true };
  }

  // The folder is passed in rather than read here: it belongs to the
  // conversation, and the model was told about that one in its system prompt.
  // Running the command somewhere else would make the approval the user gave
  // apply to a folder they were not shown.
  if (!root) {
    return { output: "No working folder is open.", isError: true };
  }

  try {
    if (name === "list_dir") {
      const path = typeof input.path === "string" && input.path.length > 0
        ? input.path
        : ".";
      const result = await host.invoke("list_dir", { root, path });
      return { output: JSON.stringify(result), isError: false };
    }

    if (name === "run_command") {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command.trim()) {
        return { output: "No command was given.", isError: true };
      }

      const result = await host.invoke("run_command", { root, command }) as {
        exit_code?: number;
        stdout?: string;
        stderr?: string;
      };

      // A non-zero exit is reported as an error so the model treats it as one
      // and reads the stderr, rather than carrying on as if it had worked.
      return {
        output: JSON.stringify(result),
        isError: (result.exit_code ?? 0) !== 0,
      };
    }

    return { output: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    // Tauri rejects a command with whatever the Rust Err(String) carried.
    return { output: String(err), isError: true };
  }
}

/**
 * Stop every command still running on this machine.
 *
 * Aborting the turn is not the same as stopping the work. The fetch is
 * cancelled and any waiting approval is denied, but a command already running
 * is a process on the user's computer that knows nothing about either — so
 * before this existed, Stop left a `find` scanning the disk with no way left
 * to reach it.
 *
 * Never throws: it is called from an abort handler, where a rejection has
 * nowhere to go.
 */
export async function cancelRunningTools(): Promise<void> {
  const host = internals();
  if (!host) return;
  try {
    const killed = await host.invoke("cancel_commands");
    if (typeof killed === "number" && killed > 0) {
      console.warn(`[tools] stopped ${killed} running command(s)`);
    }
  } catch (err) {
    console.error("[tools] could not stop running commands:", err);
  }
}

export interface ToolDescription {
  /** One line, above the fold. */
  headline: string;
  /** Shown verbatim and never summarised — this is what is being approved. */
  body: string;
}

/**
 * What the gate shows about a pending call.
 *
 * A command is shown exactly as it will run, because a summarised command is
 * an unreviewable one, and the entire argument for running model-written code
 * on someone's machine is that they read it first.
 */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
): ToolDescription {
  if (name === "run_command") {
    const command = typeof input.command === "string" ? input.command : "";
    const purpose = typeof input.purpose === "string" && input.purpose.trim()
      ? input.purpose.trim()
      : "Run a command";
    return { headline: purpose, body: command };
  }

  if (name === "list_dir") {
    const path = typeof input.path === "string" && input.path ? input.path : ".";
    return {
      headline: path === "." ? "List the working folder" : `List ${path}`,
      body: path,
    };
  }

  return { headline: name, body: JSON.stringify(input, null, 2) };
}
