// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pendingLikedSongs = vi.hoisted(() => {
  let resolvePromise!: (tracks: unknown[]) => void;
  const promise = new Promise<unknown[]>((resolve) => {
    resolvePromise = resolve;
  });
  return { calls: 0, promise, resolve: resolvePromise };
});

vi.mock("@/lib/innertube/library", () => ({
  fetchLikedSongs: vi.fn(() => {
    if (pendingLikedSongs.calls++ === 0) return pendingLikedSongs.promise;
    return Promise.resolve([
      {
        id: "issue-62-track",
        kind: "song",
        title: "Issue 62",
        thumbnails: [],
      },
      {
        id: "existing-liked-track",
        kind: "song",
        title: "Already liked",
        thumbnails: [],
      },
    ]);
  }),
}));

vi.mock("@/lib/innertube/mutations", () => ({
  likeTrack: vi.fn(async () => undefined),
  removeRating: vi.fn(async () => undefined),
  dislikeTrack: vi.fn(async () => undefined),
  fetchUserPlaylists: vi.fn(async () => []),
  addToPlaylist: vi.fn(async () => undefined),
  createPlaylistWithTrack: vi.fn(async () => undefined),
  removeFromPlaylist: vi.fn(async () => undefined),
}));

vi.mock("@/lib/innertube/radio", () => ({
  fetchRadio: vi.fn(async () => []),
}));

vi.mock("@/lib/lastfm", () => ({
  syncLastfmLove: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { LikeDislikeButtons } from "@/components/shared/like-buttons";
import { useTrackMenuController } from "@/components/shared/track-context-menu";
import { fetchLikedSongs } from "@/lib/innertube/library";
import type { ShelfItem } from "@/lib/innertube/types";

const item: ShelfItem = {
  id: "issue-62-track",
  kind: "song",
  title: "Issue 62",
  thumbnails: [],
};

let runContextLike: (() => Promise<void>) | undefined;

function Reproduction() {
  const controller = useTrackMenuController(item);
  runContextLike = controller.runLike;
  return React.createElement(LikeDislikeButtons, {
    videoId: item.id,
    track: item,
  });
}

function heart(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-label="Add to liked"], [aria-label="Remove from liked"]',
  );
  if (!button) throw new Error("Heart button was not rendered");
  return button;
}

describe("issue 62", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the heart filled when a pre-like fetch resolves last", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Reproduction),
        ),
      );
    });

    expect(heart(container).getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      await runContextLike!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(heart(container).getAttribute("aria-pressed")).toBe("true");

    // Complete the snapshot that started before runLike. Its stale result
    // must not overwrite the successful mutation's cache update.
    await act(async () => {
      pendingLikedSongs.resolve([]);
      await pendingLikedSongs.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(heart(container).getAttribute("aria-pressed")).toBe("true");
    expect(fetchLikedSongs).toHaveBeenCalledTimes(2);
    expect(
      queryClient
        .getQueryData<ShelfItem[]>(["liked-songs"])
        ?.map((track) => track.id),
    ).toEqual(["issue-62-track", "existing-liked-track"]);
  });
});
