import { describe, expect, it, vi } from "vitest";
import { createSessionGate } from "./session-gate";

type Handlers = Record<string, (() => void)[]>;

function fakeDeps(renewing: boolean, timeoutMs = 10_000) {
  const handlers: Handlers = {};
  const invoke = vi.fn(async () => ({ renewing }));
  const listen = vi.fn(async (event: string, cb: () => void) => {
    (handlers[event] ??= []).push(cb);
    return () => {
      handlers[event] = handlers[event].filter((h) => h !== cb);
    };
  });
  const fire = (event: string) => {
    for (const h of handlers[event] ?? []) h();
  };
  return { deps: { invoke, listen, timeoutMs }, invoke, listen, fire, handlers };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Resolve-tracking wrapper so a test can assert a promise is still pending. */
function track(p: Promise<void>) {
  const state = { done: false };
  void p.then(() => {
    state.done = true;
  });
  return state;
}

describe("session gate", () => {
  it("opens at once when Rust says nothing is being renewed", async () => {
    const f = fakeDeps(false);
    const ready = createSessionGate(f.deps);
    await ready();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("holds while the boot renewal is in flight and opens on session-refreshed", async () => {
    const f = fakeDeps(true);
    const ready = createSessionGate(f.deps);
    const p = track(ready());
    await flush();
    expect(p.done).toBe(false);
    f.fire("session-refreshed");
    await flush();
    expect(p.done).toBe(true);
  });

  it("also opens when the renewal fails, so a dead session still gets its verdict", async () => {
    const f = fakeDeps(true);
    const ready = createSessionGate(f.deps);
    const p = track(ready());
    await flush();
    f.fire("session-refresh-failed");
    await flush();
    expect(p.done).toBe(true);
  });

  it("gives up at the cap rather than hanging the app", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeDeps(true, 500);
      const ready = createSessionGate(f.deps);
      const p = track(ready());
      await vi.advanceTimersByTimeAsync(499);
      expect(p.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers its listeners before asking for the state", async () => {
    const order: string[] = [];
    const f = fakeDeps(false);
    f.invoke.mockImplementation(async () => {
      order.push("invoke");
      return { renewing: false };
    });
    f.listen.mockImplementation(async (event: string) => {
      order.push(`listen:${event}`);
      return () => {};
    });
    await createSessionGate(f.deps)();
    expect(order.indexOf("invoke")).toBeGreaterThan(
      order.indexOf("listen:session-refreshed"),
    );
  });

  it("asks for the boot state once no matter how many requests", async () => {
    const f = fakeDeps(false);
    const ready = createSessionGate(f.deps);
    await Promise.all([ready(), ready(), ready()]);
    await ready();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("opens on an IPC failure instead of blocking every request", async () => {
    const f = fakeDeps(true);
    f.invoke.mockRejectedValueOnce(new Error("no ipc"));
    await expect(createSessionGate(f.deps)()).resolves.toBeUndefined();
  });

  it("closes again on session-renewing (resume, account switch) and reopens on the verdict", async () => {
    const f = fakeDeps(false);
    const ready = createSessionGate(f.deps);
    await ready();
    f.fire("session-renewing");
    const p = track(ready());
    await flush();
    expect(p.done).toBe(false);
    f.fire("session-refreshed");
    await flush();
    expect(p.done).toBe(true);
    // And is free again afterwards.
    await expect(ready()).resolves.toBeUndefined();
  });

  it("does not let an earlier hold's cap cut a later hold short", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeDeps(false, 500);
      const ready = createSessionGate(f.deps);
      await ready();
      f.fire("session-renewing");
      await vi.advanceTimersByTimeAsync(100);
      f.fire("session-refreshed"); // first hold released at t=100
      f.fire("session-renewing"); // second hold starts at t=100
      const p = track(ready());
      await vi.advanceTimersByTimeAsync(450); // t=550: first timer fired, must be inert
      expect(p.done).toBe(false);
      await vi.advanceTimersByTimeAsync(50); // t=600: second hold's own cap
      expect(p.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
