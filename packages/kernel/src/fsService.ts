import { open, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { relativePath, resolveInsideRoot } from "./fsPaths.js";

export const MAX_LIST_ENTRIES = 2_000;
export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_FIND_FILES = 5_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".noir"]);

export interface FsEntryView {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
}

function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

export async function listDirectory(
  root: string,
  value: string,
): Promise<{ entries: FsEntryView[]; truncated: boolean }> {
  const rel = relativePath(value);
  const absolute = resolveInsideRoot(root, rel);
  const dirents = await readdir(absolute, { withFileTypes: true }).catch(() => {
    throw new RpcFault(ErrorCodes.notFound, `Directory not found: ${rel}`);
  });
  // Git metadata stays hidden, and symlinks are never navigated: the editor edits real files.
  const visible = dirents.filter((dirent) => dirent.name !== ".git" && !dirent.isSymbolicLink());
  // stat is bounded by the page size and must never fail the listing for one bad entry.
  const entries: FsEntryView[] = [];
  for (const dirent of visible.slice(0, MAX_LIST_ENTRIES)) {
    const kind = dirent.isDirectory() ? "dir" : "file";
    let size = 0;
    if (kind === "file") {
      // An entry removed or made unreadable after readdir still lists, with no size.
      size = await stat(join(absolute, dirent.name)).then(
        (info) => info.size,
        () => 0,
      );
    }
    entries.push({ name: dirent.name, path: joinRel(rel, dirent.name), kind, size });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: visible.length > MAX_LIST_ENTRIES };
}

/**
 * Strict UTF-8: invalid byte sequences are refused rather than replaced, because the editor would
 * otherwise save the mangled copy back over the file. A truncated read may end mid-sequence, so up
 * to three trailing bytes are dropped to reach the last complete character.
 */
function decodeText(bytes: Buffer, truncated: boolean, rel: string): string {
  if (bytes.length === 0) return "";
  const attempts = truncated ? 4 : 1;
  for (let trim = 0; trim < attempts && trim < bytes.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
    } catch {
      // Only a split trailing sequence is recoverable; the next trim tries to drop it.
    }
  }
  throw new RpcFault(ErrorCodes.invalidParams, `Not a UTF-8 text file: ${rel}`);
}

/** Reads at most `length` bytes, so a huge file never materializes in memory. */
async function readHead(absolute: string, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const handle = await open(absolute, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readFileText(
  root: string,
  value: string,
): Promise<{ content: string; size: number; mtimeMs: number; truncated: boolean }> {
  const rel = relativePath(value);
  const absolute = resolveInsideRoot(root, rel);
  const info = await stat(absolute).catch(() => {
    throw new RpcFault(ErrorCodes.notFound, `File not found: ${rel}`);
  });
  if (!info.isFile()) throw new RpcFault(ErrorCodes.invalidParams, `Not a file: ${rel}`);
  const truncated = info.size > MAX_READ_BYTES;
  const bytes = await readHead(absolute, Math.min(info.size, MAX_READ_BYTES));
  if (bytes.includes(0)) throw new RpcFault(ErrorCodes.invalidParams, `Not a UTF-8 text file: ${rel}`);
  return {
    content: decodeText(bytes, truncated, rel),
    size: info.size,
    mtimeMs: Math.floor(info.mtimeMs),
    truncated,
  };
}

export async function writeFileText(
  root: string,
  value: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<{ mtimeMs: number }> {
  const rel = relativePath(value);
  if (rel === "") throw new RpcFault(ErrorCodes.invalidParams, "A file path is required");
  if (content.includes("\u0000")) throw new RpcFault(ErrorCodes.invalidParams, "File content must not contain NUL");
  const absolute = resolveInsideRoot(root, rel);
  const parent = dirname(absolute);
  await stat(parent).catch(() => {
    throw new RpcFault(ErrorCodes.notFound, `Directory not found: ${rel.split("/").slice(0, -1).join("/")}`);
  });
  if (expectedMtimeMs !== undefined) {
    const current = await stat(absolute).catch(() => undefined);
    if (current !== undefined && Math.floor(current.mtimeMs) !== expectedMtimeMs) {
      throw new RpcFault(ErrorCodes.conflict, `${rel} changed on disk`);
    }
  }
  try {
    await writeFile(absolute, content, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EISDIR" || code === "ENOTDIR") {
      throw new RpcFault(ErrorCodes.invalidParams, `Not a file: ${rel}`);
    }
    throw error;
  }
  return { mtimeMs: Math.floor((await stat(absolute)).mtimeMs) };
}

/** Every file under the root, for the quick-open picker; git and dependency dirs are skipped. */
export async function findFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (rel: string): Promise<void> => {
    if (truncated) return;
    const dirents = await readdir(resolveInsideRoot(root, rel), { withFileTypes: true }).catch((error: unknown) => {
      // A directory that vanished mid-walk is expected; anything else would silently hide files.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw new RpcFault(ErrorCodes.invalidParams, `Directory cannot be listed: ${rel}`);
    });
    for (const dirent of dirents) {
      if (truncated) return;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;
      const path = joinRel(rel, dirent.name);
      if (dirent.isDirectory()) {
        await walk(path);
      } else if (dirent.isFile()) {
        // Only report truncation once a file is actually dropped.
        if (files.length >= MAX_FIND_FILES) {
          truncated = true;
          return;
        }
        files.push(path);
      }
    }
  };
  await walk("");
  return { files: files.sort(), truncated };
}
