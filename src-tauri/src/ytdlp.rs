//! Managed yt-dlp binary lifecycle.
//!
//! End users don't have yt-dlp on PATH, so the app owns its copy: the
//! official single-file release is downloaded into
//! `<app-data>/bin/yt-dlp.exe` on first run and self-updated via
//! `yt-dlp -U` on a 72-hour cadence. The managed copy is canonical —
//! PATH is only a fallback for dev machines while the download hasn't
//! happened (or failed).
//!
//! Streaming resilience depends on this: YouTube regularly breaks
//! extractors and yt-dlp ships fixes within days, so the binary must
//! update on its own schedule, not the app's release schedule.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const BINARY_NAME: &str = "yt-dlp";

/// Official single-file builds. The `latest/download/` URL redirects to
/// the newest release asset, so no GitHub API call (and no rate limit)
/// is involved.
#[cfg(windows)]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/// How often to let the managed binary check for its own update.
const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
/// Hard cap on the `-U` self-update run.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Hard cap on the first-run download (the exe is ~12 MB).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the managed binary lives for this install.
pub fn managed_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
        .join(BINARY_NAME)
}

/// Program to spawn for yt-dlp work.
///
/// **PATH wins when available.** The official single-file macOS/Windows
/// builds we download into `app_data/bin` are PyInstaller *onefile*
/// bundles: every process start re-extracts ~30–40 MB to a temp dir and
/// costs ~10–12s of wall time *before* any network work. That alone was
/// the entire "play starts after 11–15s" budget. Homebrew / pip installs
/// are thin wrappers around an already-imported package and start in
/// <0.5s, so we prefer them whenever `yt-dlp` resolves on PATH.
///
/// Managed is still downloaded (see `ensure`) for machines with no PATH
/// install and for self-update; it's just no longer preferred when a
/// fast alternative exists. Result is cached for the process lifetime.
pub fn program(managed: &Path) -> PathBuf {
    use std::sync::OnceLock;
    static PATH_OK: OnceLock<bool> = OnceLock::new();
    let path_ok = *PATH_OK.get_or_init(probe_path_install_sync);
    if path_ok {
        return PathBuf::from("yt-dlp");
    }
    if managed.exists() {
        managed.to_path_buf()
    } else {
        PathBuf::from("yt-dlp")
    }
}

/// Sync PATH probe for `program()`. Kept separate from the async probe
/// used by `ensure()` so spawn sites stay non-async.
fn probe_path_install_sync() -> bool {
    let mut cmd = std::process::Command::new("yt-dlp");
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.status() {
        Ok(s) if s.success() => {
            eprintln!("[ytdlp] preferring PATH yt-dlp over managed binary (fast start)");
            true
        }
        _ => false,
    }
}

fn emit_state(app: &tauri::AppHandle, phase: &str, message: Option<String>) {
    let _ = app.emit(
        "ytdlp-state",
        serde_json::json!({ "phase": phase, "message": message }),
    );
}

/// Idempotent "make yt-dlp available" entry point. Called from the
/// frontend on every launch (so the webview's event listener is
/// guaranteed to be mounted before any state event fires) and safe to
/// re-invoke as a retry after a failed download.
///
/// Emits `ytdlp-state` events: `downloading` → `ready` | `error`.
pub async fn ensure(app: tauri::AppHandle) {
    // Serialize concurrent calls (StrictMode double-mount, retry spam).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    let managed = managed_path(&app);

    if managed.exists() {
        emit_state(&app, "ready", None);
        maybe_self_update(&managed).await;
        return;
    }

    // Dev fallback: a working PATH install means we can play right now.
    // Still fetch the managed copy in the background so this install
    // stops depending on the machine's PATH from the next launch on.
    let path_works = probe_path_install().await;
    if path_works {
        emit_state(&app, "ready", None);
    } else {
        emit_state(&app, "downloading", None);
    }

    match download(&managed).await {
        Ok(()) => {
            eprintln!("[ytdlp] downloaded managed binary to {managed:?}");
            touch_update_stamp(&managed);
            emit_state(&app, "ready", None);
        }
        Err(e) => {
            eprintln!("[ytdlp] download failed: {e}");
            if !path_works {
                emit_state(&app, "error", Some(e));
            }
        }
    }
}

/// True when a bare `yt-dlp --version` spawn succeeds (PATH install).
async fn probe_path_install() -> bool {
    let mut cmd = tokio::process::Command::new("yt-dlp");
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    match cmd.status().await {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

/// Fetch the official binary into `<managed>.part`, then rename. The
/// .part indirection means a torn download never masquerades as a
/// working binary.
async fn download(managed: &Path) -> Result<(), String> {
    if let Some(dir) = managed.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }
    let part = managed.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let resp = reqwest::get(DOWNLOAD_URL)
            .await
            .map_err(|e| format!("request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("http: {e}"))?;
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create {part:?}: {e}"))?;
        let mut stream = resp;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| format!("read body: {e}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("flush: {e}"))?;
        Ok::<(), String>(())
    };

    match tokio::time::timeout(DOWNLOAD_TIMEOUT, fetch).await {
        Err(_) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("download timed out".into());
        }
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // Sanity floor: the real exe is ~12 MB; a tiny payload is an error
    // page or a truncated body, not yt-dlp.
    const MIN_BINARY_BYTES: u64 = 1024 * 1024;
    let size = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if size < MIN_BINARY_BYTES {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("downloaded file too small ({size} bytes)"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(
            &part,
            std::fs::Permissions::from_mode(0o755),
        )
        .await;
    }

    tokio::fs::rename(&part, managed)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn update_stamp_path(managed: &Path) -> PathBuf {
    managed.with_file_name("last-update-check")
}

fn touch_update_stamp(managed: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(update_stamp_path(managed), now.to_string());
}

fn update_stamp_age(managed: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(update_stamp_path(managed)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

/// Run `yt-dlp -U` on the managed copy when the last check is older
/// than `UPDATE_INTERVAL`. The official release binary replaces itself
/// in place. The stamp is refreshed even on failure so a broken update
/// path can't turn into a retry storm on every launch.
async fn maybe_self_update(managed: &Path) {
    match update_stamp_age(managed) {
        Some(age) if age < UPDATE_INTERVAL => return,
        _ => {}
    }
    touch_update_stamp(managed);

    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("-U");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // The timeout below drops the output() future — without this the
    // wedged child would outlive it as an orphan.
    cmd.kill_on_drop(true);

    let run = async {
        match cmd.output().await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("");
                eprintln!("[ytdlp] self-update ({}): {line}", out.status);
            }
            Err(e) => eprintln!("[ytdlp] self-update spawn failed: {e}"),
        }
    };
    if tokio::time::timeout(UPDATE_TIMEOUT, run).await.is_err() {
        eprintln!("[ytdlp] self-update timed out");
    }
}
