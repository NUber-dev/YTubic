import { Link } from "@tanstack/react-router";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { isFloatingPlayerWindow } from "@/lib/floating-player";

type Props = {
  /** Route to open in the main window. */
  to: "/artist/$id" | "/album/$id";
  id: string;
  /** Tauri event the floating window emits instead. `AppShell` listens. */
  event: "nav:artist" | "nav:album";
  className?: string;
  children: React.ReactNode;
};

/**
 * A link to an entity page that also works from the floating-player
 * window. That window renders outside the router, so `<Link>` would
 * throw there; instead the click emits a Tauri event the main window's
 * `<AppShell>` turns into a real navigation, and asks Rust to bring
 * that window forward so the user sees the page they just opened.
 *
 * Both player variants render the same metadata line, so this is the
 * one place that knows about the split.
 */
export function EntityLink({ to, id, event, className, children }: Props) {
  const cls = cn(
    "cursor-pointer transition-colors hover:text-foreground hover:underline",
    className,
  );

  if (isFloatingPlayerWindow()) {
    return (
      <button
        type="button"
        className={cls}
        onClick={() => {
          void emit(event, { id });
          // Best-effort: the command might not be registered in older
          // builds, and the navigation still lands either way.
          void invoke("focus_main_window").catch(() => {});
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <Link to={to} params={{ id }} className={cls}>
      {children}
    </Link>
  );
}
