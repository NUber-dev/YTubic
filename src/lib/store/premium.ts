import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fetchPremiumStatus, type PremiumStatus } from "@/lib/innertube/account";

type State = {
  /**
   * Last known Premium status from auto-detection. `null` while we
   * haven't checked yet *or* when the user is not signed in.
   */
  status: PremiumStatus;
  /**
   * User-set override. When `true`, `isPremium()` returns true even if
   * auto-detection says otherwise. Exists because Premium detection
   * walks an undocumented endpoint and can misfire on locales / layouts
   * we haven't seen — a paying user must always have an escape hatch.
   * Cleared automatically on sign-out via `usePremiumStatusSync`.
   */
  override: boolean;
  setStatus: (status: PremiumStatus) => void;
  setOverride: (v: boolean) => void;
};

/**
 * Premium-status state shared across React and non-React code. The
 * `audio-engine` + `stream.ts` modules consult this synchronously via
 * `usePremiumStore.getState()` to decide whether to fire prefetches and
 * whether to ask Rust for an ephemeral (no-disk) stream.
 *
 * The actual fetching/refresh is owned by the `usePremiumStatusSync`
 * hook mounted in AppShell — keeping the store dumb means anyone with a
 * cached value (e.g. a freshly opened floating-player window) starts
 * from the conservative `null` and only flips to "premium" once the
 * authoritative check completes.
 *
 * Only `override` is persisted: `status` is rederived on every launch
 * so a Premium → Free downgrade outside the app takes effect on the
 * next start without us serving a stale "premium" flag.
 */
export const usePremiumStore = create<State>()(
  persist(
    (set) => ({
      status: null,
      override: false,
      setStatus: (status) => set({ status }),
      setOverride: (override) => set({ override }),
    }),
    {
      name: "ytm-premium",
      partialize: (s) => ({ override: s.override }),
    },
  ),
);

/** Synchronous read for non-React callers (stream.ts, audio-engine). */
export function isPremium(): boolean {
  const s = usePremiumStore.getState();
  return s.status === "premium" || s.override;
}

/**
 * Mount once near the app root (AppShell). Watches the login state and
 * — when authenticated — fetches Premium status from YT Music, then
 * mirrors both into the Zustand store. Signed-out users get `null`
 * immediately so stream URLs flip to ephemeral mode without waiting on
 * a network round-trip.
 */
export function usePremiumStatusSync(): void {
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  const premium = useQuery({
    queryKey: ["premium-status"],
    queryFn: fetchPremiumStatus,
    enabled: loggedIn.data === true,
    // Premium membership doesn't churn within a session — 30 min is fine
    // and saves an extra account_menu hit on every settings visit.
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    if (loggedIn.data === false) {
      // Sign-out also drops the manual override — the override is a
      // claim about the *current* account, and the next sign-in might
      // be a different account that doesn't have Premium.
      usePremiumStore.setState({ status: null, override: false });
      return;
    }
    if (premium.data === undefined) return;
    usePremiumStore.getState().setStatus(premium.data);
  }, [loggedIn.data, premium.data]);
}
