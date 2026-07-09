import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWhatsNewStore } from "@/lib/store/whats-new";
import { whatsNewFor } from "@/lib/whats-new";

/**
 * The post-update What's New screen: a hero banner, the title and
 * release date, and a scrollable list of changes grouped into sections.
 * Opened automatically once per release (see `useWhatsNewOnUpdate`) and
 * manually from the About dialog. Closed with the X, a click outside,
 * or Escape, so it carries no footer button of its own.
 */
export function WhatsNewDialog() {
  const open = useWhatsNewStore((s) => s.open);
  const setOpen = useWhatsNewStore((s) => s.setOpen);
  const version = useWhatsNewStore((s) => s.version);
  const entry = version ? whatsNewFor(version) : undefined;

  return (
    <Dialog open={open && !!entry} onOpenChange={setOpen}>
      {entry ? (
        <DialogContent className="flex max-h-[85vh] max-w-md flex-col gap-0 overflow-hidden p-0">
          {/* Hero: bundled image if the entry has one, else a branded
              gradient so the screen never looks broken. Fixed height
              (not aspect-ratio): an aspect-ratio flex child mis-sizes
              the column under max-height and lets the dialog outgrow
              the viewport. */}
          <div className="relative h-[190px] w-full shrink-0 overflow-hidden">
            {entry.image ? (
              <img
                src={entry.image}
                alt=""
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/25 via-primary/10 to-background">
                <img
                  src="/ytubic-icon.svg"
                  alt=""
                  className="size-16 opacity-90 drop-shadow-md"
                />
              </div>
            )}
          </div>

          <div className="shrink-0 px-6 pb-4 pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <DialogTitle className="text-xl font-bold leading-none">
                What's New
              </DialogTitle>
              <span className="shrink-0 text-xs text-muted-foreground">
                {entry.date}
              </span>
            </div>
            <DialogDescription className="sr-only">
              Release notes for YTubic version {entry.version}
            </DialogDescription>
          </div>

          <div className="app-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-0">
            {entry.sections.map((section, i) => (
              <div key={i} className="flex flex-col gap-2">
                {section.heading ? (
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.heading}
                  </h3>
                ) : null}
                {section.body ? (
                  <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {section.body}
                    </p>
                  </div>
                ) : section.items ? (
                  <ul className="flex flex-col gap-2">
                    {section.items.map((item, j) => (
                      <li
                        key={j}
                        className="flex gap-2.5 text-sm leading-snug text-foreground/90"
                      >
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
