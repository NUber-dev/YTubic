import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { fetchRadio } from "@/lib/innertube/radio";
import { prefetchStream, saveTrackMeta, streamUrlFor } from "@/lib/stream";
import { usePlaybackStore, type QueueTrack } from "@/lib/store/playback";
import { usePremiumStore } from "@/lib/store/premium";
import { useSettingsStore } from "@/lib/store/settings";
import { openPremiumGate } from "@/lib/store/premium-gate";
import {
  resolveStreamId,
  useTrackSourceStore,
} from "@/lib/store/track-source";
import { pickThumbnail } from "@/components/shared/thumbnail";

/**
 * AudioEngine binds the playback store to a singleton HTMLAudioElement
 * and drives OS media controls.
 *
 * - Windows: SMTC + hardware keys via souvlaki in Rust (see media effects and
 *   src-tauri/src/media.rs). The webview Media Session is disabled on WebView2
 *   so we don't get a competing "Unknown app" tile from msedgewebview2.exe.
 * - macOS: WKWebView claims the hardware media keys once HTML <audio> is
 *   playing. F8 play/pause reaches the element directly; F7/F9 (previous/next,
 *   labeled rewind/fast-forward on Mac keyboards) only fire if
 *   `navigator.mediaSession` has action handlers. souvlaki still updates
 *   MPNowPlayingInfoCenter for Control Center metadata.
 *
 * Mount this hook once, near the root. It owns the <audio> element's lifecycle.
 */
export function useAudioEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Guard against stale stream resolutions when the user skips mid-fetch.
  const resolveTokenRef = useRef(0);
  // Counts how many tracks have failed in a row without a successful
  // play in between. Reset to 0 on `playing`. Used to short-circuit
  // auto-skip after a few consecutive failures so we don't burn through
  // the whole queue if e.g. the network is dead.
  const consecutiveErrorsRef = useRef(0);
  // Remembers the `videoId:index` we've already auto-retried once, so a
  // track that keeps failing falls through to the normal error/skip path
  // instead of looping. Cleared on a successful `playing`.
  const retriedTrackRef = useRef<string | null>(null);
  // When > 0, ignore element `play`/`pause` → store sync. Used while we
  // intentionally pause during track switches (store still wants
  // `playing: true`) so media-key-driven pauses stay the only ones that
  // flip the UI.
  const suppressPlayPauseSyncRef = useRef(0);
  // Bumping this re-runs the resolve effect for the *current* track
  // without any of its real deps changing — used to re-fetch a fresh
  // stream URL after a transient failure (e.g. a googlevideo 403).
  const [retryNonce, setRetryNonce] = useState(0);

  // Ensure a single <audio> element exists.
  useEffect(() => {
    if (audioRef.current) return;
    const el = new Audio();
    el.preload = "auto";
    // Note: do NOT set crossOrigin — googlevideo.com doesn't return CORS
    // headers, and setting it makes the media fail to load in the webview.
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, []);

  // Wire element → store events.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const store = usePlaybackStore.getState;

    const onTimeUpdate = () => {
      store().setPosition(el.currentTime);
    };
    const onDurationChange = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        store().setDuration(el.duration);
      }
    };
    const onEnded = () => {
      store().next();
    };
    const onError = () => {
      const mediaErr = el.error;
      const codeLabels: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED",
        2: "MEDIA_ERR_NETWORK",
        3: "MEDIA_ERR_DECODE",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
      };
      const msg = mediaErr
        ? `${codeLabels[mediaErr.code] ?? `code ${mediaErr.code}`}${
            mediaErr.message ? `: ${mediaErr.message}` : ""
          }`
        : "Unknown audio error";
      if (import.meta.env.DEV) {
        console.error("[audio] element error:", msg, "src=", el.currentSrc);
      }

      // One automatic retry of the SAME track before giving up. Most
      // first-play failures are a transient googlevideo 403 on the media
      // URL: the stream server drops the failed entry immediately, so a
      // re-fetch spawns a fresh yt-dlp resolve that usually succeeds —
      // exactly what a manual re-click does. Only retry a track the user
      // actively wants playing, and only once per track instance.
      {
        const s0 = store();
        const cur0 = s0.index >= 0 ? s0.queue[s0.index] : undefined;
        const key0 = cur0 ? `${cur0.videoId}:${s0.index}` : null;
        if (s0.playing && key0 && retriedTrackRef.current !== key0) {
          retriedTrackRef.current = key0;
          if (import.meta.env.DEV) {
            console.warn("[audio] retrying", key0, "after error:", msg);
          }
          store().setStatus("loading");
          // Small delay so a truly-dead source doesn't hot-loop; also
          // gives the server a beat to tear down the failed download.
          window.setTimeout(() => setRetryNonce((n) => n + 1), 400);
          return;
        }
      }

      store().setStatus("error", msg);

      // Auto-advance: if the user wanted playback and we have a next
      // track, try it. Stop after 3 consecutive failures so a dead
      // network or a poisoned playlist doesn't burn through everything.
      const s = store();
      const hasNext = s.index >= 0 && s.index + 1 < s.queue.length;
      consecutiveErrorsRef.current += 1;
      if (s.playing && hasNext && consecutiveErrorsRef.current <= 3) {
        // Keep `playing: true` so the new track auto-resumes.
        s.next();
      } else {
        s.setPlaying(false);
      }
    };
    const onPlaying = () => {
      consecutiveErrorsRef.current = 0;
      // Track played successfully — allow a fresh auto-retry if it later
      // fails again (e.g. a mid-stream drop on a much later replay).
      retriedTrackRef.current = null;
      store().setStatus("ready");
    };
    const onWaiting = () => {
      // buffering — keep status as ready; don't flip to loading on every gap.
    };

    // Keep the play/pause button in sync when the OS / WebKit toggles the
    // <audio> element directly (macOS media keys / F8 often do this instead
    // of going through our souvlaki `media-control` path). Intentional
    // pauses during track resolve are suppressed via the ref above.
    const onPause = () => {
      if (suppressPlayPauseSyncRef.current > 0) return;
      if (store().playing) store().setPlaying(false);
    };
    const onPlay = () => {
      if (suppressPlayPauseSyncRef.current > 0) return;
      if (!store().playing) store().setPlaying(true);
    };

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("pause", onPause);
    el.addEventListener("play", onPlay);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("play", onPlay);
    };
  }, []);

  // React to current-track changes → resolve stream → set src.
  const { videoId, track, index } = usePlaybackStore(
    useShallow((s) => {
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      return { videoId: t?.videoId, track: t, index: s.index };
    }),
  );

  // Substitute the streaming videoId via the user's per-track source
  // preference (Song ↔ Music Video). Subscribing here means the effect
  // below re-runs and re-resolves the stream when the user toggles the
  // source on the currently playing track.
  const streamVideoId = useTrackSourceStore((s) =>
    videoId ? resolveStreamId(videoId, s.byVideoId) : undefined,
  );

  // Reactive Premium check for the gate below. Subscribing (rather than
  // calling isPremium() inside the effect) makes the resolve effect
  // re-run when the status lands after sign-in / the launch-time probe.
  // Without this, a track gated during the "still checking" window would
  // sit silent until the user re-picked it.
  const premiumOk = usePremiumStore((s) => s.status === "premium");

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // Stop the previous track immediately. Without this the old src keeps
    // playing through the streamUrlFor() round-trip (~50–500 ms), so the
    // user hears the tail of track A bleed into the start of track B.
    // Suppress play/pause→store sync: we still want `playing: true` so the
    // new track auto-resumes once its src is ready. Hold the suppress for
    // a short macrotask window — `pause` may fire async after `el.pause()`.
    suppressPlayPauseSyncRef.current += 1;
    el.pause();
    window.setTimeout(() => {
      suppressPlayPauseSyncRef.current = Math.max(
        0,
        suppressPlayPauseSyncRef.current - 1,
      );
    }, 100);
    if (!streamVideoId) {
      el.removeAttribute("src");
      el.load();
      usePlaybackStore.getState().setStreamUrl(undefined);
      return;
    }
    // Premium gate: signed-out / Free accounts browse but don't stream.
    // Every entry path (track clicks, media keys, tray, floating window,
    // restored queues) funnels through this effect, so one check here
    // guarantees no yt-dlp spawn and no cache write happens without
    // Premium. A deliberate play attempt (playing=true) gets the
    // explainer dialog; the silent preload of a restored queue
    // (playing=false) just parks the track.
    if (!premiumOk) {
      el.removeAttribute("src");
      el.load();
      const store = usePlaybackStore.getState();
      store.setStreamUrl(undefined);
      store.setStatus("idle");
      if (store.playing) {
        store.setPlaying(false);
        openPremiumGate();
      }
      return;
    }
    // Drop the previous track's src immediately. Otherwise a paused→playing
    // transition committed together with the track change (playNow/goTo set
    // playing: true) makes the [playing] effect below re-play the OLD src
    // for the duration of the streamUrlFor() round-trip.
    el.removeAttribute("src");

    const token = ++resolveTokenRef.current;
    usePlaybackStore.getState().setStatus("loading");

    // Persist this track's title/artist beside its cache file so the
    // Storage tab can name it without depending on the library walk.
    // Read from the store imperatively (like the rest of this effect) so
    // the track object doesn't have to join the dependency array.
    {
      const st = usePlaybackStore.getState();
      void saveTrackMeta(
        streamVideoId,
        st.index >= 0 ? st.queue[st.index] : undefined,
      );
    }

    // Playback goes through our local streaming HTTP server. It spawns
    // yt-dlp and pipes the audio bytes progressively so playback starts
    // as soon as the first chunk lands (typically ~200ms after the
    // yt-dlp subprocess starts emitting bytes).
    streamUrlFor(streamVideoId)
      .then((src) => {
        if (token !== resolveTokenRef.current) return;
        if (import.meta.env.DEV) {
          console.debug("[audio] setting src for", videoId, "→", src);
        }
        el.src = src;
        usePlaybackStore.getState().setStreamUrl(src);
        el.load();
        if (usePlaybackStore.getState().playing) {
          void el.play().catch((e) => {
            // AbortError is what we get when a pending play() is
            // interrupted by a new load (e.g. user clicked the next
            // track before the current one started). It's harmless
            // and should never surface to the user.
            if (e?.name === "AbortError") return;
            if (import.meta.env.DEV) {
              console.error("[audio] play() rejected:", e);
            }
            usePlaybackStore
              .getState()
              .setStatus("error", e?.message ?? String(e));
          });
        }
      })
      .catch((e: Error) => {
        if (token !== resolveTokenRef.current) return;
        usePlaybackStore.getState().setStatus("error", e.message);
        usePlaybackStore.getState().setPlaying(false);
      });
    // `index` is in the deps so advancing to a different queue slot that
    // holds the *same* videoId (a duplicate in a playlist, radio dupes)
    // still re-resolves and plays instead of stalling on "loading" —
    // videoId/streamVideoId alone wouldn't change. Repeating a *single*
    // track (repeat-one, or repeat-all on a 1-track queue) keeps the same
    // index, so the store replays it via pendingSeek instead — see
    // `next()` in store/playback.ts. `premiumOk` so that gaining Premium
    // (sign-in, status re-check) re-resolves a track the gate parked.
    // `retryNonce` so the error handler can force a fresh stream-URL fetch
    // for the current track after a transient failure without changing id.
  }, [streamVideoId, videoId, index, premiumOk, retryNonce]);

  // Play / pause follow store.
  const playing = usePlaybackStore((s) => s.playing);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing && !premiumOk) {
      // Resume attempts (play button, Space, SMTC play) on a gated track
      // never reach the resolve effect (its deps don't include
      // `playing`), so intercept them here.
      usePlaybackStore.getState().setPlaying(false);
      openPremiumGate();
      return;
    }
    if (!el.src) return;
    if (playing) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore.getState().setStatus("error", e?.message ?? String(e));
      });
    } else {
      el.pause();
    }
  }, [playing, premiumOk]);

  // Volume / mute follow store.
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // <audio>.volume is linear amplitude (0..1), but loudness perception
    // is logarithmic — a linear slider crams almost all the perceivable
    // change into the bottom ~20% and 20–100% sounds nearly identical.
    // Apply a cubic curve so the slider tracks perceived loudness.
    const clamped = Math.max(0, Math.min(1, volume));
    el.volume = clamped ** 3;
    el.muted = muted;
  }, [volume, muted]);

  // Handle seek requests.
  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || pendingSeek === undefined) return;
    try {
      el.currentTime = pendingSeek;
    } catch {
      /* seek failed — non-fatal */
    }
    usePlaybackStore.getState().clearPendingSeek();
    // repeat-one and error auto-advance re-select the same track and set
    // { pendingSeek: 0, playing: true } without changing `playing` (already
    // true), so the [playing] effect never re-fires. After an `ended` event
    // the element is paused, so seeking to 0 alone leaves it silent. Resume
    // here when the store wants playback but the element is paused.
    if (usePlaybackStore.getState().playing && el.paused && el.src) {
      void el.play().catch((e) => {
        if (e?.name === "AbortError") return;
        usePlaybackStore
          .getState()
          .setStatus("error", e?.message ?? String(e));
      });
    }
  }, [pendingSeek]);

  // Media-key actions can arrive from Media Session and/or souvlaki at once
  // on macOS. Debounce prev/next so a single physical keypress can't skip
  // two tracks.
  const lastSkipAtRef = useRef(0);
  const runSkip = (dir: "prev" | "next") => {
    const now = performance.now();
    if (now - lastSkipAtRef.current < 250) return;
    lastSkipAtRef.current = now;
    const store = usePlaybackStore.getState();
    if (dir === "prev") store.prev();
    else store.next();
  };

  // macOS media keys (F7 previous / F9 next): WKWebView routes hardware media
  // keys through the page Media Session while <audio> is active. Without these
  // handlers F7/F9 often do nothing (F8 still works by toggling the element).
  // On Windows MediaSessionService is disabled and souvlaki owns the keys —
  // registering here is a no-op there and does not recreate the SMTC tile.
  // Re-bind when the current track changes: WebKit sometimes drops handlers
  // across source swaps on the <audio> element.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    const store = () => usePlaybackStore.getState();

    const bind = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Not every action is supported on every engine.
      }
    };

    bind("play", () => store().setPlaying(true));
    bind("pause", () => store().setPlaying(false));
    bind("previoustrack", () => runSkip("prev"));
    bind("nexttrack", () => runSkip("next"));
    bind("seekto", (details) => {
      if (typeof details.seekTime === "number") {
        store().seek(details.seekTime);
      }
    });
    // Music-player semantics for keyboard media keys: treat seek± as
    // prev/next (restart / skip), not ±10s scrub.
    bind("seekbackward", () => runSkip("prev"));
    bind("seekforward", () => runSkip("next"));

    return () => {
      for (const action of [
        "play",
        "pause",
        "previoustrack",
        "nexttrack",
        "seekto",
        "seekbackward",
        "seekforward",
      ] as const) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebind on track identity
  }, [track?.videoId]);

  // Fallback when F7/F9 are delivered as normal function keys (System Settings
  // → Keyboard → "Use F1, F2, etc. keys as standard function keys") or as the
  // MediaTrack* key values some engines emit.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "F7" || e.key === "MediaTrackPrevious") {
        e.preventDefault();
        runSkip("prev");
      } else if (e.key === "F9" || e.key === "MediaTrackNext") {
        e.preventDefault();
        runSkip("next");
      } else if (e.key === "MediaPlayPause" || e.key === "F8") {
        // F8 usually already toggles <audio>; only handle the explicit media
        // key name so we don't fight WebKit on F8.
        if (e.key === "MediaPlayPause") {
          e.preventDefault();
          usePlaybackStore.getState().toggle();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tray menu commands come via a Tauri event. `cancelled` flag
  // protects against StrictMode's mount→unmount→mount race that
  // would otherwise leak duplicate listeners and double-call
  // `toggle()` (which would silently no-op the play/pause hotkey).
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<string>("tray-action", (e) => {
      const store = usePlaybackStore.getState();
      if (e.payload === "play_pause") store.toggle();
      else if (e.payload === "prev") store.prev();
      else if (e.payload === "next") store.next();
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // SMTC / media-key button presses arrive from Rust (souvlaki /
  // MPRemoteCommandCenter) as a `media-control` event. `cancelled` guards
  // against StrictMode's mount→unmount→mount double-listen, like the tray
  // listener.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen<{ action: string; position?: number }>("media-control", (e) => {
      const store = usePlaybackStore.getState();
      switch (e.payload.action) {
        case "play":
          store.setPlaying(true);
          break;
        case "pause":
        case "stop":
          store.setPlaying(false);
          break;
        case "toggle":
          store.toggle();
          break;
        case "next":
          runSkip("next");
          break;
        case "previous":
          runSkip("prev");
          break;
        case "seek":
          if (typeof e.payload.position === "number") store.seek(e.payload.position);
          break;
      }
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSkip via stable ref
  }, []);

  // Prefetch the next queued track in the background while the current
  // one plays. First-time plays take ~2s (yt-dlp resolve + first audio
  // chunk); by the time the user hits "next" the file is cached on
  // disk and playback starts instantly with full seek support.
  const status = usePlaybackStore((s) => s.status);
  const { nextVideoId } = usePlaybackStore(
    useShallow((s) => ({
      nextVideoId:
        s.index >= 0 && s.index + 1 < s.queue.length
          ? s.queue[s.index + 1].videoId
          : undefined,
    })),
  );
  // Substitute via source-prefs for the prefetch too — otherwise we'd
  // warm the cache for the wrong stream when the user has switched the
  // upcoming track to its video version.
  const nextStreamVideoId = useTrackSourceStore((s) =>
    nextVideoId ? resolveStreamId(nextVideoId, s.byVideoId) : undefined,
  );
  useEffect(() => {
    if (status !== "ready") return;
    if (!nextStreamVideoId) return;
    void prefetchStream(nextStreamVideoId);
    // Label the prefetched file too — same reasoning as the play path.
    const st = usePlaybackStore.getState();
    void saveTrackMeta(
      nextStreamVideoId,
      st.index >= 0 && st.index + 1 < st.queue.length
        ? st.queue[st.index + 1]
        : undefined,
    );
  }, [status, nextStreamVideoId]);

  // Auto-extend the queue with radio tracks when we're near the end, so
  // playback continues past the explicit queue.
  const autoRadio = usePlaybackStore((s) => s.autoRadio);
  const { qLen, qIndex, seedVideoId } = usePlaybackStore(
    useShallow((s) => ({
      qLen: s.queue.length,
      qIndex: s.index,
      seedVideoId:
        s.index >= 0 ? s.queue[s.index]?.videoId : undefined,
    })),
  );
  const radioFetchedForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!autoRadio) return;
    if (qIndex < 0 || !seedVideoId) return;
    // Only fire when the current track is the last queued one.
    if (qIndex < qLen - 1) return;
    if (radioFetchedForRef.current === seedVideoId) return;
    radioFetchedForRef.current = seedVideoId;
    fetchRadio(seedVideoId)
      .then((tracks) => {
        // Guard against a stale fetch: the user may have replaced the queue
        // (playNow/setQueue) while the radio request was in flight. Only
        // append if this seed is still the current, last-in-queue track.
        const s = usePlaybackStore.getState();
        const cur = s.index >= 0 ? s.queue[s.index]?.videoId : undefined;
        if (cur !== seedVideoId || s.index < s.queue.length - 1) return;
        const rest = tracks.filter((t) => t.id !== seedVideoId);
        if (rest.length) s.appendToQueue(rest);
      })
      .catch(() => {
        // Allow a retry on transient failure.
        radioFetchedForRef.current = undefined;
      });
  }, [autoRadio, qIndex, qLen, seedVideoId]);

  // Push metadata + playback state to the OS media controls (Windows SMTC /
  // macOS Now Playing via souvlaki) and keep the page Media Session metadata
  // in sync so WKWebView keeps advertising previous/next for F7/F9. Windows
  // interpolates the scrubber between pushes while Playing, so we don't push
  // on every timeupdate — just on track / play-state / duration change, plus a
  // light 2s refresh while playing to correct drift and reflect seeks. Live
  // values are read imperatively so this OS sync never re-triggers the resolve
  // / playback effects above.
  const duration = usePlaybackStore((s) => s.duration);
  useEffect(() => {
    const pushOs = () => {
      const s = usePlaybackStore.getState();
      const t = s.index >= 0 ? s.queue[s.index] : undefined;
      if (!t) {
        void invoke("media_clear").catch(() => {});
        return;
      }
      void invoke("media_update", {
        title: t.title,
        artist: buildArtistLabel(t),
        album: t.album ?? "",
        thumbnail: pickThumbnail(t.thumbnails, 512) ?? "",
        duration: Number.isFinite(s.duration) ? s.duration : 0,
        elapsed: s.position,
        paused: !s.playing,
      }).catch(() => {});
    };

    // Media Session metadata/state: only on dep change (not the 2s tick).
    // Action handlers are registered once above; this keeps the session
    // "live" so macOS keeps routing F7/F9 here while audio is playing.
    if ("mediaSession" in navigator) {
      try {
        const s = usePlaybackStore.getState();
        const t = s.index >= 0 ? s.queue[s.index] : undefined;
        if (!t) {
          navigator.mediaSession.metadata = null;
          navigator.mediaSession.playbackState = "none";
        } else {
          const thumbnail = pickThumbnail(t.thumbnails, 512) ?? "";
          navigator.mediaSession.metadata = new MediaMetadata({
            title: t.title,
            artist: buildArtistLabel(t),
            album: t.album || undefined,
            artwork: thumbnail
              ? [{ src: thumbnail, sizes: "512x512", type: "image/jpeg" }]
              : undefined,
          });
          navigator.mediaSession.playbackState = s.playing
            ? "playing"
            : "paused";
          const dur = Number.isFinite(s.duration) ? s.duration : 0;
          if (dur > 0) {
            navigator.mediaSession.setPositionState?.({
              duration: dur,
              playbackRate: 1,
              position: Math.min(Math.max(0, s.position), dur),
            });
          }
        }
      } catch {
        /* ignore unsupported engines */
      }
    }

    pushOs();
    if (!playing) return;
    const id = window.setInterval(pushOs, 2000);
    return () => window.clearInterval(id);
  }, [track, playing, duration]);

  // Discord Rich Presence mirrors the same metadata, but pushed only on
  // track / play-state / duration change — never the 2s position refresh
  // above. Discord rate-limits activity updates, and it derives its own
  // progress bar from the start/end timestamps, so one push animates the bar
  // for the whole song. The worker + (re)connect lifecycle live in
  // src-tauri/src/discord.rs; the on/off toggle is mirrored separately by
  // useDiscordPresenceSync, which also clears the activity when disabled.
  const discordRp = useSettingsStore((s) => s.discordRichPresence);
  useEffect(() => {
    if (!discordRp) return; // disabled → useDiscordPresenceSync cleared it
    const s = usePlaybackStore.getState();
    const t = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!t) {
      void invoke("discord_clear").catch(() => {});
      return;
    }
    const dur = Number.isFinite(s.duration) ? s.duration : 0;
    // Timestamps (hence the progress bar) only while actually playing: Discord
    // can't freeze a bar, so paused shows none rather than a wrong one. Unix
    // milliseconds, per Discord's Activity spec.
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (s.playing && dur > 0) {
      startMs = Math.round(Date.now() - s.position * 1000);
      endMs = Math.round(startMs + dur * 1000);
    }
    void invoke("discord_update", {
      title: t.title,
      artist: buildArtistLabel(t),
      album: t.album ?? "",
      imageUrl: pickThumbnail(t.thumbnails, 512) ?? "",
      startMs,
      endMs,
    }).catch(() => {});
  }, [track, playing, duration, discordRp]);
}

function buildArtistLabel(track: QueueTrack): string {
  if (track.artists?.length) return track.artists.map((a) => a.name).join(", ");
  return track.subtitle ?? "";
}
