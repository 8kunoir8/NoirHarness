import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ErrorCodes } from "@noir/protocol";
import type { Kernel } from "../src/index.js";
import { memorySecrets, startKernel } from "./support.js";
import { profileAgentDir } from "../src/profile.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir kernel ünïcode ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function call(port: number, token: string, method: string, params?: unknown): Promise<any> {
  return sendFrame(port, token, { jsonrpc: "2.0", id: 1, method, params });
}

async function sendFrame(port: number, token: string, frame: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify(frame));
  const [data] = await reply;
  ws.close();
  return JSON.parse(String(data));
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
    const secrets = memorySecrets();
    const first = await startKernel({ dataDir: dir, secrets });
    const created = await call(first.port, first.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    await first.close();

    const second = await startKernel({ dataDir: dir, secrets });
    const res = await call(second.port, second.token, "provider.list");
    expect(res.result.providers).toHaveLength(1);
    expect(res.result.providers[0].hasKey).toBe(true);
    expect(JSON.stringify(res.result)).not.toContain('"k"');
    const deleted = await call(second.port, second.token, "provider.delete", { id: created.result.id });
    expect(deleted.error).toBeUndefined();
    await second.close();
  });

  it("lists every model when model.list is called without params", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const provider = await call(kernel.port, kernel.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    for (const modelId of ["gpt-a", "gpt-b"]) {
      const model = await call(kernel.port, kernel.token, "model.create", { providerId: provider.result.id, modelId });
      expect(model.error).toBeUndefined();
    }
    const listed = await call(kernel.port, kernel.token, "model.list");
    expect(listed.error).toBeUndefined();
    expect(listed.result.models.map((m: { modelId: string }) => m.modelId)).toEqual(["gpt-a", "gpt-b"]);
    expect(listed.result.models[0].providerId).toBe(provider.result.id);
    await kernel.close();
  });

  it("rolls back a model whose id the profile renderer rejects", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const provider = await call(kernel.port, kernel.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    const bad = await call(kernel.port, kernel.token, "model.create", {
      providerId: provider.result.id, modelId: "gpt 4o",
    });
    expect(bad.error).toBeDefined();
    const listed = await call(kernel.port, kernel.token, "model.list");
    expect(listed.result.models).toEqual([]);
    await kernel.close();
  });

  it("keeps a model whose id contains slashes", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const provider = await call(kernel.port, kernel.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    const created = await call(kernel.port, kernel.token, "model.create", {
      providerId: provider.result.id, modelId: "openai/gpt-4o",
    });
    expect(created.error).toBeUndefined();
    const rendered = readFileSync(join(profileAgentDir(dir), "models.yml"), "utf8");
    expect(rendered).toContain("id: openai/gpt-4o");
    const config = readFileSync(join(profileAgentDir(dir), "config.yml"), "utf8");
    expect(config).toContain("- .noir/skills-engine");
    const listed = await call(kernel.port, kernel.token, "model.list");
    expect(listed.result.models.map((model: { modelId: string }) => model.modelId)).toEqual(["openai/gpt-4o"]);
    await kernel.close();
  });

  it("removes models.yml when a rolled-back create cannot re-sync", async () => {
    const dataDir = tempDir();
    const kernel = await startKernel({ dataDir });
    const good = await call(kernel.port, kernel.token, "provider.create", {
      name: "Good", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "sk-good-round2",
    });
    expect(good.error).toBeUndefined();
    const model = await call(kernel.port, kernel.token, "model.create", { providerId: good.result.id, modelId: "gpt-ok" });
    expect(model.error).toBeUndefined();

    const profileFile = join(profileAgentDir(dataDir), "models.yml");
    expect(readFileSync(profileFile, "utf8")).toContain("sk-good-round2");

    // Make the second half of materializeProfile fail after models.yml has been rewritten.
    const blockedConfig = join(profileAgentDir(dataDir), "config.yml");
    rmSync(blockedConfig, { force: true });
    mkdirSync(blockedConfig, { recursive: true });
    try {
      const leaked = "sk-leaked-round2";
      const second = await call(kernel.port, kernel.token, "provider.create", {
        name: "Second", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: leaked,
      });
      expect(second.error).toBeDefined();
      if (existsSync(profileFile)) expect(readFileSync(profileFile, "utf8")).not.toContain(leaked);
      const listed = await call(kernel.port, kernel.token, "provider.list");
      expect(listed.result.providers.map((provider: { name: string }) => provider.name)).toEqual(["Good"]);
    } finally {
      await kernel.close();
      rmSync(blockedConfig, { recursive: true, force: true });
    }
  });

  it("reports invalid params for bad provider input and malformed requests", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const badProvider = await call(kernel.port, kernel.token, "provider.create", {
      name: "Local", baseUrl: "not a url", apiKind: "openai-completions", apiKey: "k",
    });
    expect(badProvider.error.code).toBe(ErrorCodes.invalidParams);
    expect(badProvider.error.message).toContain("baseUrl");
    const badFrame = await sendFrame(kernel.port, kernel.token, { jsonrpc: "2.0", id: 2 });
    expect(badFrame.error.code).toBe(ErrorCodes.invalidParams);
    expect(badFrame.error.message).toContain("method");
    await kernel.close();
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

  it("rejects a second workspace for the same path", async () => {
    const dir = tempDir();
    const root = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const project = await call(kernel.port, kernel.token, "project.add", { path: root });
    const first = await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id });
    expect(first.error).toBeUndefined();
    const second = await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id });
    expect(second.error.code).toBe(ErrorCodes.conflict);
    const listed = await call(kernel.port, kernel.token, "workspace.list");
    expect(listed.result.workspaces).toHaveLength(1);
    expect(listed.result.workspaces[0].id).toBe(first.result.id);
    await kernel.close();
  });

  it("installs a skill over rpc and lists it with its source", async () => {
    const dir = tempDir();
    const root = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    try {
      const project = await call(kernel.port, kernel.token, "project.add", { path: root });
      const workspace = await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id });
      const workspaceId = workspace.result.id as string;

      // A seed directory inside the data dir: no git, no network, and the copy path is the same one a URL takes.
      const source = join(dir, "seed");
      mkdirSync(join(source, "rpc-skill"), { recursive: true });
      writeFileSync(join(source, "rpc-skill", "SKILL.md"), "---\nname: rpc-skill\ndescription: d\n---\n\nB\n");

      const installed = await call(kernel.port, kernel.token, "skill.install", {
        workspaceId, scope: "project", kind: "local", source,
      });
      expect(installed.error).toBeUndefined();
      expect(installed.result.name).toBe("rpc-skill");
      expect(installed.result.hash).toMatch(/^[0-9a-f]{64}$/);

      const listed = await call(kernel.port, kernel.token, "skill.list", { workspaceId });
      const row = (listed.result.skills as Array<{ name: string; source: { kind: string } | null }>).find(
        (skill) => skill.name === "rpc-skill",
      );
      expect(row?.source?.kind).toBe("local");

      const removed = await call(kernel.port, kernel.token, "skill.remove", { workspaceId, scope: "project", name: "rpc-skill" });
      expect(removed.error).toBeUndefined();
      expect(removed.result).toEqual({ ok: true, skills: [] });
      const after = await call(kernel.port, kernel.token, "skill.list", { workspaceId });
      expect(after.result.skills).toEqual([]);
      expect(existsSync(join(root, ".noir", "skills", "rpc-skill"))).toBe(false);
    } finally {
      await kernel.close();
    }
  });
});
