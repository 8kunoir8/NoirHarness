import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Where the kernel lives and what to run it with. */
export interface HostTarget {
  dataDir: string;
  kernelEntry: string;
  nodeBin: string;
  /** The built renderer a paired browser loads; absent when there is none to serve. */
  webRoot?: string;
}

export interface HostedKernel {
  port: number;
  token: string;
  pid: number;
  /** False when the kernel had to be spawned as a plain child of the app. */
  daemon: boolean;
  /** False when the app talks to a different build than the one it would spawn. */
  buildMatches: boolean;
}

export interface HealthInfo {
  status: string;
  pid: number;
  buildId: string | null;
}

export interface RuntimeFile {
  pid: number;
  port: number;
  token: string;
}
export interface ShutdownReply {
  stopped?: boolean;
  /** Present only on a refusal. */
  live?: number;
}

export interface HostDeps {
  buildId?: (file: string) => string | null;
  probeHealth?: (port: number, timeoutMs: number) => Promise<HealthInfo | null>;
  requestShutdown?: (port: number, token: string, force: boolean) => Promise<{ status: number; body: ShutdownReply }>;
  isAlive?: (pid: number) => boolean;
  waitRuntime?: (file: string, timeoutMs: number) => Promise<RuntimeFile>;
  spawnProcess?: (bin: string, args: string[], opts: SpawnOptions) => { unref(): void };
  killPid?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Asked only when a replacement would kill work; resolves what the user chose. */
  promptBusy?: (live: number) => Promise<"stop" | "keep">;
}

type ResolvedDeps = Required<HostDeps>;

const PROBE_TIMEOUT_MS = 750;
const EXIT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 20_000;
const LOG_LIMIT_BYTES = 2_000_000;

export function runtimeFilePath(dataDir: string): string {
  return join(dataDir, "runtime", "kernel.json");
}
export function buildIdOfFile(file: string): string | null {
  // Re-declared rather than imported: only the kernel ships a `buildIdOf`, and main must not pull
  // the kernel package into the Electron bundle for one hash.
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function readRuntimeFile(file: string): RuntimeFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { pid?: unknown; port?: unknown; token?: unknown };
    if (typeof candidate.pid !== "number" || typeof candidate.port !== "number" || typeof candidate.token !== "string") return null;
    return { pid: candidate.pid, port: candidate.port, token: candidate.token };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

/**
 * Path of `<dataDir>/logs/kernel.log`, rotated to `kernel.1.log` once it passes 2 MB. The daemon
 * appends to it itself: a handle handed to the child would be inherited by it, and an inherited
 * handle keeps the parent's pipes open after the parent is gone.
 */
export function logPath(dataDir: string): string {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "kernel.log");
  try {
    if (statSync(file).size > LOG_LIMIT_BYTES) {
      try {
        unlinkSync(join(dir, "kernel.1.log"));
      } catch {
        // No previous rotation to replace.
      }
      renameSync(file, join(dir, "kernel.1.log"));
    }
  } catch {
    // First run: nothing to rotate.
  }
  return file;
}

export async function probeHealth(port: number, timeoutMs: number): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const candidate = body as { status?: unknown; pid?: unknown; buildId?: unknown };
    if (candidate.status !== "ok" || typeof candidate.pid !== "number") return null;
    return { status: "ok", pid: candidate.pid, buildId: typeof candidate.buildId === "string" ? candidate.buildId : null };
  } catch {
    return null;
  }
}

async function requestShutdown(port: number, token: string, force: boolean): Promise<{ status: number; body: { live?: number } }> {
  const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ force }),
    signal: AbortSignal.timeout(EXIT_TIMEOUT_MS),
  });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: typeof body === "object" && body !== null ? (body as { live?: number }) : {} };
}

async function waitRuntime(file: string, timeoutMs: number): Promise<RuntimeFile> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readRuntimeFile(file);
    if (info !== null && isProcessAlive(info.pid)) return info;
    if (Date.now() > deadline) throw new Error("Kernel did not start");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitGone(pid: number, alive: (pid: number) => boolean, sleep: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await sleep(50);
  }
}

/**
 * Attaches to the daemon this data directory already has, or starts one.
 *
 * Idle replacement is silent; a daemon that owns a live turn is only replaced when the caller's
 * prompt says so, because the stop would discard that turn.
 */
export async function hostKernel(target: HostTarget, overrides: HostDeps = {}): Promise<HostedKernel> {
  const deps: ResolvedDeps = {
    buildId: buildIdOfFile,
    probeHealth,
    requestShutdown,
    isAlive: isProcessAlive,
    waitRuntime,
    spawnProcess: (bin, args, opts) => spawn(bin, args, opts),
    killPid: (pid) => void process.kill(pid, "SIGTERM"),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    promptBusy: async () => "keep",
    ...overrides,
  };
  const file = runtimeFilePath(target.dataDir);
  const wanted = deps.buildId(target.kernelEntry);

  const current = readRuntimeFile(file);
  if (current !== null && deps.isAlive(current.pid)) {
    const health = await deps.probeHealth(current.port, PROBE_TIMEOUT_MS);
    if (health !== null && health.pid === current.pid) {
      if (health.buildId === wanted) {
        return { port: current.port, token: current.token, pid: current.pid, daemon: true, buildMatches: true };
      }
      const outcome = await deps.requestShutdown(current.port, current.token, false);
      if (outcome.status === 200) {
        await waitGone(current.pid, deps.isAlive, deps.sleep);
      } else if (outcome.status === 409) {
        if ((await deps.promptBusy(outcome.body.live ?? 0)) === "keep") {
          return { port: current.port, token: current.token, pid: current.pid, daemon: true, buildMatches: false };
        }
        await deps.requestShutdown(current.port, current.token, true);
        await waitGone(current.pid, deps.isAlive, deps.sleep);
      } else {
        // A build from before the control plane answered 404, or the endpoint stopped answering.
        deps.killPid(current.pid);
        await waitGone(current.pid, deps.isAlive, deps.sleep);
      }
    } else {
      // The recorded pid is alive but does not answer as itself: a reused pid, not our daemon.
      deps.killPid(current.pid);
      await waitGone(current.pid, deps.isAlive, deps.sleep);
    }
  }

  return spawnDetached(target, deps);
}

async function spawnDetached(target: HostTarget, deps: ResolvedDeps): Promise<HostedKernel> {
  const file = runtimeFilePath(target.dataDir);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NOIR_DATA_DIR: target.dataDir,
    NOIR_KERNEL_LOG: logPath(target.dataDir),
    ...(target.webRoot === undefined ? {} : { NOIR_WEB_ROOT: target.webRoot }),
  };
  // Every handle is closed: a detached child that inherits one holds this app's pipes open, and
  // whoever is watching those pipes never learns that this app ended. The daemon logs to a file.
  const spawnOnce = (detached: boolean): void => {
    deps.spawnProcess(target.nodeBin, [target.kernelEntry], {
      detached,
      windowsHide: true,
      stdio: "ignore",
      env,
    }).unref();
  };
  let daemon = true;
  try {
    spawnOnce(true);
  } catch {
    // Detached spawning is unavailable (a platform restriction, a missing binary): a child still runs.
    daemon = false;
    spawnOnce(false);
  }
  const info = await deps.waitRuntime(file, START_TIMEOUT_MS);
  return { port: info.port, token: info.token, pid: info.pid, daemon, buildMatches: true };
}
