//! Commands the model can ask for, and the folder boundary they run inside.
//!
//! Nothing here is exposed to the webview as a general capability. The webview
//! can ask for one named operation on one path, and this module decides
//! whether that is allowed. A model that asks for something outside the folder
//! gets an error string it can read and correct from, not a panic.
//!
//! The boundary is enforced by canonicalising both the root and the target and
//! checking containment afterwards. Doing it before would let a symlink inside
//! the folder point at `~/.ssh` and pass, because the string still looks local.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Enough entries to describe a working folder, few enough to stay readable in
/// a prompt. A node_modules listing is not worth 40,000 tokens.
const MAX_ENTRIES: usize = 200;

/// A command that has not finished in two minutes is not going to. Killing it
/// returns an error the model can read and adapt to, where leaving it running
/// would hang the turn with nothing on screen to explain why.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Output goes back into the prompt, so it is capped like any other text the
/// model has to read.
const MAX_OUTPUT_BYTES: usize = 16_000;

/// How much of a command's output is kept in memory before `clamp` trims it.
///
/// Far above MAX_OUTPUT_BYTES on purpose: the pipe is drained to the end
/// whatever this is — a child that cannot write is a child that never exits —
/// and this only decides how much is kept. Keeping a window rather than the
/// whole stream means `find /` cannot exhaust memory on the way to being
/// trimmed to 16k anyway.
const MAX_KEPT_BYTES: usize = 1_000_000;

#[derive(Serialize)]
pub struct DirEntryInfo {
    name: String,
    is_dir: bool,
    /// Bytes. Omitted for directories, where it means nothing useful.
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Serialize)]
pub struct ListDirResult {
    path: String,
    entries: Vec<DirEntryInfo>,
    truncated: bool,
}

fn home() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home directory in the environment".to_string())
}

/// Where a conversation starts when it has not been pointed anywhere.
///
/// Documents, because it is the folder that already holds the spreadsheets and
/// decks this is for, and because it is somewhere a mistaken command does less
/// damage than it would in the home directory itself.
#[tauri::command]
pub fn tool_root() -> Result<String, String> {
    // Phones have no folder to offer. iOS and Android are sandboxed, there is
    // no shell to run a command in, and the dialog plugin does not implement a
    // folder picker on either. Failing here is the whole gate: the client reads
    // no root, so the chip does not render, no folder is sent to the Edge
    // Function and it declares no tools — the same path a browser already takes.
    #[cfg(mobile)]
    return Err("Tools are desktop-only.".to_string());

    #[cfg(desktop)]
    {
    let home = home()?;
    let root = Path::new(&home).join("Documents");
    if !root.is_dir() {
        return Ok(home);
    }
    Ok(root.to_string_lossy().to_string())
    }
}

/// Open the platform's own folder chooser — Finder on macOS, Explorer on
/// Windows — and return what was picked, already validated.
///
/// Desktop only, and not by our choice: the dialog plugin has no folder picker
/// on mobile. That matches where the rest of this can run anyway.
///
/// The webview cannot open a dialog on its own. The plugin's own IPC commands
/// are registered but unreachable — the capability grants `core:default` and
/// nothing else — so the only dialog that opens is this one, asking for exactly
/// one thing.
///
/// `Ok(None)` means the person closed the chooser, which is not an error and
/// should leave the conversation where it was.
#[tauri::command]
pub async fn choose_folder<R: tauri::Runtime>(
    window: tauri::Window<R>,
    start: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(mobile)]
    {
        let _ = (window, start);
        return Err("Choosing a folder is desktop-only.".to_string());
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;

        let mut builder = window
            .dialog()
            .file()
            .set_title("Choose this conversation's working folder");

        // A sheet attached to the window rather than a free-floating panel,
        // which is what both platforms expect of a document-scoped choice.
        #[cfg(any(windows, target_os = "macos"))]
        {
            builder = builder.set_parent(&window);
        }

        // Open where the conversation already is, so changing one segment of a
        // deep path is a click rather than a navigation.
        if let Some(start) = start.filter(|s| !s.trim().is_empty()) {
            builder = builder.set_directory(start);
        }

        // Blocking is correct here: a command runs off the main thread, and the
        // chooser is modal to the person anyway. Nothing else in the app is
        // waiting on this thread.
        let Some(picked) = builder.blocking_pick_folder() else {
            return Ok(None);
        };

        let path = picked
            .into_path()
            .map_err(|e| format!("That folder could not be read: {e}"))?;

        // Through the same check as a typed path. The chooser will not normally
        // return something unreadable, but the stored value should have been
        // resolved the one way regardless of how it was chosen.
        validate_root(path.to_string_lossy().to_string()).map(Some)
    }
}

/// Turn what someone typed or chose into a folder, or say why it is not one.
///
/// Returns the canonical path rather than the input, so what gets stored on the
/// conversation is already resolved: `~/Docs/../Documents` and a symlink both
/// come back as the real folder they land on. Storing the literal instead would
/// mean re-resolving it on every turn and getting a different answer once the
/// symlink moved.
///
/// The error strings are written to be read by a person, because this one is
/// answered by a person — unlike the tool errors above, which a model reads.
#[tauri::command]
pub fn validate_root(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Type or choose a folder.".to_string());
    }

    // `~` is what people paste and what they type; nothing below expands it.
    let expanded = if trimmed == "~" {
        home()?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        Path::new(&home()?).join(rest).to_string_lossy().to_string()
    } else {
        trimmed.to_string()
    };

    let resolved = Path::new(&expanded)
        .canonicalize()
        .map_err(|_| format!("There is no folder at {expanded}."))?;

    if !resolved.is_dir() {
        return Err(format!("{expanded} is a file, not a folder."));
    }

    // Readable is the minimum; a folder that cannot be listed would fail later
    // as a tool error mid-conversation instead of here, where it can be fixed.
    fs::read_dir(&resolved)
        .map_err(|e| format!("That folder cannot be read: {e}"))?;

    Ok(resolved.to_string_lossy().to_string())
}

/// Resolve `relative` inside `root`, refusing anything that escapes.
///
/// `canonicalize` resolves `..` and follows symlinks, so the containment check
/// below sees where the path really lands rather than what it was spelled as.
fn resolve_within(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("working folder is unreadable: {e}"))?;

    let candidate = root_path.join(relative.trim_start_matches('/'));
    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("no such path in the working folder: {relative} ({e})"))?;

    if !resolved.starts_with(&root_path) {
        return Err(format!(
            "{relative} resolves outside the working folder and was refused"
        ));
    }
    Ok(resolved)
}

/// List one directory inside the working folder.
///
/// Returns `Err(String)` rather than panicking on every failure path: the
/// string goes back to the model as the tool result, and a model that can read
/// "no such path" will try a different one instead of repeating itself.
/// `(async)` so a slow directory — a network mount, a folder with a very large
/// number of entries — cannot stall the window while it is read.
#[tauri::command(async)]
pub fn list_dir(root: String, path: String) -> Result<ListDirResult, String> {
    let target = resolve_within(&root, &path)?;

    if !target.is_dir() {
        return Err(format!("{path} is a file, not a directory"));
    }

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut truncated = false;

    let read = fs::read_dir(&target).map_err(|e| format!("could not read {path}: {e}"))?;

    for item in read {
        let item = match item {
            Ok(item) => item,
            // One unreadable entry should not lose the whole listing.
            Err(_) => continue,
        };

        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }

        let metadata = item.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);

        entries.push(DirEntryInfo {
            name: item.file_name().to_string_lossy().to_string(),
            is_dir,
            size: if is_dir {
                None
            } else {
                metadata.as_ref().map(|m| m.len())
            },
        });
    }

    entries.sort_by(|a, b| (b.is_dir, &a.name).cmp(&(a.is_dir, &b.name)));

    Ok(ListDirResult {
        path,
        entries,
        truncated,
    })
}

#[derive(Serialize)]
pub struct CommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Trim to the cap, keeping both ends.
///
/// The head says what the command started doing and the tail carries the
/// error, which is usually the last thing printed. Keeping only one end throws
/// away half of what makes a failure diagnosable.
fn clamp(raw: Vec<u8>) -> String {
    let text = String::from_utf8_lossy(&raw).to_string();
    if text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    let head = MAX_OUTPUT_BYTES * 3 / 5;
    let tail = MAX_OUTPUT_BYTES - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text
        .chars()
        .rev()
        .take(tail)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}\n[… trimmed …]\n{end}")
}

fn shell() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("/bin/sh", "-c")
    }
}

/// Shells started by `run_command` and not yet finished.
///
/// Exists so Stop can mean something. Without it the button aborts the HTTP
/// request and denies any waiting approval, which stops the *conversation* —
/// while the `find` the user was actually trying to stop carries on chewing
/// through their disk with nothing on screen and no way to reach it.
fn running() -> &'static Mutex<HashSet<u32>> {
    static RUNNING: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Drops a pid out of the registry however the command ended.
struct Registered(u32);

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut set) = running().lock() {
            set.remove(&self.0);
        }
    }
}

/// Kill a shell and everything it started.
///
/// The process group, not the process. `sh -c "find / | head"` forks, so
/// killing the shell alone orphans the `find` and leaves it running — which
/// looks exactly like Stop having done nothing, because from the user's side
/// it has. A negative pid is the group, which is why the shell is given one of
/// its own when it is spawned.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("-{pid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

/// Stop every command still running. Called when the reader presses Stop.
///
/// Deliberately kills everything rather than one named call: by the time
/// someone reaches for Stop they want the machine to go quiet, not to reason
/// about which of several commands is the one costing them.
#[tauri::command(async)]
pub fn cancel_commands() -> usize {
    let pids: Vec<u32> = running().lock().map(|set| set.iter().copied().collect())
        .unwrap_or_default();
    for pid in &pids {
        kill_group(*pid);
    }
    pids.len()
}

/// Drain one of the child's pipes on its own thread, keeping a bounded window.
///
/// Draining is not optional. A pipe has a small OS buffer — 64 KB is typical —
/// and a child that fills it BLOCKS on the next write until something reads.
/// If nobody reads until after the child exits, a command that produces more
/// than a bufferful can never exit and nothing after it ever runs.
///
/// So this reads to the end always, and simply stops *keeping* bytes past the
/// cap. Dropping them on the floor is what lets `find /` finish instead of
/// wedging.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let Some(mut pipe) = pipe else { return kept };

        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if kept.len() < MAX_KEPT_BYTES {
                        let room = MAX_KEPT_BYTES - kept.len();
                        kept.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
                // A killed child closes its pipes mid-read. That is an ending,
                // not a failure — keep what arrived.
                Err(_) => break,
            }
        }
        kept
    })
}

/// Run one approved command with the working folder as its cwd.
///
/// This goes through a shell on purpose — pipes, redirection and heredocs are
/// most of what makes a one-line command useful, and a model writing shell
/// expects shell. The control on it is not this function: it is that a person
/// read the command in full and pressed Approve. Note that a spawned process
/// has the user's own permissions and is not bound by the folder, which is
/// exactly why the text is never summarised before it is shown.
///
/// `(async)` is load-bearing. Tauri runs a synchronous command ON THE MAIN
/// THREAD, so the wait loop below froze the entire window — beachball, "not
/// responding" — for however long the command took. This one waits up to two
/// minutes by design, so the app was one slow command away from looking dead.
/// The function is still synchronous; the attribute only asks Tauri to run it
/// somewhere that is not the thread drawing the UI.
#[tauri::command(async)]
pub fn run_command(root: String, command: String) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("empty command".to_string());
    }

    let cwd = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("working folder is unreadable: {e}"))?;

    let (program, flag) = shell();
    let mut builder = Command::new(program);
    builder
        .arg(flag)
        .arg(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Its own process group, so Stop can kill the shell AND whatever it
    // started. Without this a `find` behind a pipe outlives the shell that
    // spawned it and keeps running with nothing left to stop it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        builder.process_group(0);
    }

    let mut child = builder
        .spawn()
        .map_err(|e| format!("could not start the command: {e}"))?;

    let pid = child.id();
    if let Ok(mut set) = running().lock() {
        set.insert(pid);
    }
    // Removed on every exit path below — finished, timed out or killed — so a
    // later Stop cannot signal a pid the OS has already handed to something
    // else.
    let _guard = Registered(pid);

    // Started before the wait, not after it. Reading only once the child has
    // exited is the deadlock: it cannot exit until someone reads.
    let out = drain::<ChildStdout>(child.stdout.take());
    let err = drain::<ChildStderr>(child.stderr.take());

    let started = Instant::now();
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= COMMAND_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("lost track of the command: {e}")),
        }
    }

    let status = child.wait().map_err(|e| format!("could not reap the command: {e}"))?;

    // Joining after the child is gone: both pipes are closed by then, so
    // neither thread can still be waiting on a read.
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();

    Ok(CommandResult {
        exit_code: if timed_out { -1 } else { status.code().unwrap_or(-1) },
        stdout: clamp(stdout),
        stderr: if timed_out {
            format!("timed out after {}s", COMMAND_TIMEOUT.as_secs())
        } else {
            clamp(stderr)
        },
        timed_out,
    })
}

#[derive(Serialize)]
pub struct EnvInfo {
    shell: String,
    python: Option<String>,
    python_version: Option<String>,
    /// Libraries worth knowing about before proposing a command that needs one.
    libraries: Vec<String>,
}

/// What is actually installed, asked once when the folder opens.
///
/// A spawned process inherits the app's PATH, not the PATH of whatever shell
/// the user launched from — so the `python3` this finds may not be the one
/// they get in a terminal. Reporting the absolute path is what stops the model
/// proposing `python3 …` and getting an interpreter with none of the libraries
/// the user thinks they have.
/// `(async)` for the same reason as run_command: this spawns several shell
/// processes looking for an interpreter, and a synchronous Tauri command runs
/// on the thread that draws the window.
#[tauri::command(async)]
pub fn probe_env() -> EnvInfo {
    let (program, flag) = shell();

    let capture = |script: &str| -> Option<String> {
        let out = Command::new(program)
            .arg(flag)
            .arg(script)
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };

    let python = capture("command -v python3 || command -v python");

    let python_version = python
        .as_deref()
        .and_then(|path| capture(&format!("{path} --version 2>&1")));

    let mut libraries = Vec::new();
    if let Some(path) = python.as_deref() {
        for lib in ["openpyxl", "pandas", "docx", "pptx"] {
            let found = capture(&format!("{path} -c 'import {lib}' >/dev/null 2>&1 && echo yes"));
            if found.is_some() {
                libraries.push(lib.to_string());
            }
        }
    }

    EnvInfo {
        shell: program.to_string(),
        python,
        python_version,
        libraries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one piece of this module a person's typing reaches directly, so the
    /// branches worth pinning are the ones they get wrong: a tilde, a trailing
    /// space, a file where a folder was meant.
    #[test]
    fn validate_root_accepts_a_folder_and_resolves_it() {
        let home = home().expect("a home directory");
        let resolved = validate_root(format!("  {home}  ")).expect("home is a folder");
        assert_eq!(resolved, Path::new(&home).canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn validate_root_expands_a_tilde() {
        let home = home().expect("a home directory");
        assert_eq!(validate_root("~".to_string()).unwrap(), validate_root(home).unwrap());
    }

    #[test]
    fn validate_root_refuses_a_file_a_gap_and_a_ghost() {
        let mut file = std::env::temp_dir();
        file.push("chat_router_validate_root.txt");
        fs::write(&file, b"x").expect("temp file");

        let refused = validate_root(file.to_string_lossy().to_string()).unwrap_err();
        assert!(refused.contains("not a folder"), "{refused}");

        assert!(validate_root("   ".to_string()).is_err());
        assert!(validate_root("/nowhere/at/all/42".to_string()).is_err());

        let _ = fs::remove_file(&file);
    }
}
