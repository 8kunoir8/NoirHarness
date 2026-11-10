import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
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

export async function gitStatus(root: string): Promise<GitStatusView> {
  if (!(await isRepo(root))) return { isRepo: false, branch: null, files: [] };
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  const porcelain = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  // A repository with no commit yet has no HEAD to diff against; untracked files still report.
  const numstat = await git(root, ["diff", "--numstat", "-z", "HEAD", "--"]).catch(() => "");
  const counts = new Map<string, { add: number; del: number }>();
  for (const record of numstat.split("\0")) {
    const [add, del, path] = record.split("\t");
    // Rename records carry an empty path: their counts arrive under the destination path instead.
    if (path === undefined || path === "" || add === undefined || del === undefined) continue;
    counts.set(path, { add: Number(add) || 0, del: Number(del) || 0 });
  }
  const records = porcelain.split("\0");
  const files: GitFileStatusView[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // `-z` renames emit the destination first and the source as the next record; skip the source.
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      continue;
    }
    const change = code === "??" ? "created" : code.includes("D") ? "deleted" : code.includes("A") ? "created" : "modified";
    const counted = counts.get(path) ?? { add: 0, del: 0 };
    const createdLines =
      change === "created"
        ? (await readFile(resolveInsideRoot(root, path), "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length
        : 0;
    files.push({
      path,
      change,
      add: change === "deleted" ? 0 : createdLines > 0 ? createdLines : counted.add,
      del: change === "deleted" ? counted.del || 1 : counted.del,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { isRepo: true, branch: branch.trim() === "" ? null : branch.trim(), files };
}

export async function gitDiff(root: string, value: string): Promise<string> {
  if (!(await isRepo(root))) return "";
  const path = relativePath(value);
  const absolute = resolveInsideRoot(root, path);
  const tracked = await git(root, ["ls-files", "--error-unmatch", "--", path]).then(
    () => true,
    () => false,
  );
  if (tracked) return git(root, ["diff", "--no-color", "HEAD", "--", path]);
  const exists = await stat(absolute).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!exists) return "";
  const lines = (await readFile(absolute, "utf8")).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  return ["--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, body, ""].join("\n");
}
