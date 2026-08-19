use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::ActiveCacheRoot;

const LABEL: &str = "player-engine";

async fn open(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let profile_dir = app.state::<ActiveCacheRoot>().0.join("player-engine-profile");
    WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?player-engine=1".into()),
    )
    .title("YTubic player engine")
    .visible(false)
    .decorations(false)
    .focused(false)
    .skip_taskbar(true)
    .position(-32000.0, -32000.0)
    .inner_size(400.0, 300.0)
    .data_directory(profile_dir)
    .additional_browser_args("--autoplay-policy=no-user-gesture-required")
    .build()
    .map_err(|e| format!("build player-engine: {e}"))
    .map(|win| {
        let _ = win.hide();
    })?;
    Ok(())
}

#[tauri::command]
pub async fn ensure_player_engine(app: AppHandle) -> Result<(), String> {
    open(&app).await
}
