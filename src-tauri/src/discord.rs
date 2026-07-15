// Discord Rich Presence: shows the current track on the user's Discord
// profile as "Listening to YTubic" with the cover art and a live progress
// bar. Opt-in (Settings → General); off by default for privacy.
//
// Unlike the SMTC controls in `media.rs`, the Discord IPC client is a plain
// socket/named-pipe with no COM/main-thread constraint, so we don't marshal
// onto the UI thread. Instead everything runs on a dedicated worker thread
// that owns the client and handles the messy parts Discord forces on us:
//   * Discord may be closed, launched later, or quit mid-session — the worker
//     lazily (re)connects and retries on a 15s tick, never blocking the app.
//   * Discord rate-limits activity updates, so the frontend only pushes on
//     track / play-state change (not the 2s SMTC position refresh), and the
//     worker additionally dedupes identical presences.
// Commands just drop a message on a channel; the caller never blocks.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use tauri::State;

// Discord Application ID. Create an application named "YTubic" at
// https://discord.com/developers/applications — the name is exactly what
// Discord renders after "Listening to". Then either set the env var at build
// time (`YTUBIC_DISCORD_APP_ID=...`) or replace the "" default below with the
// Application ID string. While this is empty the worker simply never connects,
// so the feature is a no-op until a real ID is provided.
const APP_ID: &str = match option_env!("YTUBIC_DISCORD_APP_ID") {
    Some(id) => id,
    // Public "YTubic" application ID (client IDs are not secret — they ship in
    // every client that renders the presence). Overridable via the env var.
    None => "1525085261418074152",
};

// Small logo badge shown in the corner of the cover art. Discord can't read a
// file bundled inside the app — a presence image must be either uploaded to the
// Dev Portal (referenced by an asset key) or a public URL Discord can proxy
// server-side. So we reuse our own app icon straight from the public repo,
// which means nothing to upload and no Dev Portal art assets to maintain.
const LOGO_URL: &str =
    "https://raw.githubusercontent.com/NUber-dev/YTubic/main/src-tauri/icons/icon.png";

/// A track's presence as the frontend sees it. `start_ms`/`end_ms` are Unix
/// milliseconds (per Discord's Activity spec) and are `None` while paused, so
/// Discord shows no progress bar rather than a wrong one.
struct Presence {
    title: String,
    artist: String,
    album: String,
    image_url: String,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
}

impl Presence {
    /// Dedup key for skipping redundant IPC writes. Deliberately excludes the
    /// exact timestamps (they drift a little on every push); `start_ms.is_some()`
    /// still distinguishes the playing state (has a bar) from paused (no bar).
    fn signature(&self) -> String {
        format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
            self.title,
            self.artist,
            self.album,
            self.image_url,
            self.start_ms.is_some(),
        )
    }
}

enum Msg {
    Update(Presence),
    Clear,
    SetEnabled(bool),
}

/// Managed Tauri state: the sending half of the worker's channel. Wrapped in a
/// `Mutex` only to satisfy `Sync` (std's `Sender` isn't) — contention is nil.
pub struct DiscordHandle(Mutex<Sender<Msg>>);

impl DiscordHandle {
    fn send(&self, msg: Msg) {
        // The worker holds the receiver for the whole app lifetime; a send
        // only fails while the process is tearing down, which we can ignore.
        if let Ok(tx) = self.0.lock() {
            let _ = tx.send(msg);
        }
    }
}

/// Start the worker thread and return the handle to `.manage()`. The thread
/// idles on the channel until the first message arrives.
pub fn spawn() -> DiscordHandle {
    let (tx, rx) = mpsc::channel::<Msg>();
    std::thread::Builder::new()
        .name("discord-rpc".into())
        .spawn(move || worker(rx))
        .expect("failed to spawn discord-rpc thread");
    DiscordHandle(Mutex::new(tx))
}

fn connect() -> Option<DiscordIpcClient> {
    if APP_ID.is_empty() {
        return None;
    }
    let mut client = DiscordIpcClient::new(APP_ID).ok()?;
    client.connect().ok()?;
    Some(client)
}

fn push(client: &mut DiscordIpcClient, p: &Presence) -> Result<(), Box<dyn std::error::Error>> {
    let mut assets = Assets::new();
    if !p.image_url.is_empty() {
        // Cover art big, app logo as the small corner badge (Spotify-style).
        assets = assets
            .large_image(&p.image_url)
            .small_image(LOGO_URL)
            .small_text("YTubic");
        if !p.album.is_empty() {
            assets = assets.large_text(&p.album);
        }
    } else {
        // No cover art for this track — show the logo as the big image instead
        // so the presence never renders empty.
        assets = assets.large_image(LOGO_URL).large_text("YTubic");
    }

    let mut activity = Activity::new()
        .details(&p.title)
        .state(&p.artist)
        .activity_type(ActivityType::Listening)
        .assets(assets);

    if let (Some(start), Some(end)) = (p.start_ms, p.end_ms) {
        activity = activity.timestamps(Timestamps::new().start(start).end(end));
    }

    client.set_activity(activity)
}

// Discord rate-limits presence updates (roughly 5 per 20s) and silently drops
// the overflow. So we (a) coalesce bursts — never push more often than
// MIN_PUSH_INTERVAL, always sending the latest desired state — and (b) re-assert
// the current track every REASSERT_INTERVAL, which self-heals a stale card if an
// update ever got dropped. The short TICK wakes the loop to do both on time and
// to retry a connect to a Discord that was down.
const TICK: Duration = Duration::from_secs(2);
const MIN_PUSH_INTERVAL: Duration = Duration::from_secs(4);
const REASSERT_INTERVAL: Duration = Duration::from_secs(20);

fn worker(rx: Receiver<Msg>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut enabled = false;
    let mut desired: Option<Presence> = None;
    let mut last_sig: Option<String> = None;
    let mut last_push_at: Option<Instant> = None;

    loop {
        // Wake at least every TICK so a coalesced update or a re-assert fires on
        // time even without a new message (and a down Discord gets retried).
        let msg = match rx.recv_timeout(TICK) {
            Ok(m) => Some(m),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return, // app exiting
        };

        match msg {
            Some(Msg::SetEnabled(false)) => {
                if let Some(mut c) = client.take() {
                    let _ = c.clear_activity();
                    let _ = c.close();
                }
                enabled = false;
                desired = None;
                last_sig = None;
                last_push_at = None;
                continue;
            }
            Some(Msg::SetEnabled(true)) => {
                enabled = true;
                // Fall through to (re)connect and push any desired state.
            }
            Some(Msg::Clear) => {
                desired = None;
                last_sig = None;
                last_push_at = None;
                if let Some(c) = client.as_mut() {
                    let _ = c.clear_activity();
                }
                continue;
            }
            Some(Msg::Update(p)) => {
                desired = Some(p);
                // Fall through to push.
            }
            None => {
                // Timeout tick: retry a pending connect/push below.
            }
        }

        if !enabled {
            continue;
        }
        let Some(p) = desired.as_ref() else {
            continue;
        };

        if client.is_none() {
            client = connect();
            if client.is_none() {
                continue; // Discord not up yet — retry on the next tick.
            }
            last_sig = None; // Force a push right after (re)connecting.
            last_push_at = None;
        }

        let sig = p.signature();
        let now = Instant::now();
        let changed = last_sig.as_deref() != Some(sig.as_str());
        let due_reassert =
            last_push_at.map_or(true, |t| now.duration_since(t) >= REASSERT_INTERVAL);

        // Nothing to do until the track changes or it's time to re-assert the
        // current one (to recover from an update Discord may have dropped).
        if !changed && !due_reassert {
            continue;
        }

        // Hold under the rate limit: a change arriving too soon isn't lost — it
        // stays in `desired` and the next tick pushes the latest value once the
        // window opens, so a burst for one track collapses to a single push.
        if let Some(t) = last_push_at {
            if now.duration_since(t) < MIN_PUSH_INTERVAL {
                continue;
            }
        }

        if let Some(c) = client.as_mut() {
            match push(c, p) {
                Ok(()) => {
                    last_sig = Some(sig);
                    last_push_at = Some(now);
                }
                Err(_) => {
                    // The pipe broke (Discord quit) — drop the client so the
                    // next tick reconnects instead of writing into the void.
                    let _ = c.close();
                    client = None;
                    last_sig = None;
                    last_push_at = None;
                }
            }
        }
    }
}

// ── Tauri commands (called from the audio engine + the settings sync hook) ──

/// Push the currently-playing track to Discord.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn discord_update(
    handle: State<'_, DiscordHandle>,
    title: String,
    artist: String,
    album: String,
    image_url: String,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) {
    handle.send(Msg::Update(Presence {
        title,
        artist,
        album,
        image_url,
        start_ms,
        end_ms,
    }));
}

/// Clear the activity (queue emptied / signed out) but stay connected.
#[tauri::command]
pub fn discord_clear(handle: State<'_, DiscordHandle>) {
    handle.send(Msg::Clear);
}

/// Enable/disable from the Settings toggle. Disabling clears the activity and
/// disconnects; enabling lets the next `discord_update` populate it.
#[tauri::command]
pub fn discord_set_enabled(handle: State<'_, DiscordHandle>, enabled: bool) {
    handle.send(Msg::SetEnabled(enabled));
}
