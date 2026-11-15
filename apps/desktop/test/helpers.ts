import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication } from "@playwright/test";
import { closeWindow } from "./app-harness.js";

/**
 * Removes a temporary data dir, stopping its daemon first so the kernel's SQLite handles are
 * closed rather than merely killed. Order matters: `rmSync` under a live kernel fails on Windows
 * and leaves the process running after the suite.
 */
export async function removeDir(dir: string): Promise<void> {
  await stopKernel(dir).catch(() => undefined);
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(100);
    }
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

function readRuntime(file: string): { pid?: number; port?: number; token?: string } | undefined {
  try {
    const runtime: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof runtime !== "object" || runtime === null) return undefined;
    return {
      ...("pid" in runtime && typeof runtime.pid === "number" ? { pid: runtime.pid } : {}),
      ...("port" in runtime && typeof runtime.port === "number" ? { port: runtime.port } : {}),
      ...("token" in runtime && typeof runtime.token === "string" ? { token: runtime.token } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The pid recorded in `<dataDir>/runtime/kernel.json`, or `undefined` when there is no claim. */
export function runtimePid(dataDir: string): number | undefined {
  return readRuntime(join(dataDir, "runtime", "kernel.json"))?.pid;
}

/** The version the packaged app reports: `app.getVersion()` reads this manifest at launch. */
export function appVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("apps/desktop/package.json has no version");
  }
  return parsed.version;
}

/**
 * Waits until the kernel recorded in `<dataDir>/runtime/kernel.json` is dead.
 * The kernel unlinks the file before it exits, so an absent file alone does not prove the
 * process is gone: keep polling the last pid we saw. Without this the relaunch can be
 * refused with "Kernel is starting" because the previous daemon's claim is still live.
 */
export async function waitForKernelExit(dataDir: string, timeoutMs = 20_000): Promise<void> {
  const runtimeFile = join(dataDir, "runtime", "kernel.json");
  const deadline = Date.now() + timeoutMs;
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    if (existsSync(runtimeFile)) lastPid = readRuntime(runtimeFile)?.pid ?? lastPid;
    if (lastPid === undefined) return; // kernel never recorded a pid: nothing to wait for
    if (!isProcessAlive(lastPid)) return;
    await delay(100);
  }
  throw new Error(`kernel process ${lastPid} recorded in ${runtimeFile} did not exit before relaunch`);
}

/**
 * Asks the daemon to stop through its control plane and waits for the process to go. The daemon
 * outlives the window, so closing the Electron app is not enough to release the data dir.
 * A dir with no runtime file (the kernel never started) is already stopped.
 */
export async function stopKernel(dataDir: string): Promise<void> {
  const runtime = readRuntime(join(dataDir, "runtime", "kernel.json"));
  if (runtime === undefined || runtime.port === undefined || runtime.token === undefined) {
    await waitForKernelExit(dataDir);
    return;
  }
  await fetch(`http://127.0.0.1:${runtime.port}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  }).catch(() => undefined);
  await waitForKernelExit(dataDir);
}

/** SIGKILLs the kernel recorded in `<dataDir>/runtime/kernel.json` and waits for it to be gone. */
export async function killKernel(dataDir: string): Promise<void> {
  const pid = runtimePid(dataDir);
  if (pid === undefined) throw new Error("no kernel pid recorded");
  process.kill(pid, "SIGKILL");
  await waitForKernelExit(dataDir);
}

/**
 * Ends an app for good: window first, then the daemon, then the driver connection.
 *
 * The order is forced by Windows handle inheritance — a detached child is handed a copy of its
 * parent's handles, so the daemon holds the app's stdio open and `close()` waits on it until the
 * daemon is gone. Use `closeWindow` instead when the daemon has to outlive the app under test.
 */
export async function closeApp(app: ElectronApplication | undefined, dataDir: string): Promise<void> {
  if (app === undefined) return;
  await closeWindow(app);
  await stopKernel(dataDir).catch(() => undefined);
  await app.close().catch(() => undefined);
}

interface KernelRuntime {
  port: number;
  token: string;
}

function readKernelRuntime(dataDir: string): KernelRuntime {
  const raw: unknown = JSON.parse(readFileSync(join(dataDir, "runtime", "kernel.json"), "utf8"));
  if (
    typeof raw !== "object" || raw === null
    || !("port" in raw) || typeof raw.port !== "number"
    || !("token" in raw) || typeof raw.token !== "string"
  ) {
    throw new Error("kernel runtime file does not contain {port, token}");
  }
  return { port: raw.port, token: raw.token };
}

/**
 * Opens the kernel socket named by the runtime file and hands the caller a request function that
 * resolves the frame carrying its own id. Broadcasts share the socket, so matching on the reply
 * order would hand a `session.created` to a `schedule.list` caller.
 */
export async function withKernel<T>(
  dataDir: string,
  body: (request: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const runtime = readKernelRuntime(dataDir);
  const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/?token=${runtime.token}`);
  try {
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error("kernel socket failed to open")), { once: true });
    await opened.promise;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    ws.addEventListener("message", (event) => {
      const frame: unknown = JSON.parse(String(event.data));
      if (typeof frame !== "object" || frame === null || !("id" in frame) || typeof frame.id !== "number") return;
      const call = pending.get(frame.id);
      if (call === undefined) return;
      pending.delete(frame.id);
      if ("error" in frame && typeof frame.error === "object" && frame.error !== null && "message" in frame.error && typeof frame.error.message === "string") {
        call.reject(new Error(frame.error.message));
      } else if ("result" in frame) {
        call.resolve(frame.result);
      } else {
        call.reject(new Error("malformed kernel response"));
      }
    });
    return await body((method, params) => {
      const id = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return promise;
    });
  } finally {
    ws.close();
  }
}

/**
 * Removes the provider through the kernel socket (not the UI) so the keyring entry and the
 * SQLite row are both deleted; a spec must not leave a credential in the host vault.
 */
export async function deleteProviderThroughKernel(dataDir: string, name: string): Promise<void> {
  await withKernel(dataDir, async (request) => {
    const listed: unknown = await request("provider.list");
    const providers = typeof listed === "object" && listed !== null && "providers" in listed && Array.isArray(listed.providers)
      ? listed.providers
      : [];
    let targetId: string | undefined;
    for (const provider of providers) {
      if (
        typeof provider === "object" && provider !== null
        && "name" in provider && provider.name === name
        && "id" in provider && typeof provider.id === "string"
      ) {
        targetId = provider.id;
        break;
      }
    }
    if (targetId === undefined) throw new Error(`provider "${name}" not found over the kernel socket`);
    await request("provider.delete", { id: targetId });
  });
}
