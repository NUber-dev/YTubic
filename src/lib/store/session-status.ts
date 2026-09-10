import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { resetInnertube } from "@/lib/innertube/client";

type State = {
  /**
   * Account whose session Google has expired for good: the keeper found
   * no YouTube session, sent the profile through Google's sign-in
   * bridge, and Google still wants the user to pick the account. The
   * only way back is a click, so the sidebar shows one.
   */
  expiredAccountId: string | null;
  setExpired: (id: string | null) => void;
};

export const useSessionStatusStore = create<State>()((set) => ({
  expiredAccountId: null,
  setExpired: (expiredAccountId) => set({ expiredAccountId }),
}));

/** Payload of Rust's `session-refresh-failed`. */
type RefreshFailed = {
  id: string | null;
  reason: "needs-relink" | "no-profile" | "offline" | "error";
};

/**
 * Mount once at the app root. Tracks the keeper's verdict on the active
 * session so the sidebar can offer the one-click re-link when Google
 * needs a click, and clears it the moment a renewal or re-link lands.
 *
 * `session-relinked` also restarts every query: whatever was fetched
 * while the session was dead is anonymous data, and the re-link does
 * not go through `session-refreshed`, so the refresh listener's
 * transition check would not see it.
 */
export function useSessionStatusListener(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    const disposers: (() => void)[] = [];
    const bind = <T>(event: string, run: (payload: T) => void) => {
      void listen<T>(event, (e) => run(e.payload)).then((un) => {
        if (cancelled) un();
        else disposers.push(un);
      });
    };
    const store = useSessionStatusStore.getState();
    bind<RefreshFailed>("session-refresh-failed", ({ id, reason }) => {
      if (reason === "needs-relink") store.setExpired(id);
    });
    bind<string>("session-refreshed", () => store.setExpired(null));
    bind<string>("session-relinked", () => {
      store.setExpired(null);
      resetInnertube();
      void qc.invalidateQueries();
    });
    // The verdict may have landed before this effect ran (a cold boot
    // where the keeper beats the webview), so ask for it as well.
    void invoke<{ needsRelink: string | null }>("get_session_state")
      .then((s) => {
        if (!cancelled && s.needsRelink) store.setExpired(s.needsRelink);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      for (const un of disposers) un();
    };
  }, [qc]);
}
