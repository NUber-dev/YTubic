//! yt-dlp playback commands. Deno runs the player challenges when the
//! managed runtime is installed; playback stays anonymous either way.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const FORMAT: &str = "bestaudio[ext=webm][protocol^=http]/bestaudio[protocol^=http]/bestaudio";
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// `deno` is `None` while the managed runtime is missing (first launch still
/// downloading it, or the download failed). yt-dlp then falls back to its own
/// runtime discovery instead of the whole track failing.
pub fn command(yt_dlp: &Path, deno: Option<&Path>) -> Command {
    let mut cmd = Command::new(yt_dlp);
    cmd.arg("--ignore-config");
    if let Some(deno) = deno {
        // App-owned configuration: explicitly select Deno, including paths
        // with spaces, so playback always uses the managed runtime.
        cmd.args(["--no-js-runtimes", "--js-runtimes"]);
        let mut runtime = std::ffi::OsString::from("deno:");
        runtime.push(deno);
        cmd.arg(runtime);
    }
    cmd.args(["--no-playlist", "--no-warnings", "--socket-timeout", "15"]);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);
    cmd
}

async fn read_stderr(mut stderr: tokio::process::ChildStderr) -> String {
    // Drain the pipe even after the limit so a verbose failure cannot
    // deadlock the child. The final error is at the end of yt-dlp's output.
    const LIMIT: usize = 16 * 1024;
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(n) = stderr.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.len() > LIMIT {
            tail.drain(..tail.len() - LIMIT);
        }
    }
    String::from_utf8_lossy(&tail).trim().to_string()
}

pub async fn download(
    yt_dlp: &Path,
    deno: Option<&Path>,
    video_id: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut cmd = command(yt_dlp, deno);
    cmd.args([
        "-f",
        FORMAT,
        "--no-part",
        "-q",
        "--retries",
        "5",
        "--extractor-retries",
        "3",
        "-o",
        "-",
    ]);
    cmd.arg(format!("https://www.youtube.com/watch?v={video_id}"));
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|e| format!("create audio file: {e}"))?;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut errors = tokio::spawn(read_stderr(child.stderr.take().expect("piped stderr")));
    let copy = async {
        let mut buffer = [0; 64 * 1024];
        loop {
            let n = tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buffer))
                .await
                .map_err(|_| "audio download timed out".to_string())?
                .map_err(|e| format!("read audio: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buffer[..n])
                .await
                .map_err(|e| format!("write audio: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("flush audio: {e}"))
    }
    .await;
    if copy.is_err() {
        let _ = child.kill().await;
    }
    let status = tokio::time::timeout(READ_TIMEOUT, child.wait()).await;
    if status.is_err() {
        let _ = child.kill().await;
    }
    let stderr = match tokio::time::timeout(Duration::from_secs(5), &mut errors).await {
        Ok(result) => result.map_err(|e| format!("read yt-dlp error: {e}"))?,
        Err(_) => {
            errors.abort();
            return Err("yt-dlp error output timed out".to_string());
        }
    };
    copy?;
    let status = status
        .map_err(|_| "yt-dlp exit timed out".to_string())?
        .map_err(|e| format!("wait for yt-dlp: {e}"))?;
    if !status.success() {
        return Err(format!("yt-dlp {status}: {stderr}"));
    }
    Ok(())
}

pub async fn resolve(yt_dlp: &Path, deno: Option<&Path>, video_id: &str) -> Result<String, String> {
    let output = tokio::time::timeout(
        READ_TIMEOUT,
        command(yt_dlp, deno)
            .args(["-j", "-f", FORMAT])
            .arg(format!("https://www.youtube.com/watch?v={video_id}"))
            .output(),
    )
    .await
    .map_err(|_| "audio lookup timed out".to_string())?
    .map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "yt-dlp {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("audio metadata is not UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn runtime_path_with_spaces_is_a_single_argument() {
        let args = args(&command(
            Path::new("yt-dlp"),
            Some(Path::new("path with spaces/deno")),
        ));
        assert!(args
            .windows(2)
            .any(|a| a == ["--js-runtimes", "deno:path with spaces/deno"]));
        assert!(args.contains(&"--no-js-runtimes".to_string()));
    }

    #[test]
    fn missing_runtime_leaves_yt_dlp_defaults_alone() {
        let args = args(&command(Path::new("yt-dlp"), None));
        assert!(!args.iter().any(|a| a.contains("js-runtimes")));
    }

    #[test]
    fn playback_never_sends_account_cookies() {
        let args = args(&command(Path::new("yt-dlp"), Some(Path::new("deno"))));
        assert!(!args.iter().any(|a| a.starts_with("--cookies")));
    }

    #[test]
    #[ignore = "requires YTUBIC_TEST_YTDLP, YTUBIC_TEST_DENO, YTUBIC_TEST_VIDEO_ID and YouTube access"]
    fn real_ytdlp_playback() {
        let yt_dlp =
            std::path::PathBuf::from(std::env::var_os("YTUBIC_TEST_YTDLP").expect("yt-dlp path"));
        let deno =
            std::path::PathBuf::from(std::env::var_os("YTUBIC_TEST_DENO").expect("Deno path"));
        let video_id = std::env::var("YTUBIC_TEST_VIDEO_ID").expect("video id");
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("audio.webm");
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            crate::deno::ensure(&deno).await.unwrap();
            download(&yt_dlp, Some(&deno), &video_id, &audio)
                .await
                .unwrap();
            let bytes = std::fs::read(audio).unwrap();
            assert!(bytes.len() > 32 * 1024);
            assert_eq!(&bytes[..4], &[0x1a, 0x45, 0xdf, 0xa3]);
            use sha2::Digest;
            println!(
                "Downloaded {} bytes; SHA-256 {:x}",
                bytes.len(),
                sha2::Sha256::digest(&bytes)
            );
        });
    }
}
