use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_secs(2);

/// Describes a file change to be committed.
#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub title: String,
    pub is_new: bool,
}

/// Messages sent to the background git worker.
enum Msg {
    Change(FileChange),
    /// Flush pending changes, commit, push, then signal completion.
    Flush(tokio::sync::oneshot::Sender<()>),
    Shutdown,
}

/// Clonable handle used by Tauri commands to talk to the worker.
#[derive(Clone)]
pub struct GitSyncHandle {
    tx: mpsc::UnboundedSender<Msg>,
    dismissed: Arc<AtomicBool>,
}

impl GitSyncHandle {
    /// Start a new git sync worker for the given notes directory.
    /// `app_handle` is used to emit events to the frontend.
    pub fn new(notes_dir: &str, app_handle: tauri::AppHandle) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let dir = PathBuf::from(notes_dir);

        tauri::async_runtime::spawn(async move {
            // Ensure the directory is a git repo and commit any leftover files.
            if let Err(e) = ensure_git_repo(&dir).await {
                eprintln!("git_sync: failed to init repo: {e}");
                return;
            }
            if let Err(e) = commit_leftover_md(&dir).await {
                eprintln!("git_sync: failed to commit leftover files: {e}");
            }
            run_worker(rx, dir, app_handle).await;
        });

        Self {
            tx,
            dismissed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Fire-and-forget: enqueue a file change.
    pub fn notify_change(&self, path: &str, title: &str, is_new: bool) {
        let _ = self.tx.send(Msg::Change(FileChange {
            path: path.to_string(),
            title: title.to_string(),
            is_new,
        }));
    }

    /// Block until all pending changes are committed and pushed.
    pub fn flush_and_push(&self) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Msg::Flush(done_tx));
        // Block the current thread waiting for the async worker to finish.
        let _ = tauri::async_runtime::block_on(async {
            let _ = done_rx.await;
        });
    }

    /// Shut down the worker (used when switching notes directories).
    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }

    pub fn is_dismissed(&self) -> bool {
        self.dismissed.load(Ordering::Relaxed)
    }

    pub fn dismiss(&self) {
        self.dismissed.store(true, Ordering::Relaxed);
    }
}

/// The long-lived background worker.
async fn run_worker(
    mut rx: mpsc::UnboundedReceiver<Msg>,
    dir: PathBuf,
    app_handle: tauri::AppHandle,
) {
    let mut pending: Vec<FileChange> = Vec::new();
    let mut deadline: Option<Instant> = None;

    loop {
        let msg = if let Some(dl) = deadline {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep_until(dl) => {
                    // Debounce fired — commit what we have.
                    do_commit_and_push(&dir, &mut pending, &app_handle).await;
                    deadline = None;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };

        match msg {
            Some(Msg::Change(change)) => {
                pending.push(change);
                deadline = Some(Instant::now() + DEBOUNCE);
            }
            Some(Msg::Flush(done)) => {
                do_commit_and_push(&dir, &mut pending, &app_handle).await;
                deadline = None;
                let _ = done.send(());
            }
            Some(Msg::Shutdown) | None => {
                // Commit any remaining changes before exiting.
                if !pending.is_empty() {
                    do_commit_and_push(&dir, &mut pending, &app_handle).await;
                }
                break;
            }
        }
    }
}

/// Stage specific files, commit with an auto-generated message, then push.
async fn do_commit_and_push(
    dir: &Path,
    pending: &mut Vec<FileChange>,
    app_handle: &tauri::AppHandle,
) {
    if pending.is_empty() {
        return;
    }

    let changes: Vec<FileChange> = pending.drain(..).collect();

    // Stage each changed file individually.
    for change in &changes {
        let file = Path::new(&change.path);
        // If the path is absolute, make it relative to dir.
        let rel = if file.is_absolute() {
            file.strip_prefix(dir)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string()
        } else {
            change.path.clone()
        };
        let _ = git(dir, &["add", &rel]).await;
    }

    // Also stage the index file.
    let _ = git(dir, &["add", ".dump-index.json"]).await;

    // Check if there's actually anything staged.
    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_ok() {
        // Exit code 0 means no diff — nothing to commit.
        return;
    }

    let message = build_commit_message(&changes);
    if let Err(e) = git(dir, &["commit", "-m", &message]).await {
        eprintln!("git_sync: commit failed: {e}");
        return;
    }

    // Push if a remote is configured.
    if has_remote(dir).await {
        if let Err(e) = git(dir, &["push"]).await {
            eprintln!("git_sync: push failed: {e}");
            emit_error(app_handle, &format!("Git push failed: {e}"));
        }
    }
}

fn build_commit_message(changes: &[FileChange]) -> String {
    if changes.len() == 1 {
        let c = &changes[0];
        let verb = if c.is_new { "Create" } else { "Update" };
        format!("{verb}: {}", c.title)
    } else {
        let new_count = changes.iter().filter(|c| c.is_new).count();
        let update_count = changes.len() - new_count;
        let mut parts = Vec::new();
        if new_count > 0 {
            parts.push(format!(
                "Create {} note{}",
                new_count,
                if new_count == 1 { "" } else { "s" }
            ));
        }
        if update_count > 0 {
            parts.push(format!(
                "Update {} note{}",
                update_count,
                if update_count == 1 { "" } else { "s" }
            ));
        }
        parts.join(", ")
    }
}

/// Run a git command in the given directory.
async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(stderr)
    }
}

async fn has_remote(dir: &Path) -> bool {
    git(dir, &["remote"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Ensure the notes directory is a git repo.  If not, init one.
async fn ensure_git_repo(dir: &Path) -> Result<(), String> {
    // Check if git is available.
    if Command::new("git")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        return Err("git not found".into());
    }

    let check = git(dir, &["rev-parse", "--is-inside-work-tree"]).await;
    if check.is_ok() {
        return Ok(());
    }

    // Not a repo — initialise.
    git(dir, &["init"]).await?;

    // Write .gitignore.
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(
            &gitignore,
            ".dump-index.json\n.DS_Store\n*.swp\n*.tmp\n",
        )
        .map_err(|e| format!("write .gitignore: {e}"))?;
    }

    // Stage .gitignore and any existing .md files.
    let _ = git(dir, &["add", ".gitignore"]).await;
    let _ = git(dir, &["add", "*.md"]).await;

    // Initial commit (only if there's something staged).
    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_err() {
        let _ = git(dir, &["commit", "-m", "Initial commit"]).await;
    }

    Ok(())
}

/// On startup, commit any .md files that might have been left uncommitted after a crash.
async fn commit_leftover_md(dir: &Path) -> Result<(), String> {
    // Stage all .md files — `git add` is a no-op for unchanged files.
    let _ = git(dir, &["add", "*.md"]).await;
    let _ = git(dir, &["add", ".dump-index.json"]).await;

    let diff = git(dir, &["diff", "--cached", "--quiet"]).await;
    if diff.is_err() {
        git(dir, &["commit", "-m", "Auto-commit: recover unsaved changes"]).await?;
    }
    Ok(())
}

fn emit_error(app_handle: &tauri::AppHandle, message: &str) {
    use tauri::Emitter;
    let _ = app_handle.emit("git-sync-error", message.to_string());
}

// ── Tauri commands ─────────────────────────────────────────────────

use tauri::State;
use crate::AppState;

#[tauri::command]
pub fn get_git_remote(state: State<AppState>) -> Result<Option<String>, String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&*dir)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let url = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if url.is_empty() {
                Ok(None)
            } else {
                Ok(Some(url))
            }
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn set_git_remote(state: State<AppState>, url: String) -> Result<(), String> {
    let dir = state.notes_dir.lock().map_err(|e| e.to_string())?;

    // Try set-url first (in case remote already exists), fall back to add.
    let set_url = std::process::Command::new("git")
        .args(["remote", "set-url", "origin", &url])
        .current_dir(&*dir)
        .output();

    match set_url {
        Ok(o) if o.status.success() => {}
        _ => {
            let add = std::process::Command::new("git")
                .args(["remote", "add", "origin", &url])
                .current_dir(&*dir)
                .output()
                .map_err(|e| e.to_string())?;
            if !add.status.success() {
                return Err(String::from_utf8_lossy(&add.stderr).to_string());
            }
        }
    }

    // Initial push.
    let push = std::process::Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&*dir)
        .output()
        .map_err(|e| e.to_string())?;

    if !push.status.success() {
        let stderr = String::from_utf8_lossy(&push.stderr).to_string();
        // Don't fail hard — the remote is configured, push can retry later.
        eprintln!("git_sync: initial push failed: {stderr}");
    }

    Ok(())
}

#[tauri::command]
pub fn dismiss_git_setup(state: State<AppState>) -> Result<(), String> {
    state.git.dismiss();
    Ok(())
}
