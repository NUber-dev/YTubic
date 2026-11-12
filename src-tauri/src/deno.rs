//! App-owned Deno runtime for yt-dlp's YouTube player challenges.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

// Keep the version and hashes together. Deno is updated with the app; yt-dlp
// continues to update independently when YouTube changes its extractors.
// 2.8.3 is the last release before Deno raised its macOS minimum to 12.
// Its official binaries target 10.12 on Intel and 11.0 on Apple Silicon.
const VERSION: &str = "2.8.3";
const BINARY_NAME: &str = if cfg!(windows) { "deno.exe" } else { "deno" };
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub fn managed_path(bin_dir: &Path) -> PathBuf {
    bin_dir.join(BINARY_NAME)
}

fn release_asset(os: &str, arch: &str) -> Result<(String, &'static str), String> {
    let (target, digest) = match (os, arch) {
        ("windows", "x86_64") => (
            "x86_64-pc-windows-msvc",
            "7fdd1f42e6b0855421ecf27bb406e2492ade1087c85e30ebf0deab6280ea743c",
        ),
        ("windows", "aarch64") => (
            "aarch64-pc-windows-msvc",
            "243f478ac577ade1bbd980ecf510607a10ed8cc977b462083ada48e5f6580de1",
        ),
        ("linux", "x86_64") => (
            "x86_64-unknown-linux-gnu",
            "30455b845ffa6082209c3590269c910ad3b7efdf28c9879afd4006c47ae54197",
        ),
        ("linux", "aarch64") => (
            "aarch64-unknown-linux-gnu",
            "d4589cc1ffcbf1995c92a0127d932aaf832ac70cfdcc6d5b7bf38043cf303575",
        ),
        ("macos", "x86_64") => (
            "x86_64-apple-darwin",
            "4254ec12123cfcf88b87703d7acf092a1ea024bdf9be8dd3cd9d4474761cb74e",
        ),
        ("macos", "aarch64") => (
            "aarch64-apple-darwin",
            "88b350be928fdba0e5d8142ff7c101a17133426371e3cf5ed0e0f74e62476f6c",
        ),
        _ => {
            return Err(format!(
                "Deno playback runtime is unavailable for {os}/{arch}"
            ))
        }
    };
    Ok((format!("deno-{target}.zip"), digest))
}

pub async fn installed(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match tokio::time::timeout(Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(output)) => {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .split_whitespace()
                    .take(2)
                    .eq(["deno", VERSION])
        }
        _ => false,
    }
}

/// Set once the managed runtime has been seen working, so playback does not
/// spawn `deno --version` before every track.
static READY: AtomicBool = AtomicBool::new(false);

/// The runtime playback should hand to yt-dlp, or `None` while it is missing.
/// Never downloads: that is setup's job, and a 40 MB fetch must not sit in
/// front of a song. The install is an atomic rename, so a runtime that is
/// still downloading is simply absent here.
pub async fn available(path: &Path) -> Option<&Path> {
    if READY.load(Ordering::Acquire) || installed(path).await {
        READY.store(true, Ordering::Release);
        Some(path)
    } else {
        None
    }
}

/// Serialize setup callers. Staging lives on the install filesystem.
pub async fn ensure(path: &Path) -> Result<(), String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    if installed(path).await {
        READY.store(true, Ordering::Release);
        return Ok(());
    }
    let root = path.parent().ok_or("Deno install path has no parent")?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("create Deno directory: {e}"))?;
    let staging = tempfile::Builder::new()
        .prefix("deno-install-")
        .tempdir_in(root)
        .map_err(|e| format!("create Deno staging directory: {e}"))?;
    let install = download(staging.path(), path);
    tokio::time::timeout(DOWNLOAD_TIMEOUT, install)
        .await
        .map_err(|_| "Deno download timed out".to_string())?
}

async fn download(staging: &Path, destination: &Path) -> Result<(), String> {
    let (asset, expected_hash) = release_asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let payload = staging.join("download");
    let mut response = reqwest::get(format!(
        "https://github.com/denoland/deno/releases/download/v{VERSION}/{asset}"
    ))
    .await
    .map_err(|e| format!("request Deno: {e}"))?
    .error_for_status()
    .map_err(|e| format!("download Deno: {e}"))?;
    let mut file = tokio::fs::File::create(&payload)
        .await
        .map_err(|e| format!("create Deno download: {e}"))?;
    let mut hash = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read Deno download: {e}"))?
    {
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write Deno download: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("flush Deno download: {e}"))?;
    drop(file);
    if format!("{:x}", hash.finalize()) != expected_hash {
        return Err("Deno download failed SHA-256 verification".to_string());
    }

    let executable = managed_path(staging);
    let executable = tokio::task::spawn_blocking(move || extract(payload, executable))
        .await
        .map_err(|e| format!("extract Deno: {e}"))?
        .map_err(|e| format!("extract Deno: {e}"))?;
    if !installed(&executable).await {
        return Err("Downloaded Deno cannot run on this system".to_string());
    }
    // Verify before replacing the existing runtime. A failed download or
    // extraction leaves the previously installed executable untouched.
    tokio::fs::rename(&executable, destination)
        .await
        .map_err(|e| format!("install Deno: {e}"))?;
    READY.store(true, Ordering::Release);
    Ok(())
}

fn extract(payload: PathBuf, executable: PathBuf) -> zip::result::ZipResult<PathBuf> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(payload)?)?;
    // Copy only the expected executable; archive paths never select destinations.
    let mut entry = archive.by_name(BINARY_NAME)?;
    let mut file = std::fs::File::create(&executable)?;
    std::io::copy(&mut entry, &mut file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(executable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_platform_has_an_explicit_error() {
        assert!(release_asset("linux", "riscv64")
            .unwrap_err()
            .contains("linux/riscv64"));
    }

    #[test]
    #[ignore = "downloads the official Deno runtime; requires network access"]
    fn installs_official_deno_and_reuses_it() {
        let root = tempfile::tempdir().unwrap();
        let path = managed_path(root.path());
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            ensure(&path).await.unwrap();
            assert!(installed(&path).await);
            let before = std::fs::metadata(&path).unwrap().modified().unwrap();
            ensure(&path).await.unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                before
            );
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
        });
    }
}
