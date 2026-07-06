//! When the app is built without `custom-protocol` (e.g. `cargo build
//! --release` instead of `pnpm tauri build`), Tauri loads the UI from
//! `devUrl` (`http://localhost:1420`). Start Vite automatically so a
//! double-clicked `.exe` still works during local development.

use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const DEV_PORT: u16 = 1420;

fn port_open() -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{DEV_PORT}").parse().expect("addr"),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn project_root() -> Option<&'static Path> {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent()
}

fn spawn_vite(root: &Path) {
    eprintln!("[dev-server] starting Vite on http://localhost:{DEV_PORT} …");
    let mut cmd = Command::new("pnpm");
    cmd.args(["dev"]).current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(_) => {}
        Err(e) => eprintln!("[dev-server] failed to spawn `pnpm dev`: {e}"),
    }
}

/// Block briefly until Vite is listening or we give up.
pub fn ensure_vite_for_dev_build() {
    if !tauri::is_dev() {
        return;
    }
    if port_open() {
        return;
    }
    let Some(root) = project_root() else {
        return;
    };
    if !root.join("package.json").exists() {
        eprintln!("[dev-server] no package.json at {root:?} — cannot auto-start Vite");
        return;
    }
    spawn_vite(root);
    for _ in 0..40 {
        if port_open() {
            eprintln!("[dev-server] Vite ready on :{DEV_PORT}");
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("[dev-server] timed out waiting for :{DEV_PORT} — run `pnpm dev` manually");
}
