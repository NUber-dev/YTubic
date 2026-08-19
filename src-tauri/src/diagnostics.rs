use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const CAPACITY: usize = 2000;

#[derive(Clone, Serialize)]
pub struct DiagLine {
    at: u64,
    tag: String,
    text: String,
}

pub struct DiagState(Mutex<VecDeque<DiagLine>>);

impl Default for DiagState {
    fn default() -> Self {
        DiagState(Mutex::new(VecDeque::with_capacity(CAPACITY)))
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn note(app: &AppHandle, tag: &str, text: impl Into<String>) {
    let text = text.into();
    eprintln!("[{tag}] {text}");
    let line = DiagLine {
        at: epoch_ms(),
        tag: tag.to_string(),
        text,
    };
    if let Some(state) = app.try_state::<DiagState>() {
        let mut buf = state.0.lock().unwrap();
        if buf.len() >= CAPACITY {
            buf.pop_front();
        }
        buf.push_back(line.clone());
    }
    let _ = app.emit("diag-line", line);
}

#[tauri::command]
pub fn diag_backlog(state: tauri::State<'_, DiagState>) -> Vec<DiagLine> {
    state.0.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn diag_log(app: AppHandle, tag: String, text: String) {
    note(&app, &tag, text);
}

pub fn open(app: &AppHandle, browser_args: &str) {
    if let Some(existing) = app.get_webview_window("diagnostics") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(
        app,
        "diagnostics",
        WebviewUrl::App("index.html?diagnostics=1".into()),
    )
    .title("YTubic diagnostics")
    .inner_size(880.0, 560.0)
    .min_inner_size(560.0, 360.0)
    .resizable(true)
    .additional_browser_args(browser_args)
    .build();
    if let Err(e) = built {
        eprintln!("[diagnostics] window open failed: {e}");
    }
}

#[tauri::command]
pub async fn open_diag_window(app: AppHandle) {
    open(&app, crate::APP_WEBVIEW_ARGS);
}

#[tauri::command]
pub async fn close_diag_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("diagnostics") {
        let _ = win.close();
    }
}
