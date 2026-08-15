//! Windows taskbar thumbnail toolbar: the shuffle / previous / play-pause /
//! next / repeat / like row that appears under the window preview when you
//! hover the taskbar button.
//!
//! This is a separate shell surface from the SMTC tile in media.rs — SMTC owns
//! the volume-flyout card, the lock screen and the media keys; the thumbnail
//! toolbar is `ITaskbarList3::ThumbBarAddButtons` and has to be driven by the
//! process that owns the taskbar button (us, not the WebView2 child).
//!
//! Three moving parts:
//!   * COM. `ITaskbarList3` is apartment-bound, so like souvlaki it lives in a
//!     main-thread thread-local and is only touched from the main thread.
//!   * Buttons can only be attached once the taskbar button exists, which
//!     happens after `setup()` returns. Explorer announces it with the
//!     registered `TaskbarButtonCreated` message — and re-announces it after an
//!     Explorer restart, at which point the old ITaskbarList3 is dead and the
//!     buttons must be attached to a fresh one. We subclass the main window to
//!     catch that message (and the button clicks, which arrive as `WM_COMMAND`
//!     with `THBN_CLICKED` in the high word).
//!   * Icons. The toolbar takes HICONs, not a glyph font, and it has no concept
//!     of a toggled button, so every state gets its own bitmap: shuffle, repeat
//!     and like are drawn in the brand colour when active and in the toolbar's
//!     foreground colour when not. They are rasterized with resvg from the same
//!     lucide paths the player bar uses, at the window's DPI and in whichever
//!     colour contrasts with the (theme-dependent) toolbar background, and
//!     rebuilt when the theme or the DPI changes.
//!
//! Clicks are emitted as the same `media-control` event souvlaki's handler
//! emits, so the frontend listener in audio-engine.ts routes them like any
//! other OS media button.

use std::cell::RefCell;
use std::ffi::c_void;

use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg::{self, Tree};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, GUID};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
    THUMBBUTTON, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, DestroyIcon, RegisterWindowMessageW, HICON, ICONINFO, WM_COMMAND,
    WM_DPICHANGED, WM_NCDESTROY, WM_SETTINGCHANGE, WM_THEMECHANGED,
};

/// Button ids. They come back in the low word of `WM_COMMAND`'s wParam.
const ID_SHUFFLE: u32 = 1;
const ID_PREV: u32 = 2;
const ID_PLAY: u32 = 3;
const ID_NEXT: u32 = 4;
const ID_REPEAT: u32 = 5;
const ID_LIKE: u32 = 6;
/// Arbitrary, only has to be unique among subclasses on this window.
const SUBCLASS_ID: usize = 0x5954_5542; // "YTUB"
/// `--brand` from index.css, for the active state of the toggle buttons.
const BRAND: u32 = 0xFA_1F_3E;

/// Repeat mode, mirroring the frontend's `RepeatMode`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Repeat {
    Off,
    All,
    One,
}

impl Repeat {
    pub fn from_str(s: &str) -> Self {
        match s {
            "all" => Repeat::All,
            "one" => Repeat::One,
            _ => Repeat::Off,
        }
    }
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

struct Icons {
    prev: HICON,
    play: HICON,
    pause: HICON,
    next: HICON,
    shuffle_off: HICON,
    shuffle_on: HICON,
    repeat_off: HICON,
    repeat_all: HICON,
    repeat_one: HICON,
    like_off: HICON,
    like_on: HICON,
}

impl Icons {
    fn all(&self) -> [HICON; 11] {
        [
            self.prev,
            self.play,
            self.pause,
            self.next,
            self.shuffle_off,
            self.shuffle_on,
            self.repeat_off,
            self.repeat_all,
            self.repeat_one,
            self.like_off,
            self.like_on,
        ]
    }

    fn destroy(&self) {
        for icon in self.all() {
            unsafe {
                let _ = DestroyIcon(icon);
            }
        }
    }
}

struct State {
    app: AppHandle,
    hwnd: HWND,
    list: Option<ITaskbarList3>,
    icons: Option<Icons>,
    /// Buttons attached to the current `list`. Reset when Explorer restarts.
    attached: bool,
    playing: bool,
    shuffle: bool,
    repeat: Repeat,
    liked: bool,
    /// Theme + DPI the current icons were drawn for; a change rebuilds them.
    light: bool,
    dpi: u32,
    /// The `TaskbarButtonCreated` registered message id.
    button_created_msg: u32,
    /// A COM call is in flight: `list` / `icons` are on loan and the message
    /// queue is being pumped. See the re-entrancy note below.
    busy: bool,
    /// What re-entrant messages asked for while `busy`; replayed by `leave`.
    pending: Pending,
}

impl State {
    fn flags(&self) -> Flags {
        Flags {
            playing: self.playing,
            shuffle: self.shuffle,
            repeat: self.repeat,
            liked: self.liked,
        }
    }
}

/// The button states, snapshotted so the toolbar can be built without keeping
/// `STATE` borrowed.
#[derive(Clone, Copy)]
struct Flags {
    playing: bool,
    shuffle: bool,
    repeat: Repeat,
    liked: bool,
}

#[derive(Default)]
struct Pending {
    attach: bool,
    refresh: bool,
    sync: bool,
}

// ── Re-entrancy ───────────────────────────────────────────────────────────────
//
// `ITaskbarList3` lives in Explorer's apartment, so every call on it is a
// cross-apartment COM call — and those pump the message queue while they wait.
// Our own window proc therefore runs *inside* `ThumbBarAddButtons`, which is
// how an earlier version of this file managed to re-enter a `RefCell` it was
// already holding mutably and abort the process on startup. The rules:
//   * `STATE` is borrowed only for as long as it takes to read or write
//     fields, never across a COM call. Whatever the call needs (`list`,
//     `icons`) is taken out first and put back after.
//   * `busy` marks that window. Work arriving inside it is recorded in
//     `pending` and replayed by `leave` rather than run against loaned state.
//   * Every borrow is a `try_borrow_mut`, so a path this note missed degrades
//     into a dropped toolbar update instead of a crash.

/// Borrow the state for a moment. `None` if it is not initialised, or if we
/// somehow re-entered a borrow that is already open.
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| {
        s.try_borrow_mut()
            .ok()
            .and_then(|mut slot| slot.as_mut().map(f))
    })
}

/// Put the loaned state back, release the guard, and replay whatever arrived
/// while the COM call was pumping messages.
fn leave(f: impl FnOnce(&mut State)) {
    let pending = with_state(|st| {
        f(st);
        st.busy = false;
        std::mem::take(&mut st.pending)
    })
    .unwrap_or_default();
    if pending.refresh {
        refresh_icons(None);
    }
    if pending.attach {
        attach();
    }
    if pending.sync {
        sync();
    }
}

/// Create the thumbnail toolbar for the main window. Main-thread only (called
/// from `setup()`, same as media::init).
pub fn init(app: &AppHandle) {
    let Some(hwnd) = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| HWND(h.0 as *mut c_void))
    else {
        eprintln!("[thumbbar] no main window HWND; skipping");
        return;
    };

    let button_created_msg = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
    let light = taskbar_is_light();
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);

    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            app: app.clone(),
            hwnd,
            list: None,
            icons: None,
            attached: false,
            playing: false,
            shuffle: false,
            repeat: Repeat::Off,
            liked: false,
            light,
            dpi,
            button_created_msg,
            busy: false,
            pending: Pending::default(),
        })
    });

    unsafe {
        if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
            eprintln!("[thumbbar] failed to subclass the main window");
        }
    }

    // The taskbar button usually does not exist yet at setup() time; this is a
    // best-effort first shot and `TaskbarButtonCreated` is the real trigger.
    attach();
}

/// Mirror the player's state onto the toolbar. Main-thread only; called from
/// media.rs, which already marshals onto the main thread.
pub fn set_state(playing: bool, shuffle: bool, repeat: Repeat, liked: bool) {
    let changed = with_state(|st| {
        if st.playing == playing
            && st.shuffle == shuffle
            && st.repeat == repeat
            && st.liked == liked
        {
            return false;
        }
        st.playing = playing;
        st.shuffle = shuffle;
        st.repeat = repeat;
        st.liked = liked;
        true
    })
    .unwrap_or(false);
    if changed {
        sync();
    }
}

/// Create (or recreate) the taskbar list object and attach the buttons.
fn attach() {
    let taken = with_state(|st| {
        if st.busy {
            st.pending.attach = true;
            return None;
        }
        if st.attached {
            return None;
        }
        st.busy = true;
        Some((st.hwnd, st.light, st.dpi, st.flags(), st.icons.take()))
    })
    .flatten();
    let Some((hwnd, light, dpi, flags, icons)) = taken else {
        return;
    };

    let icons = icons.or_else(|| build_icons(light, dpi));
    let list = icons.as_ref().and_then(|i| add_buttons(hwnd, i, flags));
    if list.is_some() {
        eprintln!("[thumbbar] toolbar attached ({}px icons)", 16 * dpi / 96);
    }

    leave(|st| {
        st.icons = icons;
        // A `TaskbarButtonCreated` that landed mid-call means this toolbar is
        // already stale; drop it and let the replayed attach build another.
        if !st.pending.attach {
            if let Some(list) = list {
                st.list = Some(list);
                st.attached = true;
            }
        }
    });
}

/// The COM half of `attach`, kept free of any `STATE` borrow.
fn add_buttons(hwnd: HWND, icons: &Icons, flags: Flags) -> Option<ITaskbarList3> {
    // A fresh instance per attach: after an Explorer restart the previous one
    // is bound to a taskbar that no longer exists.
    let list: ITaskbarList3 =
        match unsafe { CoCreateInstance(&TaskbarList as *const GUID, None, CLSCTX_INPROC_SERVER) } {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[thumbbar] CoCreateInstance(TaskbarList) failed: {e}");
                return None;
            }
        };
    if let Err(e) = unsafe { list.HrInit() } {
        eprintln!("[thumbbar] HrInit failed: {e}");
        return None;
    }
    let buttons = buttons(icons, flags);
    // ThumbBarAddButtons is one-shot per window per taskbar-list instance;
    // everything after this goes through ThumbBarUpdateButtons.
    if let Err(e) = unsafe { list.ThumbBarAddButtons(hwnd, &buttons) } {
        eprintln!("[thumbbar] ThumbBarAddButtons failed: {e}");
        return None;
    }
    Some(list)
}

/// Push the current icons / flags to an already-attached toolbar.
fn sync() {
    let taken = with_state(|st| {
        if st.busy {
            st.pending.sync = true;
            return None;
        }
        if !st.attached {
            return None;
        }
        let list = st.list.clone()?;
        let icons = st.icons.take()?;
        st.busy = true;
        Some((st.hwnd, list, icons, st.flags()))
    })
    .flatten();
    let Some((hwnd, list, icons, flags)) = taken else {
        return;
    };

    let buttons = buttons(&icons, flags);
    if let Err(e) = unsafe { list.ThumbBarUpdateButtons(hwnd, &buttons) } {
        eprintln!("[thumbbar] ThumbBarUpdateButtons failed: {e}");
    }

    leave(|st| st.icons = Some(icons));
}

/// Redraw the glyphs when the taskbar theme or the window DPI changed. The old
/// icons stay alive until the toolbar has been pointed at the new ones.
fn refresh_icons(dpi_override: Option<u32>) {
    let light = taskbar_is_light();
    let wanted = with_state(|st| {
        if st.busy {
            st.pending.refresh = true;
            return None;
        }
        // During WM_DPICHANGED the window still reports the old DPI, so the new
        // one comes from the message's wParam instead.
        let dpi = dpi_override
            .unwrap_or_else(|| unsafe { GetDpiForWindow(st.hwnd) })
            .max(96);
        if light == st.light && dpi == st.dpi && st.icons.is_some() {
            return None;
        }
        st.light = light;
        st.dpi = dpi;
        Some(dpi)
    })
    .flatten();
    let Some(dpi) = wanted else {
        return;
    };
    let Some(fresh) = build_icons(light, dpi) else {
        return;
    };

    let mut fresh = Some(fresh);
    let stale = with_state(|st| st.icons.replace(fresh.take()?)).flatten();
    if let Some(fresh) = fresh {
        // The window went away between the two borrows; don't leak the icons.
        fresh.destroy();
        return;
    }
    sync();
    if let Some(stale) = stale {
        stale.destroy();
    }
}

fn buttons(icons: &Icons, flags: Flags) -> [THUMBBUTTON; 6] {
    [
        button(
            ID_SHUFFLE,
            if flags.shuffle {
                icons.shuffle_on
            } else {
                icons.shuffle_off
            },
            if flags.shuffle {
                "Shuffle: on"
            } else {
                "Shuffle: off"
            },
        ),
        button(ID_PREV, icons.prev, "Previous"),
        button(
            ID_PLAY,
            if flags.playing {
                icons.pause
            } else {
                icons.play
            },
            if flags.playing { "Pause" } else { "Play" },
        ),
        button(ID_NEXT, icons.next, "Next"),
        button(
            ID_REPEAT,
            match flags.repeat {
                Repeat::Off => icons.repeat_off,
                Repeat::All => icons.repeat_all,
                Repeat::One => icons.repeat_one,
            },
            match flags.repeat {
                Repeat::Off => "Repeat: off",
                Repeat::All => "Repeat: all",
                Repeat::One => "Repeat: one",
            },
        ),
        button(
            ID_LIKE,
            if flags.liked {
                icons.like_on
            } else {
                icons.like_off
            },
            if flags.liked {
                "Remove from liked"
            } else {
                "Add to liked"
            },
        ),
    ]
}

fn button(id: u32, icon: HICON, tip: &str) -> THUMBBUTTON {
    let mut sz_tip = [0u16; 260];
    for (slot, ch) in sz_tip.iter_mut().zip(tip.encode_utf16()) {
        *slot = ch;
    }
    THUMBBUTTON {
        dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
        iId: id,
        iBitmap: 0,
        hIcon: icon,
        szTip: sz_tip,
        dwFlags: THBF_ENABLED,
    }
}

// ── Window subclass ───────────────────────────────────────────────────────────

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    // This runs re-entrantly inside our own COM calls (see the re-entrancy
    // note above), and a panic cannot unwind out of a window proc — it aborts
    // the process. So every borrow here is fallible and every handler steps
    // aside when a call is already in flight.
    let created_msg = with_state(|st| st.button_created_msg);

    if Some(msg) == created_msg {
        // Sent when the taskbar button appears, and again after an Explorer
        // restart — in which case the previous toolbar is gone with it.
        with_state(|st| {
            st.attached = false;
            st.list = None;
        });
        attach();
    } else if msg == WM_COMMAND && (wparam.0 >> 16) as u32 & 0xffff == THBN_CLICKED {
        let action = match wparam.0 as u32 & 0xffff {
            ID_SHUFFLE => Some("shuffle"),
            ID_PREV => Some("previous"),
            ID_PLAY => Some("toggle"),
            ID_NEXT => Some("next"),
            ID_REPEAT => Some("repeat"),
            ID_LIKE => Some("like"),
            _ => None,
        };
        if let Some(action) = action {
            with_state(|st| {
                let _ = st
                    .app
                    .emit("media-control", serde_json::json!({ "action": action }));
            });
            return LRESULT(0);
        }
    } else if msg == WM_SETTINGCHANGE || msg == WM_THEMECHANGED || msg == WM_DPICHANGED {
        let dpi = (msg == WM_DPICHANGED).then(|| (wparam.0 as u32) & 0xffff);
        refresh_icons(dpi);
    } else if msg == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        }
        let icons = STATE.with(|s| {
            s.try_borrow_mut()
                .ok()
                .and_then(|mut slot| slot.take())
                .and_then(|st| st.icons)
        });
        if let Some(icons) = icons {
            icons.destroy();
        }
    }

    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

// ── Icons ─────────────────────────────────────────────────────────────────────

/// Is the taskbar drawn light? (`SystemUsesLightTheme` is the taskbar/tray
/// setting; `AppsUseLightTheme` is the one for app surfaces.) Missing key means
/// the dark default of a stock Windows 11.
fn taskbar_is_light() -> bool {
    let mut data: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    status == ERROR_SUCCESS && data == 1
}

// The glyphs, as the lucide path data the player bar draws with (lucide-react:
// shuffle, skip-back, play, pause, skip-forward, repeat, repeat-1, heart).
// `fill` says whether the shape is solid — the transport buttons are drawn
// `fill-current` in the player bar, the toggles are outlines.
struct Glyph {
    paths: &'static [&'static str],
    fill: bool,
}

const SHUFFLE: Glyph = Glyph {
    paths: &[
        "m18 14 4 4-4 4",
        "m18 2 4 4-4 4",
        "M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22",
        "M2 6h1.972a4 4 0 0 1 3.6 2.2",
        "M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45",
    ],
    fill: false,
};
const PREV: Glyph = Glyph {
    paths: &[
        "M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z",
        "M3 20V4",
    ],
    fill: true,
};
const PLAY: Glyph = Glyph {
    paths: &["M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"],
    fill: true,
};
const PAUSE: Glyph = Glyph {
    // lucide draws these as <rect rx=1>; as paths with round joins they come
    // out the same at icon sizes.
    paths: &["M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
             "M6 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
    fill: true,
};
const NEXT: Glyph = Glyph {
    paths: &[
        "M21 4v16",
        "M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z",
    ],
    fill: true,
};
const REPEAT: Glyph = Glyph {
    paths: &[
        "m17 2 4 4-4 4",
        "M3 11v-1a4 4 0 0 1 4-4h14",
        "m7 22-4-4 4-4",
        "M21 13v1a4 4 0 0 1-4 4H3",
    ],
    fill: false,
};
const REPEAT_ONE: Glyph = Glyph {
    paths: &[
        "m17 2 4 4-4 4",
        "M3 11v-1a4 4 0 0 1 4-4h14",
        "m7 22-4-4 4-4",
        "M21 13v1a4 4 0 0 1-4 4H3",
        "M11 10h1v4",
    ],
    fill: false,
};
const HEART: &str = "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5";
const HEART_OUTLINE: Glyph = Glyph {
    paths: &[HEART],
    fill: false,
};
const HEART_FILLED: Glyph = Glyph {
    paths: &[HEART],
    fill: true,
};

fn build_icons(light: bool, dpi: u32) -> Option<Icons> {
    // 16px at 100%, the size the shell asks for, scaled to the window's DPI.
    let size = (16 * dpi / 96).clamp(16, 64) as u32;
    let fg: u32 = if light { 0x1B1B1B } else { 0xFFFFFF };
    Some(Icons {
        prev: make_icon(&PREV, size, fg)?,
        play: make_icon(&PLAY, size, fg)?,
        pause: make_icon(&PAUSE, size, fg)?,
        next: make_icon(&NEXT, size, fg)?,
        shuffle_off: make_icon(&SHUFFLE, size, fg)?,
        shuffle_on: make_icon(&SHUFFLE, size, BRAND)?,
        repeat_off: make_icon(&REPEAT, size, fg)?,
        repeat_all: make_icon(&REPEAT, size, BRAND)?,
        repeat_one: make_icon(&REPEAT_ONE, size, BRAND)?,
        like_off: make_icon(&HEART_OUTLINE, size, fg)?,
        like_on: make_icon(&HEART_FILLED, size, BRAND)?,
    })
}

/// Wrap the glyph's paths in an SVG document coloured for the current theme.
/// lucide's 24x24 grid already carries the padding the toolbar wants, so the
/// document is rendered edge to edge.
fn glyph_svg(glyph: &Glyph, size: u32, rgb: u32) -> String {
    let color = format!("#{:06x}", rgb);
    let fill = if glyph.fill { color.as_str() } else { "none" };
    // lucide's own stroke width is 2 on the 24-unit grid. At 16px that lands
    // just under 1.4 device pixels and the glyphs read as washed out next to
    // the shell's own toolbar icons, so thin them up only where it's needed.
    let stroke_width = if size < 24 { 2.4 } else { 2.0 };
    let body: String = glyph
        .paths
        .iter()
        .map(|d| format!("<path d=\"{d}\"/>"))
        .collect();
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" \
         fill=\"{fill}\" stroke=\"{color}\" stroke-width=\"{stroke_width}\" \
         stroke-linecap=\"round\" stroke-linejoin=\"round\">{body}</svg>"
    )
}

/// Rasterize one glyph into a 32-bit ARGB icon at the toolbar's size.
fn make_icon(glyph: &Glyph, size: u32, rgb: u32) -> Option<HICON> {
    let svg = glyph_svg(glyph, size, rgb);
    let tree = match Tree::from_str(&svg, &usvg::Options::default()) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[thumbbar] glyph parse failed: {e}");
            return None;
        }
    };
    let mut pixmap = Pixmap::new(size, size)?;
    let scale = size as f32 / 24.0;
    resvg::render(
        &tree,
        Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );

    let size = size as i32;
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: size,
        // Negative height: top-down rows, so pixel 0 is the top-left.
        biHeight: -size,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut bits: *mut c_void = std::ptr::null_mut();
    let color = unsafe {
        CreateDIBSection(
            None,
            &info as *const BITMAPINFO,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
    }
    .ok()?;
    if bits.is_null() {
        unsafe {
            let _ = DeleteObject(color.into());
        }
        return None;
    }

    let px = size as usize;
    let pixels = unsafe { std::slice::from_raw_parts_mut(bits as *mut u32, px * px) };
    // tiny-skia hands back premultiplied RGBA; an icon's colour bitmap is
    // straight-alpha BGRA (0xAARRGGBB once the little-endian bytes are read
    // back as a u32).
    for (dst, src) in pixels.iter_mut().zip(pixmap.pixels()) {
        let c = src.demultiply();
        *dst = ((c.alpha() as u32) << 24)
            | ((c.red() as u32) << 16)
            | ((c.green() as u32) << 8)
            | c.blue() as u32;
    }

    // 1bpp AND mask, all zeros: the colour bitmap's alpha does the masking.
    let mask_stride = ((px + 15) / 16) * 2;
    let mask_bits = vec![0u8; mask_stride * px];
    let mask = unsafe { CreateBitmap(size, size, 1, 1, Some(mask_bits.as_ptr() as *const c_void)) };

    let icon_info = ICONINFO {
        fIcon: true.into(),
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: mask,
        hbmColor: color,
    };
    let icon = unsafe { CreateIconIndirect(&icon_info) };
    unsafe {
        // CreateIconIndirect copies both bitmaps.
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
    }
    icon.ok()
}
