//! Managed yt-dlp binary lifecycle.
//!
//! End users don't have yt-dlp on PATH, so the app owns its copy: the
//! official release is downloaded into `<app-data>/bin/` on first run
//! and refreshed on a 72-hour cadence. The managed copy is canonical —
//! PATH is only a fallback for dev machines while the download hasn't
//! happened (or failed).
//!
//! Streaming resilience depends on this: YouTube regularly breaks
//! extractors and yt-dlp ships fixes within days, so the binary must
//! update on its own schedule, not the app's release schedule.
//!
//! # Why macOS takes the directory build
//!
//! Windows and Linux get the single-file release. macOS deliberately does
//! not: `yt-dlp_macos` is a PyInstaller *onefile* bundle, which unpacks
//! its ~100 bundled dylibs into a brand-new temp directory on every single
//! launch. Because the path is new each time, the kernel's code-signature
//! cache never hits and dyld re-hashes every dylib from scratch — the
//! process then sits in `fcntl` for ~30 seconds at 3% CPU before yt-dlp
//! runs a line of its own code. That cost is paid per spawn, so it landed
//! on every track the user played.
//!
//! `yt-dlp_macos.zip` is the same program built as a *directory* bundle.
//! Its files stay on disk, so the signature check happens once and later
//! launches start in ~0.3 s (measured: 30.0 s → 0.31 s). The trade is that
//! yt-dlp's own updater refuses to touch a directory install ("Auto-update
//! is not supported for unpackaged executables"), so `update_bundle` below
//! replaces `-U` on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
const BINARY_NAME: &str = "yt-dlp.exe";
/// The archive names its entry point after the platform, not plain `yt-dlp`.
#[cfg(target_os = "macos")]
const BINARY_NAME: &str = "yt-dlp_macos";
#[cfg(all(unix, not(target_os = "macos")))]
const BINARY_NAME: &str = "yt-dlp";

/// Directory the macOS bundle is unpacked into, under `<app-data>/bin/`.
#[cfg(target_os = "macos")]
const MACOS_BUNDLE_DIR: &str = "yt-dlp_macos";

/// Name of the in-flight download, kept beside the install rather than
/// inside it — on macOS the install directory itself is what gets replaced.
#[cfg(target_os = "macos")]
const DOWNLOAD_PART: &str = "yt-dlp_macos.zip.part";
#[cfg(not(target_os = "macos"))]
const DOWNLOAD_PART: &str = "yt-dlp.part";

/// Official builds. The `latest/download/` URL redirects to the newest
/// release asset, so no GitHub API call (and no rate limit) is involved.
/// macOS takes the directory bundle — see the module comment for why.
#[cfg(windows)]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "macos")]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip";
#[cfg(all(unix, not(target_os = "macos")))]
const DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/// How often to let the managed copy check for an update.
const UPDATE_INTERVAL: Duration = Duration::from_secs(72 * 60 * 60);
/// Hard cap on the `-U` self-update run.
#[cfg(not(target_os = "macos"))]
const UPDATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Hard cap on the first-run download (~12 MB single-file, ~52 MB zip).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Where the managed executable lives for this install. On macOS that is
/// one level deeper than the others: the entry point inside the unpacked
/// bundle directory.
pub fn managed_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin");
    #[cfg(target_os = "macos")]
    let dir = dir.join(MACOS_BUNDLE_DIR);
    dir.join(BINARY_NAME)
}

/// The `bin/` directory holding the managed install and its sidecar files
/// (the download in flight, the update stamp). One level up from the
/// executable everywhere except macOS, where the bundle nests it twice.
fn install_root(managed: &Path) -> &Path {
    let root = managed.parent().unwrap_or(managed);
    #[cfg(target_os = "macos")]
    let root = root.parent().unwrap_or(root);
    root
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
pub async fn ensure(app: tauri::AppHandle) {
    // Serialize concurrent calls (StrictMode double-mount, retry spam).
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    let managed = managed_path(&app);

    if managed.exists() {
        emit_state(&app, "ready", None);
        // Before the update check, not after: the check can spend minutes
        // re-downloading, and warming is what the next play actually waits on.
        #[cfg(target_os = "macos")]
        {
            prewarm(&managed);
            sweep_legacy_onefile(&managed).await;
        }
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
            #[cfg(target_os = "macos")]
            {
                prewarm(&managed);
                sweep_legacy_onefile(&managed).await;
            }
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

/// Fetch the official release into a `.part` file, then put it in place.
/// The .part indirection means a torn download never masquerades as a
/// working install — on macOS the payload is an archive that then gets
/// unpacked by `extract_bundle`, everywhere else it is the binary itself.
async fn download(managed: &Path) -> Result<(), String> {
    let root = install_root(managed);
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("mkdir {root:?}: {e}"))?;
    let part = root.join(DOWNLOAD_PART);
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

    // Sanity floor: the real payload is tens of MB; a tiny one is an error
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

    #[cfg(target_os = "macos")]
    {
        let dest = managed.parent().unwrap_or(root);
        let result = extract_bundle(&part, dest).await;
        let _ = tokio::fs::remove_file(&part).await;
        return result;
    }

    #[cfg(not(target_os = "macos"))]
    {
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
}

/// Unpack the release archive into `dest`, swapping it in only once the
/// new copy is known-good, so a torn extraction can never replace a
/// working install with a broken one.
#[cfg(target_os = "macos")]
async fn extract_bundle(zip: &Path, dest: &Path) -> Result<(), String> {
    let staging = dest.with_extension("new");
    let previous = dest.with_extension("old");
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let _ = tokio::fs::remove_dir_all(&previous).await;

    // /usr/bin/unzip ships with macOS and restores the executable bit the
    // bundle's entry point needs, so no zip crate has to enter the tree.
    let status = tokio::process::Command::new("/usr/bin/unzip")
        .arg("-q")
        .arg("-o")
        .arg(zip)
        .arg("-d")
        .arg(&staging)
        .status()
        .await
        .map_err(|e| format!("spawn unzip: {e}"))?;
    if !status.success() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(format!("unzip exited {status}"));
    }
    // An archive without the entry point is not something to install over a
    // copy that currently works.
    if !staging.join(BINARY_NAME).exists() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(format!("{BINARY_NAME} missing from the archive"));
    }

    // Move the old copy aside rather than deleting it, so a failure between
    // the two renames can be undone instead of leaving no yt-dlp at all.
    let had_previous = tokio::fs::metadata(dest).await.is_ok();
    if had_previous {
        tokio::fs::rename(dest, &previous)
            .await
            .map_err(|e| format!("move the old bundle aside: {e}"))?;
    }
    if let Err(e) = tokio::fs::rename(&staging, dest).await {
        if had_previous {
            let _ = tokio::fs::rename(&previous, dest).await;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(format!("install the bundle: {e}"));
    }
    let _ = tokio::fs::remove_dir_all(&previous).await;
    Ok(())
}

/// Pay the bundle's cold-start cost off the critical path.
///
/// The directory build is only fast once the kernel has hashed each of its
/// dylibs, and that first pass costs ~30 s (see the module comment). Left
/// alone it lands on whichever track the user plays first; running it in
/// the background at launch moves it to a moment nobody is waiting on.
/// When the cache is already warm this returns in a fraction of a second,
/// so it is cheap enough to do on every launch.
/// Delete the single-file copy that earlier versions installed.
///
/// An install predating the directory bundle leaves a ~36 MB `bin/yt-dlp`
/// that nothing reads any more. Swept only once the bundle is actually in
/// place, so an install that hasn't migrated yet keeps something runnable.
#[cfg(target_os = "macos")]
async fn sweep_legacy_onefile(managed: &Path) {
    if !managed.exists() {
        return;
    }
    // Can't collide with the bundle: that directory is `yt-dlp_macos`.
    let legacy = install_root(managed).join("yt-dlp");
    if tokio::fs::metadata(&legacy).await.is_err() {
        return;
    }
    match tokio::fs::remove_file(&legacy).await {
        Ok(()) => eprintln!("[ytdlp] removed the superseded single-file copy"),
        Err(e) => eprintln!("[ytdlp] could not remove {legacy:?}: {e}"),
    }
}

#[cfg(target_os = "macos")]
fn prewarm(managed: &Path) {
    let managed = managed.to_path_buf();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let ok = tokio::process::Command::new(&managed)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            eprintln!("[ytdlp] warmed in {:.1}s", started.elapsed().as_secs_f32());
        }
    });
}

fn update_stamp_path(managed: &Path) -> PathBuf {
    // Beside the install, never inside it: on macOS the bundle directory is
    // replaced wholesale on update, which would take the stamp with it and
    // put the check back into a loop.
    install_root(managed).join("last-update-check")
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

/// Bring the managed copy up to date when the last check is older than
/// `UPDATE_INTERVAL`. The stamp is refreshed even on failure so a broken
/// update path can't turn into a retry storm on every launch.
async fn maybe_self_update(managed: &Path) {
    match update_stamp_age(managed) {
        Some(age) if age < UPDATE_INTERVAL => return,
        _ => {}
    }
    touch_update_stamp(managed);

    #[cfg(target_os = "macos")]
    update_bundle(managed).await;
    #[cfg(not(target_os = "macos"))]
    run_self_update(managed).await;
}

/// macOS replacement for `-U`: yt-dlp's updater refuses to touch a
/// directory install ("Auto-update is not supported for unpackaged
/// executables"), so compare the installed version against the newest
/// release ourselves and re-install the bundle when they differ.
#[cfg(target_os = "macos")]
async fn update_bundle(managed: &Path) {
    let Some(latest) = latest_release_tag().await else {
        eprintln!("[ytdlp] could not read the latest release tag; keeping the current copy");
        return;
    };
    let installed = installed_version(managed).await;
    if installed.as_deref() == Some(latest.as_str()) {
        return;
    }
    eprintln!(
        "[ytdlp] updating {} -> {latest}",
        installed.as_deref().unwrap_or("unknown")
    );
    match download(managed).await {
        // The freshly unpacked dylibs are cold again, so warm them now
        // rather than on the next track the user plays.
        Ok(()) => {
            eprintln!("[ytdlp] updated to {latest}");
            prewarm(managed);
        }
        Err(e) => eprintln!("[ytdlp] update failed: {e}"),
    }
}

/// Newest published version, read from the redirect `releases/latest`
/// serves. One HEAD request, and unlike the GitHub API it carries no rate
/// limit — the same reason the download URLs above go through
/// `latest/download/`.
async fn latest_release_tag() -> Option<String> {
    let resp = reqwest::Client::new()
        .head("https://github.com/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let tag = resp.url().path().rsplit('/').next()?.trim().to_string();
    // If the redirect ever stops landing on a version, treat it as unknown.
    // Comparing against a non-version would re-download the bundle on every
    // single check.
    if !tag.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    Some(tag)
}

/// Version the installed copy reports, or `None` if it won't run.
async fn installed_version(managed: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(managed);
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Windows / Linux: the single-file release replaces itself in place.
#[cfg(not(target_os = "macos"))]
async fn run_self_update(managed: &Path) {
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

    // `-U` reports its own success and can still leave the old copy in
    // place (it has, silently, for weeks at a time). Because the stamp is
    // refreshed before the attempt, a quiet failure buys another 72 hours
    // on a binary YouTube may already have broken, so confirm the version
    // actually moved, and fall back to re-fetching the release asset when
    // it didn't. Same path the first-run download takes.
    let Some(latest) = latest_release_tag().await else {
        return;
    };
    if installed_version(managed).await.as_deref() == Some(latest.as_str()) {
        return;
    }
    eprintln!("[ytdlp] self-update left us behind {latest}; re-downloading");
    match download(managed).await {
        Ok(()) => eprintln!("[ytdlp] re-downloaded {latest}"),
        Err(e) => eprintln!("[ytdlp] re-download failed: {e}"),
    }
}

/// The swap in `extract_bundle` is the one place where a bad download can
/// destroy a working install, so it gets a test: a valid archive must
/// replace the old bundle, and an archive missing the entry point must
/// leave the existing one exactly as it was.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ytubic-ytdlp-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build an archive shaped like the real one: the entry point plus an
    /// `_internal/` payload, both at the archive root.
    fn make_zip(root: &Path, marker: &str, with_entry_point: bool) -> PathBuf {
        let src = root.join(format!("src-{marker}"));
        std::fs::create_dir_all(src.join("_internal")).unwrap();
        std::fs::write(src.join("_internal/lib.so"), marker).unwrap();
        if with_entry_point {
            std::fs::write(src.join(BINARY_NAME), marker).unwrap();
        }
        let zip = root.join(format!("{marker}.zip"));
        let status = std::process::Command::new("/usr/bin/zip")
            .arg("-q")
            .arg("-r")
            .arg(&zip)
            .arg(".")
            .current_dir(&src)
            .status()
            .unwrap();
        assert!(status.success());
        zip
    }

    fn entry_point_contents(dest: &Path) -> String {
        std::fs::read_to_string(dest.join(BINARY_NAME)).unwrap()
    }

    #[test]
    fn extract_installs_then_replaces_and_leaves_no_staging() {
        let root = scratch("replace");
        let dest = root.join(MACOS_BUNDLE_DIR);
        let rt = tokio::runtime::Runtime::new().unwrap();

        rt.block_on(extract_bundle(&make_zip(&root, "first", true), &dest))
            .unwrap();
        assert_eq!(entry_point_contents(&dest), "first");

        rt.block_on(extract_bundle(&make_zip(&root, "second", true), &dest))
            .unwrap();
        assert_eq!(entry_point_contents(&dest), "second");
        assert!(dest.join("_internal/lib.so").exists());

        // Leftover staging would be silently re-used by the next extraction.
        assert!(!dest.with_extension("new").exists());
        assert!(!dest.with_extension("old").exists());
    }

    #[test]
    fn archive_without_entry_point_leaves_the_working_install_alone() {
        let root = scratch("reject");
        let dest = root.join(MACOS_BUNDLE_DIR);
        let rt = tokio::runtime::Runtime::new().unwrap();

        rt.block_on(extract_bundle(&make_zip(&root, "good", true), &dest))
            .unwrap();

        let err = rt
            .block_on(extract_bundle(&make_zip(&root, "broken", false), &dest))
            .unwrap_err();
        assert!(err.contains(BINARY_NAME), "unexpected error: {err}");
        // Still the copy that worked, not a half-installed one.
        assert_eq!(entry_point_contents(&dest), "good");
        assert!(!dest.with_extension("new").exists());
    }

    #[test]
    fn install_root_is_the_bin_dir_not_the_bundle() {
        let managed = PathBuf::from("/app-data/bin")
            .join(MACOS_BUNDLE_DIR)
            .join(BINARY_NAME);
        assert_eq!(install_root(&managed), Path::new("/app-data/bin"));
        // The update stamp has to survive the bundle being replaced.
        assert_eq!(
            update_stamp_path(&managed),
            Path::new("/app-data/bin/last-update-check")
        );
    }
}
