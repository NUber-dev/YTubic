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
  IconEyeOff,
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
              aria-label="Ambient Background"
            />
          }
        />
        <SettingRow
          icon={IconHeartFilled}
          title="Rating Buttons"
          description="Show a single heart, or separate like and dislike buttons."
          control={
            <SegmentedControl
              value={rating}
              onChange={setRating}
              options={RATING_OPTIONS}
            />
          }
        />
        <PlayerLayoutRow />
        <FullscreenLayoutRow />
        <IdleFadeRow />
      </Group>
    </TabPane>
  );
}

/* ------------------------------------------------------------------ */
/* Layout tiles                                                        */
/* ------------------------------------------------------------------ */

/**
 * One option of a tile picker: a miniature screen with a label under
 * it. Only the chosen tile is lit; the others sit dimmed, so the choice
 * reads before the label does. The art is always dark, so its marks are
 * literal white alphas rather than the theme's `--w*` tokens.
 */
function LayoutTile({
  on,
  label,
  onSelect,
  children,
}: {
  on: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onSelect}
      className="group/tile flex min-w-0 cursor-pointer flex-col gap-2 text-left"
    >
      <div
        className={cn(
          "relative h-[136px] overflow-hidden rounded-[11px] border transition-[border-color,box-shadow] duration-150",
          on
            ? "border-[rgba(var(--acc1rgb),0.7)] shadow-[0_0_0_3px_rgba(var(--acc1rgb),0.16)]"
            : "border-w080 group-hover/tile:border-w160",
        )}
        style={{ background: DUSK_WASH }}
      >
        <div
          className={cn(
            "absolute inset-0 flex flex-col transition-[opacity,filter] duration-150",
            !on && "opacity-55 saturate-[0.8] group-hover/tile:opacity-75",
          )}
        >
          {children}
        </div>
        {on ? (
          <span className="absolute right-2 top-2 grid size-[18px] place-items-center rounded-full bg-acc1 text-white">
            <IconCheck className="size-[11px]" stroke={3} />
          </span>
        ) : null}
      </div>
      <span
        className={cn(
          "pl-0.5 text-[12.5px] font-medium",
          on ? "text-t1" : "text-t4",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Player layout                                                       */
/* ------------------------------------------------------------------ */

/**
 * Where the now-playing card lives: beside the page, under it, or in
 * its own window. Each tile is the app in miniature, sidebar rail and
 * all, with the player drawn where that mode puts it.
 */
function PlayerLayoutRow() {
  const value = useLayoutStore((s) => s.mode);
  const setValue = useLayoutStore((s) => s.setMode);

  return (
    <div className="flex flex-col">
      <SettingRow
        icon={IconLayoutFilled}
        title="Player Layout"
        description="Choose where the now-playing card lives."
      />
      <div role="radiogroup" className="grid grid-cols-3 gap-3 pb-4">
        {PLAYER_TILES.map(({ id, label, body }) => {
          const on = value === id;
          return (
            <LayoutTile
              key={id}
              on={on}
              label={label}
              onSelect={() => setValue(id)}
            >
              {body(on)}
            </LayoutTile>
          );
        })}
      </div>
    </div>
  );
}

/** The sidebar as a narrow rail of square menu items, the first lit. */
function MiniSidebar() {
  return (
    <div
      className="my-1.5 ml-1.5 flex w-[14px] shrink-0 flex-col items-center gap-1 rounded px-1 py-1.5"
      style={{ background: "rgba(255,255,255,0.045)" }}
    >
      {[0.34, 0.13, 0.13, 0.13].map((a, i) => (
        <span
          key={i}
          className="size-1.5 rounded-[2px]"
          style={{ background: `rgba(255,255,255,${a})` }}
        />
      ))}
    </div>
  );
}

/** The page behind the player: a heading and rows of covers. */
function MiniPage({
  n,
  rows,
  size,
}: {
  n: number;
  rows: number;
  size: number;
}) {
  return (
    <div className="flex flex-col gap-1.5 overflow-hidden px-2.5 pt-2.5">
      <Bar w="46%" h={4} a={0.22} />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-[5px]">
          {Array.from({ length: n }, (_, i) => (
            <div
              key={i}
              className="shrink-0 rounded bg-white/8"
              style={{ width: size, height: size }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A cover inside a card, so its shadow stays soft. */
function CardCover({ size }: { size: number }) {
  return (
    <div
      className="shrink-0 rounded-[5px] shadow-[0_4px_10px_-5px_rgba(0,0,0,0.35)]"
      style={{ width: size, height: size, background: DUSK_COVER }}
    />
  );
}

function MiniProgress() {
  return (
    <div className="relative h-0.5 w-full overflow-hidden rounded-full bg-white/14">
      <div className="absolute inset-y-0 left-0 w-[40%] rounded-full bg-white/35" />
    </div>
  );
}

/** Prev / play / next at card scale; the accent only while chosen. */
function MiniPrevNext({ on }: { on: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg
        width="7"
        height="7"
        viewBox="0 0 24 24"
        className="fill-white/30 stroke-white/30"
        strokeWidth="3"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M19 5v14L7 12z" />
      </svg>
      <span
        className={cn(
          "grid size-3.5 shrink-0 place-items-center rounded-full",
          on
            ? "bg-acc1 shadow-[0_4px_10px_-3px_rgba(var(--acc1rgb),0.7)]"
            : "bg-white/22",
        )}
      >
        <svg
          width="6"
          height="6"
          viewBox="0 0 24 24"
          className="fill-white stroke-white"
          strokeWidth="3"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 4v16l14-8z" />
        </svg>
      </span>
      <svg
        width="7"
        height="7"
        viewBox="0 0 24 24"
        className="fill-white/30 stroke-white/30"
        strokeWidth="3"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5 5v14l12-7z" />
      </svg>
    </div>
  );
}

/** Title bars under a cover: the track name and the artist. */
function MiniTitle() {
  return (
    <div className="flex w-full flex-col gap-[3px]">
      <Bar w="80%" h={3} a={0.35} />
      <Bar w="55%" h={2} a={0.16} />
    </div>
  );
}

/** The two window dots that mark a title bar. */
function WindowDots() {
  return (
    <div className="flex h-[3px] w-full justify-end gap-0.5">
      <span className="size-[3px] rounded-[1px] bg-white/30" />
      <span className="size-[3px] rounded-[1px] bg-white/30" />
    </div>
  );
}

const PLAYER_TILES: {
  id: LayoutMode;
  label: string;
  body: (on: boolean) => React.ReactNode;
}[] = [
  {
    id: "right",
    label: "Side Card",
    body: (on) => (
      <div className="flex h-full">
        <MiniSidebar />
        <div className="min-w-0 flex-1">
          <MiniPage n={3} rows={1} size={22} />
        </div>
        <div className="my-1.5 mr-1.5 flex w-[60px] shrink-0 flex-col items-center gap-[5px] rounded-[7px] border border-white/10 bg-white/6 p-1.5">
          <CardCover size={46} />
          <MiniTitle />
          <MiniProgress />
          <MiniPrevNext on={on} />
          <div className="flex w-full flex-col gap-[3px]">
            <Bar w="90%" h={2} a={0.12} />
            <Bar w="70%" h={2} a={0.12} />
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "bottom",
    label: "Bottom Bar",
    body: (on) => (
      <div className="flex h-full">
        <MiniSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <MiniPage n={6} rows={2} size={20} />
          </div>
          <div className="mx-1.5 mb-1.5 mt-1 flex shrink-0 flex-col gap-1 rounded-md border border-white/10 bg-white/6 px-2 pb-1.5 pt-[5px]">
            <div className="flex items-center gap-1.5">
              <CardCover size={18} />
              <div className="flex w-[30px] flex-col gap-[3px]">
                <Bar w="100%" h={3} a={0.35} />
                <Bar w="60%" h={2} a={0.16} />
              </div>
              <div className="flex flex-1 justify-center">
                <MiniPrevNext on={on} />
              </div>
              <div className="flex w-[30px] justify-end gap-[3px]">
                <span className="size-[5px] rounded-[2px] bg-white/16" />
                <span className="size-[5px] rounded-[2px] bg-white/16" />
              </div>
            </div>
            <MiniProgress />
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "floating",
    label: "Floating",
    body: (on) => (
      <>
        <div className="absolute inset-0 flex opacity-35">
          <MiniSidebar />
          <div className="min-w-0 flex-1 overflow-hidden">
            <MiniPage n={6} rows={2} size={20} />
          </div>
        </div>
        <div className="absolute inset-0 grid place-items-center">
          <div
            className="flex w-[68px] flex-col items-center gap-[5px] rounded-[7px] border border-white/16 p-1.5 shadow-[0_16px_30px_-10px_rgba(0,0,0,0.75),0_0_0_1px_rgba(0,0,0,0.35)]"
            style={{ background: "#2a2c3f" }}
          >
            <WindowDots />
            <CardCover size={54} />
            <MiniTitle />
            <MiniPrevNext on={on} />
          </div>
        </div>
      </>
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Fullscreen player layout                                            */
/* ------------------------------------------------------------------ */

/**
 * Three tiles, each a miniature of the now-playing screen: a dusk-blue
 * "album" wash, a cover, the title bars and the transport with its play
 * button.
 */
function IdleFadeRow() {
  const on = useSettingsStore((s) => s.fullscreenIdleFade);
  const set = useSettingsStore((s) => s.setFullscreenIdleFade);
  return (
    <SettingRow
      icon={IconEyeOff}
      title="Hide Controls When Idle"
      description="Fade the full-screen controls away once the mouse stops moving."
      control={
        <Switch
          checked={on}
          onCheckedChange={set}
          aria-label="Hide Controls When Idle"
        />
      }
    />
  );
}

function FullscreenLayoutRow() {
  const value = useSettingsStore((s) => s.fullscreenLayout);
  const setValue = useSettingsStore((s) => s.setFullscreenLayout);

  return (
    <div className="flex flex-col">
      <SettingRow
        icon={IconAppWindowFilled}
        title="Fullscreen Player Layout"
        description="How the now-playing screen fills the display."
      />
      <div role="radiogroup" className="grid grid-cols-3 gap-3 pb-4">
        {FS_TILES.map(({ id, label, body }) => {
          const on = value === id;
          return (
            <LayoutTile
              key={id}
              on={on}
              label={label}
              onSelect={() => setValue(id)}
            >
              {body}
              <MiniTransport on={on} />
            </LayoutTile>
          );
        })}
      </div>
    </div>
  );
}

/* The dusk palette the tiles are painted in. */
const DUSK_WASH =
  "radial-gradient(120% 100% at 22% 10%, rgba(120,132,220,0.28), transparent 58%), linear-gradient(165deg, #232538, #17181f)";
const DUSK_COVER = "linear-gradient(140deg, #7d84c9, #383c68)";
const DUSK_ART = "linear-gradient(140deg, #7d84c9, #383c68 55%, #101018)";

function MiniCover() {
  return (
    <div
      className="size-[34px] shrink-0 rounded-md shadow-[0_6px_16px_-6px_rgba(0,0,0,0.45)]"
      style={{ background: DUSK_COVER }}
    />
  );
}

/** A title or lyric line. */
function Bar({ w, h, a }: { w: string; h: number; a: number }) {
  return (
    <div
      className="shrink-0 rounded-full"
      style={{ width: w, height: h, background: `rgba(255,255,255,${a})` }}
    />
  );
}

/** Progress plus prev / play / next; the accent only while chosen. */
function MiniTransport({ on }: { on: boolean }) {
  return (
    <div className="relative flex shrink-0 flex-col items-center gap-2.5 px-3.5 pb-3.5">
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/15">
        <div className="absolute inset-y-0 left-0 w-[40%] rounded-full bg-white/35" />
      </div>
      <div className="flex items-center gap-3.5">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          className="fill-white/30 stroke-white/30"
          strokeWidth="3"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M19 5v14L7 12z" />
        </svg>
        <span
          className={cn(
            "grid size-5 place-items-center rounded-full",
            on
              ? "bg-acc1 shadow-[0_4px_10px_-3px_rgba(var(--acc1rgb),0.7)]"
              : "bg-white/22",
          )}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            className="fill-white stroke-white"
            strokeWidth="3"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M6 4v16l14-8z" />
          </svg>
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          className="fill-white/30 stroke-white/30"
          strokeWidth="3"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 5v14l12-7z" />
        </svg>
      </div>
    </div>
  );
}

const FS_TILES: {
  id: FullscreenLayout;
  label: string;
  body: React.ReactNode;
}[] = [
  {
    id: "cover",
    label: "Centered",
    body: (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-1.5 pt-2.5">
        <MiniCover />
        <Bar w="44px" h={5} a={0.35} />
      </div>
    ),
  },
  {
    id: "lyrics",
    label: "With Lyrics",
    body: (
      <div className="flex min-h-0 flex-1 items-center gap-3.5 px-5 pb-1.5 pt-2.5">
        <MiniCover />
        <div className="flex flex-1 flex-col gap-[7px]">
          <Bar w="60%" h={5} a={0.16} />
          <Bar w="100%" h={6} a={0.35} />
          <Bar w="78%" h={5} a={0.16} />
        </div>
      </div>
    ),
  },
  {
    id: "immersive",
    label: "Immersive Art",
    body: (
      <>
        <div className="absolute inset-0" style={{ background: DUSK_ART }} />
        <div className="relative flex min-h-0 flex-1 flex-col justify-end gap-1.5 px-3.5 pb-3 pt-2.5">
          <Bar w="64px" h={8} a={0.92} />
          <Bar w="36px" h={4} a={0.5} />
        </div>
      </>
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
      title="Interface Font"
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
