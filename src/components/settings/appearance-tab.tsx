import { useTheme } from "next-themes";
import {
  IconAppWindowFilled,
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
import { cn } from "@/lib/utils";
import { useLayoutStore, type LayoutMode } from "@/lib/store/layout";
import {
  useSettingsStore,
  type FullscreenLayout,
  type RatingButtons,
} from "@/lib/store/settings";

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
        <FullscreenLayoutRow />
      </Group>
    </TabPane>
  );
}

/* ------------------------------------------------------------------ */
/* Fullscreen player layout                                            */
/* ------------------------------------------------------------------ */

/** Three picture tiles, each a miniature of the layout it stands for. */
function FullscreenLayoutRow() {
  const value = useSettingsStore((s) => s.fullscreenLayout);
  const setValue = useSettingsStore((s) => s.setFullscreenLayout);

  return (
    <div className="flex flex-col">
      <SettingRow
        icon={IconAppWindowFilled}
        title="Fullscreen player layout"
        description="How the now-playing screen fills the display."
      />
      <div className="grid grid-cols-3 gap-3 pb-4">
        {FS_TILES.map(({ id, label, preview }) => {
          const on = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setValue(id)}
              className={cn(
                "min-w-0 cursor-pointer rounded-[11px] border p-1.5 pb-0 text-left transition-[border-color,background-color,box-shadow] duration-150",
                on
                  ? "border-[rgba(var(--acc1rgb),0.75)] bg-[rgba(var(--acc1rgb),0.10)] shadow-[0_0_0_3px_rgba(var(--acc1rgb),0.16)]"
                  : "border-w070 bg-w020 hover:bg-w040",
              )}
            >
              {preview}
              <div className="flex items-center gap-[7px] px-2 pb-[7px] pt-2">
                <span
                  className={cn(
                    "size-[13px] shrink-0 rounded-full border-[1.5px]",
                    on
                      ? "border-acc1 bg-[radial-gradient(circle,var(--acc1)_0_3.2px,transparent_3.4px)]"
                      : "border-w220",
                  )}
                />
                <span className="text-[12.5px] font-medium text-t3">
                  {label}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FS_TILES: {
  id: FullscreenLayout;
  label: string;
  preview: React.ReactNode;
}[] = [
  {
    id: "cover",
    label: "Centered",
    preview: (
      <div className="flex h-[90px] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-surf3">
        <div className="size-[34px] rounded-[5px] bg-[linear-gradient(140deg,#4a3a6e,#20202b)]" />
        <div className="h-1 w-11 rounded-sm bg-surf7" />
        <div className="h-[3px] w-[30px] rounded-sm bg-surf5" />
        <div className="h-[3px] w-[58px] rounded-sm bg-surf4" />
      </div>
    ),
  },
  {
    id: "lyrics",
    label: "With lyrics",
    preview: (
      <div className="flex h-[90px] items-center gap-2 overflow-hidden rounded-lg bg-surf3 px-[9px]">
        <div className="size-8 shrink-0 rounded-[5px] bg-[linear-gradient(140deg,#7a3552,#241a20)]" />
        <div className="flex flex-1 flex-col gap-1">
          <div className="h-1 w-full rounded-sm bg-surf7" />
          <div className="h-[3px] w-[80%] rounded-sm bg-surf5" />
          <div className="h-[3px] w-[92%] rounded-sm bg-surf5" />
          <div className="h-[3px] w-[64%] rounded-sm bg-surf4" />
        </div>
      </div>
    ),
  },
  {
    id: "immersive",
    label: "Immersive art",
    preview: (
      <div className="flex h-[90px] flex-col justify-end gap-1 overflow-hidden rounded-lg bg-[linear-gradient(150deg,#2f5a5c,#101418_78%)] p-2">
        <div className="h-1 w-[52%] rounded-sm bg-white/40" />
        <div className="h-[3px] w-[34%] rounded-sm bg-white/20" />
      </div>
    ),
  },
];

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
