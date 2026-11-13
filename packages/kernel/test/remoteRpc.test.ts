import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ErrorCodes } from "@noir/protocol";
import type { Kernel } from "../src/index.js";
import { memorySecrets, startKernel } from "./support.js";

const dirs: string[] = [];
const kernels: Kernel[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir remote rpc "));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<{ dir: string; kernel: Kernel }> {
  const dir = tempDir();
  const kernel = await startKernel({ dataDir: dir, secrets: memorySecrets() });
  kernels.push(kernel);
  return { dir, kernel };
}

async function call(port: number, token: string, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const [data] = await reply;
  ws.close();
  return JSON.parse(String(data));
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; cookie: string; json: { deviceId?: string } }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), host: `127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            cookie: (res.headers["set-cookie"] ?? [""])[0] ?? "",
            json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("remote over rpc", () => {
  it("is off by default and reports why pairing is possible", async () => {
    const { kernel } = await start();
    const status = await call(kernel.port, kernel.token, "remote.status");
    expect(status.result).toMatchObject({ enabled: false, port: null, url: null, canServe: false });
  });

  it("records the port it listens on and clears it on disable", async () => {
    const { dir, kernel } = await start();
    const enabled = await call(kernel.port, kernel.token, "remote.enable");
    const port = enabled.result.port as number;
    expect(port).toBeGreaterThan(0);
    const info = JSON.parse(readFileSync(join(dir, "runtime", "kernel.json"), "utf8"));
    expect(info.remotePort).toBe(port);

    const disabled = await call(kernel.port, kernel.token, "remote.disable");
    expect(disabled.result.port).toBeNull();
    const after = JSON.parse(readFileSync(join(dir, "runtime", "kernel.json"), "utf8"));
    expect(after.remotePort).toBeUndefined();
  });

  it("pairs a browser and lists it, then revokes its live socket", async () => {
    const { kernel } = await start();
    const enabled = await call(kernel.port, kernel.token, "remote.enable");
    const port = enabled.result.port as number;
    const pair = await call(kernel.port, kernel.token, "remote.pair");
    expect(pair.result.url).toContain(`:${port}/pair#`);
    expect(pair.result.url).toContain(pair.result.code);

    const redeemed = await post(port, "/pair/redeem", { code: pair.result.code });
    expect(redeemed.status).toBe(200);
    const cookie = redeemed.cookie.split(";")[0] ?? "";

    const deviceId = redeemed.json.deviceId ?? "";
    const listed = await call(kernel.port, kernel.token, "remote.devices");
    expect(listed.result.devices.map((device: { id: string }) => device.id)).toContain(deviceId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
    await once(ws, "open");
    const connected = await call(kernel.port, kernel.token, "remote.devices");
    expect(connected.result.devices.find((device: { id: string }) => device.id === deviceId)?.connected).toBe(true);

    const closed = once(ws, "close");
    const revoked = await call(kernel.port, kernel.token, "remote.revoke", { id: deviceId });
    expect(revoked.result.ok).toBe(true);
    await closed;

    const after = await call(kernel.port, kernel.token, "remote.devices");
    expect(after.result.devices.find((device: { id: string }) => device.id === deviceId)?.revokedAt).not.toBeNull();
  });

  it("keeps the admin verbs off a paired device", async () => {
    const { kernel } = await start();
    const enabled = await call(kernel.port, kernel.token, "remote.enable");
    const port = enabled.result.port as number;
    const pair = await call(kernel.port, kernel.token, "remote.pair");
    const redeemed = await post(port, "/pair/redeem", { code: pair.result.code });
    const cookie = redeemed.cookie.split(";")[0] ?? "";

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
    await once(ws, "open");
    const reply = once(ws, "message");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "remote.devices" }));
    const [data] = await reply;
    const frame = JSON.parse(String(data));
    expect(frame.error.code).toBe(ErrorCodes.forbidden);
    ws.close();
  });

  it("still lets a device run a session", async () => {
    const { kernel } = await start();
    const enabled = await call(kernel.port, kernel.token, "remote.enable");
    const port = enabled.result.port as number;
    const pair = await call(kernel.port, kernel.token, "remote.pair");
    const cookie = (await post(port, "/pair/redeem", { code: pair.result.code })).cookie.split(";")[0] ?? "";

    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
    await once(ws, "open");
    const reply = once(ws, "message");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session.list", params: {} }));
    const [data] = await reply;
    expect(JSON.parse(String(data)).result).toHaveProperty("sessions");
    ws.close();
  });
});
