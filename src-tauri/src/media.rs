// OS media controls via `souvlaki`: on Windows this is the System Media
// Transport Controls (SMTC) — the media tile in the Quick Settings / volume
// flyout, the lock screen, and the hardware media keys. Linux maps to MPRIS;
// macOS maps to Now Playing / MPRemoteCommandCenter. souvlaki does not need a
// window handle on either platform, so `hwnd: None` is a real backend.
//
// Why we drive this from Rust instead of the webview's `navigator.mediaSession`:
// the audio plays in an `<audio>` element inside WebView2, so Chromium creates
// its OWN SMTC session — but that session is owned by the `msedgewebview2.exe`
// child process, whose app identity Windows can't resolve, so the tile shows
// "Unknown app" with no icon. There is no supported API to re-attribute a
// WebView2 media session to the host app (WebView2Feedback #2236, open since
// 2022). Creating the SMTC ourselves, bound to the host process's main window,
// makes Windows resolve the tile to YTubic's own executable identity (name +
// icon). Chromium's competing "Unknown app" tile is suppressed by disabling its
// media session via `--disable-features=...MediaSessionService` on the main
// window (see `additionalBrowserArgs` in tauri.conf.json).
//
// souvlaki's `MediaControls` is COM-backed on Windows: it is neither `Send` nor
// `Sync`, and its calls must run on the thread that owns the window (the main
// thread). So we keep it in a main-thread thread-local and only ever touch it
// from the main thread — the commands below marshal on via
// `AppHandle::run_on_main_thread`.
use std::cell::RefCell;
use std::time::Duration;

use serde::Deserialize;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

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
        let emit = |action: &str| {
            let _ = app_handle.emit("media-control", serde_json::json!({ "action": action }));
        };
        match event {
            MediaControlEvent::Play => emit("play"),
            MediaControlEvent::Pause => emit("pause"),
            MediaControlEvent::Toggle => emit("toggle"),
            MediaControlEvent::Next => emit("next"),
            MediaControlEvent::Previous => emit("previous"),
            MediaControlEvent::Stop => emit("stop"),
            MediaControlEvent::SetPosition(MediaPosition(d)) => {
                let _ = app_handle.emit(
                    "media-control",
                    serde_json::json!({ "action": "seek", "position": d.as_secs_f64() }),
                );
            }
            _ => {}
        }
    });
    if let Err(e) = attached {
        eprintln!("[media] failed to attach media controls: {e:?}");
        return;
    }

    CONTROLS.with(|c| *c.borrow_mut() = Some(controls));
}

/// Everything the frontend pushes about the current track. Passed as one
/// object so the command signature doesn't grow a tail of positional flags.
#[derive(Deserialize)]
pub struct NowPlaying {
    title: String,
    artist: String,
    album: String,
    thumbnail: String,
    duration: f64,
    elapsed: f64,
    paused: bool,
    /// The three toggle states are for the Windows thumbnail toolbar only;
    /// SMTC has no concept of them.
    shuffle: bool,
    /// "off" | "all" | "one".
    repeat: String,
    liked: bool,
}

/// Push the current track's metadata + playback state. Main-thread only.
fn apply(app: &AppHandle, now: NowPlaying) {
    let NowPlaying {
        title,
        artist,
        album,
        thumbnail: cover,
        duration,
        elapsed,
        paused,
        shuffle,
        repeat,
        liked,
    } = now;
    let playing = !paused;
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
                // The window title is what Windows prints above the taskbar
                // thumbnail preview (and in Alt+Tab), so it carries the track
                // like Apple Music's does instead of repeating the app name.
                set_window_title(
                    app,
                    &if artist.is_empty() {
                        title.clone()
                    } else {
                        format!("{title} - {artist}")
                    },
                );
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
    // Keep the taskbar thumbnail toolbar in sync. Cheap: it no-ops unless one
    // of the states actually changed.
    #[cfg(windows)]
    crate::thumbbar::set_state(
        playing,
        shuffle,
        crate::thumbbar::Repeat::from_str(&repeat),
        liked,
    );
    #[cfg(not(windows))]
    let _ = (shuffle, repeat, liked);
}

fn clear(app: &AppHandle) {
    LAST_META.with(|m| *m.borrow_mut() = None);
    set_window_title(app, "YTubic");
    #[cfg(windows)]
    crate::thumbbar::set_state(false, false, crate::thumbbar::Repeat::Off, false);
    CONTROLS.with(|cell| {
        if let Some(controls) = cell.borrow_mut().as_mut() {
            let _ = controls.set_playback(MediaPlayback::Stopped);
        }
    });
}

/// The main window only: the floating player keeps its own title.
fn set_window_title(app: &AppHandle, title: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(title);
    }
}

// ── Tauri commands (called from the frontend; marshalled onto the main thread) ──

/// Push the currently-playing track's metadata + playback state to the OS.
#[tauri::command]
pub fn media_update(app: AppHandle, now: NowPlaying) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply(&handle, now);
    });
}

/// Tell the OS nothing is playing (queue emptied / signed out).
#[tauri::command]
pub fn media_clear(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || clear(&handle));
}
