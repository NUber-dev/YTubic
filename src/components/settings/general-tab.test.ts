// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { GeneralTab } from "./general-tab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/store/auth-queries", () => ({
  authLoggedInQuery: { queryKey: ["auth"], queryFn: async () => true },
}));
vi.mock("@/lib/updater", () => ({ checkForUpdates: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let autostart: boolean;
let minimized: boolean;
let rejectSave: boolean;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  autostart = true;
  minimized = false;
  rejectSave = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "autostart_is_enabled") return autostart;
    if (command === "get_start_minimized") return minimized;
    if (command === "set_start_minimized") {
      if (rejectSave) throw new Error("Cannot save settings");
      minimized = (args as { enabled: boolean }).enabled;
    }
    if (command === "autostart_set") {
      autostart = (args as { enabled: boolean }).enabled;
    }
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function render() {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(GeneralTab),
      ),
    );
  });
  await settle();
}

function toggle(label: string) {
  return host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

it("only offers Start Minimized while Launch at Startup is enabled", async () => {
  autostart = false;
  await render();
  expect(toggle("Start Minimized")).toBeNull();
  await act(async () => toggle("Launch at Startup")!.click());
  await settle();
  expect(toggle("Start Minimized")).not.toBeNull();
  await act(async () => toggle("Launch at Startup")!.click());
  await settle();
  expect(toggle("Start Minimized")).toBeNull();
});

it("loads the saved preference and persists changes through the backend", async () => {
  minimized = true;
  await render();
  expect(toggle("Start Minimized")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle("Start Minimized")!.click());
  await settle();
  expect(invoke).toHaveBeenCalledWith("set_start_minimized", {
    enabled: false,
  });
  expect(toggle("Start Minimized")!.getAttribute("aria-checked")).toBe("false");
});

it("keeps the persisted switch value and reports a failed save", async () => {
  rejectSave = true;
  await render();
  await act(async () => toggle("Start Minimized")!.click());
  await settle();
  expect(toast.error).toHaveBeenCalledWith("Error: Cannot save settings");
  expect(toggle("Start Minimized")!.getAttribute("aria-checked")).toBe("false");
});
