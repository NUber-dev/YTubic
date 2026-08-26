import { useTheme } from "next-themes";
import {
  IconLayoutFilled,
  IconPaletteFilled,
  IconPhotoFilled,
} from "@tabler/icons-react";
import { SegmentedControl } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import { useSettingsStore } from "@/lib/store/settings";

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const LAYOUT_OPTIONS: { value: LayoutMode; label: string }[] = [
  { value: "right", label: "Side card" },
  { value: "bottom", label: "Bottom bar" },
  { value: "floating", label: "Floating" },
];

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const layoutMode = useLayoutStore((s) => s.mode);
  const setLayoutMode = useLayoutStore((s) => s.setMode);
  const background = useSettingsStore((s) => s.background);
  const setBackground = useSettingsStore((s) => s.setBackground);

  return (
    <TabPane>
      <Group>
        <SettingRow
          icon={IconPaletteFilled}
          title="Theme"
          description="Choose light or dark, or follow your OS preference."
          control={
            <SegmentedControl
              // `theme` is undefined during the very first render
              // (next-themes resolves it on mount) — fall back to
              // "system" so the control never renders empty.
              value={theme ?? "system"}
              onChange={setTheme}
              options={THEME_OPTIONS}
            />
          }
        />
        <SettingRow
          icon={IconLayoutFilled}
          title="Player layout"
          description="Choose where the now-playing card lives."
          control={
            <SegmentedControl
              value={layoutMode}
              onChange={setLayoutMode}
              options={LAYOUT_OPTIONS}
            />
          }
        />
        {/* Two values, so the design gives this one a switch rather
            than a two-up segmented control. */}
        <SettingRow
          icon={IconPhotoFilled}
          title="Ambient Background"
          description="Tint the window with the current album art, or keep it plain."
          control={
            <Switch
              checked={background === "ambient"}
              onCheckedChange={(v) => setBackground(v ? "ambient" : "plain")}
              aria-label="Ambient background"
            />
          }
        />
      </Group>
    </TabPane>
  );
}
