import { invoke } from "@tauri-apps/api/core";

/**
 * Trace line for the source matcher and the video pipeline. Picking the
 * wrong music video is only ever diagnosable after the fact, from the
 * candidates that were considered and why each was dropped, so those
 * decisions are recorded rather than reconstructed.
 */
export function diagLog(tag: string, text: string): void {
  void invoke("diag_log", { tag, text }).catch(() => {});
}
