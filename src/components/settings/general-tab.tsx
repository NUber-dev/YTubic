import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  BellIcon,
  RocketIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useSettingsStore } from "@/lib/store/settings";

export function GeneralTab() {
  return (
    <TabPane tightTop>
      <BehaviorGroup />
    </TabPane>
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
