// @vitest-environment node
import type { SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostKernel, logPath, type HostDeps, type HostTarget } from "../src/kernelHost.js";

const target = (dataDir: string): HostTarget => ({ dataDir, kernelEntry: "/k/index.cjs", nodeBin: "/bin/node" });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir host "));
  mkdirSync(join(dir, "runtime"), { recursive: true });
  return dir;
}

function writeRuntime(dir: string, info: { pid: number; port: number; token: string }): void {
  writeFileSync(join(dir, "runtime", "kernel.json"), JSON.stringify(info));
}

const baseDeps = (over: Partial<HostDeps> = {}): HostDeps => ({
  buildId: () => "same",
  probeHealth: async () => ({ status: "ok", pid: 100, buildId: "same" }),
  requestShutdown: async () => ({ status: 200, body: { stopped: true } }),
  isAlive: () => true,
  waitRuntime: async () => ({ pid: 100, port: 4000, token: "tok" }),
  spawnProcess: () => ({ unref: () => undefined }),
  killPid: () => undefined,
  sleep: async () => undefined,
  promptBusy: async () => "stop",
  ...over,
});

describe("hostKernel", () => {
  it("spawns when no runtime file exists", async () => {
    const dir = dataDir();
    const spawnProcess = vi.fn(() => ({ unref: () => undefined }));
    const hosted = await hostKernel(target(dir), baseDeps({ spawnProcess }));
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(hosted).toEqual({ pid: 100, port: 4000, token: "tok", daemon: true, buildMatches: true });
  });

  it("hands the daemon no handles and a log path instead", async () => {
    const dir = dataDir();
    const spawnProcess = vi.fn((_bin: string, _args: string[], _opts: SpawnOptions) => ({ unref: () => undefined }));
    await hostKernel(target(dir), baseDeps({ spawnProcess }));
    const options = spawnProcess.mock.calls[0]?.[2];
    // An inherited stdout keeps the supervisor's pipe open; whoever watches it never sees the end.
    expect(options?.stdio).toBe("ignore");
    expect(options?.detached).toBe(true);
    expect(options?.env?.NOIR_KERNEL_LOG).toBe(join(dir, "logs", "kernel.log"));
  });

  it("attaches without spawning when the build matches", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 100, port: 4000, token: "tok" });
    const spawnProcess = vi.fn();
    const hosted = await hostKernel(target(dir), baseDeps({ spawnProcess }));
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(hosted.buildMatches).toBe(true);
  });

  it("spawns when the recorded pid is dead", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 99, port: 4000, token: "old" });
    const spawnProcess = vi.fn(() => ({ unref: () => undefined }));
    await hostKernel(target(dir), baseDeps({ spawnProcess, isAlive: () => false }));
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("replaces an idle daemon of a different build", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 100, port: 4000, token: "tok" });
    const requestShutdown = vi.fn(async () => ({ status: 200, body: { stopped: true } }));
    const spawnProcess = vi.fn(() => ({ unref: () => undefined }));
    let alive = true;
    const hosted = await hostKernel(
      target(dir),
      baseDeps({
        probeHealth: async () => ({ status: "ok", pid: 100, buildId: "older" }),
        requestShutdown,
        spawnProcess,
        isAlive: () => alive,
        sleep: async () => { alive = false; },
      }),
    );
    expect(requestShutdown).toHaveBeenCalledWith(4000, "tok", false);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(hosted.buildMatches).toBe(true);
  });

  it("asks before replacing a daemon that owns a live turn", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 100, port: 4000, token: "tok" });
    const spawnProcess = vi.fn();
    const ask = vi.fn(async () => "keep" as const);
    const hosted = await hostKernel(
      target(dir),
      baseDeps({
        probeHealth: async () => ({ status: "ok", pid: 100, buildId: "older" }),
        requestShutdown: async () => ({ status: 409, body: { stopped: false, live: 1 } }),
        promptBusy: ask,
        spawnProcess,
      }),
    );
    expect(ask).toHaveBeenCalledWith(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(hosted.buildMatches).toBe(false);
  });

  it("stops a busy daemon when the user says so", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 100, port: 4000, token: "tok" });
    const requestShutdown = vi.fn()
      .mockResolvedValueOnce({ status: 409, body: { stopped: false, live: 1 } })
      .mockResolvedValueOnce({ status: 200, body: { stopped: true } });
    const spawnProcess = vi.fn(() => ({ unref: () => undefined }));
    let alive = true;
    await hostKernel(
      target(dir),
      baseDeps({
        probeHealth: async () => ({ status: "ok", pid: 100, buildId: "older" }),
        requestShutdown,
        spawnProcess,
        isAlive: () => alive,
        sleep: async () => { alive = false; },
      }),
    );
    expect(requestShutdown.mock.calls[1]).toEqual([4000, "tok", true]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("signals a daemon that predates the control plane", async () => {
    const dir = dataDir();
    writeRuntime(dir, { pid: 100, port: 4000, token: "tok" });
    const killPid = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref: () => undefined }));
    let alive = true;
    await hostKernel(
      target(dir),
      baseDeps({
        probeHealth: async () => null,
        killPid,
        spawnProcess,
        isAlive: () => alive,
        sleep: async () => { alive = false; },
      }),
    );
    expect(killPid).toHaveBeenCalledWith(100);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("falls back to a child kernel when the detached spawn throws", async () => {
    const dir = dataDir();
    const spawnProcess = vi.fn((_bin: string, _args: string[], opts: SpawnOptions) => {
      if (opts.detached === true) throw new Error("spawn ENOENT");
      return { unref: () => undefined };
    });
    const hosted = await hostKernel(target(dir), baseDeps({ spawnProcess }));
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(hosted.daemon).toBe(false);
  });
});

describe("logPath", () => {
  it("rotates a log past two megabytes", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "kernel.log"), "x".repeat(2_000_001));
    expect(logPath(dir)).toBe(join(dir, "logs", "kernel.log"));
    expect(existsSync(join(dir, "logs", "kernel.log"))).toBe(false);
    expect(readFileSync(join(dir, "logs", "kernel.1.log"), "utf8")).toHaveLength(2_000_001);
  });

  it("leaves an existing small log in place", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "kernel.log"), "earlier\n");
    logPath(dir);
    expect(readFileSync(join(dir, "logs", "kernel.log"), "utf8")).toBe("earlier\n");
  });
});
