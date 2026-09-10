import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

type SessionState = { renewing: boolean };

type Deps = {
  invoke: (cmd: string) => Promise<SessionState>;
  listen: (event: string, cb: () => void) => Promise<() => void>;
  /** Longest one hold ever lasts, so a stuck renewal cannot hang the app. */
  timeoutMs: number;
};

/**
 * Build the gate every InnerTube request awaits before it reads the
 * cookie jar.
 *
 * When the app opens after hours closed, the replayed cookie snapshot
 * is usually already expired server-side, and the hidden session-keeper
 * renews it a few seconds into the launch. Without the gate the first
 * wave of requests (account, library, likes, home) went out in those
 * seconds with the dead copy, Google answered "anonymous", and the app
 * cached that as truth: a sign-in button and an empty library over a
 * session that was fine moments later, which users answered by
 * clicking the button and doing a full sign-in. The liked-songs list
 * was worst: an hour of staleTime plus persistence, so the empty list
 * survived a reload from disk and the hearts stayed grey.
 *
 * The same window opens whenever the keeper has to renew a snapshot
 * that may be dead: a resume from hours of sleep, a switch to an
 * account that has not been active for a while. Rust announces those
 * with `session-renewing`, and the gate holds again until
 * `session-refreshed` / `session-refresh-failed`, or `timeoutMs`.
 * Routine 20-minute renewals of a healthy session do not close it.
 *
 * At launch the current state is asked for once (`get_session_state`)
 * after the listeners are up, so a renewal that finishes in between is
 * not missed. On a warm restart that is the whole cost: one IPC call.
 */
export function createSessionGate(deps: Deps): () => Promise<void> {
  let boot: Promise<void> | null = null;
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;

  const close = () => {
    if (hold) return;
    const mine = {};
    let resolve: () => void = () => {};
    hold = new Promise<void>((r) => {
      resolve = r;
    });
    const current = (release = () => {
      if (release !== current) return;
      hold = null;
      release = null;
      resolve();
    });
    // The cap belongs to this hold only: a later hold must not be cut
    // short by an earlier hold's timer.
    void mine;
    setTimeout(current, deps.timeoutMs);
  };
  const open = () => release?.();

  const init = () =>
    (boot ??= (async () => {
      // Listeners go up BEFORE the state is asked for, or a renewal that
      // finishes in between is never heard and the gate waits out the cap.
      await Promise.all([
        deps.listen("session-renewing", close),
        deps.listen("session-refreshed", open),
        deps.listen("session-refresh-failed", open),
      ]).catch(() => {
        // Without events the gate can only ever open; better than a
        // hold nothing will lift.
      });
      try {
        const state = await deps.invoke("get_session_state");
        if (state.renewing) close();
      } catch {
        // IPC failure: nothing to wait for, let the request try its luck.
      }
    })());

  return async () => {
    await init();
    if (hold) await hold;
  };
}

export const sessionReady = createSessionGate({
  invoke: (cmd) => tauriInvoke<SessionState>(cmd),
  listen: (event, cb) => tauriListen(event, () => cb()),
  timeoutMs: 45_000,
});
