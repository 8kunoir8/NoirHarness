import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startKernel } from "../src/index.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir-kernel-")); dirs.push(d); return d; }
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
  it("writes a runtime file and serves health", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const info = JSON.parse(readFileSync(join(dir, "runtime", "kernel.json"), "utf8"));
    expect(info.port).toBe(kernel.port);
    expect(info.token).toBe(kernel.token);
    const res = await call(kernel.port, kernel.token, "system.health");
    expect(res.result.status).toBe("ok");
    await kernel.close();
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
});
