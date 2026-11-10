import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  const entries: FsEntryView[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    const path = joinRel(rel, dirent.name);
    const kind = dirent.isDirectory() ? "dir" : "file";
    let size = 0;
    if (kind === "file") size = (await stat(join(absolute, dirent.name))).size;
    entries.push({ name: dirent.name, path, kind, size });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES };
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
  const buffer = await readFile(absolute);
  const slice = buffer.subarray(0, MAX_READ_BYTES);
  if (slice.includes(0)) throw new RpcFault(ErrorCodes.invalidParams, `Not a text file: ${rel}`);
  return {
    content: slice.toString("utf8"),
    size: buffer.length,
    mtimeMs: Math.floor(info.mtimeMs),
    truncated: buffer.length > MAX_READ_BYTES,
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
  await writeFile(absolute, content, "utf8");
  return { mtimeMs: Math.floor((await stat(absolute)).mtimeMs) };
}

/** Every file under the root, for the quick-open picker; git and dependency dirs are skipped. */
export async function findFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (files.length >= MAX_FIND_FILES) return;
    const dirents = await readdir(resolveInsideRoot(root, rel), { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (files.length >= MAX_FIND_FILES) return;
      if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;
      const path = joinRel(rel, dirent.name);
      if (dirent.isDirectory()) await walk(path);
      else if (dirent.isFile()) files.push(path);
    }
  };
  await walk("");
  return { files: files.sort(), truncated: files.length >= MAX_FIND_FILES };
}
