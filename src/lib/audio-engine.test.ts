// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_MAC: true }));
vi.mock("@/lib/stream", () => ({
  streamUrlFor: vi.fn(async () => "http://127.0.0.1:1234/stream/test"),
  saveTrackMeta: vi.fn(async () => {}),
  prefetchStream: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({}),
}));

import { useAudioEngine } from "@/lib/audio-engine";
import { usePlaybackStore } from "@/lib/store/playback";
import { usePremiumStore } from "@/lib/store/premium";

function Engine() {
  useAudioEngine();
  return null;
}

describe("macOS Repeat One", () => {
  const audioElements: HTMLAudioElement[] = [];
  let root: ReturnType<typeof createRoot>;
  let play: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    audioElements.length = 0;
    vi.stubGlobal("Audio", function () {
      const el = document.createElement("audio");
      audioElements.push(el);
      return el;
    });
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    usePremiumStore.setState({ status: "premium" });
    usePlaybackStore.setState({
      queue: [{ videoId: "test", title: "Test", thumbnails: [] }],
      index: 0,
      playing: true,
      repeat: "one",
      position: 0,
      duration: 257,
      pendingSeek: undefined,
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mount = async () => {
    await act(async () => root.render(createElement(Engine)));
    const el = audioElements[0];
    Object.defineProperty(el, "duration", { configurable: true, value: 257 });
    expect(el.src).toContain("/stream/test");
    return el;
  };

  it("restarts the active element when it dispatches ended", async () => {
    const el = await mount();
    el.currentTime = 257;
    play.mockClear();

    act(() => el.dispatchEvent(new Event("ended")));

    expect(el.currentTime).toBe(0);
    expect(usePlaybackStore.getState().position).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("restarts when WebKit stalls at the final frame without ended", async () => {
    const el = await mount();
    el.currentTime = 256.8;
    play.mockClear();

    act(() => vi.advanceTimersByTime(2500));

    expect(el.currentTime).toBe(0);
    expect(usePlaybackStore.getState().position).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not restart a paused or non-repeating track", async () => {
    const el = await mount();
    el.currentTime = 256.8;
    act(() => usePlaybackStore.setState({ playing: false }));
    play.mockClear();
    act(() => vi.advanceTimersByTime(3000));
    expect(play).not.toHaveBeenCalled();

    act(() => usePlaybackStore.setState({ playing: true, repeat: "off" }));
    play.mockClear();
    act(() => vi.advanceTimersByTime(3000));
    expect(play).not.toHaveBeenCalled();
    expect(el.currentTime).toBe(256.8);
  });
});
