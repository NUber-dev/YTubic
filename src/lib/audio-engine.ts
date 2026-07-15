import { useEffect, useMemo, useRef, useState } from "react";
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
  wantsVideoStream,
} from "@/lib/store/track-source";
import { findCleanAudioAlternate } from "@/lib/innertube/alternate-source";
import { fetchPanelDuration } from "@/lib/innertube/radio";
import { pickThumbnail } from "@/components/shared/thumbnail";
import { useLyricsSources } from "@/lib/lyrics/sources";
import { correctedDuration, shouldSkipOutro } from "@/lib/outro";

/**
 * AudioEngine binds the playback store to a singleton HTMLAudioElement
 * and drives the OS media controls (Windows SMTC) from Rust via souvlaki (see
 * the media effects below and src-tauri/src/media.rs) rather than the webview's
 * own media session — that one runs in the WebView2 child process and shows up
 * as "Unknown app" in the Windows Now Playing tile.
 *
 * Mount this hook once, near the root. It owns the <audio> element's lifecycle.
 */
// The engine's singleton element, exposed so the fullscreen player can
// adopt it as a visible surface when the current stream is a video file.
let mediaElSingleton: HTMLVideoElement | null = null;
export function getMediaElement(): HTMLVideoElement | null {
  return mediaElSingleton;
}

export function useAudioEngine() {
  const audioRef = useRef<HTMLVideoElement | null>(null);
  // Guard against stale stream resolutions when the user skips mid-fetch.
  const resolveTokenRef = useRef(0);
  // Counts how many tracks have failed in a row without a successful
  // play in between. Reset to 0 on `playing`. Used to short-circuit
  // auto-skip after a few consecutive failures so we don't burn through
  // the whole queue if e.g. the network is dead.
  const consecutiveErrorsRef = useRef(0);
  // videoIds we've already run an audio-hunt for, so the same track doesn't
  // re-trigger a search on every re-render or seek.
  const huntedRef = useRef<Set<string>>(new Set());
  // Long-outro auto-advance bookkeeping: the last sung line's timestamp
  // for the current track, the videoId we already advanced past (never
  // twice), and the videoId whose outro the user deliberately seeked
  // into (respect that — they want to hear it).
  const lastVocalRef = useRef<number | null>(null);
  // Raw element-reported duration (pre-correction) so the end guard can
  // recognise the doubled-header case even after the store was clamped.
  const rawElDurationRef = useRef(0);
  const outroSkippedRef = useRef<string | null>(null);
  const outroSuppressedRef = useRef<string | null>(null);
  // Remembers the `videoId:index` we've already auto-retried once, so a
  // track that keeps failing falls through to the normal error/skip path
  // instead of looping. Cleared on a successful `playing`.
  const retriedTrackRef = useRef<string | null>(null);
  // Bumping this re-runs the resolve effect for the *current* track
  // without any of its real deps changing — used to re-fetch a fresh
  // stream URL after a transient failure (e.g. a googlevideo 403).
  const [retryNonce, setRetryNonce] = useState(0);

  // Ensure a single media element exists. It's a <video> element, not
  // new Audio(): for audio-only streams the two behave identically, but
  // when the user switches a track to its video source the same element
  // carries the picture and the fullscreen player adopts it as a live
  // surface (getMediaElement above).
  useEffect(() => {
    if (audioRef.current) return;
    const el = document.createElement("video");
    el.preload = "auto";
    el.playsInline = true;
    // Note: do NOT set crossOrigin — googlevideo.com doesn't return CORS
    // headers, and setting it makes the media fail to load in the webview.
    audioRef.current = el;
    mediaElSingleton = el;
    return () => {
      el.pause();
      el.src = "";
      el.remove();
      audioRef.current = null;
      mediaElSingleton = null;
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
        rawElDurationRef.current = el.duration;
        const cur = store();
        const meta =
          cur.index >= 0 ? cur.queue[cur.index]?.duration : undefined;
        cur.setDuration(correctedDuration(meta, el.duration));
      } else if (el.duration === Infinity) {
        // Streaming containers (progressively served webm) report
        // Infinity until fully buffered, which left the bar showing the
        // LISTED length while the real file ran longer, so the bar pinned
        // at full with audio still playing. The seekable range end is
        // the truth the server actually has; it grows monotonically to
        // the real length as the download completes.
        syncSeekableDuration();
      }
    };
    const syncSeekableDuration = () => {
      if (el.duration !== Infinity || el.seekable.length === 0) return;
      const end = el.seekable.end(el.seekable.length - 1);
      if (!Number.isFinite(end) || end <= 0) return;
      const cur = store();
      if (end > cur.duration + 0.5) {
        rawElDurationRef.current = end;
        const meta =
          cur.index >= 0 ? cur.queue[cur.index]?.duration : undefined;
        cur.setDuration(correctedDuration(meta, end));
      }
    };
    const onProgress = () => syncSeekableDuration();
    const onEnded = () => {
      store().next();
    };
    // External pause/play — the system Now Playing widget or WebKit's
    // built-in media session can pause the element directly, bypassing
    // the store, which left the UI showing a stale playing state. Sync
    // the element's actual state back. Track changes pause the element
    // too, but by the time the queued pause event runs the status is
    // already "loading", so the ready-guard keeps auto-play intact.
    const onElPause = () => {
      const s = store();
      if (s.status === "ready" && s.playing && !el.ended) {
        s.setPlaying(false);
      }
    };
    const onElPlay = () => {
      const s = store();
      if (s.status === "ready" && !s.playing) {
        s.setPlaying(true);
      }
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

      // A music-video stream the webview can't decode (MEDIA_ERR_DECODE /
      // MEDIA_ERR_SRC_NOT_SUPPORTED) shouldn't surface a raw error banner
      // or skip the track. While the video source is the selected one,
      // drop it back to audio and let the resolve effect retry with the
      // song stream, which every track has. The selected-source check
      // keeps this from looping: once we're on audio a repeat failure
      // falls through to the normal error path below.
      const errored = store();
      const cur =
        errored.index >= 0 ? errored.queue[errored.index] : undefined;
      if (cur && (mediaErr?.code === 3 || mediaErr?.code === 4)) {
        const ts = useTrackSourceStore.getState();
        const selected = ts.byVideoId[cur.videoId]?.selected ?? "song";
        if (selected === "video") {
          if (import.meta.env.DEV) {
            console.warn(
              "[audio] video stream failed to decode, falling back to audio:",
              cur.videoId,
            );
          }
          ts.setSelected(cur.videoId, "song");
          return;
        }
      }

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

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("progress", onProgress);
    el.addEventListener("ended", onEnded);
    el.addEventListener("pause", onElPause);
    el.addEventListener("play", onElPlay);
    el.addEventListener("error", onError);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("pause", onElPause);
      el.removeEventListener("play", onElPlay);
      el.removeEventListener("error", onError);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
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

  // True only when the user explicitly switched this track to its video
  // source — then the stream request carries ?video=1 and the element
  // has real frames to show.
  const wantVideo = useTrackSourceStore((s) =>
    videoId ? wantsVideoStream(videoId, s.byVideoId) : false,
  );

  // Tracks queued from surfaces without a length (home cards) carry no
  // duration, which leaves the doubled-header clamp with no reference —
  // a 2x file then displays and scrubs at twice its real length. Fetch
  // the authoritative length from the track's own /next row once and
  // patch the queue entry; the re-clamp effect below applies it.
  useEffect(() => {
    if (!videoId) return;
    const cur = usePlaybackStore.getState();
    const track = cur.index >= 0 ? cur.queue[cur.index] : undefined;
    if (!track || track.videoId !== videoId || track.duration) return;
    let cancelled = false;
    fetchPanelDuration(videoId)
      .then((secs) => {
        if (cancelled || !secs) return;
        usePlaybackStore.getState().patchTrackDuration(videoId, secs);
      })
      .catch(() => {
        /* metadata nicety only — the element duration stays */
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Re-apply the header clamp when the metadata length lands AFTER the
  // element already reported durationchange (the late-fetch above).
  const liveMetaDuration = usePlaybackStore((s) =>
    s.index >= 0 ? s.queue[s.index]?.duration : undefined,
  );
  useEffect(() => {
    if (!liveMetaDuration || !rawElDurationRef.current) return;
    usePlaybackStore
      .getState()
      .setDuration(
        correctedDuration(liveMetaDuration, rawElDurationRef.current),
      );
  }, [liveMetaDuration]);

  // Reactive Premium check for the gate below. Subscribing (rather than
  // calling isPremium() inside the effect) makes the resolve effect
  // re-run when the status lands after sign-in / the launch-time probe.
  // Without this, a track gated during the "still checking" window would
  // sit silent until the user re-picked it.
  const premiumOk = usePremiumStore((s) => s.status === "premium");

  // Seed the song<->video pairing from InnerTube's own counterpart data
  // (from a /next `playlistPanelVideoWrapperRenderer`) so the Source
  // toggle flips to the real other version instead of a fuzzy search that
  // can land on an unrelated clip. Only when we have a pairing and no
  // record yet; `selected` lands on whichever kind was queued, so the
  // default stream doesn't change and no wasteful re-resolve fires.
  const counterpartId = track?.counterpartId;
  const trackKind = track?.kind;
  useEffect(() => {
    if (!videoId || !counterpartId || !trackKind) return;
    const ts = useTrackSourceStore.getState();
    if (ts.byVideoId[videoId]) return;
    const counterpartKind = trackKind === "video" ? "song" : "video";
    ts.setAlternate(videoId, counterpartKind, counterpartId);
  }, [videoId, counterpartId, trackKind]);

  // Auto-hunt the clean album ("song") version of whatever was queued.
  // Originally this only rescued kind==="video" rows, but extended/looped
  // re-uploads also surface as ordinary song rows (a 7:45 "(Remix)" that
  // keeps rolling minutes after the actual song ends), so it now fires for
  // any kind and leans on findCleanAudioAlternate's guarantees instead:
  // artists must exist (a bare title is not identity — a wrong swap here
  // changes what's PLAYING, worse than wrong lyrics), the found title has
  // to match, and the duration gate only ever swaps to a meaningfully
  // shorter album version (or a near-equal one for true video rows).
  // Fires once per id; /next counterpart data (handled above) and manual
  // Song/Video choices both take precedence.
  const huntTitle = track?.title;
  useEffect(() => {
    // Video rows only. The kind-agnostic expansion was chasing what
    // turned out to be the doubled-header bug (see correctedDuration) —
    // and for a normal song row an aggressively shorter "match" is a
    // sped-up bootleg, not a cleaner version.
    if (!videoId || trackKind !== "video") return;
    if (huntedRef.current.has(videoId)) return;
    const ts = useTrackSourceStore.getState();
    // A record alone doesn't mean "leave it alone": the counterpart
    // seeding above creates one for every popular song (song = the row
    // itself + its music video), which used to block the hunt exactly
    // where it's most needed. Only back off when the song side already
    // points elsewhere (a previous hunt or manual pick) or the user
    // explicitly selected the video source.
    const rec = ts.byVideoId[videoId];
    if (rec && (rec.song !== videoId || rec.selected === "video")) return;
    huntedRef.current.add(videoId);
    const s = usePlaybackStore.getState();
    const cur = s.index >= 0 ? s.queue[s.index] : undefined;
    if (!cur || cur.videoId !== videoId) return;
    void findCleanAudioAlternate({
      videoId,
      title: cur.title,
      artists: cur.artists,
      kind: cur.kind,
      duration: cur.duration,
    })
      .then((altId) => {
        if (!altId) return;
        // Bail if a manual choice or /next pairing landed while we searched.
        const now = useTrackSourceStore.getState();
        if (now.byVideoId[videoId]) return;
        now.setAlternate(videoId, "song", altId);
        now.setSelected(videoId, "song");
      })
      .catch(() => {
        /* stay on the queued source; a later manual switch still works */
      });
  }, [videoId, trackKind, huntTitle]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    // Stop the previous track immediately. Without this the old src keeps
    // playing through the streamUrlFor() round-trip (~50–500 ms), so the
    // user hears the tail of track A bleed into the start of track B.
    el.pause();
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
    streamUrlFor(streamVideoId, { video: wantVideo })
      .then((src) => {
        if (token !== resolveTokenRef.current) return;
        if (import.meta.env.DEV) {
          console.debug("[audio] setting src for", videoId, "→", src);
        }
        el.src = src;
        const st = usePlaybackStore.getState();
        st.setStreamUrl(src);
        st.setStreamKind(wantVideo ? "video" : "audio");
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
  }, [streamVideoId, wantVideo, videoId, index, premiumOk, retryNonce]);

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
    // A deliberate seek into the tail means the user wants the outro —
    // disable the long-outro auto-advance for this track.
    if (
      videoId &&
      ((lastVocalRef.current !== null &&
        pendingSeek > lastVocalRef.current + 10) ||
        (() => {
          const cur =
            usePlaybackStore.getState().queue[
              usePlaybackStore.getState().index
            ];
          return !!cur?.duration && pendingSeek > cur.duration;
        })())
    ) {
      outroSuppressedRef.current = videoId;
    }
    {
      // Keep the system Now Playing clock in step with the new playhead.
      const s = usePlaybackStore.getState();
      const cur = s.index >= 0 ? s.queue[s.index] : undefined;
      const dur = s.duration > 0 ? s.duration : (cur?.duration ?? 0);
      pushNowPlaying(cur, s.playing, pendingSeek, dur);
    }
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

  // OS media controls (Windows SMTC) are driven from Rust via souvlaki, not
  // navigator.mediaSession — the webview's own media session shows up as
  // "Unknown app" because it belongs to the WebView2 child process. Metadata /
  // state is pushed by the media_update effect lower down; buttons come back
  // via the media-control listener. See src-tauri/src/media.rs.

  // Mirror metadata + play state into the macOS system Now Playing panel
  // (Control Center / Touch Bar / media keys / AirPods). A WKWebView only
  // bridges navigator.mediaSession to Windows SMTC, not to macOS, so the
  // native side handles it. Fires on track change and play/pause; the
  // seek effect below pushes the new elapsed time.
  useEffect(() => {
    const s = usePlaybackStore.getState();
    const dur = s.duration > 0 ? s.duration : (track?.duration ?? 0);
    pushNowPlaying(track, playing, s.position, dur);
  }, [track, playing]);

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

  // macOS remote-command events from MPRemoteCommandCenter (Control
  // Center, media keys, AirPods). The native side emits these; drive the
  // same store the in-app transport uses. Never fires off macOS.
  useEffect(() => {
    let cancelled = false;
    const disposers: Array<() => void> = [];
    const keep = (un: () => void) => {
      if (cancelled) un();
      else disposers.push(un);
    };
    void listen<string>("media-remote", (e) => {
      const store = usePlaybackStore.getState();
      switch (e.payload) {
        case "play":
          store.setPlaying(true);
          break;
        case "pause":
          store.setPlaying(false);
          break;
        case "toggle":
          store.toggle();
          break;
        case "next":
          store.next();
          break;
        case "prev":
          store.prev();
          break;
      }
    })
      .then(keep)
      .catch((e) => console.error("[media-remote] listen failed", e));
    void listen<number>("media-remote-seek", (e) => {
      if (typeof e.payload === "number") {
        usePlaybackStore.getState().seek(e.payload);
      }
    })
      .then(keep)
      .catch((e) => console.error("[media-remote] listen failed", e));
    return () => {
      cancelled = true;
      disposers.forEach((d) => d());
    };
  }, []);


  // SMTC / media-key button presses arrive from Rust (souvlaki) as a
  // `media-control` event. Drive the store the same way the old
  // navigator.mediaSession action handlers did. `cancelled` guards against
  // StrictMode's mount→unmount→mount double-listen, like the tray listener.
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
          store.next();
          break;
        case "previous":
          store.prev();
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
  }, []);

  // System media commands on macOS route through WKWebView's media
  // session — upstream removed these handlers when souvlaki took over
  // on Windows, which left the mac widget's buttons acting on the
  // element directly and desyncing the store. Mac-only: Windows keeps
  // the souvlaki media-control path.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    if (!navigator.userAgent.includes("Mac")) return;
    const api = navigator.mediaSession;
    const store = usePlaybackStore.getState;
    api.setActionHandler("play", () => store().setPlaying(true));
    api.setActionHandler("pause", () => store().setPlaying(false));
    api.setActionHandler("previoustrack", () => store().prev());
    api.setActionHandler("nexttrack", () => store().next());
    api.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") store().seek(details.seekTime);
    });
    return () => {
      api.setActionHandler("play", null);
      api.setActionHandler("pause", null);
      api.setActionHandler("previoustrack", null);
      api.setActionHandler("nexttrack", null);
      api.setActionHandler("seekto", null);
    };
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

  // Push metadata + playback state to the OS media controls (Windows SMTC).
  // Windows interpolates the scrubber between pushes while the state is
  // Playing, so we don't push on every timeupdate — just on track / play-state
  // / duration change, plus a light 2s refresh while playing to correct drift
  // and reflect seeks. Live values are read imperatively so this OS sync never
  // re-triggers the resolve / playback effects above.
  const duration = usePlaybackStore((s) => s.duration);
  const position = usePlaybackStore((s) => s.position);

  // Long-outro auto-advance. Extended uploads and music-video audio can
  // run minutes past the actual song; when the synced lyrics say the
  // vocals ended long ago (see shouldSkipOutro's thresholds), move on.
  // Reuses the same lyric queries the panel fires, so this costs no
  // extra network beyond what the lyrics UI already does.
  const { queries: lyricQueries, best: lyricBest } = useLyricsSources(
    track,
    !!track,
  );
  const lastVocal = useMemo(() => {
    const data = lyricBest ? lyricQueries[lyricBest]?.data : null;
    if (!data || data.kind !== "timed" || data.lines.length === 0) {
      return null;
    }
    // Trailing "♪" instrumental markers aren't vocals — walk back to the
    // last line with real text.
    for (let i = data.lines.length - 1; i >= 0; i--) {
      const line = data.lines[i];
      const text = line.text.trim();
      if (text && text !== "♪") return line.end ?? line.start;
    }
    return null;
  }, [lyricBest, lyricQueries]);
  useEffect(() => {
    lastVocalRef.current = lastVocal;
  }, [lastVocal]);
  // Metadata-end guard: some YT entries stream audio whose container
  // claims a far longer duration than the entry's own listed length
  // (a "4:21" row whose element reports 8:41). The listed metadata
  // length is the song; once playback runs meaningfully past it while
  // the element believes in a much longer file, move on. Seeking past
  // the listed end disables it for that track (same suppression as the
  // outro skip — a deliberate listen wins).
  const metaDuration = track?.duration ?? 0;
  useEffect(() => {
    if (!playing || !videoId) return;
    if (outroSkippedRef.current === videoId) return;
    if (outroSuppressedRef.current === videoId) return;
    if (
      metaDuration > 60 &&
      rawElDurationRef.current > metaDuration * 1.5 &&
      position > metaDuration + 2
    ) {
      outroSkippedRef.current = videoId;
      usePlaybackStore.getState().next();
    }
  }, [position, duration, metaDuration, playing, videoId]);

  useEffect(() => {
    if (!playing || !videoId || !lastVocal) return;
    if (outroSkippedRef.current === videoId) return;
    if (outroSuppressedRef.current === videoId) return;
    if (shouldSkipOutro(position, duration, lastVocal)) {
      outroSkippedRef.current = videoId;
      if (import.meta.env.DEV) {
        console.debug(
          "[audio] long outro: advancing",
          videoId,
          `pos=${Math.round(position)}s lastVocal=${Math.round(lastVocal)}s dur=${Math.round(duration)}s`,
        );
      }
      usePlaybackStore.getState().next();
    }
  }, [position, duration, playing, videoId, lastVocal]);
  useEffect(() => {
    const push = () => {
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
    push();
    if (!playing) return;
    const id = window.setInterval(push, 2000);
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

/**
 * Push the current track into the macOS system Now Playing panel. The
 * Rust command is a no-op off macOS, and the invoke is swallowed if the
 * command isn't registered, so this is safe to call unconditionally.
 *
 * MPNowPlayingInfoCenter extrapolates the playhead from `elapsed` +
 * `playbackRate`, so we only push on track change, play/pause, and seek
 * rather than on every timeupdate.
 */
function pushNowPlaying(
  track: QueueTrack | undefined,
  playing: boolean,
  elapsed: number,
  duration: number,
): void {
  const info = track
    ? {
        title: track.title,
        artist: buildArtistLabel(track),
        album: track.album ?? "",
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        elapsed: Math.max(0, elapsed),
        playbackRate: playing ? 1 : 0,
      }
    : { title: "", artist: "", album: "", duration: 0, elapsed: 0, playbackRate: 0 };
  void invoke("set_now_playing", { info }).catch(() => {
    /* command only present on the desktop build; ignore otherwise */
  });
}
