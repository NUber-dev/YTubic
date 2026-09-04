import { useEffect, useState, type ComponentType } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  IconAdjustmentsFilled,
  IconContrastFilled,
  IconDatabaseFilled,
  IconPlayerPlayFilled,
  IconPuzzleFilled,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { useUpdateStore } from "@/lib/store/update";
import { GeneralTab } from "@/components/settings/general-tab";
import { PlaybackTab } from "@/components/settings/playback-tab";
import { AppearanceTab } from "@/components/settings/appearance-tab";
import { StorageTab } from "@/components/settings/storage-tab";
import { IntegrationsTab } from "@/components/settings/integrations-tab";
import {
  useSettingsDialog,
  type SettingsTab,
} from "@/lib/store/settings-dialog";
import { cn } from "@/lib/utils";

const TABS: {
  id: SettingsTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { id: "general", label: "General", icon: IconAdjustmentsFilled },
  { id: "playback", label: "Playback", icon: IconPlayerPlayFilled },
  { id: "appearance", label: "Appearance", icon: IconContrastFilled },
  { id: "storage", label: "Storage", icon: IconDatabaseFilled },
  { id: "integrations", label: "Integrations", icon: IconPuzzleFilled },
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

  // Footer of the tab rail. Cheap enough to read on open and it saves
  // a trip to About just to check what you're running.
  const [version, setVersion] = useState("");
  const phase = useUpdateStore((s) => s.phase);
  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName={frostedDialogOverlay}
        className={cn(
          "flex h-[640px] max-h-[85vh] w-[920px] max-w-[calc(100vw-2rem)] flex-row gap-0 overflow-hidden rounded-[20px] p-0 sm:max-w-[920px]",
          "shadow-[0_30px_70px_-20px_var(--k850)]",
          frostedDialogPanel,
        )}
      >
        {/* Catch-light along the top edge, inset so it stops at the
            border rather than over it. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-px top-0 z-[1] h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
        />

        <aside className="flex w-[196px] shrink-0 flex-col gap-5 border-r border-w060 bg-sidepanel px-3.5 pb-[18px] pt-5">
          {/* Same 20px inset and same 29px box as the panel header, whose
              height is set by its close button — so "Settings" and the
              active tab's title land on one baseline without hand-tuned
              offsets. */}
          <DialogTitle className="flex h-7 items-center px-1.5 text-xl font-semibold leading-none tracking-[-0.015em] text-t1">
            Settings
          </DialogTitle>
          <nav className="flex flex-col gap-0.5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] transition-colors duration-[140ms]",
                  tab === id
                    ? "bg-w070 font-semibold text-t1"
                    : "font-medium text-t5 hover:bg-w050 hover:text-t3",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-[3px] px-2">
            <span className="text-[11.5px] text-t9">
              {version ? `YTubic v${version}` : "YTubic"}
            </span>
            <span className="text-[11.5px] text-t10">
              {phase === "idle" || phase === "error"
                ? "Up to date"
                : "Update available"}
            </span>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Fixed header: the active tab's title, with the close button
              on the same row. It doesn't scroll away. */}
          <div className="flex items-center gap-4 border-b border-w055 p-5">
            <h3 className="text-xl font-semibold leading-none tracking-[-0.015em] text-t1">
              {TABS.find((t) => t.id === tab)?.label}
            </h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close settings"
              className="ml-auto grid size-7 flex-none cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2"
            >
              <IconX className="size-3" />
            </button>
          </div>
          {/* Slot the Storage tab portals its pinned list toolbar
              into. Living above the scroller means scrolling rows get
              clipped by the scroller's own overflow, so the toolbar
              needs no background of its own — same architecture as
              the playlist page header. */}
          {/* pr = scroller's px + the 8px .app-scroll scrollbar the slot
              doesn't have — keeps the toolbar's width identical in both
              homes so the pin swap doesn't visibly shift. A pin always
              implies overflow, so the scrollbar is always there while
              this slot is in use. */}
          <div
            data-settings-pinned-slot
            className="shrink-0 pl-5 pr-7"
          />
          {/* scrollbar-gutter stable: the scrollbar's column is reserved
              even while the tab is short, so a tab growing past the
              viewport (opening the equaliser) doesn't shift every row
              left by the scrollbar's width. It also makes the slot's
              pr-7 above hold for tabs with no pin. */}
          {/* overflow-anchor off: the pinned-toolbar swap removes the
              toolbar's height from this scroller's content while
              adding the same height to the slot above — geometry-
              neutral overall, but Chrome's scroll anchoring only sees
              the removal and "compensates" scrollTop, which unpins the
              toolbar and loops (scroll-down felt like being thrown
              back up). */}
          <div className="app-scroll min-w-0 flex-1 overflow-y-auto px-5 pb-[22px] pt-1 [overflow-anchor:none] [scrollbar-gutter:stable]">
            {tab === "general" && <GeneralTab />}
            {tab === "playback" && <PlaybackTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "storage" && <StorageTab />}
            {tab === "integrations" && <IntegrationsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
