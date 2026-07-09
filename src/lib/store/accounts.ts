import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resetInnertube } from "@/lib/innertube/client";
import { fetchAccountInfo } from "@/lib/innertube/account";
import { fetchChannelList } from "@/lib/innertube/channels";
import { clearPrefetchMemo } from "@/lib/stream";
import { openChannelPicker } from "@/lib/store/channel-picker";
import { usePlaybackStore } from "@/lib/store/playback";
import { usePinnedPlaylistsStore } from "@/lib/store/pinned-playlists";
import { usePremiumStore } from "@/lib/store/premium";
import { useSearchHistory } from "@/lib/store/search-history";
import { useTrackSourceStore } from "@/lib/store/track-source";

export type AccountSummary = {
  id: string;
  email: string;
  name: string;
  photoUrl: string | null;
  /** Brand-channel page id this account acts as; null = personal channel. */
  pageId: string | null;
  channelName: string | null;
  channelPhotoUrl: string | null;
  isActive: boolean;
};

/**
 * List of all accounts the user has signed into. `isActive` is derived
 * on the Rust side from the index file's `active` field. Meta (name /
 * email / photo) is empty for an account that was added but hasn't had
 * its `/account_menu` info backfilled yet — the row falls back to the
 * id in that brief window (typically <1 s after the sign-in window
 * closes).
 */
export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => invoke<AccountSummary[]>("list_accounts"),
    staleTime: 30_000,
  });
}

/**
 * Mount once at the app root. Wires the Rust `accounts-changed`
 * event into a full context reset: stops the player, clears the
 * per-account Zustand stores, drops the prefetch memo, wipes the
 * TanStack Query cache, and resets the InnerTube client so the next
 * outbound request uses the freshly-active jar.
 *
 * Rust only emits `accounts-changed` when the *active* account id
 * actually changes (login, switch, logout, dedup-induced flip). Meta
 * backfill for the currently active account doesn't fire this event —
 * that path runs through a soft "accounts" query invalidation inside
 * `useAccountMetaBackfill` so we don't blow away the user's freshly-
 * loaded home feed on every session boot.
 */
/**
 * Soft-refresh listener for `login-success`. Fires right after a new
 * sign-in window closes — at that point Rust has appended an empty-
 * meta account row and flipped active to it, but we DON'T do the
 * heavy reset (player stop, query clear) yet. The frontend's meta
 * backfill needs to run with the new cookies to discover the email;
 * if that email collides with an existing account, Rust dedups
 * silently and the user ends up right back where they started. Doing
 * the full reset before that decision was the "double-reset on
 * dedup" bug.
 *
 * Soft refresh = drop the InnerTube client (so the backfill fetches
 * with the new jar) and refresh the auth-related queries so the
 * sidebar acknowledges the new row. The `accounts-changed` event
 * follows shortly after from `update_account_meta` and runs the
 * full reset.
 */
export function useLoginSuccessListener(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen("login-success", () => {
      resetInnertube();
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["auth-logged-in"] });
      // RESET (not invalidate) the id + meta pair the backfill writes
      // from. Invalidate keeps stale data around while refetching: the
      // id query is a local invoke that lands in ~1ms with the NEW
      // account id while `account-info` still holds the PREVIOUS
      // account's meta, so the backfill effect would fire
      // `update_account_meta(new id, old meta)`. Identity dedup then
      // mislabels the fresh row as a duplicate of the old account and
      // merges them, replacing the old account's cookies. Reset drops
      // the data first, so the effect only ever sees a fresh pair.
      void qc.resetQueries({ queryKey: ["active-account-id"] });
      void qc.resetQueries({ queryKey: ["account-info"] });
      // A Google account can hold several YouTube channels, and the
      // library/likes belong to the channel rather than the account.
      // Right after a fresh sign-in is the moment to offer the choice,
      // when there is one to make. Best-effort: on failure the picker
      // stays reachable from Settings and the sidebar account menu.
      void fetchChannelList()
        .then((list) => {
          if (list.length > 1) openChannelPicker();
        })
        .catch(() => {});
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [qc]);
}

export function useAccountsChangedListener(): void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void listen("accounts-changed", async () => {
      // 1. Swap the pinned-playlists bucket eagerly. Fetching the new
      //    active id before clearing the query cache means the sidebar
      //    flips straight from account A's pins to account B's instead
      //    of flashing through an empty list while the
      //    `["active-account-id"]` query refetches.
      const newActiveId = await invoke<string | null>(
        "get_active_account_id",
      ).catch(() => null);
      usePinnedPlaylistsStore.getState().setActiveAccount(newActiveId);

      // 2. Stop audio so the previous account's track doesn't keep
      //    playing while everything else churns. `clearQueue` sets
      //    index = -1 which strips the audio element's src.
      usePlaybackStore.getState().clearQueue();

      // 3. Other per-account local state: typed search history,
      //    per-track Song↔Video preferences, cached Premium status.
      useSearchHistory.getState().clear();
      useTrackSourceStore.setState({ byVideoId: {} });
      usePremiumStore.setState({ status: null });

      // 4. In-memory caches that wrap network state.
      resetInnertube();
      clearPrefetchMemo();

      // 5. Query cache. `resetQueries` puts every query back to its
      //    initial empty state and refetches the ones with mounted
      //    observers. Not `clear()` + `invalidateQueries()`: clear
      //    empties the cache map, the follow-up invalidate then
      //    matches nothing, and a screen that stays mounted through
      //    the switch (Home, when the user switches accounts from
      //    the sidebar) keeps showing the old account's data from
      //    its now-detached observer instead of refetching.
      void qc.resetQueries();

      // 6. Send the user to Home. Account-scoped routes (a playlist
      //    the previous account had access to, a library page) can't
      //    keep showing valid state after a switch, so a forced
      //    navigate is the cheapest way to land somewhere that works
      //    for any account. If we're already on "/", the navigate is
      //    a no-op but step 5 has already reset the home feed query,
      //    which refetches in place.
      void navigate({ to: "/" });
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [qc, navigate]);
}

/**
 * Backfill the active account's meta from `/account_menu` once per
 * session. Idempotent — the Rust side handles dedup if this happens
 * to be a re-login of an already-saved Google account (in which case
 * the active id may flip to the older entry, then the
 * `accounts-changed` event re-renders the UI with the new active id).
 *
 * Mounted alongside `usePremiumStatusSync` in AppShell. The two share
 * the `account-info` query so this hook costs one extra Tauri call
 * (`update_account_meta`) per session.
 */
export function useAccountMetaBackfill(): void {
  const qc = useQueryClient();

  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  const account = useQuery({
    queryKey: ["account-info"],
    queryFn: () => fetchAccountInfo(),
    enabled: loggedIn.data === true,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const activeId = useQuery({
    queryKey: ["active-account-id"],
    queryFn: () => invoke<string | null>("get_active_account_id"),
    staleTime: 30_000,
  });

  const id = activeId.data ?? null;
  const name = account.data?.name ?? "";
  const email = account.data?.email ?? "";
  const photoUrl = account.data?.photoUrl ?? null;

  // Push the active account id into the pinned-playlists store so the
  // sidebar's bucket lookup resolves to the right account on every
  // launch, not just after the first switch. `activeId.data` is
  // `undefined` while loading, `null` when signed out, and an id
  // string otherwise — we only sync once it's actually loaded.
  useEffect(() => {
    if (activeId.data === undefined) return;
    usePinnedPlaylistsStore.getState().setActiveAccount(activeId.data);
  }, [activeId.data]);

  useEffect(() => {
    if (!id || (!name && !email)) return;
    void invoke("update_account_meta", { id, name, email, photoUrl })
      .then(() => {
        // Re-fetch the list so the sidebar picks up the new meta. Rust
        // only emits accounts-changed on dedup-induced active flips —
        // a plain meta update still needs an explicit invalidate so
        // the row renders the user's name + avatar.
        void qc.invalidateQueries({ queryKey: ["accounts"] });
      })
      .catch((e) => {
        // Best-effort. Worst case the sidebar shows a row with no name
        // until the next launch reads the file again.
        console.warn("[accounts] update_account_meta failed:", e);
      });
  }, [id, name, email, photoUrl, qc]);
}

export function switchAccount(id: string): Promise<void> {
  return invoke<void>("switch_account", { id });
}

export function removeAccount(id: string): Promise<void> {
  return invoke<void>("remove_account", { id });
}
