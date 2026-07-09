import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

type State = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/**
 * Ephemeral UI state for the "Premium required" dialog. Lives in a
 * store because the trigger sits outside React: the audio engine
 * blocks stream resolution for non-Premium users and pops this dialog
 * from plain callbacks.
 */
export const usePremiumGateDialog = create<State>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/**
 * Open the gate dialog (idempotent). Also raises the main window: the
 * blocked play attempt may come from the tray, media keys or the
 * floating player while the main window sits hidden, and a dialog
 * nobody can see would read as "the play button is broken".
 */
export function openPremiumGate(): void {
  usePremiumGateDialog.setState({ open: true });
  void invoke("focus_main_window").catch(() => {});
}
