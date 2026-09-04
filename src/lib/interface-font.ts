import "@fontsource-variable/inter";
import "@fontsource-variable/roboto";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/google-sans-flex";
import { useSettingsStore, type InterfaceFont } from "@/lib/store/settings";

/**
 * The Interface font setting. The faces ship with the app (fontsource
 * variable builds, weight axis only) so the choice works offline and
 * looks the same on every machine; "System default" is the stack the
 * app always used. The chosen stack is written to `--app-font` on the
 * document root, which `index.css` reads for the whole tree. Imported
 * once from main.tsx, so the main and floating windows both apply it,
 * and the floating window follows changes through the settings store's
 * cross-window rehydrate.
 */

export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

export const INTERFACE_FONTS: {
  id: InterfaceFont;
  label: string;
  stack: string;
}[] = [
  {
    id: "gsans",
    label: "Google Sans",
    stack: "'Google Sans Flex Variable', system-ui, sans-serif",
  },
  {
    id: "inter",
    label: "Inter",
    stack: "'Inter Variable', system-ui, sans-serif",
  },
  {
    id: "roboto",
    label: "Roboto",
    stack: "'Roboto Variable', system-ui, sans-serif",
  },
  {
    id: "plex",
    label: "IBM Plex Sans",
    stack: "'IBM Plex Sans Variable', system-ui, sans-serif",
  },
  { id: "system", label: "System default", stack: SYSTEM_FONT_STACK },
];

export function interfaceFontStack(id: InterfaceFont): string {
  return INTERFACE_FONTS.find((f) => f.id === id)?.stack ?? SYSTEM_FONT_STACK;
}

function apply(id: InterfaceFont): void {
  document.documentElement.style.setProperty(
    "--app-font",
    interfaceFontStack(id),
  );
}

if (typeof document !== "undefined") {
  apply(useSettingsStore.getState().interfaceFont);
  useSettingsStore.subscribe((s, prev) => {
    if (s.interfaceFont !== prev.interfaceFont) apply(s.interfaceFont);
  });
}
