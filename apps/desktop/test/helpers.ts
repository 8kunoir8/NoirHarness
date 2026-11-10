import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Retries because Windows keeps handles on SQLite files and omp session files briefly after exit. */
export async function removeDir(dir: string): Promise<void> {
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

function readRuntimePid(file: string): number | undefined {
  try {
    const runtime: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof runtime === "object" && runtime !== null && "pid" in runtime && typeof runtime.pid === "number"
      ? runtime.pid
      : undefined;
  } catch {
    return undefined;
  }
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
    if (existsSync(runtimeFile)) lastPid = readRuntimePid(runtimeFile) ?? lastPid;
    if (lastPid === undefined) return; // kernel never recorded a pid: nothing to wait for
    if (!isProcessAlive(lastPid)) return;
    await delay(100);
  }
  throw new Error(`kernel process ${lastPid} recorded in ${runtimeFile} did not exit before relaunch`);
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
 * Removes the provider through the kernel socket (not the UI) so the keyring entry and the
 * SQLite row are both deleted; a spec must not leave a credential in the host vault.
 */
export async function deleteProviderThroughKernel(dataDir: string, name: string): Promise<void> {
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
    const request = (method: string, params?: unknown): Promise<unknown> => {
      const id = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return promise;
    };

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
  } finally {
    ws.close();
  }
}

/** `~/.omp/profiles/noir/agent` — the profile the kernel generates and `omp` reads. */
export function profileAgentDir(): string {
  return join(homedir(), ".omp", "profiles", "noir", "agent");
}

export interface ProfileSnapshot {
  restore(): Promise<void>;
}

/** Relative path → SHA-256 of every regular file under `root`. */
function fileHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, relative);
      else if (entry.isFile()) hashes.set(relative, createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(root, "");
  return hashes;
}

function sameTree(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, hash] of left) {
    if (right.get(path) !== hash) return false;
  }
  return true;
}

/**
 * The app rewrites the real `~/.omp/profiles/noir/agent` on every provider/model change, so an
 * e2e run must put back whatever the developer had (including "nothing") before it started.
 *
 * Restore copies the backup to a sibling staging directory, verifies it, and only then swaps it
 * into place; the live directory is never deleted while the backup is the only remaining copy.
 */
export function snapshotProfileAgentDir(dir = profileAgentDir()): ProfileSnapshot {
  const backupRoot = mkdtempSync(join(tmpdir(), "noir profile backup "));
  const backup = join(backupRoot, "agent");
  const existed = existsSync(dir);
  if (existed) cpSync(dir, backup, { recursive: true });
  return {
    async restore(): Promise<void> {
      if (!existed) {
        await removeDir(dir);
        await removeDir(backupRoot);
        return;
      }
      const stagingRoot = mkdtempSync(join(dirname(dir), ".agent-restore-"));
      try {
        const staging = join(stagingRoot, "agent");
        cpSync(backup, staging, { recursive: true });
        if (!sameTree(fileHashes(backup), fileHashes(staging))) {
          throw new Error("staged profile copy does not match the backup");
        }
        await removeDir(dir);
        renameSync(staging, dir);
      } catch (error) {
        await removeDir(stagingRoot).catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`profile restore failed; backup kept at ${backupRoot}: ${reason}`);
      }
      await removeDir(stagingRoot).catch(() => undefined);
      // The live profile is already replaced; a cleanup failure must not read as a failed restore.
      await removeDir(backupRoot).catch(() => undefined);
    },
  };
}
