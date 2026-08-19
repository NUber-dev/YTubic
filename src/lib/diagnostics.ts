import { invoke } from "@tauri-apps/api/core";

export const DIAG_QUERY_FLAG = "diagnostics";

export function diagLog(tag: string, text: string): void {
  void invoke("diag_log", { tag, text }).catch(() => {});
}

export function isDiagnosticsWindow(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has(DIAG_QUERY_FLAG);
}

export type DiagLine = {
  at: number;
  tag: string;
  text: string;
};
