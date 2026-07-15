import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the settings dialog tabs — the same
 * surface-panel + row language the sidebar and player card use.
 */

/** Cluster of related rows. No card chrome — settings read as one
 *  flat list, rows separated by hairline dividers only. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/70">{children}</div>
  );
}

export function SettingRow({
  icon: Icon,
  iconClassName,
  title,
  description,
  control,
}: {
  // Accepts lucide icons and our own SVG brand marks alike (both just take
  // a className) — lucide has no Discord icon, so the Integrations tab passes
  // a custom one.
  icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon
          className={cn("size-[18px] text-muted-foreground", iconClassName)}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-medium leading-none">{title}</span>
        {description ? (
          <span className="text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {control}
    </div>
  );
}

/** Tab pane wrapper. Dividers between top-level blocks continue the
 *  same flat-list rhythm the groups use internally; the tab heading
 *  itself lives in the dialog shell's fixed header row.
 *
 *  `tightTop` collapses the very first row's own `py-4` top padding so
 *  the list starts flush with the scroller top. Use it on tabs whose
 *  first block is a settings row (General, Appearance) to line them up
 *  with the Storage tab, whose stat cards already sit flush there.
 *  (Storage itself omits it — its first TabPane row follows the stats
 *  block, not the header, so it should keep the padding.) */
export function TabPane({
  children,
  tightTop = false,
}: {
  children: ReactNode;
  tightTop?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border/70",
        tightTop && "[&>*:first-child>*:first-child]:pt-0",
      )}
    >
      {children}
    </div>
  );
}
