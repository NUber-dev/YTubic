/**
 * The "E" chip YouTube Music puts next to an explicit track. Shared by
 * the track rows and the shelf cards, which used to carry their own
 * copies and drifted apart.
 *
 * Drawn the way the rest of the refresh draws small chips: a black
 * overlay rather than an opaque grey, so it darkens whatever it sits on
 * in both themes, plus a hairline ring to give it an edge against the
 * glass. The label rides `--t4`, which is dark on the light fill and
 * light on the dark one, so one token covers both.
 */
export function ExplicitBadge() {
  return (
    <span
      title="Explicit"
      aria-label="Explicit"
      className="inline-flex size-[17px] shrink-0 items-center justify-center rounded-sm bg-black/12 text-[10.5px] font-bold leading-none text-t4 outline outline-1 -outline-offset-1 outline-w060 dark:bg-black/25 dark:outline-w120"
    >
      E
    </span>
  );
}
