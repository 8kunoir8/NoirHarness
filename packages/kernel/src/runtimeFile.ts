import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const RuntimeInfoSchema = z.object({ pid: z.number().int(), port: z.number().int(), token: z.string() });
const LockInfoSchema = z.object({ pid: z.number().int(), token: z.string(), startedAt: z.number() });

export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

/** Ownership claim held for the lifetime of a kernel instance. */
export type LockInfo = z.infer<typeof LockInfoSchema>;

export function runtimeFilePath(dataDir: string): string {
  return join(dataDir, "runtime", "kernel.json");
}

export function lockFilePath(dataDir: string): string {
  return join(dataDir, "runtime", "kernel.lock");
}

export function readRuntimeFile(file: string): RuntimeInfo | null {
  if (!existsSync(file)) return null;
  try {
    const result = RuntimeInfoSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function readLockFile(file: string): LockInfo | null {
  if (!existsSync(file)) return null;
  try {
    const result = LockInfoSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically creates the lock file, or returns false when another process already holds it.
 * `mode: 0o600` is a POSIX guarantee; on Windows the file inherits the data directory ACL.
 */
export function tryCreateLock(file: string, info: LockInfo): boolean {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(info), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/** Removes the lock only when its owner still matches; never steals a newer claim. */
export function removeLockIfOwned(file: string, owner: LockInfo): boolean {
  const current = readLockFile(file);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Removes an unreadable lock left behind by a crashed writer. */
export function removeMalformedLock(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Absent or already removed.
  }
}

export function writeRuntimeFile(file: string, info: RuntimeInfo): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // `mode: 0o600` is a POSIX guarantee; on Windows the file inherits the data directory ACL.
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Removes the runtime file only when it still describes this instance. */
export function removeRuntimeFileIfOwned(file: string, owner: { pid: number; token: string }): boolean {
  const current = readRuntimeFile(file);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
