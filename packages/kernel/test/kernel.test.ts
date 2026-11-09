import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startKernel, type Kernel } from "../src/index.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir kernel ünïcode ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function call(port: number, token: string, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const response = await new Promise<any>((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  ws.close();
  return response;
}

describe("startKernel", () => {
  it("writes a runtime file, serves health, and clears the runtime file on close", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const file = join(dir, "runtime", "kernel.json");
    const info = JSON.parse(readFileSync(file, "utf8"));
    expect(info.port).toBe(kernel.port);
    expect(info.token).toBe(kernel.token);
    const res = await call(kernel.port, kernel.token, "system.health");
    expect(res.result.status).toBe("ok");
    await kernel.close();
    expect(existsSync(file)).toBe(false);
  });

  it("persists a provider across restarts", async () => {
    const dir = tempDir();
    const first = await startKernel({ dataDir: dir });
    await call(first.port, first.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    await first.close();

    const second = await startKernel({ dataDir: dir });
    const res = await call(second.port, second.token, "provider.list");
    expect(res.result.providers).toHaveLength(1);
    expect(res.result.providers[0].hasKey).toBe(true);
    expect(JSON.stringify(res.result)).not.toContain('"k"');
    await second.close();
  });

  it("refuses a second live instance on the same data dir", async () => {
    const dir = tempDir();
    const first = await startKernel({ dataDir: dir });
    await expect(startKernel({ dataDir: dir })).rejects.toThrow(/already running/i);
    await first.close();
  });

  it("correlates the health reply by id when a broadcast arrives first", async () => {
    const dir = tempDir();
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: { type: "session.status" } } }));
      socket.on("message", () => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "ok", pid: process.ppid } }));
      });
    });
    const address = wss.address();
    if (!address || typeof address === "string") throw new Error("fake server has no port");
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime", "kernel.json"), JSON.stringify({ pid: process.ppid, port: address.port, token: "probe-token" }));
    await expect(startKernel({ dataDir: dir })).rejects.toThrow(/already running/i);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("refuses a recent claim whose owner is still starting", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime", "kernel.lock"), JSON.stringify({ pid: process.ppid, token: "owner", startedAt: Date.now() }));
    await expect(startKernel({ dataDir: dir })).rejects.toThrow(/starting/i);
  });

  it("reclaims a claim whose pid is dead", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime", "kernel.lock"), JSON.stringify({ pid: 999999, token: "dead", startedAt: Date.now() }));
    const kernel = await startKernel({ dataDir: dir });
    expect(kernel.port).toBeGreaterThan(0);
    await kernel.close();
  });

  it("allows exactly one of two concurrent starts", async () => {
    const dir = tempDir();
    const settled = await Promise.allSettled([startKernel({ dataDir: dir }), startKernel({ dataDir: dir })]);
    const winners = settled.filter((r): r is PromiseFulfilledResult<Kernel> => r.status === "fulfilled");
    const losers = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String(losers[0]?.reason)).toMatch(/already running|starting/i);
    await winners[0]?.value.close();
  });

  it("reclaims a runtime file that names a live but unrelated pid", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "runtime"), { recursive: true });
    const file = join(dir, "runtime", "kernel.json");
    writeFileSync(file, JSON.stringify({ pid: process.ppid, port: 1, token: "unrelated" }));
    const kernel = await startKernel({ dataDir: dir });
    expect(kernel.port).toBeGreaterThan(0);
    const info = JSON.parse(readFileSync(file, "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.token).toBe(kernel.token);
    await kernel.close();
  });

  it("leaves a foreign runtime file intact on close", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const file = join(dir, "runtime", "kernel.json");
    const foreign = { pid: process.ppid, port: 1, token: "foreign-token" };
    writeFileSync(file, JSON.stringify(foreign));
    await kernel.close();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(foreign);
  });
});
