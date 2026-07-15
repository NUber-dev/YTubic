//! macOS system Now Playing integration.
//!
//! A Tauri WKWebView does not bridge the JS MediaSession API to macOS's
//! system Now Playing the way WebView2 does for Windows SMTC, so the OS
//! shows "Not Playing" no matter what the web layer sets. We drive
//! MediaPlayer.framework directly instead: push metadata into
//! MPNowPlayingInfoCenter, and route MPRemoteCommandCenter presses
//! (Control Center, the Touch Bar, media keys, AirPods) back to the
//! frontend playback store as Tauri events.
//!
//! Everything here is a no-op off macOS.
//!
//! Artwork is deliberately left out for now: the only artwork API this
//! objc2-media-player build exposes is `initWithBoundsSize:requestHandler:`,
//! whose block must return a raw image pointer with an ownership
//! convention we can't validate without running on-device, and a wrong
//! guess risks a crash when Control Center renders the art. Text, times,
//! and the transport commands (the actual "Not Playing" fix) all work
//! without it.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Total length in seconds (0 when not yet known).
    pub duration: f64,
    /// Current playhead in seconds.
    pub elapsed: f64,
    /// 1.0 while playing, 0.0 while paused. Doubles as the play state.
    pub playback_rate: f64,
}

#[cfg(target_os = "macos")]
pub use imp::{apply, init};

#[cfg(not(target_os = "macos"))]
pub fn apply(_info: &NowPlayingInfo) {}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod imp {
    use super::NowPlayingInfo;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_foundation::{NSDictionary, NSMutableDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPChangePlaybackPositionCommandEvent, MPMediaItemPropertyAlbumTitle,
        MPMediaItemPropertyArtist, MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle,
        MPNowPlayingInfoCenter, MPNowPlayingInfoPropertyElapsedPlaybackTime,
        MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
        MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
    };
    use tauri::Emitter;

    /// Replace the whole nowPlayingInfo dictionary and the play state.
    /// Cheap enough to send on every track / play-pause / seek change.
    pub fn apply(info: &NowPlayingInfo) {
        unsafe {
            let center = MPNowPlayingInfoCenter::defaultCenter();
            let dict: Retained<NSMutableDictionary<NSString, AnyObject>> =
                NSMutableDictionary::new();

            put_string(&dict, MPMediaItemPropertyTitle, &info.title);
            put_string(&dict, MPMediaItemPropertyArtist, &info.artist);
            if !info.album.is_empty() {
                put_string(&dict, MPMediaItemPropertyAlbumTitle, &info.album);
            }
            if info.duration > 0.0 {
                put_number(
                    &dict,
                    MPMediaItemPropertyPlaybackDuration,
                    &NSNumber::new_f64(info.duration),
                );
            }
            put_number(
                &dict,
                MPNowPlayingInfoPropertyElapsedPlaybackTime,
                &NSNumber::new_f64(info.elapsed),
            );
            put_number(
                &dict,
                MPNowPlayingInfoPropertyPlaybackRate,
                &NSNumber::new_f64(info.playback_rate),
            );

            let as_dict: &NSDictionary<NSString, AnyObject> = &dict;
            center.setNowPlayingInfo(Some(as_dict));
            center.setPlaybackState(if info.playback_rate > 0.0 {
                MPNowPlayingPlaybackState::Playing
            } else {
                MPNowPlayingPlaybackState::Paused
            });
        }
    }

    unsafe fn put_string(
        dict: &NSMutableDictionary<NSString, AnyObject>,
        key: &NSString,
        value: &str,
    ) {
        let val = NSString::from_str(value);
        let _: () = msg_send![dict, setObject: &*val, forKey: key];
    }

    unsafe fn put_number(
        dict: &NSMutableDictionary<NSString, AnyObject>,
        key: &NSString,
        value: &NSNumber,
    ) {
        let _: () = msg_send![dict, setObject: value, forKey: key];
    }

    /// Register the remote-command handlers once, at startup. Each press
    /// emits a Tauri event the frontend playback store listens for, so
    /// the OS transport drives the same store as the in-app buttons.
    pub fn init(app: &tauri::AppHandle) {
        unsafe {
            let center = MPRemoteCommandCenter::sharedCommandCenter();
            wire(&center.playCommand(), app.clone(), "play");
            wire(&center.pauseCommand(), app.clone(), "pause");
            wire(&center.togglePlayPauseCommand(), app.clone(), "toggle");
            wire(&center.nextTrackCommand(), app.clone(), "next");
            wire(&center.previousTrackCommand(), app.clone(), "prev");

            let pos_cmd = center.changePlaybackPositionCommand();
            let app_seek = app.clone();
            let block = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                if let Some(pos) =
                    event.as_ref().downcast_ref::<MPChangePlaybackPositionCommandEvent>()
                {
                    let _ = app_seek.emit("media-remote-seek", pos.positionTime());
                }
                MPRemoteCommandHandlerStatus::Success
            });
            pos_cmd.setEnabled(true);
            let _ = pos_cmd.addTargetWithHandler(&block);
            // The command center copies + retains the block; keep our
            // handle alive for the whole process rather than tracking each.
            std::mem::forget(block);
        }
    }

    unsafe fn wire(cmd: &MPRemoteCommand, app: tauri::AppHandle, action: &'static str) {
        let block = RcBlock::new(move |_event: NonNull<MPRemoteCommandEvent>| {
            let _ = app.emit("media-remote", action);
            MPRemoteCommandHandlerStatus::Success
        });
        cmd.setEnabled(true);
        let _ = cmd.addTargetWithHandler(&block);
        std::mem::forget(block);
    }
}
