import { useTheme } from "next-themes";
import {
  IconCheck,
  IconChevronDown,
  IconHeart,
  IconHeartFilled,
  IconLayoutFilled,
  IconPaletteFilled,
  IconPhotoFilled,
  IconThumbDown,
  IconThumbUp,
  IconTypography,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Group, SettingRow, TabPane } from "@/components/settings/primitives";
import { INTERFACE_FONTS, interfaceFontStack } from "@/lib/interface-font";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import { useSettingsStore, type RatingButtons } from "@/lib/store/settings";

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

// Segments carry the very glyphs the setting switches between.
const RATING_OPTIONS: { value: RatingButtons; label: React.ReactNode }[] = [
  {
    value: "heart",
    label: (
      <span className="flex items-center gap-[7px]">
        <IconHeart className="size-[15px]" stroke={1.7} />
        Heart
      </span>
    ),
  },
  {
    value: "both",
    label: (
      <span className="flex items-center gap-0.5">
        <IconThumbUp className="size-[15px]" stroke={1.7} />
        <IconThumbDown className="size-[15px]" stroke={1.7} />
        <span className="ml-1.5">Like</span>
      </span>
    ),
  },
];

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const layoutMode = useLayoutStore((s) => s.mode);
  const setLayoutMode = useLayoutStore((s) => s.setMode);
  const background = useSettingsStore((s) => s.background);
  const setBackground = useSettingsStore((s) => s.setBackground);
  const rating = useSettingsStore((s) => s.ratingButtons);
  const setRating = useSettingsStore((s) => s.setRatingButtons);

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
        <InterfaceFontRow />
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
        <SettingRow
          icon={IconHeartFilled}
          title="Rating buttons"
          description="Show a single heart, or separate like and dislike buttons."
          control={
            <SegmentedControl
              value={rating}
              onChange={setRating}
              options={RATING_OPTIONS}
            />
          }
        />
      </Group>
    </TabPane>
  );
}

/** Menu of the bundled typefaces, each entry set in its own face. */
function InterfaceFontRow() {
  const font = useSettingsStore((s) => s.interfaceFont);
  const setFont = useSettingsStore((s) => s.setInterfaceFont);
  const current = INTERFACE_FONTS.find((f) => f.id === font);

  return (
    <SettingRow
      icon={IconTypography}
      title="Interface font"
      description="Applies to the whole app. Track and artist names use it too."
      control={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-[196px] cursor-pointer items-center gap-2 rounded-[10px] border border-w090 bg-w040 px-3 text-[13px] text-t2 transition-colors duration-[140ms] hover:bg-w070 data-[state=open]:border-w200"
              style={{ fontFamily: interfaceFontStack(font) }}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {current?.label ?? "System default"}
              </span>
              <IconChevronDown className="size-3 shrink-0 text-t6" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[232px]">
            {INTERFACE_FONTS.map((f) => (
              <DropdownMenuItem
                key={f.id}
                onSelect={() => setFont(f.id)}
                style={{ fontFamily: f.stack }}
              >
                <span className="flex-1 truncate">{f.label}</span>
                {font === f.id ? (
                  <IconCheck className="size-4 text-acc1!" stroke={2.4} />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
