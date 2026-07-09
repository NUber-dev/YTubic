import { create } from "zustand";

type State = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/**
 * Ephemeral UI state for the channel picker. Lives in a store (not
 * local state) because unrelated corners open it: the Settings account
 * row, the sidebar account menu, and the automatic prompt right after
 * a sign-in that discovers multiple channels.
 */
export const useChannelPickerDialog = create<State>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openChannelPicker(): void {
  useChannelPickerDialog.setState({ open: true });
}
