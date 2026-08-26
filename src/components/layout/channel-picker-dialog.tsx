import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  IconCheck,
  IconLoader2,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { fetchChannelList, type ChannelChoice } from "@/lib/innertube/channels";
import { useAccounts } from "@/lib/store/accounts";
import { useChannelPickerDialog } from "@/lib/store/channel-picker";
import { cn } from "@/lib/utils";

/**
 * Lets the user pick which YouTube channel (personal or brand) the
 * active account acts as. Library, likes and recommendations are
 * scoped to the channel, so switching triggers the same full reset as
 * an account switch (Rust emits `accounts-changed` from
 * `set_account_channel` when the choice changes).
 *
 * Opened from Settings, the sidebar account menu, and automatically
 * after a sign-in that discovers more than one channel.
 */
export function ChannelPickerDialog() {
  const open = useChannelPickerDialog((s) => s.open);
  const setOpen = useChannelPickerDialog((s) => s.setOpen);

  const accounts = useAccounts();
  const active = accounts.data?.find((a) => a.isActive);
  // Our stored choice is the source of truth, not the switcher's
  // `isSelected`: we never flip the selection server-side, we only
  // send the page id per request.
  const currentPageId = active?.pageId ?? null;

  const channels = useQuery({
    queryKey: ["channel-list"],
    queryFn: fetchChannelList,
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const pick = async (c: ChannelChoice) => {
    if (!active) return;
    setOpen(false);
    if ((c.pageId ?? null) === currentPageId) return;
    try {
      await invoke("set_account_channel", {
        id: active.id,
        pageId: c.pageId,
        channelName: c.name,
        channelPhotoUrl: c.photoUrl ?? null,
      });
      // Rust emits `accounts-changed`; the global listener clears the
      // query cache and lands on Home with the new channel's data.
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={frostedDialogOverlay}
        className={cn(
          "w-[460px] max-w-[calc(100vw-2rem)] gap-4 rounded-2xl px-[26px] pb-[22px] pt-6 shadow-[0_30px_70px_-20px_var(--k850)] sm:max-w-[460px]",
          frostedDialogPanel,
        )}
      >
        {/* Catch-light along the top edge, as on the other dialogs. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />
        <DialogClose className="absolute right-4 top-4 z-[2] grid size-7 cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2">
          <IconX className="size-3" />
          <span className="sr-only">Close</span>
        </DialogClose>

        {/* Right padding clears the close button. */}
        <DialogHeader className="gap-2 pr-[34px]">
          <DialogTitle className="text-2xl font-bold leading-none tracking-[-0.02em] text-t1">
            Choose a channel
          </DialogTitle>
          <DialogDescription className="text-[13.5px] leading-[1.5] text-t4 text-pretty">
            Your library, likes and recommendations belong to the channel, not
            the account. Pick the one YTubic should use.
          </DialogDescription>
        </DialogHeader>

        {channels.isLoading ? (
          <div className="flex items-center justify-center py-10">
            <IconLoader2 className="size-5 animate-spin text-t6" />
          </div>
        ) : channels.isError ? (
          <div className="flex flex-col items-start gap-3.5 py-1">
            <p className="text-[13.5px] leading-[1.5] text-t4">
              Couldn't load the channel list. Check your connection and try
              again.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void channels.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {(channels.data ?? []).map((c) => {
              const isCurrent = (c.pageId ?? null) === currentPageId;
              return (
                <button
                  key={c.pageId ?? "personal"}
                  type="button"
                  onClick={() => void pick(c)}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-[140ms]",
                    isCurrent
                      ? "border-w075 bg-w060"
                      : "border-transparent hover:bg-w050",
                  )}
                >
                  <Avatar className="size-9">
                    {c.photoUrl ? <AvatarImage src={c.photoUrl} /> : null}
                    <AvatarFallback className="bg-w070 text-t5">
                      <IconUsersGroup className="size-4" />
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-sm font-semibold leading-none text-t2">
                      {c.name}
                    </span>
                    <span className="truncate text-[12.5px] leading-none text-t6">
                      {c.byline ||
                        (c.pageId ? "Brand channel" : "Personal channel")}
                    </span>
                  </span>
                  {isCurrent ? (
                    <IconCheck
                      className="size-4 shrink-0 text-acc1"
                      stroke={2.4}
                    />
                  ) : null}
                </button>
              );
            })}
            {channels.data && channels.data.length === 0 ? (
              <p className="py-4 text-[13.5px] text-t5">
                No channels found for this account.
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
