import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CloseButtonAction = "tray" | "quit";
export type CacheAutoCleanPeriod = "off" | "daily" | "weekly" | "monthly";
export type BackgroundMode = "ambient" | "plain";

type State = {
  /** What the title-bar ✕ does: hide to tray (default) or quit. */
  closeAction: CloseButtonAction;
  /** Cadence of the background sweep that deletes cached tracks not
   *  in the user's library (see `lib/cache-cleanup.ts`). */
  cacheAutoClean: CacheAutoCleanPeriod;
  /** Unix ms of the last completed sweep. 0 = never ran. */
  lastCacheCleanAt: number;
  /** Window backdrop: "ambient" tints with blurred album art,
   *  "plain" keeps the flat theme background. */
  background: BackgroundMode;
  /** System toast on track change while the app is in the background
   *  (see `lib/playback-notifications.ts`). */
  playbackNotifications: boolean;
  /** Broadcast the current track to Discord as a Rich Presence status
   *  ("Listening to YTubic"). Off by default — opt-in for privacy.
   *  The IPC worker lives in `src-tauri/src/discord.rs`. */
  discordRichPresence: boolean;
  /** Scrobble every played track to the connected Last.fm account. Only
   *  meaningful while `lastfmSessionKey` is set; connecting turns it on.
   *  The signed HTTP calls + offline retry queue live in
   *  `src-tauri/src/lastfm.rs`; the play-time timing that decides when to
   *  scrobble lives in `lib/lastfm-scrobbler.ts`. */
  lastfmEnabled: boolean;
  /** Last.fm session key: a permanent bearer credential for the connected
   *  account, or null when not connected. Passed to every scrobble call. */
  lastfmSessionKey: string | null;
  /** Display name of the connected Last.fm account, shown in Settings. */
  lastfmUsername: string | null;
  /** Last.fm profile avatar URL for the connected account (fetched from
   *  user.getInfo, purely cosmetic for the account card), or null. */
  lastfmAvatar: string | null;
  /** Mirror YouTube Music likes to Last.fm as Loved tracks. Separate from
   *  scrobbling and off by default: an opt-in, since people often keep their
   *  likes intentionally different per platform. See `lib/lastfm.ts`. */
  lastfmLoveSync: boolean;
  /** OS-level volume hotkeys: nudge the music volume from a keyboard/macro pad
   *  even when another app is focused. Off by default (a global shortcut is
   *  system-wide). The bindings are registered in Rust
   *  (`src-tauri/src/shortcuts.rs`); the event is handled in
   *  `lib/audio-engine.ts`. */
  volumeHotkeysEnabled: boolean;
  /** Percent (1–50) each hotkey press changes the volume. Applied JS-side. */
  volumeHotkeyStep: number;
  /** Tauri accelerators for volume down / up / mute-toggle, e.g.
   *  "CommandOrControl+Alt+Shift+Down". Empty string = that action unbound. */
  volumeHotkeyDown: string;
  volumeHotkeyUp: string;
  volumeHotkeyMute: string;
  setCloseAction: (v: CloseButtonAction) => void;
  setCacheAutoClean: (v: CacheAutoCleanPeriod) => void;
  markCacheCleaned: () => void;
  setBackground: (v: BackgroundMode) => void;
  setPlaybackNotifications: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
  setLastfmEnabled: (v: boolean) => void;
  setLastfmLoveSync: (v: boolean) => void;
  setLastfmAvatar: (v: string | null) => void;
  /** Store the account returned by the connect flow and enable scrobbling. */
  setLastfmSession: (username: string, sessionKey: string) => void;
  /** Forget the connected account and stop scrobbling. */
  clearLastfmSession: () => void;
  setVolumeHotkeysEnabled: (v: boolean) => void;
  setVolumeHotkeyStep: (v: number) => void;
  setVolumeHotkeyDown: (v: string) => void;
  setVolumeHotkeyUp: (v: string) => void;
  setVolumeHotkeyMute: (v: string) => void;
};

/**
 * General app preferences editable from the Settings page. Persisted
 * in localStorage like the other stores; anything Rust needs to act on
 * (close behavior) is mirrored over IPC by a sync hook rather than
 * read from disk on the Rust side.
 */
export const useSettingsStore = create<State>()(
  persist(
    (set) => ({
      closeAction: "tray",
      cacheAutoClean: "off",
      lastCacheCleanAt: 0,
      background: "ambient",
      playbackNotifications: false,
      discordRichPresence: false,
      lastfmEnabled: false,
      lastfmSessionKey: null,
      lastfmUsername: null,
      lastfmAvatar: null,
      lastfmLoveSync: false,
      volumeHotkeysEnabled: false,
      volumeHotkeyStep: 5,
      // Three modifiers keep the defaults clear of everyday app shortcuts, and
      // adding Shift dodges the Intel graphics Ctrl+Alt+Arrow screen-rotate
      // combo. All editable in Settings → General.
      volumeHotkeyDown: "CommandOrControl+Alt+Shift+Down",
      volumeHotkeyUp: "CommandOrControl+Alt+Shift+Up",
      volumeHotkeyMute: "CommandOrControl+Alt+Shift+M",
      setCloseAction: (closeAction) => set({ closeAction }),
      setCacheAutoClean: (cacheAutoClean) => set({ cacheAutoClean }),
      markCacheCleaned: () => set({ lastCacheCleanAt: Date.now() }),
      setBackground: (background) => set({ background }),
      setPlaybackNotifications: (playbackNotifications) =>
        set({ playbackNotifications }),
      setDiscordRichPresence: (discordRichPresence) =>
        set({ discordRichPresence }),
      setLastfmEnabled: (lastfmEnabled) => set({ lastfmEnabled }),
      setLastfmLoveSync: (lastfmLoveSync) => set({ lastfmLoveSync }),
      setLastfmAvatar: (lastfmAvatar) => set({ lastfmAvatar }),
      setLastfmSession: (lastfmUsername, lastfmSessionKey) =>
        set({ lastfmUsername, lastfmSessionKey, lastfmEnabled: true }),
      clearLastfmSession: () =>
        set({
          lastfmUsername: null,
          lastfmSessionKey: null,
          lastfmAvatar: null,
          lastfmEnabled: false,
          lastfmLoveSync: false,
        }),
      setVolumeHotkeysEnabled: (volumeHotkeysEnabled) =>
        set({ volumeHotkeysEnabled }),
      setVolumeHotkeyStep: (volumeHotkeyStep) =>
        set({ volumeHotkeyStep: Math.max(1, Math.min(50, volumeHotkeyStep)) }),
      setVolumeHotkeyDown: (volumeHotkeyDown) => set({ volumeHotkeyDown }),
      setVolumeHotkeyUp: (volumeHotkeyUp) => set({ volumeHotkeyUp }),
      setVolumeHotkeyMute: (volumeHotkeyMute) => set({ volumeHotkeyMute }),
    }),
    { name: "ytm-settings" },
  ),
);

// The main and floating-player windows are separate JS contexts sharing
// the `ytm-settings` localStorage key (same pattern as `ytm-layout`).
// Re-hydrate on the cross-window `storage` event so e.g. switching the
// Background mode in the main window restyles the floating player live.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "ytm-settings") {
      void useSettingsStore.persist.rehydrate();
    }
  });
}

/**
 * Mirror the persisted close-button preference into Rust, where the
 * actual `CloseRequested` handling lives (it must cover every close
 * path — title-bar ✕, Alt+F4, taskbar Close). Mounted once in
 * AppShell: pushes the persisted value right after launch, then again
 * on every change from the Settings page.
 */
export function useCloseBehaviorSync(): void {
  const closeAction = useSettingsStore((s) => s.closeAction);
  useEffect(() => {
    invoke("set_close_behavior", {
      quitOnClose: closeAction === "quit",
    }).catch(() => {
      /* plain-vite dev without a Tauri backend — nothing to sync */
    });
  }, [closeAction]);
}

/**
 * Mirror the Discord Rich Presence toggle into Rust, where the IPC worker
 * lives (`src-tauri/src/discord.rs`). Turning it off tells the worker to
 * clear the activity and disconnect; turning it on lets the audio engine's
 * push effect populate it on the next track / play-state change. Mounted
 * once in AppShell so the disable path fires even when nothing is playing.
 */
export function useDiscordPresenceSync(): void {
  const enabled = useSettingsStore((s) => s.discordRichPresence);
  useEffect(() => {
    invoke("discord_set_enabled", { enabled }).catch(() => {
      /* plain-vite dev without a Tauri backend — nothing to sync */
    });
  }, [enabled]);
}

/**
 * Mirror the global volume-hotkey config into Rust, which owns the OS-level
 * key registrations (`src-tauri/src/shortcuts.rs`). Re-applies on launch and
 * on every change; Rust clears the old bindings and registers the current
 * ones. A registration failure (bad accelerator, or a combo another app
 * already holds) comes back as a rejected promise — surfaced as a toast so the
 * user knows the shortcut didn't take, but only when the feature is enabled so
 * a disabled + malformed combo stays quiet. Mounted once in AppShell.
 */
export function useVolumeHotkeysSync(): void {
  const enabled = useSettingsStore((s) => s.volumeHotkeysEnabled);
  const down = useSettingsStore((s) => s.volumeHotkeyDown);
  const up = useSettingsStore((s) => s.volumeHotkeyUp);
  const mute = useSettingsStore((s) => s.volumeHotkeyMute);
  useEffect(() => {
    invoke("apply_volume_hotkeys", { enabled, down, up, mute }).catch((e) => {
      // Ignore the plain-vite dev case (no Tauri backend); only nag when the
      // user actually turned the feature on.
      if (enabled && typeof e === "string") {
        toast.error(`Volume hotkey: ${e}`);
      }
    });
  }, [enabled, down, up, mute]);
}
