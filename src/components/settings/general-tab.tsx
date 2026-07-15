import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BellIcon,
  CommandIcon,
  KeyboardIcon,
  Loader2Icon,
  LogInIcon,
  PercentIcon,
  RocketIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

export function GeneralTab() {
  return (
    <TabPane tightTop>
      <AccountGroup />
      <BehaviorGroup />
      <VolumeHotkeysGroup />
    </TabPane>
  );
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function AccountGroup() {
  const [signingIn, setSigningIn] = useState(false);
  const loggedIn = useQuery({
    queryKey: ["auth-logged-in"],
    queryFn: () => invoke<boolean>("is_logged_in"),
    staleTime: 30_000,
  });

  useEffect(() => {
    // This tab owns the in-flight spinner + the toast feedback for a
    // sign-in started from the button below. Query invalidation +
    // InnerTube client reset live in the global
    // `useLoginSuccessListener` so they fire regardless of where the
    // sign-in was initiated (here or from a library/search empty
    // state).
    const unlistenSuccess = listen("login-success", () => {
      setSigningIn(false);
      toast.success("Signed in");
    });
    const unlistenCancel = listen("login-cancelled", () => {
      setSigningIn(false);
    });
    return () => {
      unlistenSuccess.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
    };
  }, []);

  const signIn = async () => {
    setSigningIn(true);
    try {
      await invoke("start_login");
    } catch (e) {
      setSigningIn(false);
      toast.error(String(e));
    }
  };

  // Once signed in, identity, channel switching, and sign-out all live
  // in the sidebar account menu, so this tab shows nothing for the
  // account. The signed-out sign-in prompt stays because the sidebar
  // renders nothing when logged out and the library/search empty
  // states send the user here to sign in. `!== false` keeps the prompt
  // hidden while the auth check is still loading so a signed-in user
  // never sees a flash of "Not signed in".
  if (loggedIn.data !== false) return null;

  return (
    <Group>
      <div className="flex items-center gap-3 py-4">
        <Avatar className="size-9">
          <AvatarFallback>
            <UserRoundIcon className="size-[18px]" />
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[15px] font-medium leading-none">
            Not signed in
          </span>
          <span className="text-[13px] text-muted-foreground">
            Sign in to unlock your library, liked songs, and
            Premium-quality streams. Cookies stay on this machine.
          </span>
        </div>
        <Button size="sm" onClick={signIn} disabled={signingIn}>
          {signingIn ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <LogInIcon />
          )}
          Sign in with Google
        </Button>
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Behavior                                                            */
/* ------------------------------------------------------------------ */

function BehaviorGroup() {
  const closeAction = useSettingsStore((s) => s.closeAction);
  const setCloseAction = useSettingsStore((s) => s.setCloseAction);
  const playbackNotifications = useSettingsStore(
    (s) => s.playbackNotifications,
  );
  const setPlaybackNotifications = useSettingsStore(
    (s) => s.setPlaybackNotifications,
  );

  const qc = useQueryClient();
  const autostart = useQuery({
    queryKey: ["autostart"],
    queryFn: () => invoke<boolean>("autostart_is_enabled"),
    staleTime: 60_000,
    retry: false,
  });

  const toggleAutostart = async (enabled: boolean) => {
    try {
      await invoke("autostart_set", { enabled });
    } catch (e) {
      toast.error(String(e));
    }
    // Re-read the OS registration either way — it's the source of
    // truth, and the failed path needs the switch snapped back.
    await qc.invalidateQueries({ queryKey: ["autostart"] });
  };

  return (
    <Group>
      <SettingRow
        icon={RocketIcon}
        title="Launch at startup"
        description="Start YTubic automatically when you log in."
        control={
          <Switch
            checked={!!autostart.data}
            onCheckedChange={(v) => void toggleAutostart(v)}
            disabled={autostart.isLoading}
            aria-label="Launch at startup"
          />
        }
      />
      <SettingRow
        icon={BellIcon}
        title="Playback notifications"
        description="Show a system notification when the track changes in the background."
        control={
          <Switch
            checked={playbackNotifications}
            onCheckedChange={setPlaybackNotifications}
            aria-label="Playback notifications"
          />
        }
      />
      <SettingRow
        icon={XIcon}
        title="Close to tray"
        description="Hide YTubic to the tray when you press ✕ instead of quitting."
        control={
          <Switch
            checked={closeAction === "tray"}
            onCheckedChange={(v) => setCloseAction(v ? "tray" : "quit")}
            aria-label="Close to tray"
          />
        }
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Global volume hotkeys                                               */
/* ------------------------------------------------------------------ */

function VolumeHotkeysGroup() {
  const enabled = useSettingsStore((s) => s.volumeHotkeysEnabled);
  const setEnabled = useSettingsStore((s) => s.setVolumeHotkeysEnabled);
  const step = useSettingsStore((s) => s.volumeHotkeyStep);
  const setStep = useSettingsStore((s) => s.setVolumeHotkeyStep);
  const down = useSettingsStore((s) => s.volumeHotkeyDown);
  const setDown = useSettingsStore((s) => s.setVolumeHotkeyDown);
  const up = useSettingsStore((s) => s.volumeHotkeyUp);
  const setUp = useSettingsStore((s) => s.setVolumeHotkeyUp);
  const mute = useSettingsStore((s) => s.volumeHotkeyMute);
  const setMute = useSettingsStore((s) => s.setVolumeHotkeyMute);

  return (
    <Group>
      <SettingRow
        icon={KeyboardIcon}
        title="Global volume hotkeys"
        description="Nudge YTubic's volume with a keyboard/macro-pad shortcut, even when another app is focused. Set your macro pad to send the same combo shown below."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Global volume hotkeys"
          />
        }
      />
      {enabled ? (
        <>
          <AccelRow label="Volume down" value={down} onChange={setDown} />
          <AccelRow label="Volume up" value={up} onChange={setUp} />
          <AccelRow label="Mute / unmute" value={mute} onChange={setMute} />
          <SettingRow
            icon={PercentIcon}
            title="Step size"
            description="How much each press changes the volume."
            control={
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={step}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setStep(n);
                  }}
                  className="w-16 text-right"
                  aria-label="Volume step size (percent)"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            }
          />
        </>
      ) : null}
    </Group>
  );
}

/**
 * One editable accelerator row. The value is a Tauri accelerator string
 * ("CommandOrControl+Alt+Shift+Down"); Rust parses it and reports back through
 * the sync hook's toast if it can't be bound. Free-text rather than a
 * key-capture widget on purpose — a macro pad often can't be "recorded"
 * reliably, and typing the exact combo is the dependable path.
 */
function AccelRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SettingRow
      icon={CommandIcon}
      title={label}
      control={
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="e.g. CommandOrControl+Alt+Shift+Down"
          className="w-64 font-mono text-xs"
          aria-label={label}
        />
      }
    />
  );
}
