import { useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { WHATS_NEW, whatsNewFor } from "@/lib/whats-new";

type State = {
  /**
   * Highest app version whose notes the user has already been shown.
   * The only persisted field; `open`/`version` below are ephemeral and
   * reset on reload so the dialog never reopens by itself.
   */
  lastSeenVersion: string | null;
  open: boolean;
  /** Which entry's version the dialog is currently showing. */
  version: string | null;
  setLastSeen: (v: string) => void;
  setOpen: (open: boolean) => void;
  show: (version: string) => void;
};

export const useWhatsNewStore = create<State>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      open: false,
      version: null,
      setLastSeen: (lastSeenVersion) => set({ lastSeenVersion }),
      setOpen: (open) => set({ open }),
      show: (version) => set({ open: true, version }),
    }),
    {
      name: "ytm-whats-new",
      partialize: (s) => ({ lastSeenVersion: s.lastSeenVersion }),
    },
  ),
);

/**
 * Open the What's New dialog manually (About dialog's "What's new"
 * link). Shows the entry for the running app version, falling back to
 * the newest entry so the button always shows something. In dev the
 * app version predates the entries, so this lands on the latest.
 */
export async function openWhatsNew(version?: string): Promise<void> {
  const v = version ?? (await getVersion().catch(() => null));
  const entry = (v ? whatsNewFor(v) : undefined) ?? WHATS_NEW[0];
  if (!entry) return;
  useWhatsNewStore.getState().show(entry.version);
}

/**
 * Mount once in AppShell. On launch, if the app version changed since
 * the last run and we have notes for the new version, pop the dialog
 * once. Recording the version afterwards means it fires exactly once
 * per release.
 *
 * `lastSeenVersion === null` covers both a fresh install and the very
 * first launch after this feature shipped (0.1.0 predated this store,
 * so the 0.1.0 -> 0.2.0 update reads as null here). In both cases we
 * still want to introduce the current version's notes once.
 *
 * Dev is skipped: the version is a moving target and shouldn't pop the
 * dialog on every reload. Manual open from About still works there.
 */
export function useWhatsNewOnUpdate(): void {
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    void getVersion()
      .then((current) => {
        if (cancelled) return;
        const store = useWhatsNewStore.getState();
        if (store.lastSeenVersion === current) return;
        if (whatsNewFor(current)) store.show(current);
        store.setLastSeen(current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
}
