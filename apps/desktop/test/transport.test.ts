import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrowser, resolveTransport } from "../src/renderer/transport.js";

interface BridgeStub {
  kernelInfo: () => Promise<{ port: number; token: string }>;
}

function installBridge(bridge: BridgeStub | undefined): void {
  const windowStub = globalThis as unknown as { window?: { noir?: unknown } };
  windowStub.window = { ...windowStub.window, ...(bridge === undefined ? {} : { noir: bridge }) };
  if (bridge === undefined && windowStub.window !== undefined) delete windowStub.window.noir;
}

afterEach(() => {
  installBridge(undefined);
  vi.unstubAllGlobals();
});

describe("transport", () => {
  it("asks the preload for the socket in the desktop window", async () => {
    installBridge({ kernelInfo: async () => ({ port: 4321, token: "tok" }) });
    expect(isBrowser()).toBe(false);
    await expect(resolveTransport()).resolves.toEqual({ mode: "desktop", url: "ws://127.0.0.1:4321/?token=tok" });
  });

  it("uses the origin it was served from in a browser", async () => {
    installBridge(undefined);
    vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.20:51000" });
    expect(isBrowser()).toBe(true);
    await expect(resolveTransport()).resolves.toEqual({ mode: "browser", url: "ws://192.168.1.20:51000/" });
  });

  it("keeps the scheme honest if the kernel is ever reached over tls", async () => {
    installBridge(undefined);
    vi.stubGlobal("location", { protocol: "https:", host: "phone.local:51000" });
    await expect(resolveTransport()).resolves.toEqual({ mode: "browser", url: "wss://phone.local:51000/" });
  });
});
