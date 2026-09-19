//! App-owned Node runtime for yt-dlp's YouTube player challenges.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

// Keep the version and hashes together. Node is updated with the app; yt-dlp
// continues to update independently when YouTube changes its extractors.
const VERSION: &str = "v26.9.0";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub fn managed_path(bin_dir: &Path) -> PathBuf {
    bin_dir.join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn release_asset(os: &str, arch: &str) -> Result<(String, &'static str), String> {
    let (platform, arch, digest) = match (os, arch) {
        ("windows", "x86_64") => (
            "win",
            "x64",
            "8490398f5e0082772dfb0ae5a6ebdff98a97696a20cb9778b4f82eec79b6d0a1",
        ),
        ("windows", "aarch64") => (
            "win",
            "arm64",
            "be0af07f8b8dd179a38625451168111d1b0c52df2b8956bbc8e7c5c4d59a4752",
        ),
        ("linux", "x86_64") => (
            "linux",
            "x64",
            "03d9104fc4f19652e74480fed11c023d75981464b7292f21a601c3f95ce7d90d",
        ),
        ("linux", "aarch64") => (
            "linux",
            "arm64",
            "d5077591aa38b48d90bf9b3ac10da8d2f40dce289b20294913c58c19f153eb12",
        ),
        ("macos", "x86_64") => (
            "darwin",
            "x64",
            "06b2e742ed9025dc84adc830243b3f731956eac9c321bccd0ede384209af02a8",
        ),
        ("macos", "aarch64") => (
            "darwin",
            "arm64",
            "6f3de7ed853ee283b4bf24b6e426618f1d357401ce5815db1866eb85eb4b05d9",
        ),
        _ => {
            return Err(format!(
                "Node playback runtime is unavailable for {os}/{arch}"
            ))
        }
    };
    let asset = if platform == "win" {
        format!("{platform}-{arch}/node.exe")
    } else {
        format!("node-{VERSION}-{platform}-{arch}.tar.gz")
    };
    Ok((asset, digest))
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
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == VERSION
        }
        _ => false,
    }
}

/// Serialize setup and playback callers so a first song cannot execute a
/// partly downloaded runtime. Staging lives on the install filesystem.
pub async fn ensure(path: &Path) -> Result<(), String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    if installed(path).await {
        return Ok(());
    }
    let root = path.parent().ok_or("Node install path has no parent")?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| format!("create Node directory: {e}"))?;
    let staging = tempfile::Builder::new()
        .prefix("node-install-")
        .tempdir_in(root)
        .map_err(|e| format!("create Node staging directory: {e}"))?;
    let install = download(staging.path(), path);
    tokio::time::timeout(DOWNLOAD_TIMEOUT, install)
        .await
        .map_err(|_| "Node download timed out".to_string())?
}

async fn download(staging: &Path, destination: &Path) -> Result<(), String> {
    let (asset, expected_hash) = release_asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let payload = staging.join("download");
    let mut response = reqwest::get(format!("https://nodejs.org/dist/{VERSION}/{asset}"))
        .await
        .map_err(|e| format!("request Node: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download Node: {e}"))?;
    let mut file = tokio::fs::File::create(&payload)
        .await
        .map_err(|e| format!("create Node download: {e}"))?;
    let mut hash = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read Node download: {e}"))?
    {
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write Node download: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("flush Node download: {e}"))?;
    drop(file);
    if format!("{:x}", hash.finalize()) != expected_hash {
        return Err("Node download failed SHA-256 verification".to_string());
    }

    #[cfg(windows)]
    let executable = {
        let executable = staging.join("node.exe");
        tokio::fs::rename(&payload, &executable)
            .await
            .map_err(|e| format!("stage Node: {e}"))?;
        executable
    };
    #[cfg(not(windows))]
    let executable = {
        let entry = format!("{}/bin/node", asset.trim_end_matches(".tar.gz"));
        // Both Linux and macOS ship tar. Extract only the runtime, without
        // npm, headers or the rest of the development toolchain.
        let output = tokio::process::Command::new("/usr/bin/tar")
            .args(["-xzf"])
            .arg(&payload)
            .arg("-C")
            .arg(staging)
            .arg("--strip-components=2")
            .arg(entry)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| format!("extract Node: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "extract Node: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        staging.join("node")
    };
    if !installed(&executable).await {
        return Err("Downloaded Node cannot run on this system".to_string());
    }
    // Verify before replacing the existing runtime. A failed download or
    // extraction leaves the previously installed executable untouched.
    tokio::fs::rename(&executable, destination)
        .await
        .map_err(|e| format!("install Node: {e}"))
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
    #[ignore = "downloads the official Node runtime; requires network access"]
    fn installs_official_node_and_reuses_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
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
