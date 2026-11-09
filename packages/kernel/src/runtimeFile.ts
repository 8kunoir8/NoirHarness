import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimeInfo {
  pid: number;
  port: number;
  token: string;
}

export function runtimeFilePath(dataDir: string): string {
  return join(dataDir, "runtime", "kernel.json");
}

export function readRuntimeFile(file: string): RuntimeInfo | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo;
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

export function writeRuntimeFile(file: string, info: RuntimeInfo): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeRuntimeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Absent or already removed.
  }
}
