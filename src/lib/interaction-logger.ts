import { useEffect } from "react";
import { diagLog } from "@/lib/diagnostics";

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "[role=\"button\"]",
  "[role=\"menuitem\"]",
  "[role=\"tab\"]",
  "[role=\"switch\"]",
  "[role=\"checkbox\"]",
  "[role=\"radio\"]",
  "input[type=\"button\"]",
  "input[type=\"submit\"]",
  "input[type=\"checkbox\"]",
  "input[type=\"radio\"]",
  "select",
].join(", ");

function describeElement(el: Element): string {
  const label = el.getAttribute("aria-label") || el.getAttribute("title");
  if (label) return label;
  const text = el.textContent?.trim().replace(/\s+/g, " ").slice(0, 60);
  if (text) return text;
  return el.tagName.toLowerCase();
}

export function useInteractionLogger(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const el = target.closest(INTERACTIVE_SELECTOR);
      if (!el) return;
      diagLog("ui", `click ${describeElement(el)}`);
    };
    const onSubmit = (e: SubmitEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLFormElement)) return;
      diagLog("ui", `submit ${target.getAttribute("aria-label") || target.name || "form"}`);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);
}
