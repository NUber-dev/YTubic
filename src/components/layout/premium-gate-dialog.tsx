import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InfoIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePremiumGateDialog } from "@/lib/store/premium-gate";
import { usePremiumAccess, usePremiumStore } from "@/lib/store/premium";

const PREMIUM_URL = "https://music.youtube.com/music_premium";
const YTM_URL = "https://music.youtube.com";

/**
 * Shown when a signed-out / Free user tries to start playback (the
 * audio engine calls `openPremiumGate()` instead of resolving a
 * stream). Content tracks the account state reactively: a "checking"
 * placeholder while the Premium probe is still in flight, then the
 * sign-in or upgrade message. It closes itself the moment Premium is
 * confirmed (e.g. right after signing in), so a paying user who
 * clicked play during the launch-time probe never reads a false
 * upsell.
 */
export function PremiumGateDialog() {
  const open = usePremiumGateDialog((s) => s.open);
  const setOpen = usePremiumGateDialog((s) => s.setOpen);
  const status = usePremiumStore((s) => s.status);
  const premiumOk = usePremiumAccess();

  // Same key as usePremiumStatusSync, so it's served from the query
  // cache with no extra invoke round-trip in the common case.
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
    enabled: open,
  });

  // Premium confirmed while the dialog is up: nothing to explain.
  useEffect(() => {
    if (open && premiumOk) setOpen(false);
  }, [open, premiumOk, setOpen]);

  const signedOut = loggedIn.data === false;
  const checking = !signedOut && status === null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {signedOut
              ? "Sign in to play music"
              : "YouTube Music Premium required"}
          </DialogTitle>
          <DialogDescription>
            {checking
              ? "Checking your YouTube Music subscription…"
              : signedOut
                ? "YTubic plays music through your YouTube Music account. Sign in with an account that has an active Music Premium subscription."
                : "Your account doesn't have an active Music Premium subscription, which YouTube requires for ad-free playback."}
          </DialogDescription>
        </DialogHeader>

        {!checking && (
          <>
            <div className="flex gap-3 rounded-lg border border-border/60 bg-surface p-3">
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Free YouTube Music is supported by ads. YouTube's Terms of
                Service require those ads to play, and YTubic has no way to
                show them, so YouTube limits ad-free playback to Premium
                accounts.{" "}
                <span className="font-medium text-foreground">
                  YTubic itself stays completely free and open source, and
                  always will be.
                </span>{" "}
                You can keep listening for free, with ads, at
                music.youtube.com.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => void openUrl(YTM_URL)}>
                Listen in browser
              </Button>
              {signedOut ? (
                <Button
                  onClick={() => {
                    invoke("start_login").catch((e) =>
                      toast.error(String(e)),
                    );
                  }}
                >
                  Sign in
                </Button>
              ) : (
                <Button onClick={() => void openUrl(PREMIUM_URL)}>
                  Get Music Premium
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
