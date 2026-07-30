use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::sync::{Mutex, Notify};

use axum::{
    extract::{Path, Request, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tower::ServiceExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeFile;

mod appid;
mod discord;
mod lastfm;
mod media;
mod power;
mod ytdlp;

/// Write `bytes` to `path` atomically: a sibling temp file, flushed to
/// disk, then renamed over the target.
///
/// A bare `fs::write` truncates first, so losing the process mid-write
/// leaves a zero-length file, and a Windows shutdown does exactly that
/// to a running app. A truncated `cookies.enc` or `accounts.json` reads
/// as "signed out" with no way back short of a re-login, which is the
/// hard-logout variant of the bug users report after a cold boot.
async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    let mut f = tokio::fs::File::create(&tmp).await?;
    f.write_all(bytes).await?;
    // fsync before the rename: without it NTFS can publish the renamed
    // directory entry while the contents are still only in the page
    // cache, which is the same torn file by another route.
    f.sync_all().await?;
    drop(f);
    tokio::fs::rename(&tmp, path).await
}

fn sanitize_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Platform-native symmetric "encrypt with current user's credentials"
/// primitive. On Windows we use DPAPI (CryptProtectData) — the blob is
/// only decryptable by the same Windows user on the same machine. Linux and
/// macOS use AES-256-GCM and keep only the random data key in the native
/// credential store (Secret Service or Keychain).
///
/// A fixed `ENTROPY` byte string is mixed in so a *different* app
/// running as the same user can't trivially pass our blob to
/// CryptUnprotectData and get our cookies out. This is a small hurdle
/// against generic credential-stealer malware, not a real boundary —
/// any attacker with our binary can read the entropy string.
mod secure_store {
    #[cfg(windows)]
    // Keeps the historical "ytm-native" tag on purpose: this string is
    // baked into every existing encrypted cookie jar, and changing it
    // would orphan them all. It's an opaque salt, not a product name.
    const ENTROPY: &[u8] = b"ytm-native/cookies.enc v1";

    #[cfg(windows)]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        use std::ptr;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: plain.len() as u32,
                pbData: plain.as_ptr() as *mut u8,
            };
            let ent_blob = CRYPT_INTEGER_BLOB {
                cbData: ENTROPY.len() as u32,
                pbData: ENTROPY.as_ptr() as *mut u8,
            };
            let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            let ok = CryptProtectData(
                &in_blob,
                ptr::null(),
                &ent_blob,
                ptr::null_mut(),
                ptr::null(),
                0,
                &mut out_blob,
            );
            if ok == 0 {
                return Err("CryptProtectData failed".into());
            }
            let data =
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            LocalFree(out_blob.pbData as _);
            Ok(data)
        }
    }

    #[cfg(windows)]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        use std::ptr;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: encrypted.len() as u32,
                pbData: encrypted.as_ptr() as *mut u8,
            };
            let ent_blob = CRYPT_INTEGER_BLOB {
                cbData: ENTROPY.len() as u32,
                pbData: ENTROPY.as_ptr() as *mut u8,
            };
            let mut out_blob: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            let ok = CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                &ent_blob,
                ptr::null_mut(),
                ptr::null(),
                0,
                &mut out_blob,
            );
            if ok == 0 {
                return Err("CryptUnprotectData failed".into());
            }
            let data =
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            LocalFree(out_blob.pbData as _);
            Ok(data)
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_MAGIC: &[u8; 5] = b"YTBC1";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_NONCE_LEN: usize = 12;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_KEY_LEN: usize = 32;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_SERVICE: &str = "com.github.ivasy.ytubic";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const KEYRING_USER: &str = "cookie-encryption-key-v1";

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_encryption_key() -> Result<[u8; KEYRING_KEY_LEN], String> {
        use keyring::{Entry, Error};
        use rand::RngCore;

        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|error| format!("system credential store is unavailable: {error}"))?;

        match entry.get_secret() {
            Ok(secret) => secret.try_into().map_err(|secret: Vec<u8>| {
                format!(
                    "system credential store returned an invalid YTubic key ({} bytes)",
                    secret.len()
                )
            }),
            Err(Error::NoEntry) => {
                let mut key = [0_u8; KEYRING_KEY_LEN];
                rand::rngs::OsRng.fill_bytes(&mut key);
                entry.set_secret(&key).map_err(|error| {
                    format!("failed to save key in system credential store: {error}")
                })?;
                Ok(key)
            }
            Err(error) => Err(format!(
                "failed to read key from system credential store: {error}"
            )),
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_encrypt_with_key(
        plain: &[u8],
        key: &[u8; KEYRING_KEY_LEN],
        nonce: &[u8; KEYRING_NONCE_LEN],
    ) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "failed to initialize cookie encryption".to_string())?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(nonce), plain)
            .map_err(|_| "failed to encrypt cookie jar".to_string())?;

        let mut framed = Vec::with_capacity(KEYRING_MAGIC.len() + nonce.len() + ciphertext.len());
        framed.extend_from_slice(KEYRING_MAGIC);
        framed.extend_from_slice(nonce);
        framed.extend_from_slice(&ciphertext);
        Ok(framed)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn keyring_decrypt_with_key(
        encrypted: &[u8],
        key: &[u8; KEYRING_KEY_LEN],
    ) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};

        if !encrypted.starts_with(KEYRING_MAGIC) {
            // Earlier builds on this platform wrote plaintext jars. Accept
            // one so the next successful persistence pass can migrate it.
            return Ok(encrypted.to_vec());
        }

        let payload = &encrypted[KEYRING_MAGIC.len()..];
        if payload.len() <= KEYRING_NONCE_LEN {
            return Err("encrypted cookie jar is truncated".to_string());
        }
        let (nonce, ciphertext) = payload.split_at(KEYRING_NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "failed to initialize cookie decryption".to_string())?;
        cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|_| "failed to decrypt cookie jar".to_string())
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        use rand::RngCore;

        let key = keyring_encryption_key()?;
        let mut nonce = [0_u8; KEYRING_NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        keyring_encrypt_with_key(plain, &key, &nonce)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        if !encrypted.starts_with(KEYRING_MAGIC) {
            return Ok(encrypted.to_vec());
        }
        let key = keyring_encryption_key()?;
        keyring_decrypt_with_key(encrypted, &key)
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }

    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        Ok(encrypted.to_vec())
    }

    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    mod keyring_tests {
        use super::*;

        const KEY: [u8; KEYRING_KEY_LEN] = [7; KEYRING_KEY_LEN];
        const NONCE: [u8; KEYRING_NONCE_LEN] = [3; KEYRING_NONCE_LEN];

        #[test]
        fn encrypted_cookie_jar_round_trips() {
            let encrypted = keyring_encrypt_with_key(b"SID=secret", &KEY, &NONCE).unwrap();
            assert!(encrypted.starts_with(KEYRING_MAGIC));
            assert_eq!(
                keyring_decrypt_with_key(&encrypted, &KEY).unwrap(),
                b"SID=secret"
            );
        }

        #[test]
        fn tampered_cookie_jar_is_rejected() {
            let mut encrypted = keyring_encrypt_with_key(b"SID=secret", &KEY, &NONCE).unwrap();
            *encrypted.last_mut().unwrap() ^= 1;
            assert!(keyring_decrypt_with_key(&encrypted, &KEY).is_err());
        }

        #[test]
        fn plaintext_cookie_jar_is_accepted_for_migration() {
            assert_eq!(
                keyring_decrypt_with_key(b"SID=legacy", &KEY).unwrap(),
                b"SID=legacy"
            );
        }
    }
}

/// Per-account metadata persisted in `accounts.json`. Cookies are NOT
/// stored here — they live encrypted under `accounts/<id>/cookies.enc`.
/// `name` / `email` / `photo_url` start empty for a freshly logged-in
/// account and get backfilled by the frontend once `/account_menu`
/// returns the active user's info (see `update_account_meta`).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct Account {
    id: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "photoUrl")]
    photo_url: Option<String>,
    /// Brand-channel identity within this Google account. `None` means
    /// the personal (default) channel. Sent as `X-Goog-PageId` on
    /// InnerTube requests; library, likes and home are scoped to it.
    #[serde(default, rename = "pageId")]
    page_id: Option<String>,
    /// Display meta for the selected channel so the UI can show it
    /// without a network round-trip.
    #[serde(default, rename = "channelName")]
    channel_name: Option<String>,
    #[serde(default, rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    /// Unix seconds when this account was first added.
    #[serde(default, rename = "addedAt")]
    added_at: i64,
}

/// Root document of `accounts.json`. `active` is the id of the
/// currently-selected account or `None` when the user is signed out
/// of everything.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct AccountsIndex {
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    accounts: Vec<Account>,
}

/// What we hand back to the frontend — augments [`Account`] with the
/// derived `isActive` flag so the UI doesn't have to cross-reference
/// against a second field.
#[derive(Clone, Debug, serde::Serialize)]
struct AccountSummary {
    id: String,
    email: String,
    name: String,
    #[serde(rename = "photoUrl")]
    photo_url: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
    #[serde(rename = "channelName")]
    channel_name: Option<String>,
    #[serde(rename = "channelPhotoUrl")]
    channel_photo_url: Option<String>,
    #[serde(rename = "isActive")]
    is_active: bool,
    /// False for accounts with no persisted WebView2 profile: added
    /// before the session-keeper shipped, or whose profile could not be
    /// moved during a dedup. Their snapshot can never be renewed, so
    /// they die whenever Google decides the extracted cookies are stale
    /// and there is nothing the app can do about it. The UI offers a
    /// re-link instead of leaving the user to discover it.
    #[serde(rename = "canRefresh")]
    can_refresh: bool,
}

fn accounts_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts")
}

fn accounts_index_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("accounts.json")
}

fn account_cookies_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("cookies.enc")
}

/// Per-account persistent WebView2 profile. Unlike the throwaway login
/// profile of old, this survives a successful sign-in: it holds the
/// live, Google-bound browser session. A periodic hidden reload re-
/// extracts fresh cookies from it (see `refresh_account_cookies`) so the
/// snapshot we replay never outlives Google's ~2h leash on *extracted*
/// cookies. That leash is what made libraries silently empty mid-session.
fn account_webview_dir(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("webview")
}

/// Browser UA the login and refresh WebViews both present to Google. Kept
/// identical so the session Google issues to the login window is the
/// same one the refresh window later renews. The claimed browser must match
/// the actual webview engine: WebView2 presents Chrome, while WKWebView must
/// present Safari or Google rejects the sign-in as an insecure browser.
#[cfg(not(target_os = "macos"))]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
const YT_LOGIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// WebView2 browser args shared by the login window and the session-keeper.
/// Both open the same per-account profile directory, and WebView2 requires
/// every instance on a shared user-data folder to pass identical args, so
/// these have to match. They also stop both windows from grabbing the
/// hardware media keys or running a media session (which would hijack
/// play/pause from the real player), and block autoplay so a hidden keeper
/// never starts making sound on its own.
const YT_WEBVIEW_ARGS: &str = "--disable-features=HardwareMediaKeyHandling,MediaSessionService \
     --autoplay-policy=user-gesture-required";

/// WebView2 browser args for windows on the DEFAULT user-data folder — the
/// main window and the floating player. Must stay byte-identical to
/// `additionalBrowserArgs` in `tauri.conf.json`: WebView2 refuses to create
/// a second webview on the same user-data folder with different args, so a
/// mismatch makes `open_player_window` fail and the floating player never
/// appears. (The first three disabled features are wry's own defaults,
/// which the conf.json value extends.)
const APP_WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HardwareMediaKeyHandling,MediaSessionService";

/// Legacy single-account path — kept only for migration. New code
/// should resolve cookies via `active_cookies_path`.
fn legacy_cookies_enc_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cookies.enc")
}

/// Read `accounts.json`. Every failure degrades to an empty index, and
/// an empty index means `active: None`, which reads as signed out AND
/// makes the periodic refresh loop a no-op, so nothing can heal it.
/// That makes the difference between "file isn't there yet" (normal on
/// a first run) and "file is there but unreadable" (a real fault, most
/// likely a torn write from a shutdown) worth logging loudly.
async fn read_index(app: &tauri::AppHandle) -> AccountsIndex {
    let path = accounts_index_path(app);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return AccountsIndex::default(),
        Err(e) => {
            eprintln!("[accounts] read accounts.json failed: {e}; treating as signed out");
            return AccountsIndex::default();
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!(
                "[accounts] accounts.json is unparseable ({} bytes): {e}; treating as signed out",
                bytes.len()
            );
            AccountsIndex::default()
        }
    }
}

async fn write_index(app: &tauri::AppHandle, idx: &AccountsIndex) -> Result<(), String> {
    let path = accounts_index_path(app);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir accounts dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(idx).map_err(|e| format!("serialize: {e}"))?;
    // Atomic: `useAccountMetaBackfill` rewrites this on every launch, so
    // a truncating write opens a signed-out window on every start.
    write_atomic(&path, &bytes)
        .await
        .map_err(|e| format!("write index: {e}"))
}

/// Resolve the cookie jar path for the active account, or `None` when
/// nobody is signed in.
async fn active_cookies_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let idx = read_index(app).await;
    let id = idx.active?;
    Some(account_cookies_path(app, &id))
}

/// One-time migration: if a plaintext `cookies.txt` from a previous
/// version exists, encrypt its contents into `cookies.enc` and remove
/// the original. Best-effort: logs on failure but never blocks startup.
async fn migrate_plaintext_cookies(app: &tauri::AppHandle) {
    let enc_path = legacy_cookies_enc_path(app);
    let old_path = enc_path.with_file_name("cookies.txt");
    if enc_path.exists() || !old_path.exists() {
        return;
    }
    let Ok(plain) = tokio::fs::read(&old_path).await else {
        return;
    };
    match secure_store::encrypt(&plain) {
        Ok(enc) => {
            if let Err(e) = tokio::fs::write(&enc_path, enc).await {
                eprintln!("[auth] migration write failed: {e}");
                return;
            }
            let _ = tokio::fs::remove_file(&old_path).await;
            eprintln!("[auth] migrated plaintext cookies.txt to encrypted cookies.enc");
        }
        Err(e) => eprintln!("[auth] migration encrypt failed: {e}"),
    }
}

/// Promote a legacy single-account `cookies.enc` to the new
/// `accounts/<id>/cookies.enc` layout. Runs after the plaintext
/// migration so a fresh install with no state at all hits a clean
/// no-op. Account meta (email / name / photo) is left empty — the
/// frontend backfills it on the first `/account_menu` round-trip.
async fn migrate_to_accounts_layout(app: &tauri::AppHandle) {
    let index_path = accounts_index_path(app);
    if index_path.exists() {
        return; // already migrated
    }
    let legacy = legacy_cookies_enc_path(app);
    if !legacy.exists() {
        // No legacy state and no new state — signed-out fresh install.
        return;
    }
    let new_id = generate_account_id();
    let new_path = account_cookies_path(app, &new_id);
    if let Some(dir) = new_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(dir).await {
            eprintln!("[auth] migrate accounts: mkdir failed: {e}");
            return;
        }
    }
    if let Err(e) = tokio::fs::rename(&legacy, &new_path).await {
        eprintln!("[auth] migrate accounts: rename failed: {e}");
        return;
    }
    let now_s = time::OffsetDateTime::now_utc().unix_timestamp();
    let idx = AccountsIndex {
        active: Some(new_id.clone()),
        accounts: vec![Account {
            id: new_id.clone(),
            added_at: now_s,
            ..Default::default()
        }],
    };
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[auth] migrate accounts: write index failed: {e}");
        return;
    }
    eprintln!("[auth] migrated single cookies.enc into accounts/{new_id}/");
}

fn generate_account_id() -> String {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    // Unix-nanos is monotone within a process; a stray clock skew on
    // another machine isn't a concern (account ids stay local).
    format!("acct-{:x}", nanos)
}

/// Read the encrypted cookie jar for the active account and decrypt
/// it in memory. Returns `None` when nobody is signed in or
/// decryption fails (treat as logged-out).
///
/// The three ways this returns `None` look identical from the outside
/// but mean very different things: no active account, a jar that
/// vanished or was torn by a shutdown, and a DPAPI blob we can no
/// longer decrypt (a different Windows user, a restored profile), so
/// each is logged distinctly. A silent `None` here is the single most
/// common way a signed-in user is shown a sign-in button.
async fn read_cookies_plain(app: &tauri::AppHandle) -> Option<String> {
    let path = active_cookies_path(app).await?;
    read_jar_at(&path).await
}

/// Decrypt one account's jar off disk. Split out of
/// `read_cookies_plain` so a refresh can compare against the specific
/// account it is refreshing rather than whichever one is active.
async fn read_jar_at(path: &std::path::Path) -> Option<String> {
    let encrypted = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("[auth] no cookie jar at {}", path.display());
            return None;
        }
        Err(e) => {
            eprintln!("[auth] read cookie jar failed: {e}");
            return None;
        }
    };
    let len = encrypted.len();
    let plain = match tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted)).await {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            eprintln!("[auth] decrypt cookie jar failed ({len} bytes): {e}");
            return None;
        }
        Err(e) => {
            eprintln!("[auth] decrypt join failed: {e}");
            return None;
        }
    };
    match String::from_utf8(plain) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[auth] cookie jar is not valid UTF-8: {e}");
            None
        }
    }
}

/// Serialize a list of cookies into the Netscape cookie-jar format that
/// yt-dlp and our reader expect. Only keeps cookies for google/youtube
/// domains — that's all the auth flow touches.
fn cookies_to_netscape(cookies: &[cookie::Cookie<'static>]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let Some(domain) = c.domain() else { continue };
        let bare = domain.trim_start_matches('.');
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }
        // Normalize: always emit with leading dot + subdomains=TRUE.
        // Auth cookies are all subdomain-inclusive by design, and modern
        // webviews expose domains inconsistently (with / without the
        // leading dot). Emitting `domain\tFALSE` for `.youtube.com`
        // would make parsers treat it as an exact-host cookie, which
        // would silently skip SAPISID for `music.youtube.com`.
        let dom_out = format!(".{bare}");
        let include_sub = "TRUE";
        let path_str = c.path().unwrap_or("/");
        let secure = if c.secure().unwrap_or(false) {
            "TRUE"
        } else {
            "FALSE"
        };
        let expiry = match c.expires() {
            Some(cookie::Expiration::DateTime(dt)) => dt.unix_timestamp(),
            _ => 0,
        };
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            dom_out,
            include_sub,
            path_str,
            secure,
            expiry,
            c.name(),
            c.value()
        ));
    }
    out
}

/// One line of a Netscape jar, kept as stored so a rewrite preserves
/// entries we don't touch byte-for-byte.
struct JarEntry {
    domain: String,
    include_sub: String,
    path: String,
    secure: String,
    expiry: i64,
    name: String,
    value: String,
}

/// Apply `Set-Cookie` response headers to a Netscape jar, the way a
/// browser would: update the value/expiry of a cookie we already hold,
/// add cookies we don't, and drop cookies the server expires
/// (`Max-Age=0` / past `Expires`). Only google/youtube domains are
/// accepted — same filter as the login capture.
///
/// Cookies that identify the account.
///
/// A `Set-Cookie` deletion for one of these takes the app from signed
/// in to signed out with no way back except a re-login, and this path
/// runs on every InnerTube response including 4xx ones. The HTTP replay
/// layer is not the authority on whether the user signed out; the
/// keeper is, because it holds the real browser session. So a deletion
/// here is refused and reported, and the caller forces a keeper refresh
/// to get the truth. Rotation cookies (`*SIDCC`, `*PSIDTS`,
/// `LOGIN_INFO`) stay deletable: tracking those is the point of the
/// merge.
const PROTECTED_COOKIES: [&str; 9] = [
    "SID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "__Secure-1PAPISID",
    "__Secure-3PAPISID",
];

/// Outcome of folding a batch of `Set-Cookie` headers into a jar.
struct JarMerge {
    jar: String,
    /// A cookie value was replaced, added or removed, so cached Cookie
    /// headers are stale.
    value_changed: bool,
    /// Also covers attribute-only refreshes (expiry bumps) that should
    /// persist but don't invalidate caches.
    needs_write: bool,
    /// `domain name` of every identity cookie the server tried to
    /// expire and we refused to drop.
    blocked_deletions: Vec<String>,
}

fn merge_set_cookies_into_jar(
    jar: &str,
    set_cookies: &[String],
    host: &str,
    now_ts: i64,
) -> JarMerge {
    let mut entries: Vec<JarEntry> = Vec::new();
    for line in jar.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        entries.push(JarEntry {
            domain: f[0].to_string(),
            include_sub: f[1].to_string(),
            path: f[2].to_string(),
            secure: f[3].to_string(),
            expiry: f[4].parse().unwrap_or(0),
            name: f[5].to_string(),
            value: f[6].to_string(),
        });
    }

    let mut value_changed = false;
    let mut needs_write = false;
    let mut blocked_deletions: Vec<String> = Vec::new();
    let host_bare = host.trim_start_matches('.').to_ascii_lowercase();

    for raw in set_cookies {
        let Ok(c) = cookie::Cookie::parse(raw.trim()) else {
            continue;
        };
        // Host-only cookies (no Domain attribute) belong to the
        // responding host.
        let bare = c
            .domain()
            .unwrap_or(host)
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let allowed = bare == "youtube.com"
            || bare.ends_with(".youtube.com")
            || bare == "google.com"
            || bare.ends_with(".google.com");
        if !allowed {
            continue;
        }
        // RFC 6265 §5.3.5: a response may only set a cookie whose
        // Domain the responding host sits at or below. Without this a
        // music.youtube.com response could plant a cookie on
        // `.google.com`, which we would then replay to Google as though
        // Google had issued it.
        let domain_matches = host_bare == bare || host_bare.ends_with(&format!(".{bare}"));
        if !domain_matches {
            continue;
        }

        // Max-Age wins over Expires (RFC 6265 §4.1.2.2); either in the
        // past is a deletion.
        let (remove, expiry) = if let Some(ma) = c.max_age() {
            let secs = ma.whole_seconds();
            (secs <= 0, now_ts.saturating_add(secs))
        } else if let Some(cookie::Expiration::DateTime(dt)) = c.expires() {
            let ts = dt.unix_timestamp();
            (ts <= now_ts, ts)
        } else {
            (false, 0) // session cookie
        };

        let pos = entries
            .iter()
            .position(|e| e.name == c.name() && e.domain.trim_start_matches('.') == bare);

        if remove {
            if PROTECTED_COOKIES.contains(&c.name()) {
                blocked_deletions.push(format!("{bare} {}", c.name()));
                continue;
            }
            if let Some(i) = pos {
                entries.remove(i);
                value_changed = true;
            }
            continue;
        }

        match pos {
            Some(i) => {
                let e = &mut entries[i];
                if e.value != c.value() {
                    e.value = c.value().to_string();
                    value_changed = true;
                }
                if e.expiry != expiry {
                    e.expiry = expiry;
                    needs_write = true;
                }
            }
            None => {
                entries.push(JarEntry {
                    domain: format!(".{bare}"),
                    include_sub: "TRUE".to_string(),
                    path: c.path().unwrap_or("/").to_string(),
                    secure: if c.secure().unwrap_or(false) {
                        "TRUE"
                    } else {
                        "FALSE"
                    }
                    .to_string(),
                    expiry,
                    name: c.name().to_string(),
                    value: c.value().to_string(),
                });
                value_changed = true;
            }
        }
    }

    needs_write |= value_changed;
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for e in &entries {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            e.domain, e.include_sub, e.path, e.secure, e.expiry, e.name, e.value
        ));
    }
    JarMerge {
        jar: out,
        value_changed,
        needs_write,
        blocked_deletions,
    }
}

/// Stable "same account" key derived from an account's backfilled meta.
/// Prefers the email; when that's empty (brand-channel identities, and
/// some accounts, omit it from `/account_menu`) it falls back to the
/// avatar URL, whose `yt3.ggpht.com/-<token>` base is stable per
/// account. Returns `None` when neither is known, so two accounts we
/// can't tell apart are never merged.
///
/// Cookie values can't serve as the key: every login runs in an
/// isolated WebView profile, so Google mints a fresh SAPISID/SID
/// session each time and the same account lands a different value on
/// each add.
fn meta_identity(email: &str, photo_url: Option<&str>) -> Option<String> {
    let email = email.trim();
    if !email.is_empty() {
        return Some(format!("email:{}", email.to_ascii_lowercase()));
    }
    if let Some(p) = photo_url {
        // Drop the "=s108-c-k-..." sizing suffix so the same avatar at
        // different requested sizes still compares equal.
        let base = p.split('=').next().unwrap_or(p).trim();
        if !base.is_empty() {
            return Some(format!("photo:{base}"));
        }
    }
    None
}

/// Collapse duplicate account rows that are the same Google account.
/// Re-adding an account you already have (or a stale/expired re-login)
/// used to append a fresh row that never merged, because dedup keyed on
/// an email that `/account_menu` often leaves empty. This heals that
/// state from the stored meta: within each set of rows sharing an
/// identity (see `meta_identity`) it keeps the earliest-added one
/// (stable id, so pinned-playlist buckets survive), copies the freshest
/// cookies into it, and drops the rest off disk. A row we can't identify
/// (no email, no avatar) is left untouched rather than risk merging two
/// real accounts.
///
/// Does not emit `accounts-changed`: callers either run it before the
/// UI reads the list (startup) or emit the event themselves.
async fn dedup_accounts_by_identity(app: &tauri::AppHandle) {
    let mut idx = read_index(app).await;
    if idx.accounts.len() < 2 {
        return;
    }

    // Identity per row from its stored meta, same order as idx.accounts.
    let identities: Vec<Option<String>> = idx
        .accounts
        .iter()
        .map(|a| meta_identity(&a.email, a.photo_url.as_deref()))
        .collect();

    // Group row indices by identity.
    let mut groups: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    for (i, ident) in identities.iter().enumerate() {
        if let Some(key) = ident {
            groups.entry(key.clone()).or_default().push(i);
        }
    }

    // removed id -> keeper id, so `active` can follow its keeper.
    let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // (source id, keeper id) jars to copy before deleting the source.
    let mut fresh_copies: Vec<(String, String)> = Vec::new();

    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        // Keep the earliest-added row: its id is the one pins are keyed
        // to, and it's the account the user has had the longest.
        let keeper = *members
            .iter()
            .min_by_key(|&&i| idx.accounts[i].added_at)
            .unwrap();
        let keeper_id = idx.accounts[keeper].id.clone();

        // Freshest cookies: the jar written most recently. After a
        // re-login that's the keeper itself (login-time dedup refreshed
        // it in place, so no copy happens); when healing a pile of
        // legacy dups it's whichever login was most recent, the one
        // most likely to still authenticate. Falls back to the keeper
        // if no jar's mtime can be read.
        let mut freshest = keeper;
        let mut best_mtime: Option<std::time::SystemTime> = None;
        for &i in members {
            let p = account_cookies_path(app, &idx.accounts[i].id);
            let mtime = tokio::fs::metadata(&p)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            if let Some(t) = mtime {
                if best_mtime.map_or(true, |b| t > b) {
                    best_mtime = Some(t);
                    freshest = i;
                }
            }
        }
        let fresh_id = idx.accounts[freshest].id.clone();
        if fresh_id != keeper_id {
            fresh_copies.push((fresh_id, keeper_id.clone()));
        }

        for &i in members {
            if i != keeper {
                remap.insert(idx.accounts[i].id.clone(), keeper_id.clone());
            }
        }
    }

    if remap.is_empty() {
        return;
    }

    for (from_id, keeper_id) in &fresh_copies {
        let from_path = account_cookies_path(app, from_id);
        let keep_path = account_cookies_path(app, keeper_id);
        if let Ok(bytes) = tokio::fs::read(&from_path).await {
            let _ = tokio::fs::write(&keep_path, bytes).await;
        }
    }

    if let Some(active) = idx.active.clone() {
        if let Some(keeper) = remap.get(&active) {
            idx.active = Some(keeper.clone());
        }
    }

    idx.accounts.retain(|a| !remap.contains_key(&a.id));

    // Persist the collapsed index BEFORE deleting the losers' jars. If
    // the app dies in between, an orphan dir is invisible litter; the
    // reverse order could leave the index pointing at deleted jars and
    // boot the app signed out.
    let removed = remap.len();
    if let Err(e) = write_index(app, &idx).await {
        eprintln!("[accounts] dedup write index: {e}");
        return;
    }
    for rid in remap.keys() {
        let _ = tokio::fs::remove_dir_all(accounts_dir(app).join(rid)).await;
    }
    eprintln!("[accounts] collapsed {removed} duplicate account row(s) by identity");
}

/// Best-effort cleanup of transient login artifacts, run once per boot:
///
/// - leftover per-login WebView profiles under `login-sessions/`. The
///   post-login `remove_dir_all` regularly loses to WebView2 file locks
///   (the browser subprocess outlives the window for a beat), and each
///   stranded profile holds a signed-in Google session on disk. At boot
///   no login window exists, so the locks are gone and deletion sticks.
/// - the http plugin's `.cookies` store from builds where its `cookies`
///   feature was still on: plaintext session-security cookies, and the
///   shadow copy that fed the rotation-divergence bug.
async fn cleanup_login_artifacts(app: &tauri::AppHandle) {
    let cache = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Ok(mut sessions) = tokio::fs::read_dir(cache.join("login-sessions")).await {
        while let Ok(Some(entry)) = sessions.next_entry().await {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
    let _ = tokio::fs::remove_file(cache.join(".cookies")).await;
}

/// Open an in-app Google sign-in window in an isolated WebView profile
/// and add the resulting cookies as a new account. Polls the (fresh)
/// webview cookie store until YouTube auth cookies appear, encrypts
/// them, writes them to `accounts/<id>/cookies.enc`, registers the
/// account in `accounts.json`, and marks it active.
///
/// Isolation matters: without it, "add another account" instantly
/// succeeds with whatever Google session is already in the shared
/// WebView2 user data dir — and there's no way for the user to pick a
/// different identity. The temp profile is deleted on close (success
/// or cancellation); our DPAPI-encrypted jar is the canonical store.
///
/// Emits `login-success` (payload: new account id) on success and
/// `login-cancelled` on close-without-auth.
///
/// We deliberately do NOT emit `accounts-changed` here. The newly-
/// added account has empty meta and may not even survive the next
/// step: the frontend's meta backfill calls `update_account_meta`,
/// which is when we find out via an identity lookup (email, or avatar
/// when the email is empty) whether this is genuinely a new account or
/// a re-sign-in of an existing one. That
/// command emits `accounts-changed` for both cases, and the global
/// listener does its full reset there. Firing the event twice was the
/// "double-reset on dedup" UX bug.
#[tauri::command]
async fn start_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("login") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Per-attempt account id, minted up front so the WebView profile can
    // live at its permanent home from the first keystroke. Still fresh
    // per attempt (a unique id), so Google's auth cookies are empty at
    // window open and "add account" starts from a clean sign-in, so
    // identity isolation is preserved. Unlike the old throwaway temp
    // profile, we KEEP this one after a successful login: it holds the
    // live, Google-bound session that `refresh_account_cookies` re-
    // extracts from periodically, so the replayed snapshot never outlives
    // Google's ~2h leash on extracted cookies.
    let account_id = generate_account_id();
    let webview_data = account_webview_dir(&app, &account_id);
    if let Err(e) = tokio::fs::create_dir_all(&webview_data).await {
        eprintln!("[login] mkdir webview-data: {e}");
    }
    // Wiped wholesale on cancel/error (profile + any partial jar); kept
    // on success.
    let account_dir = accounts_dir(&app).join(&account_id);

    let url = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F"
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;

    let win = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Sign in - accounts.google.com")
        .inner_size(500.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .data_directory(webview_data.clone())
        .user_agent(YT_LOGIN_UA)
        // Must match the session-keeper's args (shared profile folder).
        .additional_browser_args(YT_WEBVIEW_ARGS)
        // Surface the current origin in the title so the user can spot
        // a redirect to an unexpected host (anti-phishing).
        .on_page_load(|win, payload| {
            let host = payload.url().host_str().unwrap_or("???");
            let _ = win.set_title(&format!("Sign in - {host}"));
        })
        .build()
        .map_err(|e| e.to_string())?;

    let app_poll = app.clone();
    // Failure paths wipe the whole account dir (profile + jar); on
    // success we keep it so the live session can be refreshed later.
    let cleanup_dir = account_dir.clone();
    tauri::async_runtime::spawn(async move {
        // Set to true once we've redirected the webview to YT ourselves.
        // Guards against thrashing if YT auto-sign-in is slow and we
        // catch a Google-auth-only state on multiple ticks.
        let mut nudged_to_yt = false;
        // Ticks spent waiting for the handshake to finish after auth
        // cookies first appear (see below).
        let mut full_set_grace: u8 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;

            let Some(win) = app_poll.get_webview_window("login") else {
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            };

            let cookies = match win.cookies() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[login] cookies error: {e}");
                    continue;
                }
            };

            let has_yt_auth = cookies.iter().any(|c| {
                let name = c.name();
                (name == "__Secure-1PSID" || name == "SAPISID")
                    && c.domain()
                        .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                        .unwrap_or(false)
            });

            if !has_yt_auth {
                // YT cookies aren't set yet. Two ways to land here:
                //   1) User hasn't completed Google sign-in. Keep waiting.
                //   2) Google sign-in succeeded but Google parked the
                //      webview on `myaccount.google.com` (first-time
                //      security review / "stay signed in?" prompt) and
                //      never honored the `continue=music.youtube.com`
                //      hint. The user is stuck on a Google settings
                //      page and YT never gets a chance to handshake.
                //
                // For case (2), force-navigate to music.youtube.com.
                // YT's auto-sign-in flow picks up the .google.com
                // session cookies and exchanges them for .youtube.com
                // cookies that InnerTube actually needs.
                if !nudged_to_yt {
                    let has_google_auth = cookies.iter().any(|c| {
                        let name = c.name();
                        (name == "SAPISID" || name == "SID" || name == "__Secure-1PSID")
                            && c.domain()
                                .map(|d| d.trim_start_matches('.').ends_with("google.com"))
                                .unwrap_or(false)
                    });
                    if has_google_auth {
                        if let Ok(url) = "https://music.youtube.com/".parse::<tauri::Url>() {
                            match win.navigate(url) {
                                Ok(()) => eprintln!(
                                    "[login] google-auth detected without YT cookies; redirected webview to music.youtube.com"
                                ),
                                Err(e) => eprintln!(
                                    "[login] failed to redirect to YT: {e}"
                                ),
                            }
                        }
                        nudged_to_yt = true;
                    }
                }
                continue;
            }

            // SAPISID shows up before YouTube finishes its handshake;
            // capturing at first sight used to miss LOGIN_INFO /
            // VISITOR_INFO1_LIVE / YSC. Those make our replayed traffic
            // look like the browser session Google issued it to, so
            // give the handshake a few ticks to complete. Capture
            // anyway after ~6 s in case the cookie set changes shape.
            let has_login_info = cookies.iter().any(|c| {
                c.name() == "LOGIN_INFO"
                    && c.domain()
                        .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                        .unwrap_or(false)
            });
            if !has_login_info && full_set_grace < 4 {
                full_set_grace += 1;
                continue;
            }

            // Same id as the persisted WebView profile created above, so
            // the account row and its live session profile stay paired.
            let new_id = account_id.clone();
            let cookies_path = account_cookies_path(&app_poll, &new_id);
            if let Some(dir) = cookies_path.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let plain = cookies_to_netscape(&cookies).into_bytes();
            let encrypted =
                match tokio::task::spawn_blocking(move || secure_store::encrypt(&plain)).await {
                    Ok(Ok(e)) => e,
                    Ok(Err(e)) => {
                        eprintln!("[login] encrypt cookies: {e}");
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                    Err(e) => {
                        eprintln!("[login] encrypt join: {e}");
                        let _ = win.close();
                        let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                        return;
                    }
                };
            if let Err(e) = write_atomic(&cookies_path, &encrypted).await {
                eprintln!("[login] write account cookies: {e}");
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            let mut idx = read_index(&app_poll).await;
            let now_s = time::OffsetDateTime::now_utc().unix_timestamp();
            idx.accounts.push(Account {
                id: new_id.clone(),
                added_at: now_s,
                ..Default::default()
            });
            idx.active = Some(new_id.clone());
            if let Err(e) = write_index(&app_poll, &idx).await {
                // We've already written the cookies file; not fatal but
                // visible to the user as "account didn't appear in
                // list". Surface it through the cancel event so the
                // frontend at least flips out of the spinning state.
                eprintln!("[login] write index: {e}");
                let _ = app_poll.emit("login-cancelled", ());
                let _ = tokio::fs::remove_dir_all(
                    &account_cookies_path(&app_poll, &new_id)
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_default(),
                )
                .await;
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            // `login-success` is the soft signal: the frontend invalidates
            // its auth queries so the meta backfill runs with the new
            // cookies. The follow-up `update_account_meta` call is where
            // dedup happens (by identity, email or avatar) and where
            // `accounts-changed` fires, so we never run the full reset
            // twice for one login flow.
            let _ = app_poll.emit("login-success", &new_id);
            let _ = win.close();
            // Keep the WebView profile: it's the live session the periodic
            // refresh re-extracts from. Only cancel/error paths above (and
            // account removal) delete it.
            return;
        }
    });

    let _ = win;
    Ok(())
}

/// Counts completed page loads in the session-keeper webview, bumped
/// from its `on_page_load` hook. At most one keeper ever runs, so a
/// single global counter is enough: `refresh_account_cookies` samples
/// it before navigating and waits for it to move.
static KEEPER_PAGE_LOADS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The live "session-keeper" WebView for `id`: a hidden window on
/// music.youtube.com that reuses the account's persisted profile. As a
/// real browser engine it stays authenticated from the stored session and
/// keeps the server-side session (and its rotating cookies) warm, which
/// plain HTTP replay cannot do. Built ONCE and reused; any keeper left
/// over from a previously-active account is closed first, so at most one
/// runs at a time. Returns (window, just_created).
async fn ensure_session_keeper(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(tauri::WebviewWindow, bool), String> {
    if !account_webview_dir(app, id).exists() {
        return Err(format!("no persisted profile for {id}"));
    }
    let label = format!("keeper-{id}");
    // Close a stale keeper left over from a previously-active account, so
    // at most one keeper (the active account's) ever runs.
    for (l, w) in app.webview_windows() {
        if l.starts_with("keeper-") && l != label {
            let _ = w.close();
        }
    }
    if let Some(win) = app.get_webview_window(&label) {
        return Ok((win, false));
    }
    let url = "https://music.youtube.com/"
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    // Hidden, undecorated, focus-less, off-screen, no taskbar entry. Built
    // once and reused (not re-created every cycle), so there is no recurring
    // window creation to flash on screen; the window-state plugin is told to
    // never restore keeper windows (see `with_filter` in `run`), so a saved
    // "visible" state can't drag it back on-screen next launch either. The
    // webview still loads and keeps the session alive regardless of
    // visibility or position.
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("YTubic session keeper")
        .visible(false)
        .decorations(false)
        .focused(false)
        .skip_taskbar(true)
        .position(-32000.0, -32000.0)
        .inner_size(1024.0, 768.0)
        .data_directory(account_webview_dir(app, id))
        .user_agent(YT_LOGIN_UA)
        .additional_browser_args(YT_WEBVIEW_ARGS)
        // Proof of life. Without it `refresh_account_cookies` cannot
        // tell a keeper that actually reloaded from one whose renderer
        // is wedged or dead: the persisted cookie store stays readable
        // either way, so the loop happily logged "renewed snapshot"
        // having renewed nothing.
        .on_page_load(|_win, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                KEEPER_PAGE_LOADS.fetch_add(1, Ordering::Relaxed);
            }
        })
        .build()
        .map_err(|e| format!("build session-keeper: {e}"))?;
    // Force-hide on top of visible(false): if WebView2 shows the host window
    // when the external page finishes loading, this puts it straight back to
    // hidden so the user never sees a stray music.youtube.com window.
    let _ = win.hide();
    Ok((win, true))
}

/// Refresh the replayed cookie snapshot for `id` from its live session-
/// keeper WebView. Reloads the keeper to force fresh authenticated
/// requests (which renews the session and rotates its short-lived
/// cookies), reads the full cookie set, and overwrites `cookies.enc`. The
/// keeper window is left OPEN for next time.
///
/// This is what survives Google's ~2h leash on *extracted* cookies: the
/// bound browser session behind the keeper stays live, so the snapshot we
/// replay never goes stale. Errors (leaving the existing snapshot
/// untouched) when the account has no persisted profile or its session is
/// logged out, so we never clobber a usable jar with an empty one.
async fn refresh_account_cookies(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    // Serialize refreshes so the periodic timer and a manual trigger can't
    // reload the keeper / rewrite the jar on top of each other.
    let guard = app.state::<RefreshGuard>();
    let _lock = guard.inner().0.lock().await;

    // Sampled BEFORE navigating: the capture below only trusts a cookie
    // store the keeper has actually reloaded into.
    let loads_before = KEEPER_PAGE_LOADS.load(Ordering::Relaxed);
    let (win, created) = ensure_session_keeper(app, id).await?;
    eprintln!("[refresh] start id={id} keeper_created={created}");
    // A reused keeper is reloaded to force fresh authenticated traffic; a
    // just-created one is already loading the URL from the builder.
    if !created {
        if let Ok(u) = "https://music.youtube.com/".parse::<tauri::Url>() {
            let _ = win.navigate(u);
        }
    }

    // Poll the keeper's cookie store until the full authed set is present
    // (LOGIN_INFO lands last, as at login), then snapshot it. The keeper
    // window stays open for the next cycle.
    let mut captured: Option<Vec<u8>> = None;
    let mut captured_at = 0u8;
    let mut captured_count = 0usize;
    let mut captured_login_info = false;
    let mut saw_page_load = false;
    for tick in 0..12u8 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // A wedged or dead renderer still hands back a readable cookie
        // store, so presence of cookies proves nothing about whether the
        // reload happened. Wait for the page-load hook to fire before
        // trusting anything, but give up waiting after ~9 s rather than
        // fail the refresh outright: the snapshot on disk staying fresh
        // matters more than perfect evidence that it was renewed.
        if !saw_page_load {
            saw_page_load = KEEPER_PAGE_LOADS.load(Ordering::Relaxed) > loads_before;
            if !saw_page_load && tick < 6 {
                continue;
            }
        }
        let Ok(cookies) = win.cookies() else { continue };
        let has_yt_auth = cookies.iter().any(|c| {
            let n = c.name();
            (n == "__Secure-1PSID" || n == "SAPISID")
                && c.domain()
                    .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                    .unwrap_or(false)
        });
        if !has_yt_auth {
            continue;
        }
        let has_login_info = cookies.iter().any(|c| {
            c.name() == "LOGIN_INFO"
                && c.domain()
                    .map(|d| d.trim_start_matches('.').ends_with("youtube.com"))
                    .unwrap_or(false)
        });
        // Give the handshake a few ticks to complete, then take what we
        // have so a missing LOGIN_INFO can't stall the refresh forever.
        if !has_login_info && tick < 4 {
            continue;
        }
        captured_at = tick;
        captured_count = cookies.len();
        captured_login_info = has_login_info;
        captured = Some(cookies_to_netscape(&cookies).into_bytes());
        break;
    }
    let Some(plain) = captured else {
        return Err("no auth cookies after reload (profile logged out?)".into());
    };
    eprintln!(
        "[refresh] captured at tick={captured_at} cookies={captured_count} \
         has_login_info={captured_login_info} page_load_confirmed={saw_page_load}"
    );

    // The keeper's snapshot replaces the jar wholesale, which throws away
    // whatever `merge_response_cookies` echoed in since the last cycle.
    // Two clients of one Google session, synced one way. Measurement says
    // the keeper's values are the newer ones, so replacing is currently
    // the right call and the semantics stay as they were, but the diff
    // has never been visible. Log it: if the keeper ever starts REGRESSING
    // values the replay path already learned, this is what will say so.
    if let Some(existing) = read_jar_at(&account_cookies_path(app, id)).await {
        let snapshot = String::from_utf8_lossy(&plain).into_owned();
        let before = jar_cookie_keys(&existing);
        let after = jar_cookie_keys(&snapshot);
        let dropped: Vec<&String> = before.difference(&after).collect();
        if !dropped.is_empty() {
            eprintln!("[refresh] snapshot drops cookie(s) the jar held: {dropped:?}");
        }
        let changed = changed_cookie_names(&existing, &snapshot);
        if !changed.is_empty() {
            eprintln!("[refresh] snapshot rotates {changed:?}");
        }
    }

    let encrypted = tokio::task::spawn_blocking(move || secure_store::encrypt(&plain))
        .await
        .map_err(|e| format!("encrypt join: {e}"))?
        .map_err(|e| format!("encrypt: {e}"))?;
    let path = account_cookies_path(app, id);
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    // Atomic, like `merge_response_cookies`: this path runs every 20
    // minutes for the whole life of the app, so it is by far the most
    // likely write to be interrupted by a shutdown, and a torn
    // `cookies.enc` reads as "signed out".
    write_atomic(&path, &encrypted)
        .await
        .map_err(|e| format!("write refreshed cookies: {e}"))?;
    // Tell the UI. Without this the frontend has no way to learn that a
    // session it already gave up on is healthy again, so a single failed
    // `/account_menu` at launch would keep showing a sign-in button for
    // the rest of the session.
    let _ = app.emit("session-refreshed", id);
    Ok(())
}

/// Force an immediate snapshot refresh for the active account. Exposed
/// for the UI (and manual testing) so a session can be renewed on demand
/// instead of only when the periodic timer fires. Returns `false` when
/// nobody is signed in.
#[tauri::command]
async fn refresh_active_session(app: tauri::AppHandle) -> Result<bool, String> {
    let idx = read_index(&app).await;
    let Some(active) = idx.active else {
        return Ok(false);
    };
    match refresh_account_cookies(&app, &active).await {
        Ok(()) => Ok(true),
        Err(e) => {
            eprintln!("[refresh] {active}: {e}");
            Err(e)
        }
    }
}

/// How long a healthy snapshot may age before it is renewed.
const REFRESH_INTERVAL_SECS: i64 = 20 * 60;
/// Wall-clock backoff after a failed refresh before falling back to the
/// normal interval. Capped deliberately: the dominant failure is
/// "profile logged out", which is permanent for an abandoned profile,
/// and hammering authenticated reloads is the exact pattern
/// `merge_response_cookies` blames for server-side revocation.
const REFRESH_BACKOFF_SECS: [i64; 3] = [30, 120, 300];
/// Longest the loop ever sleeps in one go. Short enough that a wall
/// clock which jumped forward across a suspend is noticed promptly, no
/// matter what the monotonic clock did while the machine was out.
const REFRESH_TICK_SECS: u64 = 60;

fn now_ts() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// Wall-clock stamp of the last successful refresh, stored beside the
/// jar. Read back on the next cycle purely so the log can report how
/// long the snapshot actually went unrenewed: that number is what
/// settles whether a suspend stalled the loop on a user's machine.
fn last_refresh_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    accounts_dir(app).join(id).join("last-refresh")
}

async fn read_last_refresh(app: &tauri::AppHandle, id: &str) -> Option<i64> {
    let raw = tokio::fs::read_to_string(last_refresh_path(app, id)).await.ok()?;
    raw.trim().parse().ok()
}

async fn write_last_refresh(app: &tauri::AppHandle, id: &str, ts: i64) {
    let path = last_refresh_path(app, id);
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let _ = tokio::fs::write(&path, ts.to_string()).await;
}

/// Keep the active account's replayed cookie snapshot fresh.
///
/// Driven by a wall-clock deadline rather than one long
/// `tokio::time::sleep`. Tokio timers ride `Instant` (QPC on Windows),
/// and whether that advances across S3 sleep and S0 Modern Standby is
/// not something to bet a session on: if it does not, a 20-minute timer
/// effectively never fires across a long standby; if it does, it fires
/// the moment the machine wakes, into a network stack that has not come
/// back yet. A deadline in wall-clock seconds is immune either way, and
/// the resume notification wakes us straight out of the tick.
async fn run_refresh_loop(app: tauri::AppHandle) {
    let resume = power::resume_signal();
    // Wall-clock deadline for the next attempt; 0 means "right now".
    let mut next_due: i64 = 0;
    let mut failures: usize = 0;
    // So an account that can never refresh is reported once, not once
    // per tick.
    let mut warned_profileless: Option<String> = None;
    // Likewise for a machine that sits offline: log the transition, not
    // every retry, or a laptop left off Wi-Fi overnight fills the file.
    let mut warned_offline = false;

    loop {
        if now_ts() >= next_due {
            match read_index(&app).await.active {
                None => next_due = now_ts() + REFRESH_INTERVAL_SECS,
                Some(active) if !account_webview_dir(&app, &active).exists() => {
                    if warned_profileless.as_deref() != Some(active.as_str()) {
                        eprintln!(
                            "[refresh] {active} has no persisted webview profile; its snapshot \
                             cannot be renewed until the user signs in again"
                        );
                        warned_profileless = Some(active.clone());
                    }
                    next_due = now_ts() + REFRESH_INTERVAL_SECS;
                }
                Some(active) => {
                    warned_profileless = None;
                    // Don't spend the attempt on a NIC that hasn't come
                    // back yet: that is what made a resume cost a full
                    // cycle before.
                    if !power::wait_for_network(Duration::from_secs(60)).await {
                        if !warned_offline {
                            eprintln!("[refresh] no internet; deferring until it comes back");
                            warned_offline = true;
                        }
                        next_due = now_ts() + 30;
                    } else {
                        if warned_offline {
                            eprintln!("[refresh] internet is back");
                            warned_offline = false;
                        }
                        let previous = read_last_refresh(&app, &active).await;
                        match refresh_account_cookies(&app, &active).await {
                            Ok(()) => {
                                let now = now_ts();
                                match previous {
                                    Some(t) => eprintln!(
                                        "[refresh] renewed snapshot for {active} \
                                         (previous succeeded {}s ago)",
                                        now - t
                                    ),
                                    None => eprintln!("[refresh] renewed snapshot for {active}"),
                                }
                                write_last_refresh(&app, &active, now).await;
                                failures = 0;
                                next_due = now + REFRESH_INTERVAL_SECS;
                            }
                            Err(e) => {
                                eprintln!("[refresh] {active}: {e}");
                                // Separate "the keeper misbehaved" from
                                // "the session is genuinely gone". Only
                                // on the first failure, so a permanently
                                // dead profile doesn't probe on a loop.
                                if failures == 0 {
                                    match probe_session_alive(&app).await {
                                        Ok(true) => eprintln!(
                                            "[refresh] the jar still authenticates, so the \
                                             keeper is what failed"
                                        ),
                                        Ok(false) => eprintln!(
                                            "[refresh] the jar no longer authenticates; this \
                                             account needs a re-login"
                                        ),
                                        Err(e) => eprintln!("[refresh] liveness probe failed: {e}"),
                                    }
                                }
                                failures += 1;
                                let wait = REFRESH_BACKOFF_SECS
                                    .get(failures - 1)
                                    .copied()
                                    .unwrap_or(REFRESH_INTERVAL_SECS);
                                next_due = now_ts() + wait;
                            }
                        }
                    }
                }
            }
        }

        let delay = (next_due - now_ts()).clamp(1, REFRESH_TICK_SECS as i64) as u64;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            _ = resume.notified() => {
                eprintln!("[power] resumed from sleep; forcing a session refresh");
                next_due = 0;
                failures = 0;
            }
        }
    }
}

/// Parse a Netscape cookie jar and return a `Cookie:` header value
/// containing all cookies that match the given domain (honoring the
/// `include_subdomains` flag). Empty string if no jar or no matches.
async fn read_cookie_header(app: &tauri::AppHandle, host: &str) -> String {
    let Some(content) = read_cookies_plain(app).await else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        // domain \t include_subdomains \t path \t secure \t expiry \t name \t value
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 {
            continue;
        }
        let domain = fields[0].trim_start_matches('.');
        let include_sub = fields[1] == "TRUE";
        let matches = host == domain || (include_sub && host.ends_with(&format!(".{domain}")));
        if !matches {
            continue;
        }
        parts.push(format!("{}={}", fields[5], fields[6]));
    }
    parts.join("; ")
}

#[tauri::command]
async fn get_cookie_header(app: tauri::AppHandle, host: String) -> Result<String, String> {
    Ok(read_cookie_header(&app, &host).await)
}

/// Does this `Cookie:` header carry what an authenticated InnerTube
/// call actually needs: an APISID to build the SAPISIDHASH with, and a
/// session id to identify the account.
///
/// Exact names, on purpose. The old check was `contains("SAPISID") ||
/// contains("__Secure-1PSID")`, and `__Secure-1PSID` is a prefix of both
/// `__Secure-1PSIDTS` and `__Secure-1PSIDCC`, so a jar that had lost the
/// real session id still reported a live session. That is why looking
/// at `cookies.enc` never told us anything during the logout
/// investigation.
fn header_has_auth_cookie(header: &str) -> bool {
    let mut has_apisid = false;
    let mut has_sid = false;
    for part in header.split(';') {
        let Some((name, _)) = part.split_once('=') else {
            continue;
        };
        match name.trim() {
            "SAPISID" | "__Secure-1PAPISID" | "__Secure-3PAPISID" => has_apisid = true,
            "SID" | "__Secure-1PSID" | "__Secure-3PSID" => has_sid = true,
            _ => {}
        }
    }
    has_apisid && has_sid
}

/// Cheap, offline "is there a usable session on disk". Says nothing
/// about whether Google still honors it; `probe_session` does that.
#[tauri::command]
async fn is_logged_in(app: tauri::AppHandle) -> Result<bool, String> {
    let header = read_cookie_header(&app, "music.youtube.com").await;
    Ok(header_has_auth_cookie(&header))
}

/// Ask music.youtube.com whether the jar we replay still authenticates.
///
/// `is_logged_in` only proves that a cookie by the right name sits in a
/// file. This is the real thing: the signed-in home page carries
/// `"LOGGED_IN":true` in its bootstrap config and the anonymous one
/// carries `false`, which discriminates cleanly (the signed-in document
/// is also markedly larger). Used to tell "the keeper broke" apart from
/// "the session is genuinely gone" when a refresh fails, and exposed as
/// a command for diagnosing a user's machine.
async fn probe_session_alive(app: &tauri::AppHandle) -> Result<bool, String> {
    let cookie = read_cookie_header(app, "music.youtube.com").await;
    if !header_has_auth_cookie(&cookie) {
        return Ok(false);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("build probe client: {e}"))?;
    let res = client
        .get("https://music.youtube.com/")
        .header("Cookie", cookie)
        .header("User-Agent", YT_LOGIN_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("probe request: {e}"))?;
    let body = res.text().await.map_err(|e| format!("probe body: {e}"))?;
    Ok(body.contains("\"LOGGED_IN\":true"))
}

#[tauri::command]
async fn probe_session(app: tauri::AppHandle) -> Result<bool, String> {
    let alive = probe_session_alive(&app).await?;
    eprintln!("[probe] session alive: {alive}");
    Ok(alive)
}

/// Hard-exit the process. The window's close button hides into the tray
/// by default (see `WindowEvent::CloseRequested` below); this command is
/// the frontend's equivalent of the tray's Quit menu item.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// What the title-bar ✕ does, mirrored from the frontend settings store
/// (`useCloseBehaviorSync`). Lives in Rust rather than only in
/// localStorage because the decision point is the `CloseRequested`
/// window event, which must also cover Alt+F4 and the taskbar's Close.
/// Defaults to hide-to-tray until the frontend pushes a value shortly
/// after the webview boots.
#[derive(Default)]
struct CloseBehavior {
    quit_on_close: AtomicBool,
}

#[tauri::command]
fn set_close_behavior(state: tauri::State<'_, CloseBehavior>, quit_on_close: bool) {
    state.quit_on_close.store(quit_on_close, Ordering::Relaxed);
}

/// Register / unregister the app for launch at OS startup. Uses the
/// autostart plugin's Rust API from our own command so the frontend
/// needs no extra capability grants.
#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    let currently = autolaunch.is_enabled().unwrap_or(false);
    if enabled == currently {
        return Ok(());
    }
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Track-change toast (Settings → General → Playback notifications).
/// The focus check lives here rather than in JS so it covers every
/// window at once: a toast is only useful when the user isn't already
/// looking at the app (main window hidden to tray, or another app in
/// the foreground).
#[tauri::command]
fn notify_track(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let any_focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if any_focused {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Bring the main window to the front. Called from the floating
/// player when the user clicks an in-bar link (e.g. an artist name)
/// — without this, the navigation would fire silently in the
/// background while the floating window keeps focus.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Spawn (or refocus) the standalone floating-player window. The
/// frontend renders a stripped-down version of itself when it sees
/// `?floating-player=1` in the URL, so the new window hosts only the
/// player UI. Audio playback stays in the main window — the floater
/// mirrors state via Tauri events.
///
/// `x` / `y` are screen coords (CSS / logical pixels, as JS reports
/// them). When provided, the window appears centered horizontally on
/// the cursor with the title bar just under it — the natural landing
/// spot when the user drags the cover out of the main window. When
/// omitted, the window-state plugin's saved position takes over.
#[tauri::command]
async fn open_player_window(
    app: tauri::AppHandle,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("player") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        if let (Some(cx), Some(cy)) = (x, y) {
            let _ = existing.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
        }
        return Ok(());
    }
    // The min height is sized so the Play/Pause control stays
    // visible at the narrowest legal window: titlebar (36) + p-4 top
    // (16) + cover (capped at 320 via `max-w-[20rem]` on the cover
    // wrapper) + gap (12) + meta (~36) + gap (12) + progress (~54)
    // + gap (12) + controls (~48) + p-3 bottom (12) ≈ 558. Lyrics
    // and the bottom button row sit below and graciously collapse
    // (lyrics is `flex-1 min-h-0`) when there isn't room.
    let win = WebviewWindowBuilder::new(
        &app,
        "player",
        WebviewUrl::App("index.html?floating-player=1".into()),
    )
    .title("YTubic — player")
    .decorations(false)
    .inner_size(360.0, 720.0)
    .min_inner_size(320.0, 560.0)
    .resizable(true)
    .skip_taskbar(false)
    // Tauri's default drag/drop handler swallows in-page HTML5 drag
    // events on WebView2, breaking the queue reorder. We don't
    // accept dropped files anywhere in the app, so disabling the
    // handler entirely is purely upside. The doc string for this
    // method literally calls out HTML5 DnD on Windows as the use case.
    .disable_drag_drop_handler()
    // Shares the default user-data folder with the main window, so the
    // args must match the main window's `additionalBrowserArgs` exactly.
    .additional_browser_args(APP_WEBVIEW_ARGS)
    .build()
    .map_err(|e| e.to_string())?;
    // Dev builds: orange taskbar icon, same as the main window.
    #[cfg(debug_assertions)]
    let _ = win.set_icon(runtime_icon(&app));
    if let (Some(cx), Some(cy)) = (x, y) {
        // Override whatever the window-state plugin restored. Centering
        // horizontally on cursor with the 36px-tall title bar just
        // below puts the user's release point on top of the new card,
        // which feels like the window snapped to where they dropped.
        let _ = win.set_position(tauri::LogicalPosition::new(cx - 180.0, cy - 18.0));
    }
    Ok(())
}

#[tauri::command]
async fn close_player_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("player") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sign the user out of every account they've added. Wipes the
/// accounts index, removes each per-account cookies dir, and emits
/// `accounts-changed` so the UI can collapse back to the signed-out
/// state. Mirrors the old single-account `clear_cookies` semantics
/// — "the app forgets you entirely" — extended to the multi-account
/// world.
#[tauri::command]
async fn clear_cookies(app: tauri::AppHandle) -> Result<(), String> {
    let dir = accounts_dir(&app);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| format!("remove accounts dir: {e}"))?;
    }
    let index = accounts_index_path(&app);
    if index.exists() {
        tokio::fs::remove_file(&index)
            .await
            .map_err(|e| format!("remove index: {e}"))?;
    }
    // Sweep any stray legacy file too — defends against a partially-
    // migrated install where someone manually copied state around.
    let legacy = legacy_cookies_enc_path(&app);
    if legacy.exists() {
        let _ = tokio::fs::remove_file(&legacy).await;
    }
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

#[tauri::command]
async fn list_accounts(app: tauri::AppHandle) -> Result<Vec<AccountSummary>, String> {
    let idx = read_index(&app).await;
    let active = idx.active.clone();
    Ok(idx
        .accounts
        .into_iter()
        .map(|a| {
            let is_active = active.as_deref() == Some(a.id.as_str());
            let can_refresh = account_webview_dir(&app, &a.id).exists();
            AccountSummary {
                can_refresh,
                id: a.id,
                email: a.email,
                name: a.name,
                photo_url: a.photo_url,
                page_id: a.page_id,
                channel_name: a.channel_name,
                channel_photo_url: a.channel_photo_url,
                is_active,
            }
        })
        .collect())
}

/// Switch the active account. The InnerTube client picks up the new
/// cookies on its next request via `get_cookie_header`; the frontend
/// invalidates its query cache on the `accounts-changed` event.
#[tauri::command]
async fn switch_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut idx = read_index(&app).await;
    if !idx.accounts.iter().any(|a| a.id == id) {
        return Err(format!("no such account: {id}"));
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        return Ok(()); // already active — silent no-op
    }
    idx.active = Some(id);
    write_index(&app, &idx).await?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Remove a single account. If the removed account was the active
/// one, pick the first remaining account as the new active (or
/// `None` when this was the last). Deletes the per-account cookies
/// directory off disk in the same call.
#[tauri::command]
async fn remove_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut idx = read_index(&app).await;
    let pos = idx
        .accounts
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| format!("no such account: {id}"))?;
    idx.accounts.remove(pos);
    // Close this account's session-keeper (if running) so its webview
    // releases the profile directory before we delete it.
    if let Some(w) = app.get_webview_window(&format!("keeper-{id}")) {
        let _ = w.close();
    }
    let dir = accounts_dir(&app).join(&id);
    if dir.exists() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    if idx.active.as_deref() == Some(id.as_str()) {
        idx.active = idx.accounts.first().map(|a| a.id.clone());
    }
    write_index(&app, &idx).await?;
    let _ = app.emit("accounts-changed", ());
    Ok(())
}

/// Backfill or update meta for an account. Frontend calls this once
/// per session after `/account_menu` returns the active user's name
/// + email + avatar.
///
/// Dedup: if the supplied identity (email, or avatar when the email is
/// empty) matches a *different* existing account, this is a re-login of
/// an account we've seen before. Replace the older account's cookies
/// with the freshly-captured ones, drop this account's just-created
/// entry, and pin the older id as active.
#[tauri::command]
async fn update_account_meta(
    app: tauri::AppHandle,
    id: String,
    name: String,
    email: String,
    #[allow(non_snake_case)] photoUrl: Option<String>,
) -> Result<(), String> {
    let photo_url = photoUrl;
    let mut idx = read_index(&app).await;

    // Meta from /account_menu always describes the ACTIVE account: the
    // fetch runs with the active jar. A caller that pairs a stale id
    // with fresh meta (or a fresh id with stale meta) must not relabel
    // some other row; with identity dedup that could merge two real
    // accounts. Drop the write and let the backfill re-run with a
    // consistent pair.
    if idx.active.as_deref() != Some(id.as_str()) {
        return Ok(());
    }

    // When the account acts as a brand channel, /account_menu describes
    // the channel, not the Google account, so its meta can't identify a
    // duplicate row.
    let acting_as_brand = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.page_id.is_some())
        .unwrap_or(false);

    // Re-login of an existing account? Match a *different* row by
    // identity (email, or avatar when the email is empty; see
    // `meta_identity`). Keying on email alone missed brand-channel and
    // no-email accounts, which is how duplicate rows used to pile up.
    let incoming = if acting_as_brand {
        None
    } else {
        meta_identity(&email, photo_url.as_deref())
    };
    let dup_pos = incoming.as_ref().and_then(|key| {
        idx.accounts.iter().position(|a| {
            a.id != id
                && meta_identity(&a.email, a.photo_url.as_deref()).as_deref() == Some(key.as_str())
        })
    });

    // A "fresh add" is the very first meta backfill after
    // `start_login` — the account row exists but its name + email
    // are still empty placeholders. That's the moment to fire
    // `accounts-changed`, because it's the only event the UI listens
    // to for the full account-switch reset. Subsequent meta refreshes
    // (every session boot for an existing account) don't trigger the
    // reset; the frontend just invalidates the accounts list to pick
    // up name/photo changes.
    let was_fresh_add = idx
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map(|a| a.name.is_empty() && a.email.is_empty())
        .unwrap_or(false);

    // Track whether the active account id actually flips. Dedup is
    // the only path that flips active here; a plain meta update
    // leaves `idx.active` alone.
    let mut active_changed = false;

    if let Some(other_pos) = dup_pos {
        let other_id = idx.accounts[other_pos].id.clone();
        let this_cookies = account_cookies_path(&app, &id);
        let other_cookies = account_cookies_path(&app, &other_id);
        if let Some(parent) = other_cookies.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(bytes) = tokio::fs::read(&this_cookies).await {
            if let Err(e) = tokio::fs::write(&other_cookies, bytes).await {
                eprintln!("[accounts] copy cookies on dedup: {e}");
            }
        }
        // Re-login replaces the older row's session with the freshly
        // captured one, so its live WebView profile has to move over too.
        // Otherwise the renewed account would have no profile to refresh
        // from and would die at ~2h like the old snapshot-only flow. The
        // just-closed login window can hold WebView2 file locks for a
        // beat, so retry the move briefly before giving up.
        let this_webview = account_webview_dir(&app, &id);
        if this_webview.exists() {
            let other_webview = account_webview_dir(&app, &other_id);
            let _ = tokio::fs::remove_dir_all(&other_webview).await;
            let mut moved = false;
            for _ in 0..5u8 {
                if tokio::fs::rename(&this_webview, &other_webview)
                    .await
                    .is_ok()
                {
                    moved = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            if !moved {
                eprintln!(
                    "[accounts] could not move webview profile {id} -> {other_id}; \
                     re-login needed to re-arm session refresh"
                );
            }
        }
        let _ = tokio::fs::remove_dir_all(accounts_dir(&app).join(&id)).await;
        if let Some(this_pos) = idx.accounts.iter().position(|a| a.id == id) {
            idx.accounts.remove(this_pos);
        }
        if let Some(other) = idx.accounts.iter_mut().find(|a| a.id == other_id) {
            other.name = name;
            // Don't let an empty backfill (some accounts' /account_menu
            // carries no email) wipe a good stored email.
            if !email.is_empty() {
                other.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                other.photo_url = photo_url;
            }
        }
        if idx.active.as_deref() != Some(other_id.as_str()) {
            active_changed = true;
        }
        idx.active = Some(other_id);
    } else if let Some(acct) = idx.accounts.iter_mut().find(|a| a.id == id) {
        if acting_as_brand {
            // Route brand-channel meta into the channel fields and leave
            // the account-level identity (name / email / photo captured
            // on the personal channel) untouched: re-login dedup keys on
            // it, and overwriting the account photo with the brand one
            // made a later re-login of the same account look like a new
            // identity.
            if !name.is_empty() {
                acct.channel_name = Some(name);
            }
            if photo_url.is_some() {
                acct.channel_photo_url = photo_url;
            }
        } else {
            acct.name = name;
            // Some accounts' /account_menu carries no email; don't let
            // that backfill wipe the stored one (it drives the re-login
            // dedup above).
            if !email.is_empty() {
                acct.email = email;
            }
            // The avatar can be the dedup identity when the email is
            // empty; never wipe it with a photo-less response.
            if photo_url.is_some() {
                acct.photo_url = photo_url;
            }
        }
    } else {
        return Err(format!("no such account: {id}"));
    }

    write_index(&app, &idx).await?;
    if was_fresh_add || active_changed {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(())
}

/// Returns the id of the currently active account, or `None` when
/// signed out. Frontend uses this to pair fresh `account_menu` info
/// with the right account row.
#[tauri::command]
async fn get_active_account_id(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(read_index(&app).await.active)
}

/// Select which YouTube channel (personal or brand) an account acts
/// as. `pageId: None` selects the personal channel. When the choice on
/// the ACTIVE account actually changes we emit `accounts-changed`:
/// library, likes and home are channel-scoped, so the frontend must
/// run the same full reset as an account switch.
#[tauri::command]
async fn set_account_channel(
    app: tauri::AppHandle,
    id: String,
    #[allow(non_snake_case)] pageId: Option<String>,
    #[allow(non_snake_case)] channelName: Option<String>,
    #[allow(non_snake_case)] channelPhotoUrl: Option<String>,
) -> Result<(), String> {
    let mut idx = read_index(&app).await;
    let is_active = idx.active.as_deref() == Some(id.as_str());
    let acct = idx
        .accounts
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("no such account: {id}"))?;
    let changed = acct.page_id != pageId;
    acct.page_id = pageId;
    acct.channel_name = channelName;
    acct.channel_photo_url = channelPhotoUrl;
    write_index(&app, &idx).await?;
    if changed && is_active {
        let _ = app.emit("accounts-changed", ());
    }
    Ok(())
}

/// Cookie header plus the active account's brand-channel page id in a
/// single call. The InnerTube client sends the page id back as the
/// `X-Goog-PageId` header. Bundling it with the cookie read (instead
/// of a second command) means a cold start can't pair fresh cookies
/// with a stale page id, or vice versa.
#[derive(Clone, Debug, serde::Serialize)]
struct AuthContext {
    cookie: String,
    #[serde(rename = "pageId")]
    page_id: Option<String>,
}

#[tauri::command]
async fn get_auth_context(app: tauri::AppHandle, host: String) -> Result<AuthContext, String> {
    let cookie = read_cookie_header(&app, &host).await;
    let page_id = if cookie.is_empty() {
        None
    } else {
        let idx = read_index(&app).await;
        idx.accounts
            .iter()
            .find(|a| idx.active.as_deref() == Some(a.id.as_str()))
            .and_then(|a| a.page_id.clone())
    };
    Ok(AuthContext { cookie, page_id })
}

/// Serializes read-modify-write cycles on the active cookie jar.
/// Parallel InnerTube responses can each carry Set-Cookie rotations;
/// without the lock two merges could interleave and drop one.
#[derive(Default)]
struct JarWriteLock(tokio::sync::Mutex<()>);

/// Serializes cookie-refresh runs so the periodic keeper reload / jar
/// rewrite can't overlap between the timer and a manual trigger.
#[derive(Default)]
struct RefreshGuard(tokio::sync::Mutex<()>);

/// Merge `Set-Cookie` headers from an InnerTube response into the
/// active account's jar, mirroring what a browser would do. Google
/// rotates session-security cookies (SIDCC / __Secure-*PSIDCC /
/// LOGIN_INFO) right after sign-in and expects the client to echo the
/// fresh values from then on; a client that keeps replaying the
/// pre-rotation snapshot matches the stolen-cookie heuristic and the
/// whole session gets revoked within hours (the v0.2.0 "library and
/// Premium vanish" bug).
///
/// Returns `true` when a cookie VALUE changed — the frontend drops its
/// cached Cookie header then. Missing jar / dead decrypt are quiet
/// no-ops: rotation echo is best-effort and must never break the data
/// call that triggered it.
#[tauri::command]
async fn merge_response_cookies(
    app: tauri::AppHandle,
    lock: tauri::State<'_, JarWriteLock>,
    host: String,
    set_cookies: Vec<String>,
) -> Result<bool, String> {
    if set_cookies.is_empty() {
        return Ok(false);
    }
    let _guard = lock.0.lock().await;
    let Some(path) = active_cookies_path(&app).await else {
        return Ok(false);
    };
    let Ok(encrypted) = tokio::fs::read(&path).await else {
        return Ok(false);
    };
    let Ok(Ok(plain)) =
        tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted)).await
    else {
        return Ok(false);
    };
    let Ok(jar) = String::from_utf8(plain) else {
        return Ok(false);
    };

    let now_ts = time::OffsetDateTime::now_utc().unix_timestamp();
    let merged = merge_set_cookies_into_jar(&jar, &set_cookies, &host, now_ts);

    // An identity cookie the server tried to expire. We did not apply
    // it (see PROTECTED_COOKIES): the keeper's live browser session is
    // the authority on whether this account is actually signed out, so
    // ask it, out of band, instead of letting one response hard-log the
    // user out. If the session really is gone the keeper refresh fails
    // and leaves the jar alone; if it is fine, the snapshot is renewed.
    if !merged.blocked_deletions.is_empty() {
        eprintln!(
            "[auth] refused server expiry of identity cookie(s) {:?} from {host}; \
             re-checking the session against the keeper",
            merged.blocked_deletions
        );
        let app_probe = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(active) = read_index(&app_probe).await.active {
                if let Err(e) = refresh_account_cookies(&app_probe, &active).await {
                    eprintln!("[auth] post-expiry keeper re-check failed: {e}");
                }
            }
        });
    }

    // The merge still honors deletions for non-identity cookies, which
    // is correct browser behavior. It has never been logged, so we have
    // no idea how often it fires in the field. Report it.
    for gone in jar_cookie_keys(&jar).difference(&jar_cookie_keys(&merged.jar)) {
        eprintln!("[auth] server expired cookie {gone} (response host {host})");
    }

    if !merged.needs_write {
        return Ok(false);
    }
    let value_changed = merged.value_changed;
    let bytes = merged.jar.into_bytes();
    let encrypted = tokio::task::spawn_blocking(move || secure_store::encrypt(&bytes))
        .await
        .map_err(|e| format!("encrypt join: {e}"))?
        .map_err(|e| format!("encrypt cookies: {e}"))?;
    // Write-then-rename: this path runs on live rotations, not just at
    // login, and a torn cookies.enc reads as "signed out".
    write_atomic(&path, &encrypted)
        .await
        .map_err(|e| format!("write jar: {e}"))?;
    if value_changed {
        eprintln!("[auth] echoed rotated session cookie(s) into the active jar");
    }
    Ok(value_changed)
}

/// `domain name` keys for every entry in a Netscape jar, so two jars
/// can be diffed to see what a merge added or dropped.
fn jar_cookie_keys(jar: &str) -> std::collections::HashSet<String> {
    jar.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 7).then(|| format!("{} {}", f[0], f[5]))
        })
        .collect()
}

/// `domain name` -> value for every entry in a Netscape jar.
fn jar_cookie_values(jar: &str) -> HashMap<String, String> {
    jar.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 7).then(|| (format!("{} {}", f[0], f[5]), f[6].to_string()))
        })
        .collect()
}

/// Names present in both jars whose value differs. Values themselves are
/// never logged; only which cookies moved.
fn changed_cookie_names(before: &str, after: &str) -> Vec<String> {
    let a = jar_cookie_values(before);
    let b = jar_cookie_values(after);
    let mut out: Vec<String> = a
        .iter()
        .filter(|(k, v)| b.get(*k).is_some_and(|nv| nv != *v))
        .map(|(k, _)| k.clone())
        .collect();
    out.sort();
    out
}

/// File (under the store plugin's default dir) + key holding the
/// user-chosen cache root. Written by `set_cache_dir`, read once at
/// startup — the stream server captures its directories when it
/// spawns, so a change only applies on the next launch.
const SETTINGS_STORE_FILE: &str = "settings.json";
const CACHE_DIR_KEY: &str = "cacheDir";

/// The cache root this process actually started with (managed state,
/// set in `setup`). All track/cover cache paths derive from it so the
/// commands and the running stream server always agree, even when the
/// stored preference already points somewhere new.
struct ActiveCacheRoot(PathBuf);

fn default_cache_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// User-chosen cache root from the settings store, if any.
fn stored_cache_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SETTINGS_STORE_FILE).ok()?;
    let value = store.get(CACHE_DIR_KEY)?;
    let s = value.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn stream_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ActiveCacheRoot>().0.join("stream")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirInfo {
    /// Root that will be used from the next launch on.
    path: String,
    default_path: String,
    is_custom: bool,
    /// True when the stored preference differs from what this process
    /// is running with — i.e. a restart is pending.
    needs_restart: bool,
}

#[tauri::command]
fn get_cache_dir(app: tauri::AppHandle) -> CacheDirInfo {
    let default = default_cache_root(&app);
    let stored = stored_cache_root(&app);
    let active = app.state::<ActiveCacheRoot>().0.clone();
    let effective = stored.clone().unwrap_or_else(|| default.clone());
    CacheDirInfo {
        needs_restart: effective != active,
        path: effective.display().to_string(),
        default_path: default.display().to_string(),
        is_custom: stored.is_some(),
    }
}

/// Persist a new cache root (`None` resets to the default). Validates
/// that the folder exists and is writable before saving; the change
/// takes effect on the next launch.
#[tauri::command]
async fn set_cache_dir(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(SETTINGS_STORE_FILE)
        .map_err(|e| format!("open settings store: {e}"))?;
    match path {
        None => {
            store.delete(CACHE_DIR_KEY);
        }
        Some(raw) => {
            let raw = raw.trim().to_string();
            let dir = PathBuf::from(&raw);
            if raw.is_empty() || !dir.is_absolute() {
                return Err("Pick an absolute folder path.".into());
            }
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| format!("Can't create the folder: {e}"))?;
            let probe = dir.join(".ytubic-write-test");
            tokio::fs::write(&probe, b"ok")
                .await
                .map_err(|e| format!("Folder isn't writable: {e}"))?;
            let _ = tokio::fs::remove_file(&probe).await;
            store.set(CACHE_DIR_KEY, serde_json::Value::String(raw));
        }
    }
    store
        .save()
        .map_err(|e| format!("save settings store: {e}"))?;
    Ok(())
}

/// Native directory picker for the cache-folder setting. Returns
/// `None` when the user cancels. Blocking picker variant, so keep it
/// off the async runtime's core threads.
#[tauri::command]
async fn pick_cache_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[derive(serde::Serialize)]
struct CacheEntry {
    #[serde(rename = "videoId")]
    video_id: String,
    size: u64,
    /// Seconds since unix epoch. Frontend formats for display.
    #[serde(rename = "modifiedSecs")]
    modified_secs: u64,
    /// Track title, if a sidecar was written when it was cached. The
    /// library walk is the frontend's fallback; without either, it shows
    /// the raw videoId.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// Display artist string (already joined), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
}

/// On-disk sidecar written next to a cached `<id>.webm` as
/// `<id>.meta.json`. The Rust side stores it verbatim; the frontend
/// supplies the already-formatted display strings.
#[derive(serde::Serialize, serde::Deserialize)]
struct TrackMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
}

/// Best-effort read of a track's metadata sidecar. Any absence or parse
/// error is treated as "no metadata" — the cache file is still valid
/// without it.
async fn read_track_meta(dir: &std::path::Path, video_id: &str) -> TrackMeta {
    let path = dir.join(format!("{video_id}.meta.json"));
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<TrackMeta>(&bytes).unwrap_or(TrackMeta {
            title: None,
            artist: None,
        }),
        Err(_) => TrackMeta {
            title: None,
            artist: None,
        },
    }
}

/// List every finalized track (.webm) currently in the stream cache.
/// In-progress .part files are ignored — they'll appear once the
/// download finishes and the rename happens.
#[tauri::command]
async fn list_cache(app: tauri::AppHandle) -> Result<Vec<CacheEntry>, String> {
    let dir = stream_cache_dir(&app);
    let mut entries: Vec<CacheEntry> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let Some(video_id) = name.strip_suffix(".webm") else {
            continue;
        };
        if !sanitize_video_id(video_id) {
            continue;
        }
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let sidecar = read_track_meta(&dir, video_id).await;
        entries.push(CacheEntry {
            video_id: video_id.to_string(),
            size: meta.len(),
            modified_secs,
            title: sidecar.title,
            artist: sidecar.artist,
        });
    }
    Ok(entries)
}

/// Delete specific cached tracks. Passing an empty vec wipes the
/// entire stream cache directory. Returns the total bytes freed.
#[tauri::command]
async fn delete_cache_entries(
    app: tauri::AppHandle,
    video_ids: Vec<String>,
) -> Result<u64, String> {
    let dir = stream_cache_dir(&app);
    if !dir.exists() {
        return Ok(0);
    }
    let mut freed: u64 = 0;

    let targets: Vec<String> = if video_ids.is_empty() {
        // "Clear all" — enumerate on the fly. Strip whichever suffix a
        // file carries so orphaned sidecars / stray .part files (whose
        // .webm is already gone) get swept too, not just live tracks.
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| format!("read_dir: {e}"))?;
        let mut out = std::collections::HashSet::new();
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Some(name) = e.file_name().to_str() {
                let id = name
                    .strip_suffix(".webm")
                    .or_else(|| name.strip_suffix(".meta.json"))
                    .or_else(|| name.strip_suffix(".part"));
                if let Some(id) = id {
                    if sanitize_video_id(id) {
                        out.insert(id.to_string());
                    }
                }
            }
        }
        out.into_iter().collect()
    } else {
        video_ids
            .into_iter()
            .filter(|id| sanitize_video_id(id))
            .collect()
    };

    for id in targets {
        let path = dir.join(format!("{id}.webm"));
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            freed += meta.len();
        }
        let _ = tokio::fs::remove_file(&path).await;
        // Stray .part file from a crashed download, if any.
        let _ = tokio::fs::remove_file(dir.join(format!("{id}.part"))).await;
        // Metadata sidecar, if one was written.
        let _ = tokio::fs::remove_file(dir.join(format!("{id}.meta.json"))).await;
    }
    Ok(freed)
}

/// Persist a cached track's display metadata to `<id>.meta.json` beside
/// its `.webm`. Called by the frontend when it streams or prefetches a
/// track into the persistent (Premium) cache — that's the moment it
/// knows the title/artist, which `list_cache` cannot derive from the
/// file alone. Idempotent; an empty title is a no-op.
#[tauri::command]
async fn set_cache_meta(
    app: tauri::AppHandle,
    video_id: String,
    title: Option<String>,
    artist: Option<String>,
) -> Result<(), String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let title = title.filter(|s| !s.trim().is_empty());
    // Nothing worth writing — skip rather than leave an empty sidecar.
    if title.is_none() {
        return Ok(());
    }
    let dir = stream_cache_dir(&app);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return Err(format!("create_dir_all: {e}"));
    }
    let meta = TrackMeta {
        title,
        artist: artist.filter(|s| !s.trim().is_empty()),
    };
    let bytes = serde_json::to_vec(&meta).map_err(|e| format!("serialize: {e}"))?;
    let path = dir.join(format!("{video_id}.meta.json"));
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

/// Make the managed yt-dlp binary available (download on first run,
/// throttled self-update after). Invoked by the frontend on mount so
/// the `ytdlp-state` event listener is guaranteed to exist before any
/// state event fires; also serves as the retry path after a failed
/// download. Idempotent — see `ytdlp::ensure`.
#[tauri::command]
async fn ensure_ytdlp(app: tauri::AppHandle) {
    ytdlp::ensure(app).await;
}

/// Run yt-dlp to resolve a videoId into metadata JSON.
#[tauri::command]
fn resolve_stream_ytdlp(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut command = std::process::Command::new(ytdlp::program(&ytdlp::managed_path(&app)));
    command.args([
        "-j",
        "-f",
        "bestaudio",
        "--no-playlist",
        "--no-warnings",
        "--extractor-args",
        "youtube:player_client=tv,android_vr",
        &url,
    ]);
    // Windows: a console-less GUI process spawning the console-subsystem
    // yt-dlp.exe with default flags makes Windows flash a console window
    // on every resolve. CREATE_NO_WINDOW suppresses it.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command.output().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp exit {}: {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("stdout not utf8: {e}"))
}

/// Lifecycle of a single track's yt-dlp download. yt-dlp writes
/// bytes into a `<videoId>.part` file which is renamed to
/// `<videoId>.webm` on successful completion; stream handlers block on
/// `notify` until `complete` flips.
struct DownloadState {
    complete: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

type DownloadMap = Arc<Mutex<HashMap<String, Arc<DownloadState>>>>;

// NB: `cookies.enc` is read only by the InnerTube pipeline (library,
// search, liked songs). We deliberately do NOT forward cookies to
// yt-dlp: YouTube's bot-detection treats any authenticated yt-dlp
// request as a bot and strips every real audio format, leaving only
// storyboard thumbnails — so anonymous streaming via the android_vr/
// ios/mweb clients actually works better than authenticated streaming.
#[derive(Clone)]
struct StreamServer {
    /// Persistent cache. Tracks land here for Premium-authenticated
    /// users and stay across app restarts.
    cache_dir: PathBuf,
    /// Session-only cache for anonymous / Free users. Wiped on every
    /// app startup (see `start_stream_server`) so a non-Premium session
    /// never accumulates a track library on disk. The `download` map
    /// keys are prefixed (`e:` vs `p:`) so the same videoId can be
    /// in-flight independently for the two modes.
    ephemeral_dir: PathBuf,
    cover_dir: PathBuf,
    downloads: DownloadMap,
    /// Expected location of the managed yt-dlp copy. Resolution to an
    /// actual program (managed vs PATH fallback) happens per-spawn via
    /// `ytdlp::program` so a mid-session download takes effect
    /// immediately.
    ytdlp_bin: PathBuf,
}

/// Read the `ephemeral` query flag from a stream/prefetch request.
/// True when `?ephemeral=1` (or `=true`) appears — used to route the
/// download to `ephemeral_dir` instead of the persistent cache.
fn is_ephemeral(req: &Request) -> bool {
    let Some(query) = req.uri().query() else {
        return false;
    };
    query.split('&').any(|kv| {
        let mut it = kv.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = it.next().unwrap_or("");
        key == "ephemeral" && (val == "1" || val == "true")
    })
}

/// Hash a URL into a stable hex filename. Uses Rust's stdlib
/// SipHash13 (DefaultHasher) — not cryptographic, but for cache-key
/// purposes only and keeps the dependency footprint small.
fn url_to_filename(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let ext = if url.contains(".png") {
        "png"
    } else if url.contains(".webp") {
        "webp"
    } else {
        "jpg"
    };
    format!("{hash}.{ext}")
}

fn cover_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<ActiveCacheRoot>().0.join("covers")
}

/// Download a cover image (typically from iTunes / mzstatic) and stash
/// it in the local cover cache, returning a localhost URL the webview
/// can use as `<img src>`. Subsequent calls for the same URL skip the
/// network and just return the existing local URL.
///
/// We don't cache failures — the next track switch retries.
#[tauri::command]
async fn cache_cover(
    app: tauri::AppHandle,
    state: tauri::State<'_, StreamServerState>,
    url: String,
) -> Result<String, String> {
    let port = {
        let p = state.port.lock().await;
        p.ok_or_else(|| "stream server not ready".to_string())?
    };
    let token = {
        let t = state.token.lock().await;
        t.clone()
            .ok_or_else(|| "stream server not ready".to_string())?
    };

    // SSRF guard: cover URLs come from remote metadata (iTunes/mzstatic +
    // YT image hosts). Only fetch https from those known CDNs so a crafted
    // metadata field can't point the server-side fetch at an internal
    // service (e.g. 169.254.169.254 or a LAN admin page). Redirects are
    // disabled below so a CDN-looking URL can't 302 into the allowlist.
    {
        let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
        if parsed.scheme() != "https" {
            return Err(format!("blocked scheme: {}", parsed.scheme()));
        }
        const ALLOWED_HOST_SUFFIXES: &[&str] = &[
            "mzstatic.com",
            "ytimg.com",
            "ggpht.com",
            "googleusercontent.com",
        ];
        let host = parsed.host_str().unwrap_or("");
        let host_ok = ALLOWED_HOST_SUFFIXES
            .iter()
            .any(|s| host == *s || host.ends_with(&format!(".{s}")));
        if !host_ok {
            return Err(format!("blocked cover host: {host}"));
        }
    }

    let dir = cover_cache_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    let filename = url_to_filename(&url);
    let path = dir.join(&filename);

    if !path.exists() {
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("client: {e}"))?
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("fetch: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
        // Write to a .part file then atomically rename so a concurrent
        // reader never sees a half-written file.
        let part = path.with_extension(format!(
            "{}.part",
            path.extension().and_then(|e| e.to_str()).unwrap_or("")
        ));
        tokio::fs::write(&part, &bytes)
            .await
            .map_err(|e| format!("write: {e}"))?;
        tokio::fs::rename(&part, &path)
            .await
            .map_err(|e| format!("rename: {e}"))?;
    }

    Ok(format!("http://127.0.0.1:{port}/{token}/cover/{filename}"))
}

#[derive(serde::Serialize)]
struct CoverCacheStats {
    count: u64,
    bytes: u64,
}

/// Sum up the cover cache directory. Used by the Settings UI to show
/// "Covers: 47 files, 12 MB" alongside the existing track-cache row.
#[tauri::command]
async fn cover_cache_stats(app: tauri::AppHandle) -> Result<CoverCacheStats, String> {
    let dir = cover_cache_dir(&app);
    let mut count: u64 = 0;
    let mut bytes: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CoverCacheStats { count: 0, bytes: 0 });
        }
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        count += 1;
        bytes += meta.len();
    }
    Ok(CoverCacheStats { count, bytes })
}

/// Wipe every file in the cover cache directory. Returns total bytes
/// freed. The directory itself is preserved so the next `cache_cover`
/// call doesn't have to recreate it.
#[tauri::command]
async fn clear_cover_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let dir = cover_cache_dir(&app);
    let mut freed: u64 = 0;
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("read_dir: {e}")),
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let Ok(meta) = e.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        freed += meta.len();
        let _ = tokio::fs::remove_file(e.path()).await;
    }
    Ok(freed)
}

#[derive(Default)]
struct StreamServerState {
    port: Arc<Mutex<Option<u16>>>,
    /// Per-launch secret used as a path prefix on every stream/prefetch/
    /// cover URL. The frontend gets it baked into the base URL, so it's
    /// transparent to the webview; a web page in the user's browser that
    /// guesses the random port still can't form a valid URL — this closes
    /// the CSRF-spawn and DNS-rebinding-read vectors.
    token: Arc<Mutex<Option<String>>>,
}

#[tauri::command]
async fn get_stream_base_url(state: tauri::State<'_, StreamServerState>) -> Result<String, String> {
    let port = *state.port.lock().await;
    let token = state.token.lock().await.clone();
    match (port, token) {
        (Some(p), Some(t)) => Ok(format!("http://127.0.0.1:{p}/{t}")),
        _ => Err("stream server not ready".to_string()),
    }
}

/// Spawn a yt-dlp downloader that writes into the shared memory buffer
/// AND to a `<videoId>.part` file on disk. On successful exit, renames
/// .part → .webm. Updates `state.complete` + pings `notify` on every
/// new chunk.
///
/// `target_dir` selects which on-disk pool to write to (persistent or
/// ephemeral). `map_key` is the prefixed key in `srv.downloads` so a
/// single videoId can be in-flight independently for both pools.
fn spawn_downloader(
    video_id: String,
    target_dir: PathBuf,
    map_key: String,
    srv: StreamServer,
    state: Arc<DownloadState>,
) {
    let downloads = srv.downloads.clone();
    tokio::spawn(async move {
        let url = format!("https://www.youtube.com/watch?v={video_id}");
        let part_path = target_dir.join(format!("{video_id}.part"));
        let final_path = target_dir.join(format!("{video_id}.webm"));
        let _ = tokio::fs::create_dir_all(&target_dir).await;
        let _ = tokio::fs::remove_file(&part_path).await; // clean stale

        let mut cmd = TokioCommand::new(ytdlp::program(&srv.ytdlp_bin));
        cmd.args([
            "-f",
            "bestaudio[ext=webm]/bestaudio",
            "--no-playlist",
            "--no-warnings",
            "--no-part",
            "-q",
            // YouTube regularly hands out a signed media URL that then 403s
            // on the very first byte-range request (token/pot desync or
            // per-URL throttling). Left alone this surfaces as a one-off
            // "download failed" that a manual re-click fixes. Retrying the
            // data download and the extractor a few times clears the vast
            // majority of these inside a single spawn, before the handler
            // ever returns 502 to the audio element.
            "--retries",
            "5",
            "--extractor-retries",
            "3",
            "--socket-timeout",
            "15",
            "--extractor-args",
            "youtube:player_client=tv,android_vr",
            "-o",
            "-",
        ]);
        cmd.arg(&url);
        // Windows: suppress the console window for the child yt-dlp.exe
        // (see resolve_stream_ytdlp for rationale).
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = match cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[stream] spawn {video_id}: {e}");
                state.complete.store(true, Ordering::Release);
                state.notify.notify_waiters();
                downloads.lock().await.remove(&map_key);
                return;
            }
        };

        let mut stdout = child.stdout.take().unwrap();
        let mut file = tokio::fs::File::create(&part_path).await.ok();
        let mut buf = vec![0u8; 64 * 1024];
        let mut ok = true;
        // Per-read timeout so a wedged yt-dlp (stalled TCP / hung extractor)
        // can't keep this task and the child process alive forever with
        // `complete` stuck false — otherwise every later request for the id
        // attaches to the dead entry and blocks 120s then 504.
        const READ_TIMEOUT: Duration = Duration::from_secs(60);
        loop {
            match tokio::time::timeout(READ_TIMEOUT, stdout.read(&mut buf)).await {
                Err(_) => {
                    eprintln!("[stream] read timeout for {video_id}; killing yt-dlp");
                    let _ = child.start_kill();
                    ok = false;
                    break;
                }
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    let chunk = &buf[..n];
                    if let Some(ref mut f) = file {
                        if let Err(e) = f.write_all(chunk).await {
                            eprintln!("[stream] write .part: {e}");
                            file = None;
                            // A truncated prefix must NOT be renamed to .webm
                            // and cached — mark the whole download failed.
                            ok = false;
                        }
                    }
                    state.notify.notify_waiters();
                }
                Ok(Err(e)) => {
                    eprintln!("[stream] read stdout: {e}");
                    ok = false;
                    break;
                }
            }
        }
        if let Some(mut f) = file.take() {
            let _ = f.flush().await;
            drop(f);
        }
        let status = child.wait().await;
        let success = ok && status.map(|s| s.success()).unwrap_or(false);

        // Finish all file operations BEFORE signalling completion.
        // Otherwise handlers waiting on `state.complete` can race and
        // observe `final_path.exists() == false` in the tiny window
        // between yt-dlp exit and our rename, returning 502 even
        // though the download succeeded.
        // 32 KB floor: yt-dlp can exit 0 with a near-empty payload when
        // YouTube serves a storyboard-only response (rate-limit, geo-block,
        // SABR fallout). Renaming such a stub to .webm would pin a
        // permanently-broken cache entry that fails MEDIA_ERR_DECODE on
        // every replay — drop it instead so the next request retries.
        const MIN_AUDIO_BYTES: u64 = 32 * 1024;
        let part_size = tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if success && part_size >= MIN_AUDIO_BYTES {
            if let Err(e) = tokio::fs::rename(&part_path, &final_path).await {
                eprintln!("[stream] rename: {e}");
                let _ = tokio::fs::remove_file(&part_path).await;
            } else {
                eprintln!("[stream] cached {video_id} ({part_size} bytes)");
            }
        } else {
            if success {
                eprintln!(
                    "[stream] download too small for {video_id}: {part_size} bytes (min {MIN_AUDIO_BYTES})"
                );
            } else {
                eprintln!("[stream] download failed {video_id}");
            }
            let _ = tokio::fs::remove_file(&part_path).await;
        }

        state.complete.store(true, Ordering::Release);
        state.notify.notify_waiters();

        if success {
            // Evict from in-memory map after a grace period so a brief
            // re-play stays in RAM, then falls back to on-disk ServeFile.
            let downloads_evict = downloads.clone();
            let key = map_key.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                downloads_evict.lock().await.remove(&key);
            });
        } else {
            // Failed: drop the entry immediately so the next play retries
            // instead of getting an instant 502 for the whole 60s window.
            downloads.lock().await.remove(&map_key);
        }
    });
}

/// Read the first 16 bytes of a completed track file and map the
/// container magic to the right `audio/*` mime. Every track is saved
/// with a `.webm` extension regardless of what yt-dlp actually
/// produced, so we can't trust the extension.
async fn sniff_audio_mime(path: &std::path::Path) -> &'static str {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = tokio::fs::File::open(path).await {
        let _ = f.read(&mut buf).await;
    }
    if &buf[4..8] == b"ftyp" {
        "audio/mp4"
    } else if &buf[..4] == &[0x1A, 0x45, 0xDF, 0xA3] {
        "audio/webm"
    } else if &buf[..3] == b"ID3" {
        "audio/mpeg"
    } else {
        "audio/webm"
    }
}

/// GET /stream/:video_id — unified serving path supporting Range
/// requests even during an active download.
async fn stream_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> Response {
    if !sanitize_video_id(&video_id) {
        return (StatusCode::BAD_REQUEST, "invalid videoId").into_response();
    }

    let ephemeral = is_ephemeral(&req);
    let target_dir = if ephemeral {
        srv.ephemeral_dir.clone()
    } else {
        srv.cache_dir.clone()
    };
    let map_key = if ephemeral {
        format!("e:{video_id}")
    } else {
        format!("p:{video_id}")
    };
    let final_path = target_dir.join(format!("{video_id}.webm"));

    // If the full file isn't on disk yet, start (or attach to) the
    // download and block until it completes. Attempting to progressively
    // stream yt-dlp's stdout broke in two ways:
    //   - m4a/mp4 audio tracks often have the `moov` atom at the end of
    //     the file, so Chromium can't decode them until every byte has
    //     arrived. The first request then fails with
    //     MEDIA_ERR_SRC_NOT_SUPPORTED.
    //   - There's no valid HTTP response for a stream whose total length
    //     is unknown AND whose Range subset has an unknown end
    //     (`Content-Range: bytes 0-*/*` is grammatically invalid per
    //     RFC 7233). Serving with `Accept-Ranges: none` works but then
    //     Chromium disables seeking entirely.
    //
    // Full download + `ServeFile` sidesteps both problems: Range
    // requests, seeking, content-type detection, and large file support
    // all become the crate's problem. The "first-play" latency is just
    // the download time (~1-3 s on a healthy connection for a typical
    // 3-minute track) and the existing next-track prefetcher hides it
    // from the user on every track except the very first one.
    let t0 = std::time::Instant::now();

    let range_hdr = req
        .headers()
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    eprintln!(
        "[stream] GET /stream/{video_id} range={range_hdr:?} cached={} ephemeral={ephemeral}",
        final_path.exists()
    );

    if !final_path.exists() {
        let state = {
            let mut map = srv.downloads.lock().await;
            if let Some(s) = map.get(&map_key) {
                s.clone()
            } else {
                let s = Arc::new(DownloadState {
                    complete: Arc::new(AtomicBool::new(false)),
                    notify: Arc::new(Notify::new()),
                });
                map.insert(map_key.clone(), s.clone());
                drop(map);
                spawn_downloader(
                    video_id.clone(),
                    target_dir.clone(),
                    map_key.clone(),
                    srv.clone(),
                    s.clone(),
                );
                s
            }
        };

        // Bounded wait — 120 s is generous for any single track; if
        // yt-dlp is wedged past that, we'd rather fail fast than hang
        // the audio element forever.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while !state.complete.load(Ordering::Acquire) {
            if tokio::time::Instant::now() >= deadline {
                eprintln!("[stream] {video_id}: TIMEOUT after 120s");
                return (StatusCode::GATEWAY_TIMEOUT, "download timeout").into_response();
            }
            let notified = state.notify.notified();
            tokio::pin!(notified);
            let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
        }

        if !final_path.exists() {
            eprintln!(
                "[stream] {video_id}: BAD_GATEWAY — complete but no .webm (elapsed {:.2}s)",
                t0.elapsed().as_secs_f32()
            );
            return (StatusCode::BAD_GATEWAY, "download failed").into_response();
        }
        eprintln!(
            "[stream] {video_id}: download finished in {:.2}s",
            t0.elapsed().as_secs_f32()
        );
    }

    // Sniff actual content-type from the file's magic bytes. Every
    // track is saved with a `.webm` extension, but yt-dlp falls back
    // to m4a when a video has no webm audio — serving that as
    // `video/webm` (what tower-http guesses from the extension) makes
    // Chromium refuse to decode.
    let sniffed_ct = sniff_audio_mime(&final_path).await;
    let mut resp = ServeFile::new(&final_path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() || resp.status() == StatusCode::PARTIAL_CONTENT {
        resp.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static(sniffed_ct),
        );
    }
    eprintln!(
        "[stream] {video_id}: responding {} ({:.2}s total) ct={:?} len={:?}",
        resp.status(),
        t0.elapsed().as_secs_f32(),
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        resp.headers()
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
    );
    resp
}

/// GET /cover/:filename — serve a cached cover image. Files are placed
/// here by the `cache_cover` Tauri command. The filename is a hex hash +
/// extension produced by `url_to_filename`, which is the only way bytes
/// land in this directory — so accepting `[a-zA-Z0-9.]+` is enough to
/// rule out path traversal.
async fn cover_serve_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(filename): Path<String>,
    req: Request,
) -> Response {
    if filename.is_empty()
        || filename.len() > 64
        || !filename
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
        || filename.contains("..")
    {
        return (StatusCode::BAD_REQUEST, "invalid filename").into_response();
    }
    let path = srv.cover_dir.join(&filename);
    if !path.exists() {
        return (StatusCode::NOT_FOUND, "not cached").into_response();
    }
    let mut resp = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map(|r| r.into_response())
        .unwrap_or_else(|e| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}")).into_response()
        });
    if resp.status().is_success() {
        // Filename is content-addressed (hash of the source URL), so
        // the bytes never change — let the webview cache aggressively.
        resp.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    resp
}

/// GET /prefetch/:video_id — fire-and-forget cache warmer. Honours the
/// same `?ephemeral=1` flag as /stream so non-Premium prefetches (if
/// the frontend ever lets one through) land in the session-only pool
/// rather than the persistent cache.
async fn prefetch_handler(
    AxumState(srv): AxumState<StreamServer>,
    Path(video_id): Path<String>,
    req: Request,
) -> StatusCode {
    if !sanitize_video_id(&video_id) {
        return StatusCode::BAD_REQUEST;
    }
    let ephemeral = is_ephemeral(&req);
    let target_dir = if ephemeral {
        srv.ephemeral_dir.clone()
    } else {
        srv.cache_dir.clone()
    };
    let map_key = if ephemeral {
        format!("e:{video_id}")
    } else {
        format!("p:{video_id}")
    };
    let final_path = target_dir.join(format!("{video_id}.webm"));
    if final_path.exists() {
        return StatusCode::OK;
    }
    let state = {
        // Single lock hold for check-then-insert so a concurrent /stream
        // (whose check+insert is already atomic) or a second /prefetch can't
        // slip in between and spawn a second downloader writing the same
        // .part file, corrupting the cached track.
        let mut map = srv.downloads.lock().await;
        if map.contains_key(&map_key) {
            return StatusCode::ACCEPTED;
        }
        let state = Arc::new(DownloadState {
            complete: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        });
        map.insert(map_key.clone(), state.clone());
        state
    };
    spawn_downloader(video_id, target_dir, map_key, srv.clone(), state);
    StatusCode::ACCEPTED
}

/// Generate an unguessable per-launch token used as a URL path prefix on
/// the local stream server. Uses OS-seeded RandomState (SipHash keys)
/// instead of pulling in an RNG crate — 128 bits is ample for a localhost
/// secret that only needs to resist online guessing by a web page.
fn generate_stream_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(0x9E37_79B9_7F4A_7C15);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

async fn start_stream_server(
    port_state: Arc<Mutex<Option<u16>>>,
    token_state: Arc<Mutex<Option<String>>>,
    cache_dir: PathBuf,
    ephemeral_dir: PathBuf,
    cover_dir: PathBuf,
    ytdlp_bin: PathBuf,
) {
    if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
        eprintln!("[stream-server] mkdir {cache_dir:?}: {e}");
    }
    if let Err(e) = tokio::fs::create_dir_all(&ephemeral_dir).await {
        eprintln!("[stream-server] mkdir {ephemeral_dir:?}: {e}");
    }
    if let Err(e) = tokio::fs::create_dir_all(&cover_dir).await {
        eprintln!("[stream-server] mkdir {cover_dir:?}: {e}");
    }

    // Wipe whatever a previous (anonymous / Free) session left behind.
    // Persisting tracks across restarts is a Premium-only feature; if a
    // non-Premium user manages to crash the app mid-stream we still
    // want the leftover .webm gone before the next launch.
    if let Ok(mut rd) = tokio::fs::read_dir(&ephemeral_dir).await {
        let mut wiped: u64 = 0;
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(meta) = entry.metadata().await {
                if meta.is_file() {
                    wiped += meta.len();
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        if wiped > 0 {
            eprintln!("[stream-server] wiped {wiped} bytes from ephemeral dir");
        }
    }

    let server = StreamServer {
        cache_dir,
        ephemeral_dir,
        cover_dir,
        downloads: Arc::new(Mutex::new(HashMap::new())),
        ytdlp_bin,
    };

    // Per-launch token as an unguessable path prefix. Baked into the base
    // URL (get_stream_base_url) and cover URLs (cache_cover), so it's
    // transparent to the webview but blocks blind access from a web page
    // that only knows the random port.
    let token = generate_stream_token();
    *token_state.lock().await = Some(token.clone());

    let routes = Router::new()
        .route("/stream/:video_id", get(stream_handler))
        .route("/prefetch/:video_id", get(prefetch_handler))
        .route("/cover/:filename", get(cover_serve_handler))
        .with_state(server);
    let app = Router::new()
        .nest(&format!("/{token}"), routes)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[stream-server] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[stream-server] local_addr failed: {e}");
            return;
        }
    };
    *port_state.lock().await = Some(port);
    eprintln!("[stream-server] listening on 127.0.0.1:{port}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[stream-server] serve error: {e}");
    }
}

/// Show + focus the main window (from tray click or single-instance
/// re-launch).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// App icon for runtime surfaces (tray, taskbar). Debug builds get an
/// orange variant of the logo so a dev instance running next to an
/// installed release is distinguishable at a glance; release builds use
/// the bundled (red) icon.
fn runtime_icon(app: &tauri::AppHandle) -> tauri::image::Image<'static> {
    #[cfg(debug_assertions)]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-dev.png")) {
            return icon;
        }
    }
    app.default_window_icon()
        .cloned()
        .expect("bundled window icon missing")
        .to_owned()
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show YTubic", true, None::<&str>)?;
    let play_item = MenuItem::with_id(app, "play_pause", "Play / Pause", true, Some("Space"))?;
    let prev_item = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item, &sep, &play_item, &prev_item, &next_item, &sep, &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(runtime_icon(app))
        .tooltip(if cfg!(debug_assertions) {
            "YTubic (dev)"
        } else {
            "YTubic"
        })
        .menu(&menu)
        // macOS menu-bar extras conventionally open on left-click. Windows
        // and Linux keep left-click reserved for restoring the main window.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "play_pause" => {
                let _ = app.emit("tray-action", "play_pause");
            }
            "prev" => {
                let _ = app.emit("tray-action", "prev");
            }
            "next" => {
                let _ = app.emit("tray-action", "next");
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            // Left-click the icon = show the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Register + pin the app's Windows identity (AppUserModelID) so the SMTC
    // media tile (and notifications, taskbar) resolve to "YTubic" + icon rather
    // than "Unknown app". Must run before any window is created. No-op off
    // Windows.
    appid::init();

    let state = StreamServerState::default();
    let port_handle = state.port.clone();
    let token_handle = state.token.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            // Default StateFlags includes DECORATIONS, which would
            // override our `decorations: false` from tauri.conf.json
            // every time the saved state is restored. Exclude it.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                // Never persist or restore the hidden session-keeper windows.
                // Their saved "visible: true" + on-screen position was being
                // replayed on the next launch, popping a stray
                // music.youtube.com window into view until the user minimized
                // it. Keeping them out of the store lets their builder flags
                // (hidden, off-screen) hold on every launch.
                .with_filter(|label| !label.starts_with("keeper-"))
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state)
        .manage(CloseBehavior::default())
        .manage(JarWriteLock::default())
        .manage(RefreshGuard::default())
        .manage(discord::spawn())
        .manage(lastfm::LastfmState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_ytdlp,
            resolve_stream_ytdlp,
            get_stream_base_url,
            start_login,
            get_cookie_header,
            get_auth_context,
            merge_response_cookies,
            is_logged_in,
            probe_session,
            refresh_active_session,
            clear_cookies,
            list_accounts,
            switch_account,
            remove_account,
            update_account_meta,
            set_account_channel,
            get_active_account_id,
            list_cache,
            delete_cache_entries,
            set_cache_meta,
            cache_cover,
            cover_cache_stats,
            clear_cover_cache,
            quit_app,
            set_close_behavior,
            autostart_set,
            autostart_is_enabled,
            notify_track,
            get_cache_dir,
            set_cache_dir,
            pick_cache_folder,
            focus_main_window,
            open_player_window,
            close_player_window,
            media::media_update,
            media::media_clear,
            discord::discord_update,
            discord::discord_clear,
            discord::discord_set_enabled,
            lastfm::lastfm_is_configured,
            lastfm::lastfm_begin_auth,
            lastfm::lastfm_poll_session,
            lastfm::lastfm_user_info,
            lastfm::lastfm_update_now_playing,
            lastfm::lastfm_scrobble,
            lastfm::lastfm_love,
            lastfm::lastfm_flush,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Main window: hide to tray or quit, per the user's
                    // Settings choice (default tray). Quit goes through
                    // an explicit exit — just letting the close proceed
                    // could leave a floating-player window keeping the
                    // process alive headless.
                    "main" => {
                        let quit = window
                            .state::<CloseBehavior>()
                            .quit_on_close
                            .load(Ordering::Relaxed);
                        if quit {
                            window.app_handle().exit(0);
                        } else {
                            let _ = window.hide();
                            api.prevent_close();
                        }
                    }
                    // The floating player window actually closes — we
                    // tell the main window so it can revert the layout
                    // mode back to "right".
                    "player" => {
                        let _ = window.app_handle().emit("player-window-closed", ());
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            eprintln!(
                "[boot] YTubic {} starting (debug={})",
                app.package_info().version,
                cfg!(debug_assertions)
            );
            let port = port_handle.clone();
            let token = token_handle.clone();
            // User-chosen cache root (Settings → Storage) or the OS
            // default. Captured once and exposed as managed state so
            // every cache-path computation matches the directories the
            // stream server is about to bind — a preference change made
            // later only applies after relaunch.
            let cache_root =
                stored_cache_root(app.handle()).unwrap_or_else(|| default_cache_root(app.handle()));
            app.manage(ActiveCacheRoot(cache_root.clone()));
            // Retry any scrobbles stranded offline on the previous run. Spawns
            // its own task; a no-op when Last.fm isn't configured or the queue
            // is empty. See src/lastfm.rs.
            lastfm::flush_on_startup(app.handle().clone());
            let cache_dir = cache_root.join("stream");
            let ephemeral_dir = cache_root.join("stream-ephemeral");
            let cover_dir = cache_root.join("covers");
            let handle = app.handle().clone();
            eprintln!("[stream-server] cache dir: {cache_dir:?}");
            eprintln!("[stream-server] ephemeral dir: {ephemeral_dir:?}");
            eprintln!("[stream-server] cover dir: {cover_dir:?}");
            let ytdlp_bin = ytdlp::managed_path(&handle);
            tauri::async_runtime::spawn(async move {
                migrate_plaintext_cookies(&handle).await;
                migrate_to_accounts_layout(&handle).await;
                // Heal any duplicate account rows left by the old
                // email-based dedup before the UI reads the list.
                dedup_accounts_by_identity(&handle).await;
                cleanup_login_artifacts(&handle).await;
                start_stream_server(port, token, cache_dir, ephemeral_dir, cover_dir, ytdlp_bin)
                    .await;
            });
            // Subscribe to resume-from-sleep before the loop starts, so a
            // machine that wakes during startup is not missed.
            if let Err(e) = power::init() {
                eprintln!("[power] resume notifications unavailable: {e}");
            }
            let refresh_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Let migrations + the stream server settle, and give a
                // just-completed login time to persist its profile.
                tokio::time::sleep(Duration::from_secs(20)).await;
                run_refresh_loop(refresh_handle).await;
            });
            // Native media controls: SMTC on Windows, MPRIS on Linux, and Now
            // Playing on macOS. setup() runs on the main thread, as required by
            // the Windows and macOS backends.
            media::init(app.handle());
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] build failed: {e}");
            }

            // WebKitGTK disables smooth (kinetic) scrolling by default, so
            // wheel scrolling otherwise jumps in coarse steps on Linux.
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    let wv = webview.inner();
                    if let Some(settings) = WebViewExt::settings(&wv) {
                        settings.set_enable_smooth_scrolling(true);
                    }
                });
            }
            // Debug builds swap the taskbar/window icon to the orange
            // dev variant (see runtime_icon) so a dev instance is
            // instantly distinguishable from an installed release.
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_icon(runtime_icon(app.handle()));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // The native red button follows our close-to-menu-bar setting and
            // may hide the only window. A later Dock click emits Reopen; show
            // the window again so the running app never appears unresponsive.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::generate_stream_token;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[test]
    fn stream_token_is_nonempty_hex_and_varies() {
        let a = generate_stream_token();
        let b = generate_stream_token();
        assert_eq!(a.len(), 32, "token should be 128 bits of hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens in a row must differ");
    }

    // Guards the security fix (review high #1): the stream server nests all
    // routes under an unguessable per-launch token prefix, so a request that
    // doesn't carry the exact token can't reach a handler.
    #[test]
    fn nested_token_prefix_gates_routes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let token = "deadbeefdeadbeefdeadbeefdeadbeef";
            let inner = Router::new().route("/ping", get(|| async { "pong" }));
            let app: Router = Router::new().nest(&format!("/{token}"), inner);

            let status = |uri: &'static str, app: Router| async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
            };

            assert_eq!(
                status("/deadbeefdeadbeefdeadbeefdeadbeef/ping", app.clone()).await,
                StatusCode::OK,
                "correct token reaches the handler"
            );
            assert_eq!(
                status("/wrongtoken/ping", app.clone()).await,
                StatusCode::NOT_FOUND,
                "a wrong token must not reach the handler"
            );
            assert_eq!(
                status("/ping", app).await,
                StatusCode::NOT_FOUND,
                "no token must not reach the handler"
            );
        });
    }

    use super::{header_has_auth_cookie, merge_set_cookies_into_jar};

    const NOW: i64 = 1_700_000_000;
    const HOST: &str = "music.youtube.com";

    fn jar() -> String {
        "# Netscape HTTP Cookie File\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSAPISID\told-sapisid\n\
         .youtube.com\tTRUE\t/\tTRUE\t1800000000\tSIDCC\told-sidcc\n"
            .to_string()
    }

    #[test]
    fn merge_replaces_rotated_value() {
        let lines = vec![
            "SIDCC=new-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(m.value_changed && m.needs_write);
        assert!(m.jar.contains("SIDCC\tnew-sidcc"));
        assert!(!m.jar.contains("old-sidcc"));
        assert!(
            m.jar.contains("SAPISID\told-sapisid"),
            "untouched cookie survives"
        );
    }

    #[test]
    fn merge_inserts_new_cookie_with_domain() {
        let lines = vec![
            "LOGIN_INFO=abc; Domain=.youtube.com; Path=/; Secure; HttpOnly; Max-Age=63072000"
                .to_string(),
        ];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(m.value_changed);
        assert!(m
            .jar
            .contains(".youtube.com\tTRUE\t/\tTRUE\t1763072000\tLOGIN_INFO\tabc"));
    }

    #[test]
    fn merge_inserts_host_only_cookie_under_response_host() {
        let lines = vec!["PZS=1; Path=/; Secure; Max-Age=600".to_string()];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(m.value_changed);
        assert!(m.jar.contains(".music.youtube.com\tTRUE\t/\tTRUE"));
    }

    #[test]
    fn merge_removes_expired_cookie() {
        let lines = vec!["SIDCC=gone; Domain=.youtube.com; Path=/; Max-Age=0".to_string()];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(m.value_changed);
        assert!(!m.jar.contains("SIDCC"));
    }

    // A response must never be able to sign the user out. Google sends a
    // deletion burst for the identity cookies on a real sign-out, and
    // `captureSetCookies` runs before the `res.ok` bail, so a 4xx could
    // carry one too.
    #[test]
    fn merge_refuses_to_delete_identity_cookies() {
        let lines = vec![
            "SAPISID=EXPIRED; Domain=.youtube.com; Path=/; Max-Age=0".to_string(),
            "SIDCC=gone; Domain=.youtube.com; Path=/; Max-Age=0".to_string(),
        ];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(
            m.jar.contains("SAPISID\told-sapisid"),
            "identity cookie must survive a server expiry"
        );
        assert!(!m.jar.contains("SIDCC"), "rotation cookies stay deletable");
        assert_eq!(m.blocked_deletions, vec!["youtube.com SAPISID".to_string()]);
    }

    // RFC 6265 §5.3.5. Without the host check a music.youtube.com
    // response could plant a cookie on .google.com that we would then
    // replay to Google as if Google had issued it.
    #[test]
    fn merge_rejects_a_domain_the_response_host_is_not_under() {
        let lines =
            vec!["EVIL=1; Domain=.google.com; Path=/; Secure; Max-Age=1000".to_string()];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!m.value_changed && !m.needs_write);
        assert_eq!(m.jar, jar(), "jar must be untouched");
    }

    #[test]
    fn merge_ignores_foreign_domains() {
        let lines = vec![
            "tracker=1; Domain=.example.com; Path=/; Max-Age=1000".to_string(),
            "__cf_bm=x; Domain=.genius.com; Path=/; Max-Age=1000".to_string(),
        ];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        assert!(!m.value_changed && !m.needs_write);
        assert_eq!(m.jar, jar(), "jar must be untouched");
    }

    // `is_logged_in` used to substring-match, and `__Secure-1PSID` is a
    // prefix of both `__Secure-1PSIDTS` and `__Secure-1PSIDCC`, so a jar
    // that had lost the real SID still reported a live session.
    #[test]
    fn auth_check_ignores_prefix_lookalike_cookies() {
        assert!(!header_has_auth_cookie(
            "__Secure-1PSIDTS=a; __Secure-1PSIDCC=b; SIDCC=c"
        ));
    }

    #[test]
    fn auth_check_needs_both_an_apisid_and_a_sid() {
        assert!(!header_has_auth_cookie("SAPISID=a; SIDCC=b"));
        assert!(!header_has_auth_cookie("__Secure-1PSID=a; YSC=b"));
        assert!(header_has_auth_cookie("SAPISID=a; __Secure-1PSID=b"));
        assert!(header_has_auth_cookie("__Secure-3PAPISID=a; SID=b"));
    }

    #[test]
    fn auth_check_tolerates_spacing_and_empty_input() {
        assert!(header_has_auth_cookie("  SAPISID=a ;   SID=b  "));
        assert!(!header_has_auth_cookie(""));
    }

    #[test]
    fn merge_expiry_only_refresh_persists_without_cache_reset() {
        let lines = vec![
            "SIDCC=old-sidcc; Domain=.youtube.com; Path=/; Secure; Max-Age=31536000".to_string(),
        ];
        let m = merge_set_cookies_into_jar(&jar(), &lines, HOST, NOW);
        let (out, changed, dirty) = (m.jar, m.value_changed, m.needs_write);
        assert!(!changed, "same value must not invalidate the header cache");
        assert!(dirty, "but the fresher expiry should be written");
        assert!(out.contains(&format!("{}", NOW + 31_536_000)));
    }
}
