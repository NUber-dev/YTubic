import { create } from "zustand";

export type SettingsTab =
  | "general"
  | "appearance"
  | "storage"
  | "integrations";

type State = {
  open: boolean;
  tab: SettingsTab;
  setOpen: (open: boolean) => void;
  setTab: (tab: SettingsTab) => void;
};

/**
 * Ephemeral UI state for the settings popup (not persisted — the
 * dialog always opens on General). Lives in a store rather than local
 * state because unrelated corners of the app open it: the sidebar
 * footer, the title-bar menu, and the "Go to Settings" sign-in CTAs.
 */
export const useSettingsDialog = create<State>()((set) => ({
  open: false,
  tab: "general",
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
}));

/** Open the settings popup, optionally on a specific tab. */
export function openSettings(tab?: SettingsTab): void {
  useSettingsDialog.setState(tab ? { open: true, tab } : { open: true });
}
