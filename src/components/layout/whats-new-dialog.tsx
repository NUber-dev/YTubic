import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useWhatsNewStore } from "@/lib/store/whats-new";
import {
  WHATS_NEW,
  whatsNewFor,
  type WhatsNewChangeType,
  type WhatsNewEntry,
} from "@/lib/whats-new";

/**
 * Change sections in display order. "New" and "Improved" share one
 * section so a release with a single improvement doesn't render two
 * one-item groups.
 */
const GROUPS: ReadonlyArray<{
  label: string;
  types: ReadonlyArray<WhatsNewChangeType>;
  labelClass: string;
  badgeClass: string;
  withShield?: boolean;
}> = [
  {
    label: "New & Improved",
    types: ["new", "improved"],
    labelClass: "text-primary",
    badgeClass: "bg-primary/15 text-primary",
  },
  {
    label: "Fixed",
    types: ["fixed"],
    labelClass: "text-foreground/60",
    badgeClass: "bg-foreground/10 text-foreground/60",
  },
  {
    label: "Security",
    types: ["security"],
    labelClass: "text-amber-600 dark:text-amber-400",
    badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    withShield: true,
  },
];

/**
 * The What's New screen: the full release history on a vertical
 * timeline, newest first. Each version is a chip on the line with a
 * one-line summary; the entry being introduced starts expanded and the
 * rest unfold on click. Opened automatically once per release (see
 * `useWhatsNewOnUpdate`) and manually from the About dialog. Closed
 * with the X, a click outside, or Escape, so it carries no footer
 * button of its own.
 */
export function WhatsNewDialog() {
  const open = useWhatsNewStore((s) => s.open);
  const setOpen = useWhatsNewStore((s) => s.setOpen);
  const version = useWhatsNewStore((s) => s.version);

  // The entry the dialog was opened for; newest as the fallback so a
  // dev build whose version has no entry still shows something.
  const focusVersion =
    (version && whatsNewFor(version) ? version : WHATS_NEW[0]?.version) ?? null;

  // Per-version expand overrides on top of the default (focused entry
  // open, everything else closed). Reset each time the dialog opens so
  // a reopen starts from the same state.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (open) setExpanded({});
  }, [open]);

  const isExpanded = (v: string) => expanded[v] ?? v === focusVersion;
  const toggle = (v: string) =>
    setExpanded((prev) => ({ ...prev, [v]: !isExpanded(v) }));

  // When the focused entry sits below newer releases (manual open on an
  // older version), bring it into view once the dialog has mounted.
  const entryRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!open || !focusVersion || focusVersion === WHATS_NEW[0]?.version)
      return;
    const t = setTimeout(() => {
      entryRefs.current
        .get(focusVersion)
        ?.scrollIntoView({ block: "start", behavior: "instant" });
    }, 60);
    return () => clearTimeout(t);
  }, [open, focusVersion]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(760px,85vh)] w-[640px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <div className="shrink-0 border-b px-6 py-5">
          <DialogTitle className="text-xl font-bold leading-none tracking-tight">
            What's New
          </DialogTitle>
          <DialogDescription className="sr-only">
            Release history for YTubic
          </DialogDescription>
        </div>

        <div className="relative min-h-0 flex-1">
          <div className="app-scroll h-full overflow-y-auto px-6 py-8">
            <div className="relative">
              {/* Timeline rail with an accent glow fading out below the
                  newest entry. */}
              <div className="absolute bottom-5 left-6 top-6 w-0.5 overflow-hidden rounded-full bg-foreground/5">
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(180deg, var(--primary) 0%, color-mix(in oklab, var(--primary) 80%, transparent) 6%, transparent 30%)",
                    boxShadow:
                      "0 0 8px color-mix(in oklab, var(--primary) 40%, transparent)",
                  }}
                />
              </div>

              {WHATS_NEW.map((entry, i) => (
                <TimelineEntry
                  key={entry.version}
                  entry={entry}
                  isNewest={i === 0}
                  isLast={i === WHATS_NEW.length - 1}
                  expanded={isExpanded(entry.version)}
                  onToggle={() => toggle(entry.version)}
                  nodeRef={(el) => {
                    if (el) entryRefs.current.set(entry.version, el);
                    else entryRefs.current.delete(entry.version);
                  }}
                />
              ))}
            </div>
          </div>
          {/* Bottom fade so the list dissolves instead of clipping. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-background" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TimelineEntry({
  entry,
  isNewest,
  isLast,
  expanded,
  onToggle,
  nodeRef,
}: {
  entry: WhatsNewEntry;
  isNewest: boolean;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  nodeRef: (el: HTMLDivElement | null) => void;
}) {
  const isMajor = entry.version.endsWith(".0");
  return (
    <div
      ref={nodeRef}
      className={cn(
        "relative pl-[72px]",
        isNewest ? "pb-5" : "pb-8",
        isLast && "pb-1",
      )}
    >
      {/* Version chip on the rail. The solid outline punches a gap in
          the timeline line behind it; the newest chip pulses. Accent
          coloring marks major (x.y.0) releases only. */}
      <span
        className={cn(
          "absolute left-0 flex h-6 items-center justify-center whitespace-nowrap rounded-[7px] border px-2.5 text-xs font-bold tabular-nums tracking-tight",
          isNewest ? "-top-2 whats-new-pulse" : "top-0",
          isMajor
            ? "border-primary/35 text-primary"
            : "border-border bg-secondary text-muted-foreground",
        )}
        style={{
          outline: "6px solid var(--background)",
          // Solid accent tint (mixed with the background, not alpha
          // over transparent) so the rail can't show through the chip.
          ...(isMajor
            ? {
                backgroundColor:
                  "color-mix(in oklab, var(--primary) 12%, var(--background))",
              }
            : null),
        }}
      >
        {entry.version}
      </span>

      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center justify-between gap-3.5 rounded-lg text-left transition-opacity hover:opacity-80",
          isNewest && "relative -top-2.5",
        )}
      >
        <div className="min-w-0">
          <div
            className={cn(
              "text-base font-semibold tracking-tight",
              isNewest ? "text-foreground" : "text-foreground/90",
            )}
          >
            {entry.summary}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{entry.date}</div>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className={cn(isNewest ? "mt-0" : "mt-3")}>
          {entry.image ? (
            <div className="relative mb-5 h-[220px] overflow-hidden rounded-xl border border-foreground/10 bg-black/20">
              <img
                src={entry.image}
                alt=""
                className={cn(
                  "absolute inset-0 h-full w-full object-cover",
                  entry.imageAlign === "top" && "object-top",
                )}
              />
            </div>
          ) : null}

          {GROUPS.map((group) => {
            const items = entry.changes.filter((c) =>
              group.types.includes(c.type),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="mb-5 last:mb-0">
                <div className="mb-2.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider",
                      group.labelClass,
                    )}
                  >
                    {group.withShield ? (
                      <ShieldIcon className="size-3.5 fill-current" />
                    ) : null}
                    {group.label}
                    <span
                      className={cn(
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-xs font-bold tabular-nums",
                        group.badgeClass,
                      )}
                    >
                      {items.length}
                    </span>
                  </span>
                </div>
                {items.map((change) => (
                  <div
                    key={change.title}
                    className="mb-2 flex items-start gap-3 last:mb-0"
                  >
                    <span
                      className={cn(
                        "mt-2 size-1.5 shrink-0 rounded-full",
                        change.type === "new"
                          ? "bg-primary"
                          : "bg-muted-foreground/70",
                      )}
                    />
                    <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-muted-foreground">
                      <span className="font-semibold tracking-tight text-foreground">
                        {change.title}
                      </span>{" "}
                      - {change.text}
                    </p>
                  </div>
                ))}
              </div>
            );
          })}

          {entry.note ? (
            <div className="mb-5 rounded-lg border border-border/60 bg-muted/40 p-3 last:mb-0">
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                A note from the developer
              </div>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                {entry.note}
              </p>
            </div>
          ) : null}

          {entry.alert ? (
            <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 last:mb-0">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
                {entry.alert}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
