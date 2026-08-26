import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconMessage,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { IconToolFilled } from "@/components/shared/filled-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  frostedDialogOverlay,
  frostedDialogPanel,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useWhatsNewStore } from "@/lib/store/whats-new";
import { WHATS_NEW, whatsNewFor, type WhatsNewEntry } from "@/lib/whats-new";

/** Rose used for hero ticks and "new" bullets. A shade off `--acc1`,
 *  which stays reserved for interactive accents. */
const HERO = "#CF385E";

/** How many ticks the rail shows at once; it windows around the
 *  selection and fades the three at each cut edge. */
const RAIL_WINDOW = 15;

/** A release is "hero" when it shipped with a screenshot. */
const isHero = (e: WhatsNewEntry) => !!e.image;

/**
 * The What's New window: one release at a time, with a tick-mark
 * timeline in the gutter to the left of the card for jumping between
 * versions. Opened automatically once per release (see
 * `useWhatsNewOnUpdate`) and manually from the About dialog.
 */
export function WhatsNewDialog() {
  const open = useWhatsNewStore((s) => s.open);
  const setOpen = useWhatsNewStore((s) => s.setOpen);
  const version = useWhatsNewStore((s) => s.version);

  const [sel, setSel] = useState(0);
  const [hov, setHov] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const last = WHATS_NEW.length - 1;

  // Each release starts at the top of its own scroll, so moving down
  // the rail never lands mid-article.
  const select = (i: number) => {
    const n = Math.max(0, Math.min(last, i));
    setSel(n);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  // Open on the release the dialog was raised for; newest as the
  // fallback, so a dev build whose version has no entry still shows
  // something.
  useEffect(() => {
    if (!open) return;
    const i =
      version && whatsNewFor(version)
        ? WHATS_NEW.findIndex((e) => e.version === version)
        : 0;
    setSel(i < 0 ? 0 : i);
    setHov(-1);
  }, [open, version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        select(sel - 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        select(sel + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Wheel over the rail steps the selection instead of scrolling.
  // Accumulate so a trackpad's many small deltas don't fly through the
  // whole history in one flick.
  const wheelAcc = useRef(0);
  const wheelAt = useRef(0);
  const onRailWheel = (e: React.WheelEvent) => {
    wheelAcc.current += e.deltaY;
    const now = e.timeStamp;
    if (Math.abs(wheelAcc.current) >= 40 && now - wheelAt.current > 70) {
      select(sel + (wheelAcc.current > 0 ? 1 : -1));
      wheelAcc.current = 0;
      wheelAt.current = now;
    }
  };

  const entry = WHATS_NEW[sel];
  const start = Math.max(
    0,
    Math.min(
      sel - Math.floor(Math.min(RAIL_WINDOW, WHATS_NEW.length) / 2),
      WHATS_NEW.length - Math.min(RAIL_WINDOW, WHATS_NEW.length),
    ),
  );
  const windowed = WHATS_NEW.slice(
    start,
    start + Math.min(RAIL_WINDOW, WHATS_NEW.length),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={frostedDialogOverlay}
        // Chrome-less: this element is only the positioning context, so
        // the rail can sit outside the card without being clipped by
        // the card's own `overflow-hidden`.
        className="block w-[560px] max-w-[calc(100vw-2rem)] border-0 bg-transparent p-0 shadow-none sm:max-w-[560px]"
      >
        <div className="relative h-[min(620px,calc(100vh-64px))] w-full">
          {/* Version rail, in the gutter to the left of the card. */}
          <div
            onWheel={onRailWheel}
            className="absolute inset-y-0 right-full flex w-[84px] items-center justify-end pr-3 [overscroll-behavior:contain]"
          >
            <div className="flex flex-col items-end">
              <RailStep
                dir="up"
                disabled={sel === 0}
                onClick={() => select(sel - 1)}
              />
              {windowed.map((e, j) => {
                const i = start + j;
                const hovered = hov === i;
                const selected = i === sel;
                const hero = isHero(e);
                // Fade the three ticks at each cut edge so the rail
                // reads as a window onto a longer list.
                const fromEnd = windowed.length - 1 - j;
                let op = 1;
                if (start > 0 && j < 3) op = [0.2, 0.45, 0.7][j];
                if (start + windowed.length < WHATS_NEW.length && fromEnd < 3) {
                  op = Math.min(op, [0.2, 0.45, 0.7][fromEnd]);
                }
                if (hovered || selected) op = 1;

                return (
                  <button
                    key={e.version}
                    type="button"
                    aria-label={e.version}
                    aria-current={selected}
                    onClick={() => select(i)}
                    onMouseEnter={() => setHov(i)}
                    onMouseLeave={() => setHov(-1)}
                    className="relative flex h-3 w-[42px] cursor-pointer items-center justify-end pr-1"
                  >
                    {hovered ? (
                      <span className="pointer-events-none absolute right-[calc(100%-4px)] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-w100 bg-surf2 px-2 py-1 text-[11.5px] font-semibold text-t1 shadow-[0_4px_12px_var(--k400)]">
                        {e.version}
                      </span>
                    ) : null}
                    <span
                      className="rounded-[1px] transition-[width,height,background-color,opacity] duration-[180ms] [transition-timing-function:cubic-bezier(.32,.72,0,1)]"
                      style={{
                        width:
                          (selected ? (hero ? 26 : 22) : hero ? 19 : 14) +
                          (hovered ? 4 : 0),
                        height: (selected ? 3 : 2) + (hovered ? 1 : 0),
                        opacity: op,
                        backgroundColor: selected
                          ? hero
                            ? HERO
                            : "var(--t1)"
                          : hero
                            ? hovered
                              ? "rgba(207,56,94,0.95)"
                              : "rgba(207,56,94,0.65)"
                            : hovered
                              ? "var(--w350)"
                              : "var(--w280)",
                      }}
                    />
                  </button>
                );
              })}
              <RailStep
                dir="down"
                disabled={sel === last}
                onClick={() => select(sel + 1)}
              />
            </div>
          </div>

          {/* Same frosted surface as every other dialog — the design's
              own `--glass2` is both darker and more opaque, which made
              this window read as a different material next to About. */}
          <div
            className={cn(
              // `border` is on this line, not in `frostedDialogPanel`: that
              // constant only carries the colour, and the width normally
              // comes from `DialogContent` — which this card is not.
              "relative flex h-full w-full flex-col overflow-hidden rounded-[20px] border shadow-[0_30px_70px_-20px_var(--k850)]",
              frostedDialogPanel,
            )}
          >
            {/* Catch-light along the top edge, inset so it stops at the
                border rather than over it. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-px top-0 h-px bg-[linear-gradient(90deg,transparent,var(--w160),transparent)]"
            />

            <div className="flex flex-none items-center gap-3 px-5 pt-5">
              <div className="flex w-full items-center gap-2.5">
                <DialogTitle className="rounded-[7px] border border-[rgba(var(--acc1rgb),0.28)] bg-[rgba(var(--acc1rgb),0.12)] px-2.5 py-1 text-xs font-bold text-acc3">
                  {entry.version}
                </DialogTitle>
                <span className="text-[13px] text-t6">{entry.date}</span>
              </div>
              <DialogDescription className="sr-only">
                Release notes for YTubic {entry.version}
              </DialogDescription>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="grid size-7 flex-none cursor-pointer place-items-center rounded-lg border border-w070 bg-w030 text-t6 transition-colors duration-[140ms] hover:bg-w080 hover:text-t2"
              >
                <IconX className="size-3" />
              </button>
            </div>

            <div
              ref={scrollRef}
              className="app-scroll min-h-0 flex-1 overflow-y-auto pb-5 pl-5 pr-3.5 pt-5 [scrollbar-gutter:stable]"
            >
              {/* Keyed on the version so switching releases replays the
                  entrance rather than swapping text in place. */}
              <div
                key={entry.version}
                className="whats-new-enter flex flex-col gap-5"
              >
                <ReleaseMedia entry={entry} />

                {entry.summary ? (
                  <div className="px-1">
                    <span className="text-[21px] font-bold leading-[1.2] tracking-[-0.02em] text-t1 text-pretty">
                      {entry.summary}
                    </span>
                  </div>
                ) : null}

                <div className="flex flex-col gap-3 px-1">
                  {entry.changes.map((c) => (
                    <div key={c.title} className="flex gap-[11px]">
                      <span
                        className="mt-[7px] size-1.5 flex-none rounded-full"
                        style={{
                          backgroundColor:
                            c.type === "new" || c.type === "improved"
                              ? HERO
                              : "var(--w220)",
                        }}
                      />
                      <span className="text-[13.5px] leading-[1.55] text-t6 text-pretty">
                        <strong className="font-semibold text-t2">
                          {c.title}
                        </strong>{" "}
                        — {c.text}
                      </span>
                    </div>
                  ))}
                </div>

                {entry.note ? (
                  <div className="flex flex-col gap-2 rounded-xl border border-w080 bg-w035 p-4">
                    <div className="flex items-center gap-2">
                      <IconMessage className="size-3 text-t4" />
                      <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-t4">
                        Note from the developer
                      </span>
                    </div>
                    <NoteText text={entry.note} />
                  </div>
                ) : null}

                {entry.alert ? (
                  <div className="flex gap-2.5 rounded-[11px] border border-[rgba(245,196,66,0.25)] bg-[rgba(245,196,66,0.08)] p-4">
                    <IconAlertTriangle className="mt-px size-4 flex-none text-[#F5C442]" />
                    <span className="text-[13px] leading-[1.6] text-[#8A6D1F] text-pretty dark:text-[#D9BC72]">
                      {entry.alert}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RailStep({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = dir === "up" ? IconChevronUp : IconChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "up" ? "Newer release" : "Older release"}
      className={cn(
        "grid size-6 cursor-pointer place-items-center text-t6 transition-[color,opacity] duration-[160ms] hover:text-t1",
        dir === "up" ? "mb-3" : "mt-3",
        disabled && "pointer-events-none opacity-30",
      )}
    >
      <Icon className="size-4" stroke={2.2} />
    </button>
  );
}

/**
 * The block above the release title: the bundled screenshot when the
 * release shipped one, otherwise a placeholder tile carrying a single
 * glyph — a wrench for a fixes-only release, a spark for anything that
 * added something.
 */
function ReleaseMedia({ entry }: { entry: WhatsNewEntry }) {
  const box =
    "relative mb-2 grid w-full place-items-center overflow-hidden rounded-xl border border-w080 bg-w030";

  if (entry.image) {
    return (
      <div className={cn(box, "h-64")}>
        <img
          src={entry.image}
          alt=""
          className={cn(
            "absolute inset-0 size-full object-cover",
            entry.imageAlign === "top" && "object-top",
          )}
        />
      </div>
    );
  }

  const fixesOnly = !entry.changes.some(
    (c) => c.type === "new" || c.type === "improved",
  );
  const Icon = fixesOnly ? IconToolFilled : IconSparkles;
  return (
    <div className={cn(box, "h-36")}>
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: fixesOnly
            ? "radial-gradient(circle at 50% 130%, rgba(var(--acc1rgb),0.14), transparent 70%)"
            : "radial-gradient(circle at 50% 130%, var(--w140), transparent 70%)",
        }}
      />
      <div
        className={cn(
          "relative grid size-12 place-items-center rounded-xl border",
          fixesOnly
            ? "border-[rgba(var(--acc1rgb),0.2)] bg-[rgba(var(--acc1rgb),0.07)] text-acc3"
            : "border-w200 bg-w070 text-t1",
        )}
      >
        <Icon className="size-6" />
      </div>
    </div>
  );
}

/**
 * Note-panel body with `[label](url)` markdown links and bare URLs
 * turned into clickable links that open in the system browser (dialog
 * text can't use plain anchors in Tauri).
 */
function NoteText({ text }: { text: string }) {
  const parts = text.split(
    /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/\S+)/g,
  );
  return (
    <span className="text-[13px] leading-[1.65] text-t5 text-pretty">
      {parts.map((part, i) => {
        const md = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
        const url = md ? md[2] : /^https?:\/\//.test(part) ? part : null;
        if (!url) return part;
        return (
          <button
            key={i}
            type="button"
            onClick={() => void openUrl(url)}
            className="cursor-pointer text-acc1 underline-offset-2 hover:underline"
          >
            {md ? md[1] : part.replace(/^https?:\/\//, "")}
          </button>
        );
      })}
    </span>
  );
}
