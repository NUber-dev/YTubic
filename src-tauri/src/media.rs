// OS media controls via `souvlaki` (the supported, no-permission path):
// - Windows: System Media Transport Controls (SMTC) — media tile, lock screen,
//   hardware media keys.
// - macOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter — Control Center /
//   lock screen / F7–F9 media keys. No Accessibility permission required.
//
// macOS also uses `navigator.mediaSession` in the webview (see
// `useAudioEngine`): once HTML <audio> is playing, WKWebView owns the Now
// Playing session for that media, so previous/next must be registered there
// for F7/F9 to reach us. That is still the official Media Session API —
// not a keylogger / event tap.
//
// We deliberately do NOT use CGEventTap / global NSEvent monitors for media
// keys. Those intercept HID events system-wide and trigger macOS
// Accessibility (or Input Monitoring) prompts. Spotify/Music/etc. never do
// that; they only register as the Now Playing target.
//
// Why we drive SMTC from Rust instead of the webview's `navigator.mediaSession`
// on Windows: the audio plays in an `<audio>` element inside WebView2, so
// Chromium creates its OWN SMTC session — but that session is owned by the
// `msedgewebview2.exe` child process, whose app identity Windows can't resolve,
// so the tile shows "Unknown app" with no icon. There is no supported API to
// re-attribute a WebView2 media session to the host app (WebView2Feedback
// #2236, open since 2022). Creating the SMTC ourselves, bound to the host
// process's main window, makes Windows resolve the tile to YTubic's own
// executable identity (name + icon). Chromium's competing "Unknown app" tile is
// suppressed by disabling its media session via
// `--disable-features=...MediaSessionService` on the main window (see
// `additionalBrowserArgs` in tauri.conf.json).
//
// souvlaki's `MediaControls` is COM-backed on Windows: it is neither `Send` nor
// `Sync`, and its calls must run on the thread that owns the window (the main
// thread). So we keep it in a main-thread thread-local and only ever touch it
// from the main thread — the commands below marshal on via
// `AppHandle::run_on_main_thread`.
use std::cell::RefCell;
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "windows")]
use tauri::Manager;

thread_local! {
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
    // Signature of the metadata last pushed to the OS. The frontend re-pushes
    // playback position every couple seconds to keep the SMTC scrubber accurate,
    // but on Windows `set_metadata` re-uploads the cover art to SMTC (COM work
    // on the UI thread) and janks a frame. Skip it when the metadata is
    // unchanged and only update the cheap playback state + position.
    static LAST_META: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Create the OS media controls and forward button presses to the frontend as
/// a `media-control` event. MUST be called on the main thread (from `setup()`),
/// where souvlaki requires to run and the main window's HWND is available.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    let hwnd: Option<*mut std::ffi::c_void> = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as *mut std::ffi::c_void);
    #[cfg(not(target_os = "windows"))]
    let hwnd: Option<*mut std::ffi::c_void> = None;

    let config = PlatformConfig {
        dbus_name: "ytubic",
        display_name: "YTubic",
        hwnd,
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[media] failed to create OS media controls: {e:?}");
            return;
        }
    };

    let app_handle = app.clone();
    let attached = controls.attach(move |event: MediaControlEvent| {
        emit_media_action(&app_handle, event);
    });
    if let Err(e) = attached {
        eprintln!("[media] failed to attach media controls: {e:?}");
        return;
    }

    CONTROLS.with(|c| *c.borrow_mut() = Some(controls));

    // souvlaki wires play/pause/previous/next. Also enable skip± so layouts
    // that surface F7/F9 as skip (not previousTrack) still reach us — still
    // via MPRemoteCommandCenter, no Accessibility.
    #[cfg(target_os = "macos")]
    macos::attach_extra_remote_commands(app.clone());
}

fn emit_media_action(app: &AppHandle, event: MediaControlEvent) {
    let emit = |action: &str| {
        let _ = app.emit("media-control", serde_json::json!({ "action": action }));
    };
    match event {
        MediaControlEvent::Play => emit("play"),
        MediaControlEvent::Pause => emit("pause"),
        MediaControlEvent::Toggle => emit("toggle"),
        MediaControlEvent::Next => emit("next"),
        MediaControlEvent::Previous => emit("previous"),
        MediaControlEvent::Stop => emit("stop"),
        MediaControlEvent::Seek(dir) => match dir {
            souvlaki::SeekDirection::Forward => emit("next"),
            souvlaki::SeekDirection::Backward => emit("previous"),
        },
        MediaControlEvent::SetPosition(MediaPosition(d)) => {
            let _ = app.emit(
                "media-control",
                serde_json::json!({ "action": "seek", "position": d.as_secs_f64() }),
            );
        }
        _ => {}
    }
}

fn emit_action(app: &AppHandle, action: &str) {
    let _ = app.emit("media-control", serde_json::json!({ "action": action }));
}

/// Push the current track's metadata + playback state. Main-thread only.
fn apply(
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration: f64,
    playing: bool,
    elapsed: f64,
) {
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            // Only re-push metadata (incl. the cover, the expensive part) when
            // it actually changed — the periodic position refresh otherwise
            // re-uploads the cover and janks a frame every couple seconds.
            let sig = format!("{title}\u{1}{artist}\u{1}{album}\u{1}{cover}\u{1}{duration}");
            let changed = LAST_META.with(|m| {
                let mut m = m.borrow_mut();
                if m.as_deref() == Some(sig.as_str()) {
                    false
                } else {
                    *m = Some(sig);
                    true
                }
            });
            if changed {
                let _ = controls.set_metadata(MediaMetadata {
                    title: Some(&title),
                    artist: Some(&artist),
                    album: if album.is_empty() { None } else { Some(&album) },
                    cover_url: if cover.is_empty() { None } else { Some(&cover) },
                    duration: if duration > 0.0 {
                        Some(Duration::from_secs_f64(duration))
                    } else {
                        None
                    },
                });
            }
            let progress = Some(MediaPosition(Duration::from_secs_f64(elapsed.max(0.0))));
            let _ = controls.set_playback(if playing {
                MediaPlayback::Playing { progress }
            } else {
                MediaPlayback::Paused { progress }
            });
        }
    });
}

fn clear() {
    LAST_META.with(|m| *m.borrow_mut() = None);
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            let _ = controls.set_playback(MediaPlayback::Stopped);
        }
    });
}

// ── Tauri commands (called from the frontend; marshalled onto the main thread) ──

/// Push the currently-playing track's metadata + playback state to the OS.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn media_update(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    thumbnail: String,
    duration: f64,
    elapsed: f64,
    paused: bool,
) {
    let _ = app.run_on_main_thread(move || {
        apply(title, artist, album, thumbnail, duration, !paused, elapsed);
    });
}

/// Tell the OS nothing is playing (queue emptied / signed out).
#[tauri::command]
pub fn media_clear(app: AppHandle) {
    let _ = app.run_on_main_thread(clear);
}

// ── macOS: extra MPRemoteCommandCenter handlers (still the public API) ──

#[cfg(target_os = "macos")]
mod macos {
    use super::emit_action;
    use block::ConcreteBlock;
    use cocoa::base::{id, nil, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::AppHandle;

    // MPRemoteCommandHandlerStatusSuccess
    const MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS: isize = 0;

    /// Register skip remote commands that souvlaki does not attach.
    /// On some macOS / keyboard layouts F7/F9 arrive as skip rather than
    /// previousTrack/nextTrack. Map them to previous/next (music-player
    /// semantics: restart current / next track). No Accessibility needed.
    pub fn attach_extra_remote_commands(app: AppHandle) {
        unsafe {
            let command_center: id = msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter];

            let attach = |cmd: id, action: &'static str| {
                if cmd == nil {
                    return;
                }
                let app = app.clone();
                let handler = ConcreteBlock::new(move |_event: id| -> isize {
                    emit_action(&app, action);
                    MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
                })
                .copy();
                let _: () = msg_send![cmd, setEnabled: YES];
                let _: () = msg_send![cmd, addTargetWithHandler: &*handler];
                // Leak: retained by the command center for process lifetime.
                std::mem::forget(handler);
            };

            let skip_back: id = msg_send![command_center, skipBackwardCommand];
            let skip_fwd: id = msg_send![command_center, skipForwardCommand];
            attach(skip_back, "previous");
            attach(skip_fwd, "next");
        }
        eprintln!("[media] macOS skip remote commands attached (→ prev/next)");
    }
}
