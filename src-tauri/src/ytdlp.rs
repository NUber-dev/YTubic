//! Managed yt-dlp binary lifecycle.
//!
//! End users don't have yt-dlp on PATH, so the app owns its copy: each
//! release channel's build is downloaded under `<app-data>/bin/` on first
//! use and refreshed on a 72-hour cadence, and the selected channel is
//! copied over `yt-dlp` — the binary the stream server spawns. PATH is
//! only a fallback for dev machines while the download hasn't happened
//! (or failed).
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
const ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const ASSET: &str = "yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const ASSET: &str = "yt-dlp";

fn channel_str(nightly: bool) -> &'static str {
    if nightly {
        "nightly"
    } else {
        "stable"
    }
}

fn download_url(nightly: bool) -> String {
    let repo = if nightly {
        "yt-dlp/yt-dlp-nightly-builds"
    } else {
        "yt-dlp/yt-dlp"
    };
    format!("https://github.com/{repo}/releases/latest/download/{ASSET}")
}

/// How often to re-download a channel's build to keep it fresh.
const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
/// Hard cap on the download (the exe is ~12 MB).
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

fn channel_path(app: &tauri::AppHandle, nightly: bool) -> PathBuf {
    #[cfg(windows)]
    let name = format!("yt-dlp-{}.exe", channel_str(nightly));
    #[cfg(not(windows))]
    let name = format!("yt-dlp-{}", channel_str(nightly));
    managed_path(app).with_file_name(name)
}

/// Program to spawn: the managed copy when present, otherwise bare
/// `yt-dlp` so PATH still works on dev machines. Resolved at every
/// spawn (not cached) so a download finishing mid-session takes effect
/// on the next track without a restart.
pub fn program(managed: &Path) -> PathBuf {
    if managed.exists() {
        managed.to_path_buf()
    } else {
        PathBuf::from("yt-dlp")
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
pub async fn ensure(app: tauri::AppHandle, nightly: bool) {
    // Serialize concurrent calls (StrictMode double-mount, retry spam).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    let active = managed_path(&app);
    let cached = channel_path(&app, nightly);

    if cached.exists() && stamp_age(&cached).is_some_and(|age| age < UPDATE_INTERVAL) {
        let _ = activate(&cached, &active).await;
        emit_state(&app, "ready", None);
        return;
    }

    // Dev fallback: a working PATH install means we can play right now.
    // Still fetch the managed copy so this install stops depending on the
    // machine's PATH from the next launch on.
    let path_works = !cached.exists() && !active.exists() && probe_path_install().await;
    if path_works {
        emit_state(&app, "ready", None);
    } else {
        emit_state(&app, "downloading", None);
    }

    match download(&cached, nightly).await {
        Ok(()) => {
            touch_stamp(&cached);
            let _ = activate(&cached, &active).await;
            emit_state(&app, "ready", None);
        }
        Err(e) => {
            eprintln!("[ytdlp] download failed: {e}");
            if cached.exists() {
                let _ = activate(&cached, &active).await;
            }
            if active.exists() || path_works {
                emit_state(&app, "ready", None);
            } else {
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

/// Fetch the binary into `<dest>.part`, then rename. The .part
/// indirection means a torn download never masquerades as a working
/// binary.
async fn download(dest: &Path, nightly: bool) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    }
    let part = dest.with_extension("part");
    let _ = tokio::fs::remove_file(&part).await;

    let fetch = async {
        let resp = reqwest::get(download_url(nightly))
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

    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("rename: {e}"))
}

fn stamp_path(bin: &Path) -> PathBuf {
    bin.with_extension("stamp")
}

fn touch_stamp(bin: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(stamp_path(bin), now.to_string());
}

fn stamp_age(bin: &Path) -> Option<Duration> {
    let raw = std::fs::read_to_string(stamp_path(bin)).ok()?;
    let then = raw.trim().parse::<u64>().ok()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Duration::from_secs(now.saturating_sub(then)))
}

async fn activate(cached: &Path, active: &Path) -> std::io::Result<()> {
    let tmp = active.with_extension("swap");
    tokio::fs::copy(cached, &tmp).await?;
    tokio::fs::rename(&tmp, active).await
}
