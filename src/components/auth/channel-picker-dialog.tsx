import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2Icon, TvIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  fetchChannelList,
  type BrandChannel,
} from "@/lib/innertube/channels";
import { cn } from "@/lib/utils";
import { useChannelPickerAfterAuth } from "@/lib/store/accounts";

type ChannelPickerDialogProps = {
  open: boolean;
  accountId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelected?: () => void;
};

export function ChannelPickerDialog({
  open,
  accountId,
  onOpenChange,
  onSelected,
}: ChannelPickerDialogProps) {
  const [channels, setChannels] = useState<BrandChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    setLoading(true);
    void fetchChannelList()
      .then((list) => {
        if (!cancelled) setChannels(list);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("[channels] fetchChannelList failed:", e);
          toast.error("Could not load YouTube channels");
          onOpenChange(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accountId, onOpenChange]);

  const selectChannel = async (channel: BrandChannel) => {
    if (!accountId) return;
    const key = channel.brandId ?? "primary";
    setBusyId(key);
    try {
      await invoke("set_active_brand", {
        id: accountId,
        brandId: channel.brandId,
        channelName: channel.channelName,
        channelHandle: channel.channelHandle ?? null,
      });
      onOpenChange(false);
      onSelected?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TvIcon className="size-5" />
            Choose YouTube channel
          </DialogTitle>
          <DialogDescription>
            This Google account has multiple YouTube channels. Pick which one
            YTubic should use for your library and liked songs.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {channels.map((channel) => {
              const key = channel.brandId ?? "primary";
              const initial = channel.channelName.trim().charAt(0).toUpperCase();
              const subtitle =
                channel.channelHandle ||
                (channel.brandId ? "Brand channel" : "Primary channel");
              return (
                <button
                  key={key}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void selectChannel(channel)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    channel.isSelected && "bg-accent/50",
                    busyId === key && "opacity-60",
                  )}
                >
                  <Avatar className="size-8 shrink-0">
                    <AvatarFallback className="text-xs">{initial}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {channel.channelName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {subtitle}
                    </div>
                  </div>
                  {busyId === key ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChannelPickerHost() {
  const { channelPickerOpen, setChannelPickerOpen, channelPickerAccountId } =
    useChannelPickerAfterAuth();
  return (
    <ChannelPickerDialog
      open={channelPickerOpen}
      accountId={channelPickerAccountId}
      onOpenChange={setChannelPickerOpen}
    />
  );
}
