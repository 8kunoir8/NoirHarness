import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The identity of a kernel build: a hash of its entry file. The desktop app hashes the same file
 * before it spawns one, so "the daemon is this build" is a fact about bytes rather than a version
 * somebody forgot to bump.
 */
export function buildIdOf(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}
