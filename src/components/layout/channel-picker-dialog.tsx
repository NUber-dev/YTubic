import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { CheckIcon, Loader2Icon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchChannelList,
  type ChannelChoice,
} from "@/lib/innertube/channels";
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose a channel</DialogTitle>
          <DialogDescription>
            Your Google account can hold several YouTube channels. Library,
            likes and recommendations belong to the channel, not the
            account, so pick the one YTubic should use.
          </DialogDescription>
        </DialogHeader>

        {channels.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : channels.isError ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-muted-foreground">
              Couldn't load the channel list. Check your connection and try
              again.
            </p>
            <Button
              variant="outline"
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
                    "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors",
                    isCurrent
                      ? "border-border/60 bg-surface"
                      : "hover:bg-accent/50",
                  )}
                >
                  <Avatar className="size-9">
                    {c.photoUrl ? <AvatarImage src={c.photoUrl} /> : null}
                    <AvatarFallback>
                      <UsersRoundIcon className="size-4" />
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium leading-none">
                      {c.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {c.byline ||
                        (c.pageId ? "Brand channel" : "Personal channel")}
                    </span>
                  </span>
                  {isCurrent ? (
                    <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
              );
            })}
            {channels.data && channels.data.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No channels found for this account.
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
