import { execFile } from "node:child_process";
import { TextDecoder, promisify } from "node:util";
import { open, stat } from "node:fs/promises";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { relativePath, resolveInsideRoot } from "./fsPaths.js";

const run = promisify(execFile);
const GIT = process.env.NOIR_GIT_COMMAND ?? "git";
const TIMEOUT_MS = 5_000;

export interface GitFileStatusView {
  path: string;
  change: "created" | "modified" | "deleted";
  add: number;
  del: number;
}

export interface GitStatusView {
  isRepo: boolean;
  branch: string | null;
  files: GitFileStatusView[];
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await run(GIT, ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  }).catch((error: unknown) => {
    throw new RpcFault(ErrorCodes.internal, error instanceof Error ? error.message : "git failed");
  });
  return result.stdout;
}

async function isRepo(root: string): Promise<boolean> {
  try {
    return (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** `git status` always emits toplevel-relative paths; drop anything outside the workspace root. */
function rebase(prefix: string, path: string): string | undefined {
  if (prefix === "") return path;
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length);
}

/** The text cap a synthetic untracked patch or line count reads, mirroring the editor's read limit. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const TRUNCATED_MARKER = "[truncated: file is larger than 2 MiB]";

/** Reads at most `length` bytes plus one to detect overflow, so a huge untracked file never loads whole. */
async function readHead(absolute: string, length: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const buffer = Buffer.alloc(length + 1);
  const handle = await open(absolute, "r");
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { bytes: buffer.subarray(0, Math.min(offset, length)), truncated: offset > length };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the file body as lines, keeping blank lines; a trailing newline does not start a new one.
 * The read stops at 2 MiB (`truncated` then reports it), and decoding keeps a split trailing
 * character pending instead of emitting a replacement char for it.
 */
async function readLines(absolute: string): Promise<{ lines: string[]; truncated: boolean }> {
  const head = await readHead(absolute, MAX_UNTRACKED_BYTES).catch(() => ({
    bytes: Buffer.alloc(0),
    truncated: false,
  }));
  const text = new TextDecoder("utf-8").decode(head.bytes, { stream: true });
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, truncated: head.truncated };
}

/**
 * A status path that cannot be resolved to the workspace simply reports no counted lines.
 * Only the first 2 MiB are read, so a huge untracked file cannot stall `git.status`; past that cap
 * the count is a lower bound rather than the file's true line count.
 */
async function countLines(root: string, path: string): Promise<number> {
  let absolute: string;
  try {
    absolute = resolveInsideRoot(root, path);
  } catch {
    return 0;
  }
  return (await readLines(absolute)).lines.length;
}

function parseNumstat(numstat: string): Map<string, { add: number; del: number }> {
  const counts = new Map<string, { add: number; del: number }>();
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record === "") continue;
    const renamed = /^(\d+|-)\t(\d+|-)\t$/.exec(record);
    if (renamed !== null) {
      // A rename record carries no path: the source then the destination arrive as the next records.
      const source = records[index + 1] ?? "";
      const destination = records[index + 2] ?? "";
      index += 2;
      const value = { add: Number(renamed[1]) || 0, del: Number(renamed[2]) || 0 };
      for (const name of [source, destination]) if (name !== "") counts.set(name, value);
      continue;
    }
    const [add, del, path] = record.split("\t");
    if (path === undefined || path === "" || add === undefined || del === undefined) continue;
    counts.set(path, { add: Number(add) || 0, del: Number(del) || 0 });
  }
  return counts;
}

export async function gitStatus(root: string): Promise<GitStatusView> {
  if (!(await isRepo(root))) return { isRepo: false, branch: null, files: [] };
  const prefix = (await git(root, ["rev-parse", "--show-prefix"]).catch(() => "")).trim();
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  // A status failure degrades to an empty list rather than an error wall.
  const porcelain = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => "");
  // A repository with no commit yet has no HEAD to diff against; untracked files still report.
  // `--relative` rebases numstat paths onto the workspace root and omits everything outside it.
  const numstat = await git(root, ["diff", "--numstat", "-z", "--relative", "HEAD", "--"]).catch(() => "");
  const counts = parseNumstat(numstat);
  const records = porcelain.split("\0");
  const files: GitFileStatusView[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const renamed = code.includes("R") || code.includes("C");
    // `-z` renames emit the destination first and the source as the next record; skip the source.
    if (renamed) index += 1;
    const path = rebase(prefix, record.slice(3));
    if (path === undefined || path === "") continue;
    // NoirHarness's own materialized state is not a user change; `.noir` is always its own dir.
    if (path === ".noir" || path.startsWith(".noir/")) continue;
    const change = renamed
      ? "modified"
      : code === "??"
        ? "created"
        : code.includes("D")
          ? "deleted"
          : code.includes("A")
            ? "created"
            : "modified";
    const counted = counts.get(path) ?? { add: 0, del: 0 };
    const createdLines = change === "created" ? await countLines(root, path) : 0;
    files.push({
      path,
      change,
      add: change === "deleted" ? 0 : counted.add > 0 ? counted.add : createdLines,
      del: counted.del,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { isRepo: true, branch: branch.trim() === "" ? null : branch.trim(), files };
}

export async function gitDiff(root: string, value: string): Promise<string> {
  if (!(await isRepo(root))) return "";
  const path = relativePath(value);
  const absolute = resolveInsideRoot(root, path);
  // `ls-tree` still lists a staged deletion, which `ls-files` no longer does.
  const inHead = await git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", path]).then(
    (output) => output.trim() !== "",
    () => false,
  );
  if (inHead) return git(root, ["diff", "--relative", "--no-color", "HEAD", "--", path]);
  const exists = await stat(absolute).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!exists) return "";
  const head = await readLines(absolute);
  const lines = head.lines.map((line) => `+${line}`);
  // Never let a capped read look like the whole file: the patch says where it stops.
  if (head.truncated) lines.push(`+${TRUNCATED_MARKER}`);
  const body = lines.join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    "",
  ].join("\n");
}
