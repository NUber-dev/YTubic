//! Windows only: answer WebView2's permission prompts for our own pages.
//!
//! Chromium ties output-device selection to media capture: `enumerateDevices`
//! names audio outputs, and `setSinkId` accepts them, only after the page has
//! been granted the microphone. The Playback tab therefore asks for a
//! microphone stream and releases it at once. Without a handler WebView2 puts
//! up its own "allow microphone?" dialog for that, which reads as if the app
//! wanted to record. The webview is ours and only ever shows the bundled
//! frontend, so the request is granted here for the app's own origins and
//! left to the default UI for anything else.

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::core::PWSTR;
use windows::Win32::System::Com::CoTaskMemFree;

/// Whether `uri` is one of the pages the app itself serves: the bundled
/// frontend (`tauri.localhost`) or the Vite dev server.
pub fn is_own_page(uri: &str) -> bool {
    let rest = match uri.split_once("://") {
        Some(("http" | "https", rest)) => rest,
        _ => return false,
    };
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
    matches!(host, "tauri.localhost" | "localhost" | "127.0.0.1")
}

pub fn install(win: &WebviewWindow) {
    let _ = win.with_webview(|webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[permissions] CoreWebView2 unavailable: {e}");
                return;
            }
        };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                return Ok(());
            }
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let own = if uri.is_null() {
                false
            } else {
                let s = uri.to_string().unwrap_or_default();
                CoTaskMemFree(Some(uri.0 as *const _));
                is_own_page(&s)
            };
            if own {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("[permissions] add_PermissionRequested failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_own_page;

    #[test]
    fn own_pages() {
        assert!(is_own_page("http://tauri.localhost/"));
        assert!(is_own_page("https://tauri.localhost/settings?x=1"));
        assert!(is_own_page("http://localhost:1420/"));
    }

    #[test]
    fn foreign_pages() {
        assert!(!is_own_page("https://accounts.google.com/"));
        assert!(!is_own_page("http://tauri.localhost.evil.com/"));
        assert!(!is_own_page("tauri://localhost"));
        assert!(!is_own_page(""));
    }
}
