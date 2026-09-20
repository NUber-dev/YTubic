//! yt-dlp playback commands. Deno runs the player challenges; session cookies
//! are supplied only for the caller's authenticated retry.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const FORMAT: &str = "bestaudio[ext=webm][protocol^=http]/bestaudio[protocol^=http]/bestaudio";
const READ_TIMEOUT: Duration = Duration::from_secs(60);

pub fn command(yt_dlp: &Path, deno: &Path, cookies: Option<&Path>) -> Command {
    let mut cmd = Command::new(yt_dlp);
    // App-owned configuration: explicitly select Deno, including paths with
    // spaces, so playback always uses the managed runtime.
    cmd.args(["--ignore-config", "--no-js-runtimes", "--js-runtimes"]);
    let mut runtime = std::ffi::OsString::from("deno:");
    runtime.push(deno);
    cmd.arg(runtime);
    cmd.args(["--no-playlist", "--no-warnings", "--socket-timeout", "15"]);
    if let Some(path) = cookies {
        cmd.arg("--cookies").arg(path);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);
    cmd
}

pub fn needs_login(error: &str) -> bool {
    error.contains("Sign in to confirm")
}

/// yt-dlp rewrites its cookie jar on exit. Always pass a disposable copy,
/// keeping the encrypted account jar under the session keeper's control.
pub fn session_file(jar: &str) -> Result<tempfile::NamedTempFile, String> {
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("ytubic-cookies-")
        .tempfile()
        .map_err(|e| format!("create playback session: {e}"))?;
    file.write_all(jar.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| format!("write playback session: {e}"))?;
    Ok(file)
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
    deno: &Path,
    video_id: &str,
    destination: &Path,
    cookies: Option<&Path>,
) -> Result<(), String> {
    let mut cmd = command(yt_dlp, deno, cookies);
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
    // Truncate on every attempt, including the authenticated retry.
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

pub async fn resolve(
    yt_dlp: &Path,
    deno: &Path,
    video_id: &str,
    cookies: Option<&Path>,
) -> Result<String, String> {
    let output = tokio::time::timeout(
        READ_TIMEOUT,
        command(yt_dlp, deno, cookies)
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

    #[test]
    fn session_copy_is_private_and_removed_after_use() {
        let jar = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\ttest\n";
        let file = session_file(jar).unwrap();
        let path = file.path().to_path_buf();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), jar);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // Simulate yt-dlp saving rotations into its own copy.
        std::fs::write(&path, "updated jar").unwrap();
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn login_retry_is_limited_to_youtube_sign_in_errors() {
        assert!(needs_login("ERROR: Sign in to confirm you’re not a bot."));
        assert!(needs_login("ERROR: Sign in to confirm you're not a bot."));
        assert!(!needs_login("HTTP Error 403: Forbidden"));
        assert!(!needs_login("Video unavailable"));
        assert!(!needs_login("deno executable not found"));
    }

    #[test]
    fn runtime_and_cookie_paths_with_spaces_are_single_arguments() {
        let cmd = command(
            Path::new("yt-dlp"),
            Path::new("path with spaces/deno"),
            Some(Path::new("session with spaces.txt")),
        );
        let args: Vec<_> = cmd
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|a| a == ["--js-runtimes", "deno:path with spaces/deno"]));
        assert!(args
            .windows(2)
            .any(|a| a == ["--cookies", "session with spaces.txt"]));
        assert!(args.contains(&"--no-js-runtimes".to_string()));
        assert!(!command(Path::new("yt-dlp"), Path::new("deno"), None)
            .as_std()
            .get_args()
            .any(|a| a == "--cookies"));
    }

    #[test]
    #[ignore = "requires YTUBIC_TEST_YTDLP, YTUBIC_TEST_DENO, YTUBIC_TEST_VIDEO_ID and YouTube access; optional YTUBIC_TEST_COOKIES"]
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
            let result = download(&yt_dlp, &deno, &video_id, &audio, None).await;
            match result {
                Err(error) if needs_login(&error) => {
                    println!("YouTube requested sign-in; retrying with the saved session");
                    let jar = std::fs::read_to_string(
                        std::env::var_os("YTUBIC_TEST_COOKIES")
                            .expect("cookie jar for login retry"),
                    )
                    .unwrap();
                    let cookies = session_file(&jar).unwrap();
                    let path = cookies.path().to_path_buf();
                    download(&yt_dlp, &deno, &video_id, &audio, Some(&path))
                        .await
                        .unwrap();
                    let metadata = resolve(&yt_dlp, &deno, &video_id, Some(&path))
                        .await
                        .unwrap();
                    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
                    assert_eq!(metadata["id"], video_id);
                    drop(cookies);
                    assert!(!path.exists());
                }
                other => other.unwrap(),
            }
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
