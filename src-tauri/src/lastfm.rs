// Last.fm scrobbling. Unlike Discord Rich Presence (a persistent local IPC
// socket, hence the worker thread in `discord.rs`), Last.fm is a stateless
// signed HTTP API, so each command is just an async request on Tauri's tokio
// runtime, so no worker and no reconnect loop.
//
// Two things Discord didn't need and that make up the bulk of this module:
//   * Per-user auth. The desktop web-auth flow: `auth.getToken` → open
//     last.fm/api/auth in the browser so the user approves → `auth.getSession`
//     exchanges the approved token for a session key that never expires. The
//     frontend holds the session key (in the settings store) and passes it back
//     on every call; we don't keep account state here.
//   * A persistent offline queue. A scrobble that can't reach Last.fm (offline,
//     server hiccup) is appended to `lastfm-queue.json` in the app config dir
//     and retried on the next successful scrobble and once at startup, so a
//     listening session survives a dropped connection.
//
// Every authed call is signed: md5 of the request params (sorted by key,
// concatenated as key+value with no separators) followed by the shared secret.
// `format` and `api_sig` themselves are excluded from the signature.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

// Last.fm API credentials, injected at build time so the shared secret never
// lives in source. `build.rs` reads YTUBIC_LASTFM_API_KEY / _SECRET from the
// environment (set as GitHub Actions secrets for release builds), falling back
// to a gitignored `src-tauri/lastfm_config.json` for local dev, and passes them
// through as the `option_env!` values below. When neither is set both are
// empty, the feature reports itself unconfigured, and the Settings UI shows it
// as unavailable rather than offering a Connect button that can't work. The API
// key is public (it ships in every client); the shared secret is only "secret"
// in the weak sense that any desktop app's is extractable from the binary.
const API_KEY: &str = match option_env!("YTUBIC_LASTFM_API_KEY") {
    Some(k) => k,
    None => "",
};
const API_SECRET: &str = match option_env!("YTUBIC_LASTFM_API_SECRET") {
    Some(s) => s,
    None => "",
};

const API_ROOT: &str = "https://ws.audioscrobbler.com/2.0/";

/// Managed Tauri state. Only a lock: it serializes the read-modify-write of the
/// on-disk offline queue so two scrobbles landing at once can't clobber the
/// file. The queue itself lives on disk (source of truth), not in memory. The
/// `Arc` lets the startup flush clone the lock out and drop the `State` guard
/// before awaiting (a `State` borrow can't be held across `.await`).
#[derive(Default, Clone)]
pub struct LastfmState {
    queue_lock: Arc<Mutex<()>>,
}

/// One scrobble waiting to be (re)sent. Carries its own `session_key` so the
/// startup flush needs no external account state and a reconnect as a different
/// user never mis-attributes a stranded scrobble.
#[derive(Serialize, Deserialize, Clone)]
struct PendingScrobble {
    artist: String,
    track: String,
    album: String,
    duration: Option<u32>,
    /// Unix seconds when the track started playing (per Last.fm's spec).
    timestamp: i64,
    session_key: String,
}

// ── Signing ──────────────────────────────────────────────────────────────

/// Compute a Last.fm `api_sig` over `params` with the given shared secret.
/// Caller passes only the params that participate in the signature (everything
/// except `format`/`api_sig`). `secret` is a parameter (rather than reading the
/// const directly) so the signing logic is testable without a configured build.
fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    // BTreeMap already iterates in ascending key (ASCII) order, exactly the
    // ordering Last.fm requires, so just concatenate key+value then the secret.
    let mut buf = String::new();
    for (k, v) in params {
        buf.push_str(k);
        buf.push_str(v);
    }
    buf.push_str(secret);
    format!("{:x}", md5::compute(buf.as_bytes()))
}

/// Attach `api_sig` (computed over the current params) plus `format=json`,
/// yielding the full param set to send. `params` must already hold every
/// signed param and nothing else.
fn finalize(mut params: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let sig = sign(&params, API_SECRET);
    params.insert("api_sig".into(), sig);
    params.insert("format".into(), "json".into());
    params
}

// ── Response shapes ──────────────────────────────────────────────────────

/// Last.fm returns HTTP 200 even for API-level failures, carrying `error`/
/// `message` in the JSON body, so every response is parsed through this.
#[derive(Deserialize)]
struct ApiError {
    error: u32,
    message: String,
}

/// Parse a response body: `Ok(())` when Last.fm reported no error, `Err(code,
/// message)` when it did. `code` lets callers tell a retryable service blip
/// (11/16/29) from a permanent rejection (bad session/signature/params).
fn check_api_error(body: &str) -> Result<(), (u32, String)> {
    match serde_json::from_str::<ApiError>(body) {
        Ok(e) => Err((e.error, e.message)),
        // No `error` field → success (or an unrelated shape we don't need).
        Err(_) => Ok(()),
    }
}

/// True for Last.fm error codes that are transient and worth re-queueing:
/// 11 = service offline, 16 = temporarily unavailable, 29 = rate limited.
fn is_transient(code: u32) -> bool {
    matches!(code, 11 | 16 | 29)
}

// ── Raw API calls ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginAuth {
    token: String,
    auth_url: String,
}

/// `auth.getToken` → an unauthorized request token, plus the browser URL the
/// user visits to approve it.
async fn get_token(client: &reqwest::Client) -> Result<String, String> {
    let mut params = BTreeMap::new();
    params.insert("method".into(), "auth.getToken".into());
    params.insert("api_key".into(), API_KEY.into());
    let params = finalize(params);

    let body = client
        .get(API_ROOT)
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read error: {e}"))?;

    check_api_error(&body).map_err(|(c, m)| format!("Last.fm error {c}: {m}"))?;

    #[derive(Deserialize)]
    struct TokenResp {
        token: String,
    }
    serde_json::from_str::<TokenResp>(&body)
        .map(|t| t.token)
        .map_err(|e| format!("unexpected getToken response: {e}"))
}

#[derive(Serialize)]
pub struct LastfmSession {
    name: String,
    key: String,
}

/// `auth.getSession` → exchange an approved token for a permanent session key.
/// Returns `Ok(Some(..))` once the user has approved the token in their browser,
/// `Ok(None)` while it is still pending approval (Last.fm error 14, which is not
/// a failure), and `Err` for a real problem (expired token, bad key, network).
/// The frontend polls this so connecting needs no manual confirmation step.
async fn get_session(
    client: &reqwest::Client,
    token: &str,
) -> Result<Option<LastfmSession>, String> {
    let mut params = BTreeMap::new();
    params.insert("method".into(), "auth.getSession".into());
    params.insert("api_key".into(), API_KEY.into());
    params.insert("token".into(), token.into());
    let params = finalize(params);

    let body = client
        .get(API_ROOT)
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read error: {e}"))?;

    match check_api_error(&body) {
        // 14 = token not yet authorized by the user: keep polling, not an error.
        Err((14, _)) => return Ok(None),
        Err((c, m)) => return Err(format!("Last.fm error {c}: {m}")),
        Ok(()) => {}
    }

    #[derive(Deserialize)]
    struct SessionResp {
        session: SessionInner,
    }
    #[derive(Deserialize)]
    struct SessionInner {
        name: String,
        key: String,
    }
    serde_json::from_str::<SessionResp>(&body)
        .map(|r| {
            Some(LastfmSession {
                name: r.session.name,
                key: r.session.key,
            })
        })
        .map_err(|e| format!("unexpected getSession response: {e}"))
}

/// Outcome of a POST to Last.fm, used to decide the offline queue's fate.
enum SendOutcome {
    Sent,
    /// Transport failure or a transient server error: keep for retry.
    Retry,
    /// Last.fm rejected it permanently (bad session/signature); dropping it is
    /// the only way to stop the queue growing forever. `String` is for logging.
    Drop(String),
}

/// POST a signed method to Last.fm and classify the outcome.
async fn post_signed(client: &reqwest::Client, params: BTreeMap<String, String>) -> SendOutcome {
    let params = finalize(params);
    let resp = match client.post(API_ROOT).form(&params).send().await {
        Ok(r) => r,
        Err(_) => return SendOutcome::Retry, // offline / DNS / TLS, retry later
    };
    if resp.status().is_server_error() {
        return SendOutcome::Retry;
    }
    let body = match resp.text().await {
        Ok(b) => b,
        Err(_) => return SendOutcome::Retry,
    };
    match check_api_error(&body) {
        Ok(()) => SendOutcome::Sent,
        Err((code, msg)) if is_transient(code) => {
            let _ = msg;
            SendOutcome::Retry
        }
        Err((code, msg)) => SendOutcome::Drop(format!("Last.fm error {code}: {msg}")),
    }
}

// ── Offline queue persistence ────────────────────────────────────────────

fn queue_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    Ok(dir.join("lastfm-queue.json"))
}

fn read_queue(app: &AppHandle) -> Vec<PendingScrobble> {
    let Ok(path) = queue_path(app) else {
        return Vec::new();
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(), // no file yet
    }
}

fn write_queue(app: &AppHandle, queue: &[PendingScrobble]) {
    let Ok(path) = queue_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if queue.is_empty() {
        // Nothing pending, so remove the file rather than leave an empty array.
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Ok(json) = serde_json::to_string(queue) {
        let _ = std::fs::write(&path, json);
    }
}

/// Build the bracketed `track.scrobble` params for a batch (≤50) that all share
/// one session key.
fn scrobble_batch_params(items: &[PendingScrobble], session_key: &str) -> BTreeMap<String, String> {
    let mut params = BTreeMap::new();
    params.insert("method".into(), "track.scrobble".into());
    params.insert("api_key".into(), API_KEY.into());
    params.insert("sk".into(), session_key.into());
    for (i, it) in items.iter().enumerate() {
        params.insert(format!("artist[{i}]"), it.artist.clone());
        params.insert(format!("track[{i}]"), it.track.clone());
        params.insert(format!("timestamp[{i}]"), it.timestamp.to_string());
        if !it.album.is_empty() {
            params.insert(format!("album[{i}]"), it.album.clone());
        }
        if let Some(d) = it.duration {
            params.insert(format!("duration[{i}]"), d.to_string());
        }
    }
    params
}

/// Try to drain the on-disk queue. Groups by session key (a scrobble batch
/// carries a single `sk`), sends each group, and rewrites the file with only
/// the items that still need retrying. Best-effort: any error just leaves the
/// affected items queued (or drops the permanently-rejected ones).
async fn flush_queue(app: &AppHandle, client: &reqwest::Client, lock: &Mutex<()>) {
    let _guard = lock.lock().await;
    let queue = read_queue(app);
    if queue.is_empty() {
        return;
    }

    // Preserve order within each session-key group.
    let mut groups: BTreeMap<String, Vec<PendingScrobble>> = BTreeMap::new();
    for item in queue {
        groups
            .entry(item.session_key.clone())
            .or_default()
            .push(item);
    }

    let mut remaining: Vec<PendingScrobble> = Vec::new();
    for (sk, items) in groups {
        // Last.fm caps a scrobble batch at 50.
        for chunk in items.chunks(50) {
            let params = scrobble_batch_params(chunk, &sk);
            match post_signed(client, params).await {
                SendOutcome::Sent => {}
                SendOutcome::Retry => remaining.extend_from_slice(chunk),
                SendOutcome::Drop(msg) => {
                    eprintln!("[lastfm] dropping {} scrobble(s): {msg}", chunk.len());
                }
            }
        }
    }
    write_queue(app, &remaining);
}

// ── Tauri commands ───────────────────────────────────────────────────────

/// Whether this build has API credentials baked in. The Settings UI uses it to
/// decide between a working Connect button and an "unavailable" note.
#[tauri::command]
pub fn lastfm_is_configured() -> bool {
    !API_KEY.is_empty() && !API_SECRET.is_empty()
}

/// Step 1 of connecting: fetch a request token and hand back the browser URL
/// the user must open to approve it.
#[tauri::command]
pub async fn lastfm_begin_auth() -> Result<BeginAuth, String> {
    if API_KEY.is_empty() || API_SECRET.is_empty() {
        return Err("Last.fm API credentials are not configured in this build.".into());
    }
    let client = reqwest::Client::new();
    let token = get_token(&client).await?;
    let auth_url = format!(
        "https://www.last.fm/api/auth/?api_key={}&token={}",
        API_KEY, token
    );
    Ok(BeginAuth { token, auth_url })
}

/// Step 2 of connecting, polled on a timer by the frontend: returns the account
/// once the user has approved the token in their browser, or `None` while it is
/// still pending.
#[tauri::command]
pub async fn lastfm_poll_session(token: String) -> Result<Option<LastfmSession>, String> {
    let client = reqwest::Client::new();
    get_session(&client, &token).await
}

/// Public profile info for a Last.fm user, used to show an avatar + name in
/// Settings. `user.getInfo` is a public method (api_key only, no signing or
/// session), so this stays unsigned.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastfmUserInfo {
    name: String,
    realname: String,
    url: String,
    image: String,
}

#[tauri::command]
pub async fn lastfm_user_info(user: String) -> Result<LastfmUserInfo, String> {
    if API_KEY.is_empty() {
        return Err("Last.fm API credentials are not configured in this build.".into());
    }
    let client = reqwest::Client::new();
    let mut params = BTreeMap::new();
    params.insert("method".to_string(), "user.getInfo".to_string());
    params.insert("api_key".to_string(), API_KEY.to_string());
    params.insert("user".to_string(), user);
    params.insert("format".to_string(), "json".to_string());

    let body = client
        .get(API_ROOT)
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read error: {e}"))?;

    check_api_error(&body).map_err(|(c, m)| format!("Last.fm error {c}: {m}"))?;

    #[derive(Deserialize)]
    struct Resp {
        user: UserInner,
    }
    #[derive(Deserialize)]
    struct UserInner {
        name: String,
        #[serde(default)]
        realname: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        image: Vec<UserImage>,
    }
    #[derive(Deserialize)]
    struct UserImage {
        #[serde(rename = "#text", default)]
        text: String,
    }

    let resp: Resp =
        serde_json::from_str(&body).map_err(|e| format!("unexpected getInfo response: {e}"))?;
    // Last.fm lists images small→extralarge; take the last non-empty (largest).
    let image = resp
        .user
        .image
        .iter()
        .rev()
        .find(|i| !i.text.is_empty())
        .map(|i| i.text.clone())
        .unwrap_or_default();
    Ok(LastfmUserInfo {
        name: resp.user.name,
        realname: resp.user.realname,
        url: resp.user.url,
        image,
    })
}

/// Tell Last.fm what's playing right now. Fire-and-forget: now-playing is
/// ephemeral (Last.fm expires it on its own), so a failure is never queued.
#[tauri::command]
pub async fn lastfm_update_now_playing(
    artist: String,
    track: String,
    album: String,
    duration: Option<u32>,
    session_key: String,
) -> Result<(), String> {
    if artist.is_empty() || track.is_empty() {
        return Ok(()); // nothing meaningful to report
    }
    let client = reqwest::Client::new();
    let mut params = BTreeMap::new();
    params.insert("method".into(), "track.updateNowPlaying".into());
    params.insert("api_key".into(), API_KEY.into());
    params.insert("sk".into(), session_key);
    params.insert("artist".into(), artist);
    params.insert("track".into(), track);
    if !album.is_empty() {
        params.insert("album".into(), album);
    }
    if let Some(d) = duration {
        params.insert("duration".into(), d.to_string());
    }
    // Best-effort; the classification doesn't matter for now-playing.
    let _ = post_signed(&client, params).await;
    Ok(())
}

/// Scrobble a completed listen. Tries to send immediately; a transport/transient
/// failure parks it in the offline queue instead of losing it, and a success
/// opportunistically drains anything already queued.
#[tauri::command]
pub async fn lastfm_scrobble(
    app: AppHandle,
    state: State<'_, LastfmState>,
    artist: String,
    track: String,
    album: String,
    duration: Option<u32>,
    timestamp: i64,
    session_key: String,
) -> Result<(), String> {
    if artist.is_empty() || track.is_empty() {
        return Ok(());
    }
    let client = reqwest::Client::new();
    let scrobble = PendingScrobble {
        artist,
        track,
        album,
        duration,
        timestamp,
        session_key: session_key.clone(),
    };

    let params = scrobble_batch_params(std::slice::from_ref(&scrobble), &session_key);
    match post_signed(&client, params).await {
        SendOutcome::Sent => {
            // Sent live, so a good moment to drain any backlog from an earlier
            // offline stretch.
            flush_queue(&app, &client, &state.queue_lock).await;
        }
        SendOutcome::Retry => {
            // Hold the queue lock across the read-modify-write so a concurrent
            // scrobble or flush can't clobber the file.
            let _guard = state.queue_lock.lock().await;
            let mut queue = read_queue(&app);
            queue.push(scrobble);
            write_queue(&app, &queue);
        }
        SendOutcome::Drop(msg) => {
            eprintln!("[lastfm] scrobble rejected, dropping: {msg}");
        }
    }
    Ok(())
}

/// Mirror a YouTube Music like/unlike to Last.fm as a loved / unloved track.
/// `loved` picks track.love vs track.unlove. Best-effort like now-playing: love
/// state isn't time-critical and isn't queued for retry (unlike scrobbles).
#[tauri::command]
pub async fn lastfm_love(
    artist: String,
    track: String,
    loved: bool,
    session_key: String,
) -> Result<(), String> {
    if artist.is_empty() || track.is_empty() {
        return Ok(());
    }
    let client = reqwest::Client::new();
    let mut params = BTreeMap::new();
    params.insert(
        "method".into(),
        if loved { "track.love" } else { "track.unlove" }.into(),
    );
    params.insert("api_key".into(), API_KEY.into());
    params.insert("sk".into(), session_key);
    params.insert("artist".into(), artist);
    params.insert("track".into(), track);
    let _ = post_signed(&client, params).await;
    Ok(())
}

/// Retry the offline queue. Called once at startup and whenever the frontend
/// wants to nudge a drain (e.g. after regaining connectivity). No-op when the
/// queue is empty.
#[tauri::command]
pub async fn lastfm_flush(app: AppHandle, state: State<'_, LastfmState>) -> Result<(), String> {
    let client = reqwest::Client::new();
    flush_queue(&app, &client, &state.queue_lock).await;
    Ok(())
}

/// Fire a one-shot queue drain at launch, retrying any scrobbles stranded by an
/// offline shutdown. Clones the lock out of managed state so the `State` guard
/// isn't held across the `.await`, then spawns onto the async runtime; never
/// blocks startup.
pub fn flush_on_startup(app: AppHandle) {
    if API_KEY.is_empty() || API_SECRET.is_empty() {
        return;
    }
    let lock = app.state::<LastfmState>().queue_lock.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        flush_queue(&app, &client, &lock).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_concatenates_sorted_key_values_then_secret() {
        // api_sig = md5 of each key+value in ascending key order, then the
        // shared secret. Expected hash computed independently (Node crypto):
        // md5("a1" + "b2" + "methodtest") with an empty secret.
        let mut a = BTreeMap::new();
        a.insert("method".to_string(), "test".to_string());
        a.insert("a".to_string(), "1".to_string());
        a.insert("b".to_string(), "2".to_string());
        assert_eq!(sign(&a, ""), "c20b52cc2af6d145fa9d9895f705aaa5");

        // Insertion order must not matter (BTreeMap sorts by key).
        let mut b = BTreeMap::new();
        b.insert("b".to_string(), "2".to_string());
        b.insert("method".to_string(), "test".to_string());
        b.insert("a".to_string(), "1".to_string());
        assert_eq!(sign(&a, ""), sign(&b, ""));

        // The secret is part of the signature, so it changes the result.
        assert_ne!(sign(&a, ""), sign(&a, "secret"));
    }

    #[test]
    fn finalize_signs_only_the_original_params() {
        let mut params = BTreeMap::new();
        params.insert("a".to_string(), "1".to_string());
        params.insert("b".to_string(), "2".to_string());
        // Signature the request must carry: computed before format/api_sig exist.
        let expected_sig = sign(&params, API_SECRET);
        let out = finalize(params);
        assert_eq!(out.get("format").map(String::as_str), Some("json"));
        assert_eq!(
            out.get("api_sig").map(String::as_str),
            Some(expected_sig.as_str()),
            "finalize must sign the params as they were before format/api_sig were added",
        );
    }

    #[test]
    fn check_api_error_distinguishes_success_from_error() {
        let err = r#"{"error":9,"message":"Invalid session key"}"#;
        match check_api_error(err) {
            Err((code, _)) => assert_eq!(code, 9),
            Ok(()) => panic!("expected an API error"),
        }
        // No `error` field is success.
        let ok = r#"{"scrobbles":{"@attr":{"accepted":1,"ignored":0}}}"#;
        assert!(check_api_error(ok).is_ok());
    }

    #[test]
    fn only_service_codes_are_retryable() {
        assert!(is_transient(11)); // service offline
        assert!(is_transient(16)); // temporarily unavailable
        assert!(is_transient(29)); // rate limited
        assert!(!is_transient(9)); // invalid session: permanent
        assert!(!is_transient(6)); // invalid parameters: permanent
    }

    #[test]
    fn scrobble_batch_uses_bracketed_indices() {
        let items = vec![
            PendingScrobble {
                artist: "A".into(),
                track: "T".into(),
                album: "Al".into(),
                duration: Some(180),
                timestamp: 1000,
                session_key: "sk".into(),
            },
            PendingScrobble {
                artist: "B".into(),
                track: "U".into(),
                album: String::new(),
                duration: None,
                timestamp: 2000,
                session_key: "sk".into(),
            },
        ];
        let p = scrobble_batch_params(&items, "sk");
        assert_eq!(p.get("method").map(String::as_str), Some("track.scrobble"));
        assert_eq!(p.get("sk").map(String::as_str), Some("sk"));
        assert_eq!(p.get("artist[0]").map(String::as_str), Some("A"));
        assert_eq!(p.get("track[0]").map(String::as_str), Some("T"));
        assert_eq!(p.get("timestamp[0]").map(String::as_str), Some("1000"));
        assert_eq!(p.get("duration[0]").map(String::as_str), Some("180"));
        assert_eq!(p.get("artist[1]").map(String::as_str), Some("B"));
        // Empty album / missing duration are omitted, not sent blank.
        assert!(!p.contains_key("album[1]"));
        assert!(!p.contains_key("duration[1]"));
    }
}
