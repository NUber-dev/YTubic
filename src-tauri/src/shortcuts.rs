// Global volume hotkeys. Unlike the in-window Space-to-play binding (which
// only works while YTubic has focus, see `useGlobalShortcuts` in the
// frontend), these are OS-level: the global-shortcut plugin fires them no
// matter which app is focused, so a macro pad / keyboard can nudge the music
// volume while the user is in another window entirely.
//
// The split mirrors the tray actions: Rust only maps a key combo to a
// direction and emits `volume-hotkey` ("up" / "down" / "mute"); the step size
// (Settings) and the actual volume state (playback store) live on the JS side,
// which listens for the event in `src/lib/audio-engine.ts`.
//
// Accelerators are parsed here into a typed `Shortcut` rather than handed to
// the plugin's own string parser, so the accepted token names are fixed and
// checked by the compiler (the plugin's string grammar isn't part of its
// documented API). The names cover both hand-typed combos
// ("CommandOrControl+Alt+Shift+Down") and the `KeyboardEvent.code` form the
// Settings "record" flow could emit ("Control+Alt+Shift+ArrowDown").

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn letter_code(c: char) -> Option<Code> {
    Some(match c {
        'a' => Code::KeyA, 'b' => Code::KeyB, 'c' => Code::KeyC, 'd' => Code::KeyD,
        'e' => Code::KeyE, 'f' => Code::KeyF, 'g' => Code::KeyG, 'h' => Code::KeyH,
        'i' => Code::KeyI, 'j' => Code::KeyJ, 'k' => Code::KeyK, 'l' => Code::KeyL,
        'm' => Code::KeyM, 'n' => Code::KeyN, 'o' => Code::KeyO, 'p' => Code::KeyP,
        'q' => Code::KeyQ, 'r' => Code::KeyR, 's' => Code::KeyS, 't' => Code::KeyT,
        'u' => Code::KeyU, 'v' => Code::KeyV, 'w' => Code::KeyW, 'x' => Code::KeyX,
        'y' => Code::KeyY, 'z' => Code::KeyZ,
        _ => return None,
    })
}

fn digit_code(c: char) -> Option<Code> {
    Some(match c {
        '0' => Code::Digit0, '1' => Code::Digit1, '2' => Code::Digit2, '3' => Code::Digit3,
        '4' => Code::Digit4, '5' => Code::Digit5, '6' => Code::Digit6, '7' => Code::Digit7,
        '8' => Code::Digit8, '9' => Code::Digit9,
        _ => return None,
    })
}

fn fkey_code(n: u8) -> Option<Code> {
    Some(match n {
        1 => Code::F1, 2 => Code::F2, 3 => Code::F3, 4 => Code::F4, 5 => Code::F5,
        6 => Code::F6, 7 => Code::F7, 8 => Code::F8, 9 => Code::F9, 10 => Code::F10,
        11 => Code::F11, 12 => Code::F12, 13 => Code::F13, 14 => Code::F14, 15 => Code::F15,
        16 => Code::F16, 17 => Code::F17, 18 => Code::F18, 19 => Code::F19, 20 => Code::F20,
        21 => Code::F21, 22 => Code::F22, 23 => Code::F23, 24 => Code::F24,
        _ => return None,
    })
}

/// Map one non-modifier token to a `Code`. Accepts bare letters/digits
/// ("m", "5"), the `KeyboardEvent.code` spellings ("KeyM", "Digit5",
/// "Numpad5", "ArrowDown"), function keys ("F1".."F24"), and a set of named
/// keys including the hardware media/volume keys (so a rotary encoder that
/// emits `AudioVolumeDown` can be bound directly).
fn parse_code(tok: &str) -> Option<Code> {
    let t = tok.to_ascii_lowercase();

    if let Some(rest) = t.strip_prefix("key") {
        if rest.len() == 1 {
            return letter_code(rest.chars().next().unwrap());
        }
    }
    if let Some(rest) = t.strip_prefix("digit") {
        if rest.len() == 1 {
            return digit_code(rest.chars().next().unwrap());
        }
    }
    if let Some(rest) = t.strip_prefix("numpad") {
        // Fold numpad digits onto their main-row codes — plenty for a volume
        // nudge and it saves maintaining a second table.
        if rest.len() == 1 {
            return digit_code(rest.chars().next().unwrap());
        }
    }
    if t.len() == 1 {
        let c = t.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            return letter_code(c);
        }
        if c.is_ascii_digit() {
            return digit_code(c);
        }
    }
    // Function keys: "f5" (but not the bare letter "f", handled above).
    if t.len() >= 2 {
        if let Some(rest) = t.strip_prefix('f') {
            if let Ok(n) = rest.parse::<u8>() {
                return fkey_code(n);
            }
        }
    }

    Some(match t.as_str() {
        "up" | "arrowup" => Code::ArrowUp,
        "down" | "arrowdown" => Code::ArrowDown,
        "left" | "arrowleft" => Code::ArrowLeft,
        "right" | "arrowright" => Code::ArrowRight,
        "space" => Code::Space,
        "enter" | "return" => Code::Enter,
        "tab" => Code::Tab,
        "esc" | "escape" => Code::Escape,
        "backspace" => Code::Backspace,
        "delete" | "del" => Code::Delete,
        "insert" | "ins" => Code::Insert,
        "home" => Code::Home,
        "end" => Code::End,
        "pageup" | "pgup" => Code::PageUp,
        "pagedown" | "pgdn" => Code::PageDown,
        "minus" => Code::Minus,
        "equal" => Code::Equal,
        "comma" => Code::Comma,
        "period" => Code::Period,
        "slash" => Code::Slash,
        "backslash" => Code::Backslash,
        "semicolon" => Code::Semicolon,
        "quote" => Code::Quote,
        "backquote" => Code::Backquote,
        "bracketleft" => Code::BracketLeft,
        "bracketright" => Code::BracketRight,
        "volumeup" | "audiovolumeup" => Code::AudioVolumeUp,
        "volumedown" | "audiovolumedown" => Code::AudioVolumeDown,
        "volumemute" | "audiovolumemute" => Code::AudioVolumeMute,
        "mediaplaypause" | "playpause" => Code::MediaPlayPause,
        "mediatracknext" | "nexttrack" => Code::MediaTrackNext,
        "mediatrackprevious" | "prevtrack" | "previoustrack" => Code::MediaTrackPrevious,
        _ => return None,
    })
}

/// Parse a "+"-separated accelerator into a typed `Shortcut`. Modifier tokens
/// are case-insensitive; `CommandOrControl` maps to Control (we target
/// Windows). Exactly one non-modifier key is required.
fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;

    for raw in accel.split('+') {
        let tok = raw.trim();
        if tok.is_empty() {
            continue;
        }
        match tok.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" | "option" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "super" | "meta" | "cmd" | "command" | "win" => mods |= Modifiers::SUPER,
            "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" => mods |= Modifiers::CONTROL,
            _ => {
                let c = parse_code(tok).ok_or_else(|| format!("unknown key \"{tok}\""))?;
                if code.is_some() {
                    return Err(format!("more than one key in \"{accel}\""));
                }
                code = Some(c);
            }
        }
    }

    let code = code.ok_or_else(|| format!("no key in \"{accel}\""))?;
    let mods = if mods.is_empty() { None } else { Some(mods) };
    Ok(Shortcut::new(mods, code))
}

/// (Re)bind the global volume hotkeys. Clears every previous binding first so a
/// changed or cleared combo never leaves a stale one live, then registers the
/// enabled, non-empty ones. Called on launch and on every Settings change by
/// `useVolumeHotkeysSync`. Returns a message listing any accelerators that
/// failed to parse or that another app already holds, so the UI can flag it.
#[tauri::command]
pub fn apply_volume_hotkeys(
    app: AppHandle,
    enabled: bool,
    down: String,
    up: String,
    mute: String,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !enabled {
        return Ok(());
    }

    let mut errors: Vec<String> = Vec::new();
    for (accel, action) in [(down, "down"), (up, "up"), (mute, "mute")] {
        let accel = accel.trim().to_string();
        if accel.is_empty() {
            continue;
        }
        let shortcut = match parse_accelerator(&accel) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{action}: {e}"));
                continue;
            }
        };
        let app_evt = app.clone();
        let res = gs.on_shortcut(shortcut, move |_app, _shortcut, event| {
            // Key-down only — the matching release event would double every nudge.
            if event.state() == ShortcutState::Pressed {
                let _ = app_evt.emit("volume-hotkey", action);
            }
        });
        if let Err(e) = res {
            errors.push(format!("{action} (\"{accel}\"): {e}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Couldn't bind: {}", errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_accelerator;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    // Compare against a constructed Shortcut rather than reading fields —
    // Shortcut's PartialEq treats same-mods-same-key as equal, and this
    // doesn't assume the re-exported type exposes its fields publicly.
    #[test]
    fn parses_default_down() {
        let want = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
            Code::ArrowDown,
        );
        assert_eq!(parse_accelerator("CommandOrControl+Alt+Shift+Down").unwrap(), want);
    }

    #[test]
    fn parses_keyboardevent_code_form() {
        let want = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
            Code::KeyM,
        );
        assert_eq!(parse_accelerator("Control+Alt+Shift+KeyM").unwrap(), want);
    }

    #[test]
    fn parses_bare_letter_and_fkey() {
        assert_eq!(
            parse_accelerator("Alt+A").unwrap(),
            Shortcut::new(Some(Modifiers::ALT), Code::KeyA)
        );
        assert_eq!(
            parse_accelerator("Ctrl+F5").unwrap(),
            Shortcut::new(Some(Modifiers::CONTROL), Code::F5)
        );
    }

    #[test]
    fn rejects_unknown_and_empty() {
        assert!(parse_accelerator("Ctrl+Nope").is_err());
        assert!(parse_accelerator("Ctrl+Alt").is_err());
    }
}
