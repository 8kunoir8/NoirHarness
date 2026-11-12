import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { v7 as uuidv7 } from "uuid";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  SKILL_NAME,
  hashSkillDir,
  parseSkillFrontmatter,
} from "./skills.js";

export type FetchTarget =
  | { kind: "git"; url: string; ref: string | undefined }
  | { kind: "local"; path: string };

/** Hostnames that may be reached over plain `http`. A whole-host comparison, never a prefix. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function parseGitTarget(source: string, ref: string | undefined): FetchTarget {
  if (ref !== undefined && !REF.test(ref)) throw new RpcFault(ErrorCodes.invalidParams, `Invalid ref: ${ref}`);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a URL`);
  }
  // `ext::` reaches a remote command; `C:\x` parses as protocol `c:`; both fall out here.
  const loopback = LOOPBACK_HOSTS[url.hostname] === true;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new RpcFault(ErrorCodes.invalidParams, `${url.protocol} is not an accepted transport`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new RpcFault(ErrorCodes.invalidParams, "A skill source URL must not carry credentials");
  }
  return { kind: "git", url: url.href, ref };
}

/** A component that is a file reports ENOTDIR, which means the same thing as ENOENT here. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Resolves a `local` target to a real directory; a link is refused rather than followed. */
export async function parseLocalTarget(source: string): Promise<FetchTarget> {
  if (!isAbsolute(source)) throw new RpcFault(ErrorCodes.invalidParams, "A local skill source must be an absolute path");
  // `resolve` strips a trailing separator; without that, POSIX `lstat` resolves the final component
  // as a directory and reports the target, accepting the very link this refuses. It also normalizes
  // `.`/`..` segments, so the path stored and the path checked are the same one.
  const resolved = resolve(source);
  const marker = await lstat(resolved).catch((error: unknown) => {
    if (isMissing(error)) {
      throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a directory`);
    }
    throw new RpcFault(ErrorCodes.invalidParams, `${source} cannot be inspected: ${(error as Error).message}`);
  });
  if (marker.isSymbolicLink()) throw new RpcFault(ErrorCodes.invalidParams, `${source} is a symlink`);
  if (!marker.isDirectory()) throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a directory`);
  return { kind: "local", path: resolved };
}

const run = promisify(execFile);
/** Read per call, so a test can point the binary at something observable. */
const gitCommand = (): string => process.env.NOIR_GIT_COMMAND ?? "git";
const GIT_TIMEOUT_MS = 30_000;
const MAX_ENTRIES = 2000;
const MAX_CLONE_BYTES = 32 * 1024 * 1024;

export interface FetchedSource {
  dir: string;
  name: string;
  description: string;
  hash: string;
  commit: string | null;
  cleanup: () => Promise<void>;
}

async function gitAt(cwd: string, args: string[]): Promise<string> {
  const config = ["-c", "protocol.ext.allow=never", "-c", "core.symlinks=false", "-c", "credential.helper="];
  const result = await run(gitCommand(), [...config, ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_ASKPASS_REQUIRE: "never" },
  }).catch((error: unknown) => {
    const failure = error as { stderr?: string; message?: string };
    throw new RpcFault(ErrorCodes.internal, (failure.stderr ?? failure.message ?? "git failed").slice(0, 2048));
  });
  return result.stdout;
}

async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(absolute)).size;
        if (files > MAX_ENTRIES) throw new RpcFault(ErrorCodes.invalidParams, `more than ${MAX_ENTRIES} files`);
        if (bytes > MAX_CLONE_BYTES) throw new RpcFault(ErrorCodes.invalidParams, `more than ${MAX_CLONE_BYTES} bytes`);
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

/** Reads the skill manifest of a staged directory, refusing a name that could escape a root. */
async function readStagedSkill(dir: string): Promise<{ name: string; description: string; hash: string }> {
  const file = join(dir, "SKILL.md");
  const marker = await lstat(file);
  if (!marker.isFile() || marker.isSymbolicLink()) throw new RpcFault(ErrorCodes.invalidParams, "SKILL.md is not a regular file");
  if (marker.size > MAX_SKILL_FILE_BYTES) throw new RpcFault(ErrorCodes.invalidParams, "SKILL.md is larger than 1 MiB");
  const front = parseSkillFrontmatter(await readFile(file, "utf8"));
  if (front.name === undefined) throw new RpcFault(ErrorCodes.invalidParams, "SKILL.md has no name");
  // The name becomes a directory name in two roots, so it is validated before any join.
  if (!SKILL_NAME.test(front.name)) throw new RpcFault(ErrorCodes.invalidParams, `"${front.name}" is not a valid skill name`);
  if (front.description === undefined) throw new RpcFault(ErrorCodes.invalidParams, "SKILL.md has no description");
  const measured = await measure(dir);
  if (measured.files > MAX_SKILL_FILES) throw new RpcFault(ErrorCodes.invalidParams, `more than ${MAX_SKILL_FILES} files`);
  if (measured.bytes > MAX_SKILL_BYTES) throw new RpcFault(ErrorCodes.invalidParams, `more than ${MAX_SKILL_BYTES} bytes`);
  return { name: front.name, description: front.description, hash: await hashSkillDir(dir) };
}

/**
 * The skill a staged source holds: the checkout itself when it is a skill root, otherwise its one
 * child directory carrying `SKILL.md`. A source with several skills is refused; installing them all
 * would need a name per directory that the manifest, not the checkout, owns.
 */
async function stagedSkillRoot(checkout: string): Promise<string> {
  // Any manifest at the root wins, so `readStagedSkill` reports a link or a directory there.
  if ((await lstat(join(checkout, "SKILL.md")).catch(() => undefined)) !== undefined) return checkout;
  const candidates: string[] = [];
  for (const entry of await readdir(checkout, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const marker = await lstat(join(checkout, entry.name, "SKILL.md")).catch(() => undefined);
    if (marker?.isFile() === true) candidates.push(entry.name);
  }
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only === undefined) {
    throw new RpcFault(
      ErrorCodes.invalidParams,
      candidates.length === 0 ? "The source has no SKILL.md" : `The source has ${candidates.length} skill directories; point at one`,
    );
  }
  return join(checkout, only);
}

export async function fetchSkill(target: FetchTarget, stagingRoot: string): Promise<FetchedSource> {
  const staging = join(stagingRoot, uuidv7());
  await mkdir(staging, { recursive: true });
  const cleanup = () => rm(staging, { recursive: true, force: true });
  try {
    let checkout: string;
    let commit: string | null = null;
    if (target.kind === "git") {
      const args = ["clone", "--depth", "1", "--no-recurse-submodules", "--single-branch"];
      if (target.ref !== undefined) args.push("--branch", target.ref);
      args.push("--", target.url, join(staging, "checkout"));
      await gitAt(staging, args);
      checkout = join(staging, "checkout");
      commit = (await gitAt(checkout, ["rev-parse", "HEAD"])).trim();
      await rm(join(checkout, ".git"), { recursive: true, force: true });
    } else {
      checkout = join(staging, "checkout");
      await mkdir(checkout, { recursive: true });
      for (const entry of await readdir(target.path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        await cp(join(target.path, entry.name), join(checkout, entry.name), { recursive: entry.isDirectory() });
      }
    }
    await measure(checkout);
    const dir = await stagedSkillRoot(checkout);
    const read = await readStagedSkill(dir);
    return { dir, name: read.name, description: read.description, hash: read.hash, commit, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
