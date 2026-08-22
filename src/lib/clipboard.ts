import { toast } from "sonner";

/**
 * Copy text to the clipboard. `navigator.clipboard` is the happy path;
 * some WebView contexts refuse it, so we fall back to a hidden textarea
 * + `execCommand("copy")` the same way the artist-page Share button does.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy a link and toast the outcome. */
export async function copyLink(url: string): Promise<void> {
  const ok = await copyToClipboard(url);
  if (ok) toast.success("Link copied to clipboard");
  else toast.error("Couldn't copy the link");
}
