import {
  DatabaseIcon,
  PaletteIcon,
  PlugIcon,
  Settings2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { GeneralTab } from "@/components/settings/general-tab";
import { AppearanceTab } from "@/components/settings/appearance-tab";
import { StorageTab } from "@/components/settings/storage-tab";
import { IntegrationsTab } from "@/components/settings/integrations-tab";
import {
  useSettingsDialog,
  type SettingsTab,
} from "@/lib/store/settings-dialog";
import { cn } from "@/lib/utils";

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "storage", label: "Storage", icon: DatabaseIcon },
  { id: "integrations", label: "Integrations", icon: PlugIcon },
];

/**
 * The settings popup: tab rail on the left, the active tab's panel on
 * the right. Mounted once in AppShell; opened from anywhere via
 * `openSettings()` (sidebar footer, title-bar menu, sign-in CTAs).
 */
export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const setOpen = useSettingsDialog((s) => s.setOpen);
  const tab = useSettingsDialog((s) => s.tab);
  const setTab = useSettingsDialog((s) => s.setTab);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        // Dim the app less than the default dialog (0.5 → 0.4) so more
        // of the red cover survives into this popup's backdrop-blur —
        // otherwise the vivid cover collapses into a dark, desaturated
        // mauve by the time it's passed through the overlay + panel.
        overlayClassName="bg-black/40"
        // Mostly-opaque (0.9) frosted panel. In dark mode the fill is a
        // hair above --background (L 0.145 → 0.19) so it reads as a dark
        // grey surface rather than a pure-black slab; the remaining 10%
        // still lets a faint warm cast of the cover through the blur.
        // Border is a touch brighter than the fill so the frosted edge
        // stays legible against the blurred art behind it.
        className="flex h-[600px] max-h-[85vh] w-[880px] max-w-[calc(100vw-2rem)] flex-row gap-0 overflow-hidden border-black/10 bg-background/90 p-0 backdrop-blur-2xl sm:max-w-[880px] dark:border-white/15 dark:bg-[oklch(0.19_0_0)]/90"
      >
        <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border/70 bg-muted/40 p-3 dark:bg-black/20">
          {/* Same size AND vertical position as the active tab's <h3>.
              That heading is centred in the header row whose height is
              set by the 28px (size-7) close button, so this title gets a
              matching h-7 items-center box at the same 16px top offset
              (aside p-3 = 12px + pt-1 = 4px). Both then centre an 18px
              text within 28px starting at y=16 → identical baseline.
              mb-3 + the aside's gap-1 (4px, which also spaces the tabs
              from each other) = 16px before the first tab — matching the
              header's pb-4 on the right, so both titles drop the same
              distance to the list below. Being margin, it sits outside
              the h-7 box so it doesn't disturb the baseline. */}
          <DialogTitle className="mb-3 flex h-7 items-center px-2.5 pt-1 text-lg font-semibold leading-none">
            Settings
          </DialogTitle>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                tab === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Fixed header row: the active tab's title with the close
              button sitting on the same baseline, flush with the
              content's right padding — it doesn't scroll away. */}
          <div className="flex items-center justify-between gap-2 px-5 pb-4 pt-4">
            <h3 className="text-lg font-semibold leading-none">
              {TABS.find((t) => t.id === tab)?.label}
            </h3>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label="Close settings"
              >
                <XIcon />
              </Button>
            </DialogClose>
          </div>
          {/* Slot the Storage tab portals its pinned list toolbar
              into. Living above the scroller means scrolling rows get
              clipped by the scroller's own overflow, so the toolbar
              needs no background of its own — same architecture as
              the playlist page header. */}
          {/* pr = scroller's px-5 + the 8px .app-scroll scrollbar the
              slot doesn't have — keeps the toolbar's width identical
              in both homes so the pin swap doesn't visibly shift. A
              pin always implies overflow, so the scrollbar (and thus
              the 8px) is always there while this slot is in use. */}
          <div data-settings-pinned-slot className="shrink-0 pl-5 pr-7" />
          {/* overflow-anchor off: the pinned-toolbar swap removes the
              toolbar's height from this scroller's content while
              adding the same height to the slot above — geometry-
              neutral overall, but Chrome's scroll anchoring only sees
              the removal and "compensates" scrollTop, which unpins the
              toolbar and loops (scroll-down felt like being thrown
              back up). */}
          <div className="app-scroll min-w-0 flex-1 overflow-y-auto px-5 pb-5 [overflow-anchor:none]">
            {tab === "general" && <GeneralTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "storage" && <StorageTab />}
            {tab === "integrations" && <IntegrationsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
