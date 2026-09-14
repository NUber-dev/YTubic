import { invoke } from "@tauri-apps/api/core";

// A wrong pick is only diagnosable from the candidates that were weighed.
export function diagLog(tag: string, text: string): void {
  void invoke("diag_log", { tag, text }).catch(() => {});
}
