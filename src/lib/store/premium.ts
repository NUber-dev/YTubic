import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { fetchPremiumStatus, type PremiumStatus } from "@/lib/innertube/account";

const DEV_PREMIUM_OVERRIDE_KEY = "ytm-dev-premium-override";

type State = {
  /**
   * Last known Premium status from auto-detection. `null` while we
   * haven't checked yet *or* when the user is not signed in.
   */
  status: PremiumStatus;
  setStatus: (status: PremiumStatus) => void;
  /**
   * Premium gate bypass override. Enabled by default.
   */
  devOverride: boolean;
  setDevOverride: (enabled: boolean) => void;
};

function readDevOverride(): boolean {
  try {
    const val = globalThis.localStorage?.getItem(DEV_PREMIUM_OVERRIDE_KEY);
    return val !== "0";
  } catch {
    return true;
  }
}

function writeDevOverride(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(DEV_PREMIUM_OVERRIDE_KEY, "1");
    } else {
      globalThis.localStorage?.setItem(DEV_PREMIUM_OVERRIDE_KEY, "0");
    }
  } catch {
    // Local override is best-effort only.
  }
}

/**
 * Premium-status state shared across React and non-React code. The
 * `audio-engine` + `stream.ts` modules consult this synchronously via
 * `usePremiumStore.getState()` to decide whether playback is allowed
 * and whether to fire prefetches.
 *
 * The actual fetching/refresh is owned by the `usePremiumStatusSync`
 * hook mounted in AppShell. Keeping the store dumb means anyone with a
 * cached value (e.g. a freshly opened floating-player window) starts
 * from the conservative `null` and only flips to "premium" once the
 * authoritative check completes.
 *
 * Nothing is persisted: `status` is rederived on every launch so a
 * Premium → Free downgrade outside the app takes effect on the next
 * start. Production builds have no user-facing override; dev builds
 * can opt into a local-only bypass from Settings so the app can be
 * exercised without a Premium account. Misdetection is covered by
 * fetchPremiumStatus failing open to "premium" when its patterns
 * don't match, plus the Re-check button on the Storage tab.
 */
export const usePremiumStore = create<State>()((set) => ({
  status: null,
  devOverride: readDevOverride(),
  setStatus: (status) => set({ status }),
  setDevOverride: (enabled) => {
    writeDevOverride(enabled);
    set({ devOverride: enabled });
  },
}));

/** Synchronous read for non-React callers (stream.ts, audio-engine). */
export function isPremium(): boolean {
  const { status, devOverride } = usePremiumStore.getState();
  return status === "premium" || devOverride;
}

/** Shared derived access check for React callers. */
export function usePremiumAccess(): boolean {
  return usePremiumStore(
    (s) => s.status === "premium" || s.devOverride,
  );
}

/**
 * Mount once near the app root (AppShell). Watches the login state
 * and, when authenticated, fetches Premium status from YT Music, then
 * mirrors it into the Zustand store. Signed-out users get `null`
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
      usePremiumStore.setState({ status: null });
      return;
    }
    if (premium.data === undefined) return;
    usePremiumStore.getState().setStatus(premium.data);
  }, [loggedIn.data, premium.data]);
}
