import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { ErrorCodes, RpcFault, type SkillSourceView } from "@noir/protocol";
import { v7 as uuidv7 } from "uuid";
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  SKILL_NAME,
  hashSkillDir,
  parseSkillFrontmatter,
  type SkillScope,
  type SkillService,
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

/**
 * Copies a local source into staging, refusing any symbolic link: `measure` and `hashSkillDir` both
 * skip links, so a staged link would carry bytes the recorded hash cannot pin. `.git` at the source
 * root is skipped, as the git branch deletes it.
 */
async function copySource(source: string, checkout: string): Promise<void> {
  const copy = async (current: string, relative: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (relative === "" && entry.name === ".git") continue;
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new RpcFault(ErrorCodes.invalidParams, `The source contains a symbolic link: ${path}`);
      }
      const from = join(current, entry.name);
      if (entry.isDirectory()) {
        await mkdir(join(checkout, path), { recursive: true });
        await copy(from, path);
      } else if (entry.isFile()) {
        await cp(from, join(checkout, path));
      }
    }
  };
  await copy(source, "");
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
      await copySource(target.path, checkout);
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

interface SourceRow {
  workspace_id: string;
  scope: SkillScope;
  name: string;
  kind: "git" | "local";
  url: string | null;
  ref: string | null;
  commit_sha: string | null;
  hash: string;
}

export class SkillSourceService {
  constructor(
    private readonly db: Database.Database,
    private readonly skills: SkillService,
    private readonly dataDir: string,
  ) {}

  private get stagingRoot(): string {
    return join(this.dataDir, "skill-staging");
  }

  private row(workspaceId: string, scope: SkillScope, name: string): SourceRow | undefined {
    return this.db
      .prepare(
        "SELECT workspace_id, scope, name, kind, url, ref, commit_sha, hash FROM skill_sources " +
          "WHERE workspace_id = ? AND scope = ? AND name = ?",
      )
      .get(scope === "global" ? "" : workspaceId, scope, name) as SourceRow | undefined;
  }

  /** Every provenance row visible to one workspace, keyed `"<scope>|<name>"`. */
  sourcesFor(workspaceId: string): Map<string, SkillSourceView> {
    const rows = this.db
      .prepare(
        "SELECT workspace_id, scope, name, kind, url, ref, commit_sha, hash FROM skill_sources WHERE workspace_id IN ('', ?)",
      )
      .all(workspaceId) as SourceRow[];
    const map = new Map<string, SkillSourceView>();
    for (const row of rows) {
      const visible = row.workspace_id === "" ? row.scope === "global" : row.scope === "project";
      if (!visible) continue;
      map.set(`${row.scope}|${row.name}`, {
        kind: row.kind,
        url: row.url ?? "",
        ref: row.ref,
        commit: row.commit_sha,
        hash: row.hash,
        updateAvailable: false,
      });
    }
    return map;
  }

  private record(workspaceId: string, scope: SkillScope, name: string, target: FetchTarget, fetched: FetchedSource): void {
    this.db
      .prepare(
        "INSERT INTO skill_sources (id, workspace_id, scope, name, kind, url, ref, commit_sha, hash, installed_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (workspace_id, scope, name) DO UPDATE SET " +
          "kind = excluded.kind, url = excluded.url, ref = excluded.ref, commit_sha = excluded.commit_sha, " +
          "hash = excluded.hash, installed_at = excluded.installed_at",
      )
      .run(
        uuidv7(),
        scope === "global" ? "" : workspaceId,
        scope,
        name,
        target.kind,
        target.kind === "git" ? target.url : target.path,
        target.kind === "git" ? (target.ref ?? null) : null,
        fetched.commit,
        fetched.hash,
        Date.now(),
      );
  }

  async install(
    workspaceId: string, root: string | undefined, scope: SkillScope, kind: "git" | "local", source: string, ref: string | undefined,
  ): Promise<{ name: string; hash: string }> {
    const target: FetchTarget = kind === "local" ? await parseLocalTarget(source) : parseGitTarget(source, ref);
    const destination = await this.skills.rootFor(workspaceId, scope, root);
    const fetched = await fetchSkill(target, this.stagingRoot);
    try {
      // A name is taken when the scan reports it for this scope, whatever directory holds it; a
      // path check alone misses a hand-placed `foo/SKILL.md` that declares `name: dup`.
      const listed = await this.skills.list(workspaceId, root);
      const taken =
        listed.skills.some((skill) => skill.scope === scope && skill.name === fetched.name) ||
        (await lstat(join(destination, fetched.name)).catch(() => undefined)) !== undefined;
      if (taken) {
        throw new RpcFault(ErrorCodes.conflict, `${fetched.name} is already installed in ${scope}; update it instead`);
      }
      await this.place(fetched.dir, join(destination, fetched.name));
      this.record(workspaceId, scope, fetched.name, target, fetched);
      if (root !== undefined) await this.skills.materialize(workspaceId, root);
      return { name: fetched.name, hash: fetched.hash };
    } finally {
      await fetched.cleanup();
    }
  }

  /**
   * Copies a staged directory into a root through a temp sibling and a rename, never a partial
   * write. Symbolic links are dropped at any depth: `fetchSkill` refuses them today, but the rule
   * that every installed byte is covered by the recorded hash must not depend on that caller.
   */
  private async place(staged: string, destination: string): Promise<void> {
    const temp = `${destination}.installing-${uuidv7()}`;
    const copy = async (from: string, to: string): Promise<void> => {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) await copy(source, target);
        else if (entry.isFile()) await cp(source, target);
      }
    };
    try {
      await copy(staged, temp);
      await rename(temp, destination);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  async checkUpdate(workspaceId: string, scope: SkillScope, name: string): Promise<{ commit: string | null; hash: string; changed: boolean }> {
    const row = this.row(workspaceId, scope, name);
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, `${name} was not installed from a source`);
    const target = await this.targetOf(row);
    const fetched = await fetchSkill(target, this.stagingRoot);
    try {
      const commit = fetched.commit;
      const changed = fetched.hash !== row.hash || (commit !== null && commit !== row.commit_sha);
      return { commit, hash: fetched.hash, changed };
    } finally {
      await fetched.cleanup();
    }
  }

  async update(
    workspaceId: string, root: string | undefined, scope: SkillScope, name: string, expectHash: string,
  ): Promise<{ commit: string | null; hash: string }> {
    const row = this.row(workspaceId, scope, name);
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, `${name} was not installed from a source`);
    const target = await this.targetOf(row);
    const fetched = await fetchSkill(target, this.stagingRoot);
    try {
      // The pin is checked before anything is touched: a stale view must leave disk and row alone.
      if (fetched.hash !== expectHash) {
        throw new RpcFault(ErrorCodes.conflict, `${name} changed since it was shown: expected ${expectHash}, fetched ${fetched.hash}`);
      }
      // `name` comes from the row and drives both the destination and the record, while the bytes
      // come from the fetched directory. After an upstream rename the two would disagree, and the
      // row would key a name `list` never reports, so a later checkUpdate or remove finds nothing.
      if (fetched.name !== name) {
        throw new RpcFault(ErrorCodes.invalidParams, `${name} now declares the name "${fetched.name}"; install it instead`);
      }
      const destination = join(await this.skills.rootFor(workspaceId, scope, root), name);
      const aside = `${destination}.previous-${uuidv7()}`;
      let moved = false;
      try {
        await rename(destination, aside);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await this.place(fetched.dir, destination);
      } catch (error) {
        if (moved) {
          try {
            await rename(aside, destination);
          } catch (restore) {
            throw new RpcFault(
              ErrorCodes.internal,
              `${name} was not updated and its previous copy is stranded at ${aside}: ` +
                `${restore instanceof Error ? restore.message : String(restore)}`,
            );
          }
        }
        throw error;
      }
      if (moved) {
        try {
          await rm(aside, { recursive: true, force: true });
        } catch (error) {
          throw new RpcFault(
            ErrorCodes.internal,
            `${name} was updated but the previous copy at ${aside} could not be removed, so its ` +
              `source row still records the old hash: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.record(workspaceId, scope, name, target, fetched);
      if (root !== undefined) await this.skills.materialize(workspaceId, root);
      return { commit: fetched.commit, hash: fetched.hash };
    } finally {
      await fetched.cleanup();
    }
  }

  async remove(workspaceId: string, root: string | undefined, scope: SkillScope, name: string): Promise<void> {
    if (!SKILL_NAME.test(name)) throw new RpcFault(ErrorCodes.invalidParams, `"${name}" is not a valid skill name`);
    // The scan keys a skill by its manifest name and keeps the directory it was found in, so that
    // directory is the only right thing to delete: `join(root, name)` is just the layout `install`
    // writes, and a hand-placed or renamed directory can sit anywhere under the scope root.
    const scanned = await this.skills.dirFor(workspaceId, scope, name, root);
    if (scanned === undefined) {
      // Absent from the scan: a provenance row or a shadowed global still names a directory under
      // the scope root, and nothing else does. Refusing must not create that root.
      const row = this.row(workspaceId, scope, name);
      const shadowed = scope === "global" && (await this.skills.list(workspaceId, root)).shadowed.includes(name);
      if (row === undefined && !shadowed) throw new RpcFault(ErrorCodes.notFound, `Skill not found: ${name}`);
    }
    await rm(scanned ?? join(await this.skills.rootFor(workspaceId, scope, root), name), { recursive: true, force: true });
    this.db
      .prepare("DELETE FROM skill_sources WHERE workspace_id = ? AND scope = ? AND name = ?")
      .run(scope === "global" ? "" : workspaceId, scope, name);
    this.db
      .prepare("DELETE FROM skills WHERE workspace_id = ? AND scope = ? AND name = ?")
      .run(scope === "global" ? "" : workspaceId, scope, name);
    if (root !== undefined) await this.skills.materialize(workspaceId, root);
  }

  private async targetOf(row: SourceRow): Promise<FetchTarget> {
    if (row.kind === "local") return parseLocalTarget(row.url ?? "");
    return parseGitTarget(row.url ?? "", row.ref ?? undefined);
  }
}
