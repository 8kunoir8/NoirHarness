import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeviceView, RemoteStatusResult } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import { Devices } from "../src/renderer/Devices.js";

const FINGERPRINT = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const OFF: RemoteStatusResult = { enabled: false, port: null, url: null, canServe: true, fingerprint: null };
const ON: RemoteStatusResult = {
  enabled: true,
  port: 51000,
  url: "https://192.168.1.20:51000/",
  canServe: true,
  fingerprint: FINGERPRINT,
};

const DEVICE: DeviceView = {
  id: "d1",
  label: "Phone",
  createdAt: 1,
  lastSeenAt: 2,
  revokedAt: null,
  connected: true,
};

function harness(overrides: Partial<Record<string, (params?: unknown) => Promise<unknown>>> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    const override = overrides[method];
    if (override !== undefined) return override(params);
    switch (method) {
      case "remote.status":
        return OFF;
      case "remote.devices":
        return { devices: [] };
      default:
        throw new Error(`unmocked ${method}`);
    }
  }) as unknown as RequestFn;
  return { request, calls };
}

describe("devices pane", () => {
  it("says what the toggle costs before it is used", () => {
    const { request } = harness();
    render(<Devices request={request} />);
    expect(screen.getByText(/the browser warns once/i)).toBeTruthy();
    return waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
  });

  it("enables the listener and offers a link", async () => {
    const user = userEvent.setup();
    const { request, calls } = harness({
      "remote.enable": async () => ON,
      "remote.pair": async () => ({
        url: "https://192.168.1.20:51000/pair#abc",
        code: "abc",
        expiresAt: Date.now() + 600_000,
      }),
    });
    render(<Devices request={request} />);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    await user.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(calls.map((call) => call.method)).toContain("remote.enable"));

    await user.click(await screen.findByRole("button", { name: /create a pairing link/i }));
    expect((await screen.findByText(/pair#abc/)).textContent).toContain("pair#abc");
    expect(calls.map((call) => call.method)).toContain("remote.pair");
  });

  it("lists a connected device and revokes it", async () => {
    const user = userEvent.setup();
    let revoked = false;
    const { request, calls } = harness({
      "remote.status": async () => ON,
      "remote.devices": async () => ({ devices: [revoked ? { ...DEVICE, connected: false, revokedAt: 5 } : DEVICE] }),
      "remote.revoke": async () => {
        revoked = true;
        return { ok: true };
      },
    });
    render(<Devices request={request} />);

    expect((await screen.findByText(/Phone · connected/)).textContent).toContain("connected");
    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() => expect(calls.filter((call) => call.method === "remote.revoke")).toHaveLength(1));
    expect(calls[0]?.params).toBeUndefined();
    expect((await screen.findByText(/Phone · revoked/)).textContent).toContain("revoked");
  });

  it("prints the fingerprint the browser warning is about", async () => {
    const { request } = harness({ "remote.status": async () => ON });
    render(<Devices request={request} />);
    expect((await screen.findByText(FINGERPRINT)).textContent).toBe(FINGERPRINT);
  });

  it("warns when the kernel has no page to serve", async () => {
    const { request } = harness({ "remote.status": async () => ({ ...ON, canServe: false }) });
    render(<Devices request={request} />);
    expect(await screen.findByText(/without a web root/i)).toBeTruthy();
  });
});
