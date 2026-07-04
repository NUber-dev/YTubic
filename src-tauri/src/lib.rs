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

fn sanitize_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 32
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Platform-native symmetric "encrypt with current user's credentials"
/// primitive. On Windows we use DPAPI (CryptProtectData) — the blob is
/// only decryptable by the same Windows user on the same machine. On
/// other platforms we currently fall back to plaintext (FIXME: hook
/// into macOS Keychain / libsecret when we ship beyond Windows).
///
/// A fixed `ENTROPY` byte string is mixed in so a *different* app
/// running as the same user can't trivially pass our blob to
/// CryptUnprotectData and get our cookies out. This is a small hurdle
/// against generic credential-stealer malware, not a real boundary —
/// any attacker with our binary can read the entropy string.
mod secure_store {
    #[cfg(windows)]
    const ENTROPY: &[u8] = b"ytm-native/cookies.enc v1";

    #[cfg(windows)]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        use std::ptr;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CRYPT_INTEGER_BLOB,
        };
        use windows_sys::Win32::Foundation::LocalFree;
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
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
                    .to_vec();
            LocalFree(out_blob.pbData as _);
            Ok(data)
        }
    }

    #[cfg(windows)]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        use std::ptr;
        use windows_sys::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPT_INTEGER_BLOB,
        };
        use windows_sys::Win32::Foundation::LocalFree;
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
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
                    .to_vec();
            LocalFree(out_blob.pbData as _);
            Ok(data)
        }
    }

    #[cfg(not(windows))]
    pub fn encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }

    #[cfg(not(windows))]
    pub fn decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        Ok(encrypted.to_vec())
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
    #[serde(rename = "isActive")]
    is_active: bool,
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

/// Legacy single-account path — kept only for migration. New code
/// should resolve cookies via `active_cookies_path`.
fn legacy_cookies_enc_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("cookies.enc")
}

async fn read_index(app: &tauri::AppHandle) -> AccountsIndex {
    let path = accounts_index_path(app);
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return AccountsIndex::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

async fn write_index(app: &tauri::AppHandle, idx: &AccountsIndex) -> Result<(), String> {
    let path = accounts_index_path(app);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("mkdir accounts dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(idx).map_err(|e| format!("serialize: {e}"))?;
    tokio::fs::write(&path, bytes)
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
async fn read_cookies_plain(app: &tauri::AppHandle) -> Option<String> {
    let path = active_cookies_path(app).await?;
    let encrypted = tokio::fs::read(&path).await.ok()?;
    let plain = tokio::task::spawn_blocking(move || secure_store::decrypt(&encrypted))
        .await
        .ok()?
        .ok()?;
    String::from_utf8(plain).ok()
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
        let secure = if c.secure().unwrap_or(false) { "TRUE" } else { "FALSE" };
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
/// which is when we find out via the email lookup whether this is
/// genuinely a new account or a re-sign-in of an existing one. That
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

    // Fresh per-attempt WebView profile so Google's auth cookies are
    // empty at window open. Lives under app_cache_dir (transient by
    // nature) and gets cleaned up after the window closes.
    let session_id = generate_account_id();
    let webview_data = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("login-sessions")
        .join(&session_id);
    if let Err(e) = tokio::fs::create_dir_all(&webview_data).await {
        eprintln!("[login] mkdir webview-data: {e}");
    }

    let url = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F"
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;

    let win = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Sign in — accounts.google.com")
        .inner_size(500.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .data_directory(webview_data.clone())
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        )
        // Surface the current origin in the title so the user can spot
        // a redirect to an unexpected host (anti-phishing).
        .on_page_load(|win, payload| {
            let host = payload.url().host_str().unwrap_or("???");
            let _ = win.set_title(&format!("Sign in — {host}"));
        })
        .build()
        .map_err(|e| e.to_string())?;

    let app_poll = app.clone();
    let cleanup_dir = webview_data.clone();
    tauri::async_runtime::spawn(async move {
        // Set to true once we've redirected the webview to YT ourselves.
        // Guards against thrashing if YT auto-sign-in is slow and we
        // catch a Google-auth-only state on multiple ticks.
        let mut nudged_to_yt = false;
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
                        (name == "SAPISID"
                            || name == "SID"
                            || name == "__Secure-1PSID")
                            && c.domain()
                                .map(|d| {
                                    d.trim_start_matches('.').ends_with("google.com")
                                })
                                .unwrap_or(false)
                    });
                    if has_google_auth {
                        if let Ok(url) =
                            "https://music.youtube.com/".parse::<tauri::Url>()
                        {
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

            let new_id = generate_account_id();
            let cookies_path = account_cookies_path(&app_poll, &new_id);
            if let Some(dir) = cookies_path.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let plain = cookies_to_netscape(&cookies).into_bytes();
            let encrypted = match tokio::task::spawn_blocking(move || {
                secure_store::encrypt(&plain)
            })
            .await
            {
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
            if let Err(e) = tokio::fs::write(&cookies_path, &encrypted).await {
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
                let _ = tokio::fs::remove_dir_all(&account_cookies_path(&app_poll, &new_id)
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_default()).await;
                let _ = win.close();
                let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
                return;
            }

            // `login-success` is the soft signal: frontend invalidates
            // its auth queries so the meta backfill can fire with the
            // new cookies. The follow-up `update_account_meta` call
            // is where `accounts-changed` actually fires — that's the
            // single source of truth for "an account flipped" so we
            // never run the full reset twice for one login flow.
            let _ = app_poll.emit("login-success", &new_id);
            let _ = win.close();
            let _ = tokio::fs::remove_dir_all(&cleanup_dir).await;
            return;
        }
    });

    let _ = win;
    Ok(())
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
        let matches = host == domain
            || (include_sub && host.ends_with(&format!(".{domain}")));
        if !matches {
            continue;
        }
        parts.push(format!("{}={}", fields[5], fields[6]));
    }
    parts.join("; ")
}

#[tauri::command]
async fn get_cookie_header(
    app: tauri::AppHandle,
    host: String,
) -> Result<String, String> {
    Ok(read_cookie_header(&app, &host).await)
}

#[tauri::command]
async fn is_logged_in(app: tauri::AppHandle) -> Result<bool, String> {
    let header = read_cookie_header(&app, "music.youtube.com").await;
    Ok(header.contains("SAPISID") || header.contains("__Secure-1PSID"))
}

/// Hard-exit the process. The window's close button hides into the tray
/// (see `WindowEvent::CloseRequested` below); this command is the
/// frontend's equivalent of the tray's Quit menu item.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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
            let _ = existing.set_position(tauri::LogicalPosition::new(
                cx - 180.0,
                cy - 18.0,
            ));
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
    .title("ytm-native — player")
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
    .build()
    .map_err(|e| e.to_string())?;
    if let (Some(cx), Some(cy)) = (x, y) {
        // Override whatever the window-state plugin restored. Centering
        // horizontally on cursor with the 36px-tall title bar just
        // below puts the user's release point on top of the new card,
        // which feels like the window snapped to where they dropped.
        let _ = win.set_position(tauri::LogicalPosition::new(
            cx - 180.0,
            cy - 18.0,
        ));
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
            AccountSummary {
                id: a.id,
                email: a.email,
                name: a.name,
                photo_url: a.photo_url,
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
/// Dedup: if the supplied email matches a *different* account that
/// already exists, this is a re-login of an account we've seen
/// before. Replace the older account's cookies with the freshly-
/// captured ones, drop this account's just-created entry, and pin
/// the older id as active.
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
    let dup_pos = if !email.is_empty() {
        idx.accounts
            .iter()
            .position(|a| a.id != id && a.email == email)
    } else {
        None
    };

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
        let _ = tokio::fs::remove_dir_all(accounts_dir(&app).join(&id)).await;
        if let Some(this_pos) = idx.accounts.iter().position(|a| a.id == id) {
            idx.accounts.remove(this_pos);
        }
        if let Some(other) = idx.accounts.iter_mut().find(|a| a.id == other_id) {
            other.name = name;
            other.email = email;
            other.photo_url = photo_url;
        }
        if idx.active.as_deref() != Some(other_id.as_str()) {
            active_changed = true;
        }
        idx.active = Some(other_id);
    } else if let Some(acct) = idx.accounts.iter_mut().find(|a| a.id == id) {
        acct.name = name;
        acct.email = email;
        acct.photo_url = photo_url;
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

fn stream_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("stream")
}

#[derive(serde::Serialize)]
struct CacheEntry {
    #[serde(rename = "videoId")]
    video_id: String,
    size: u64,
    /// Seconds since unix epoch. Frontend formats for display.
    #[serde(rename = "modifiedSecs")]
    modified_secs: u64,
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
        let Ok(meta) = e.metadata().await else { continue };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(CacheEntry {
            video_id: video_id.to_string(),
            size: meta.len(),
            modified_secs,
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
        // "Clear all" — enumerate on the fly.
        let mut rd = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| format!("read_dir: {e}"))?;
        let mut out = Vec::new();
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Some(name) = e.file_name().to_str() {
                if let Some(id) = name.strip_suffix(".webm") {
                    if sanitize_video_id(id) {
                        out.push(id.to_string());
                    }
                }
            }
        }
        out
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
    }
    Ok(freed)
}

/// Run yt-dlp to resolve a videoId into metadata JSON.
#[tauri::command]
fn resolve_stream_ytdlp(video_id: String) -> Result<String, String> {
    if !sanitize_video_id(&video_id) {
        return Err(format!("invalid videoId: {video_id}"));
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut command = std::process::Command::new("yt-dlp");
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
    let output = command
        .output()
        .map_err(|e| format!("spawn yt-dlp: {e}"))?;
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
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("covers")
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
        t.clone().ok_or_else(|| "stream server not ready".to_string())?
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
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("read body: {e}"))?;
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
        let Ok(meta) = e.metadata().await else { continue };
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
        let Ok(meta) = e.metadata().await else { continue };
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
async fn get_stream_base_url(
    state: tauri::State<'_, StreamServerState>,
) -> Result<String, String> {
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

        let mut cmd = TokioCommand::new("yt-dlp");
        cmd.args([
            "-f",
            "bestaudio[ext=webm]/bestaudio",
            "--no-playlist",
            "--no-warnings",
            "--no-part",
            "-q",
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
        let mut child = match cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
        {
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
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if let Some(ref mut f) = file {
                        if let Err(e) = f.write_all(chunk).await {
                            eprintln!("[stream] write .part: {e}");
                            file = None;
                        }
                    }
                    state.notify.notify_waiters();
                }
                Err(e) => {
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

        // Evict from in-memory map after a grace period so a brief
        // re-play stays in RAM, then falls back to on-disk ServeFile.
        let downloads_evict = downloads.clone();
        let key = map_key.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            downloads_evict.lock().await.remove(&key);
        });
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
                return (StatusCode::GATEWAY_TIMEOUT, "download timeout")
                    .into_response();
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
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}"))
                .into_response()
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
            (StatusCode::INTERNAL_SERVER_ERROR, format!("serve: {e}"))
                .into_response()
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
    {
        let map = srv.downloads.lock().await;
        if map.contains_key(&map_key) {
            return StatusCode::ACCEPTED;
        }
    }
    let state = Arc::new(DownloadState {
        complete: Arc::new(AtomicBool::new(false)),
        notify: Arc::new(Notify::new()),
    });
    srv.downloads
        .lock()
        .await
        .insert(map_key.clone(), state.clone());
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

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show ytm-native", true, None::<&str>)?;
    let play_item = MenuItem::with_id(app, "play_pause", "Play / Pause", true, Some("Space"))?;
    let prev_item = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let next_item = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_item, &sep, &play_item, &prev_item, &next_item, &sep, &quit_item],
    )?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("ytm-native")
        .menu(&menu)
        .show_menu_on_left_click(false)
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
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            resolve_stream_ytdlp,
            get_stream_base_url,
            start_login,
            get_cookie_header,
            is_logged_in,
            clear_cookies,
            list_accounts,
            switch_account,
            remove_account,
            update_account_meta,
            get_active_account_id,
            list_cache,
            delete_cache_entries,
            cache_cover,
            cover_cache_stats,
            clear_cover_cache,
            quit_app,
            focus_main_window,
            open_player_window,
            close_player_window,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Close-to-tray: first close request hides the main
                    // window instead of exiting. Real quit is via the
                    // tray's Quit item.
                    "main" => {
                        let _ = window.hide();
                        api.prevent_close();
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
            let port = port_handle.clone();
            let token = token_handle.clone();
            let cache_root = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let cache_dir = cache_root.join("stream");
            let ephemeral_dir = cache_root.join("stream-ephemeral");
            let cover_dir = cache_root.join("covers");
            let handle = app.handle().clone();
            eprintln!("[stream-server] cache dir: {cache_dir:?}");
            eprintln!("[stream-server] ephemeral dir: {ephemeral_dir:?}");
            eprintln!("[stream-server] cover dir: {cover_dir:?}");
            tauri::async_runtime::spawn(async move {
                migrate_plaintext_cookies(&handle).await;
                migrate_to_accounts_layout(&handle).await;
                start_stream_server(port, token, cache_dir, ephemeral_dir, cover_dir).await;
            });
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[tray] build failed: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
