import { invoke } from "@tauri-apps/api/core";
import {
  fetchAccountInfo,
  fetchPremiumStatus,
  type AccountInfo,
  type PremiumStatus,
} from "@/lib/innertube/account";

/**
 * Retry / refetch policy shared by every query that decides whether the
 * user is signed in.
 *
 * All three run at launch and again right after a resume from standby,
 * precisely when the network is least likely to be usable. The previous
 * `retry: false` turned one unlucky attempt into a session-long "signed
 * out" state: a *resolved* query counts as fresh data even when what it
 * resolved to came from a failure, and freshness suppresses the
 * reconnect refetch for the whole `staleTime`, so the one moment the
 * app could have recovered was the one moment it ignored.
 *
 * Backoff rides out a NIC that takes a few seconds to reassociate, and
 * `refetchOnReconnect: "always"` re-checks the instant connectivity
 * returns, regardless of staleness.
 */
const AUTH_RETRY = {
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
  refetchOnReconnect: "always",
} as const;

/**
 * `is_logged_in`: a local read of the encrypted jar, so it only fails
 * if IPC itself does. Kept on the same policy anyway: it shares its
 * key with six call sites and divergent options on one shared key make
 * observers fight over the same cache entry.
 */
export const authLoggedInQuery = {
  queryKey: ["auth-logged-in"] as const,
  queryFn: () => invoke<boolean>("is_logged_in"),
  staleTime: 30_000,
  ...AUTH_RETRY,
};

/**
 * Live `/account_menu` identity, mounted from the sidebar and from the
 * meta-backfill hook. Both must use this one definition: they share a
 * query key.
 */
export function accountInfoQuery(enabled: boolean) {
  return {
    queryKey: ["account-info"] as const,
    queryFn: (): Promise<AccountInfo | null> => fetchAccountInfo(),
    enabled,
    staleTime: 5 * 60_000,
    ...AUTH_RETRY,
  };
}

/** Premium tier from the same endpoint, on a longer staleTime. */
export function premiumStatusQuery(enabled: boolean) {
  return {
    queryKey: ["premium-status"] as const,
    queryFn: (): Promise<PremiumStatus> => fetchPremiumStatus(),
    enabled,
    // Premium membership doesn't churn within a session; 30 min saves
    // an extra account_menu hit on every settings visit.
    staleTime: 30 * 60 * 1000,
    ...AUTH_RETRY,
  };
}
