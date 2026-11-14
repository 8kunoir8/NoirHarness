import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { v7 as uuidv7 } from "uuid";
import { parse as parseYaml } from "yaml";

export type SkillScope = "global" | "project";

export interface DiscoveredSkill {
  scope: SkillScope;
  name: string;
  description: string;
  /** Absolute path to the skill directory. */
  dir: string;
  hash: string;
}

export interface SkillScan {
  skills: DiscoveredSkill[];
  /**
   * Global entries a project skill hides. They carry their directory: the scan is the only place
   * that knows where a name lives, so `remove` and `install` must resolve a shadowed copy through
   * it instead of guessing `<root>/<name>`.
   */
  shadowed: Array<{ name: string; dir: string }>;
  /** `"<scope>:<dir>: <reason>"` for every directory that could not be used. */
  warnings: string[];
}

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 8 * 1024 * 1024;
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * True for `<name>.installing-<uuid>` and `<name>.previous-<uuid>`: the scratch siblings `place`
 * and `update` create next to a destination. They are ours by construction — a valid skill name,
 * a reserved suffix, and a uuidv7 tail — so a scan skips them and a write path may delete them
 * without touching anything a user placed.
 */
export function isStaleSibling(name: string): boolean {
  const match = /^(.*)\.(?:installing|previous)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
    name,
  );
  return match !== null && SKILL_NAME.test(match[1] ?? "");
}

/** Code-unit order, so output does not move with the machine's locale. */
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  // A skill file written on Windows ends its lines with CRLF, and the fence is searched as `\n---`:
  // slicing there leaves the preceding `\r` on the last line, where YAML reads it as a break that
  // ends the document mid-scalar — a `description: "…"` dies and every later key becomes a stray
  // node. 355 of the 432 skills on this machine are CRLF, so this is the common case, not an edge.
  // Normalizing first also makes the parsed `description` free of stray `\r`.
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = normalized.slice(3, end).replace(/^\n/, "");
  let doc: unknown;
  try {
    doc = parseYaml(yaml);
  } catch {
    return {};
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return {};
  const record = doc as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : undefined;
  // Block scalars keep their trailing newline; only an all-whitespace description counts as absent.
  const description = typeof record.description === "string" ? record.description : undefined;
  return {
    ...(name === undefined || name === "" ? {} : { name }),
    ...(description === undefined || description.trim() === "" ? {} : { description }),
  };
}

async function listFiles(dir: string, prefix: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // A symlink inside a skill could point outside the workspace; skip it rather than follow.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await listFiles(absolute, rel, files);
    else if (entry.isFile()) {
      if (files.length >= MAX_SKILL_FILES) throw new Error(`more than ${MAX_SKILL_FILES} files`);
      files.push(rel);
    }
  }
}

/** SHA-256 over every file's path, size and bytes in sorted order; symlinks are skipped. */
export async function hashSkillDir(dir: string): Promise<string> {
  const files: string[] = [];
  await listFiles(dir, "", files);
  const hash = createHash("sha256");
  let total = 0;
  for (const rel of files) {
    const absolute = join(dir, ...rel.split("/"));
    // Size is checked before the read so a large file is never loaded to discover its size.
    const info = await stat(absolute);
    total += info.size;
    if (total > MAX_SKILL_BYTES) throw new Error(`more than ${MAX_SKILL_BYTES} bytes`);
    const bytes = await readFile(absolute);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function readSkill(scope: SkillScope, dir: string): Promise<{ name: string; description: string; hash: string }> {
  const file = join(dir, "SKILL.md");
  const marker = await lstat(file);
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("SKILL.md is not a regular file");
  if (marker.size > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md is larger than 1 MiB");
  const body = await readFile(file);
  const front = parseSkillFrontmatter(body.toString("utf8"));
  if (front.name === undefined) throw new Error("SKILL.md has no name");
  if (!SKILL_NAME.test(front.name)) throw new Error(`"${front.name}" is not a valid skill name`);
  if (front.description === undefined) throw new Error("SKILL.md has no description");
  return { name: front.name, description: front.description, hash: await hashSkillDir(dir) };
}

async function scanRoot(
  scope: SkillScope,
  rootDir: string | undefined,
  skills: Map<string, DiscoveredSkill>,
  warnings: string[],
): Promise<void> {
  if (rootDir === undefined) return;
  let marker;
  try {
    marker = await lstat(rootDir);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT") return;
    warnings.push(`${scope}:${rootDir}: ${failure.message}`);
    return;
  }
  if (marker.isSymbolicLink()) {
    warnings.push(`${scope}:${rootDir}: root is a symlink`);
    return;
  }
  if (!marker.isDirectory()) {
    warnings.push(`${scope}:${rootDir}: root is not a directory`);
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT") return;
    warnings.push(`${scope}:${rootDir}: ${failure.message}`);
    return;
  }
  // Windows filesystems are case-insensitive, so two names differing only by case would collide
  // in the engine root; report the later one as a duplicate instead of overwriting the first.
  const seen = process.platform === "win32" ? new Set<string>() : undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    // A scratch sibling holds a full copy of some skill; scanning it would list a duplicate.
    if (isStaleSibling(entry.name)) continue;
    const dir = join(rootDir, entry.name);
    try {
      const read = await readSkill(scope, dir);
      const key = read.name.toLowerCase();
      if (skills.has(read.name) || seen?.has(key) === true) {
        warnings.push(`${scope}:${dir}: duplicate name "${read.name}"`);
        continue;
      }
      seen?.add(key);
      skills.set(read.name, { scope, dir, ...read });
    } catch (error) {
      warnings.push(`${scope}:${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Project skills are scanned first: a name present in both scopes resolves to the project copy,
 * and the global copy is reported as shadowed instead of silently winning somewhere else.
 */
export async function discoverSkills(globalDir: string, projectDir: string | undefined): Promise<SkillScan> {
  const skills = new Map<string, DiscoveredSkill>();
  const warnings: string[] = [];
  const shadowed: Array<{ name: string; dir: string }> = [];
  await scanRoot("project", projectDir, skills, warnings);
  const projectNames = new Set(skills.keys());
  const projectNamesLower =
    process.platform === "win32" ? new Set([...projectNames].map((name) => name.toLowerCase())) : undefined;
  const global = new Map<string, DiscoveredSkill>();
  const globalWarnings: string[] = [];
  await scanRoot("global", globalDir, global, globalWarnings);
  warnings.push(...globalWarnings);
  for (const [name, skill] of global) {
    if (projectNames.has(name)) {
      shadowed.push({ name, dir: skill.dir });
      continue;
    }
    // One NTFS directory cannot hold both spellings; project precedence wins case-insensitively.
    if (projectNamesLower?.has(name.toLowerCase()) === true) {
      shadowed.push({ name, dir: skill.dir });
      warnings.push(`global:${skill.dir}: "${name}" differs only by case from a project skill`);
      continue;
    }
    skills.set(name, skill);
  }
  return {
    skills: [...skills.values()].sort((a, b) => compareCodeUnits(a.name, b.name)),
    shadowed: shadowed.sort((a, b) => compareCodeUnits(a.name, b.name)),
    warnings: warnings.sort(compareCodeUnits),
  };
}

export interface SkillManifest {
  version: 1;
  skills: { name: string; scope: SkillScope; hash: string; description: string }[];
}

export interface SkillRowView {
  scope: SkillScope;
  name: string;
  description: string;
  hash: string;
  enabled: boolean;
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

/** Copies a skill directory without following symlinks; the destination replaces any old copy. */
async function copySkill(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copySkill(from, to);
    else if (entry.isFile()) await cp(from, to);
  }
}

/**
 * `lstat` that reports a missing path as `undefined`. Any other failure propagates: "absent" and
 * "unreadable" are different answers, and only the caller knows which one is safe.
 */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Ensures `path` is a real directory, creating it only when nothing exists there yet. `makeFault`
 * lets a caller that owes an `RpcFault` report the refusal with its own code and message.
 */
async function ensureRealDirectory(
  path: string,
  label: string,
  makeFault: (message: string) => Error = (message) => new Error(message),
): Promise<void> {
  const marker = await lstatOrUndefined(path);
  if (marker === undefined) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (marker.isSymbolicLink()) throw makeFault(`${label} is a symlink`);
  if (!marker.isDirectory()) throw makeFault(`${label} is not a directory`);
}

/** True when `<root>/.noir` exists but is a symlink or not a directory; it is never followed. */
async function hasUntrustedNoir(root: string): Promise<boolean> {
  try {
    const marker = await lstat(join(root, ".noir"));
    return marker.isSymbolicLink() || !marker.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class SkillService {
  constructor(private readonly db: Database.Database, private readonly dataDir: string) {}

  private get globalRoot(): string {
    return join(this.dataDir, "skills");
  }

  /**
   * The workspace root and its `.noir` must be real directories, and `<root>/.noir/skills` must be
   * a real directory or absent; the returned path is the leaf when it exists. It never creates
   * anything — `rootFor` creates the leaf after this passes, `dirFor` never writes.
   */
  private async checkedWorkspace(root: string | undefined): Promise<string | undefined> {
    if (root === undefined) throw new RpcFault(ErrorCodes.invalidParams, "A project skill needs a workspace");
    // A workspace whose directory is gone is never recreated here; `materialize` refuses it too.
    const marker = await stat(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (marker?.isDirectory() !== true) {
      throw new RpcFault(ErrorCodes.invalidParams, "Workspace root is not a directory");
    }
    if (await hasUntrustedNoir(root)) throw new RpcFault(ErrorCodes.invalidParams, "Workspace .noir is not a directory");
    const leaf = join(root, ".noir", "skills");
    const leafMarker = await lstatOrUndefined(leaf);
    // A linked leaf is refused, not followed: an install, update, or remove must never operate on
    // bytes outside the workspace just because a cloned repo carried `<root>/.noir/skills`.
    if (leafMarker !== undefined && (leafMarker.isSymbolicLink() || !leafMarker.isDirectory())) {
      throw new RpcFault(ErrorCodes.invalidParams, "Workspace .noir/skills is not a directory");
    }
    return leafMarker === undefined ? undefined : leaf;
  }

  /** The directory a scope installs into and scans: the data dir for global, `<ws>/.noir/skills` for project. */
  async rootFor(workspaceId: string, scope: SkillScope, root: string | undefined): Promise<string> {
    if (scope === "global") return this.globalRoot;
    const leaf = await this.checkedWorkspace(root);
    if (leaf !== undefined) return leaf;
    // `checkedWorkspace` rejects an undefined root, so this branch always has one.
    const created = join(root as string, ".noir", "skills");
    await mkdir(created, { recursive: true });
    return created;
  }

  /**
   * The directory the scan resolved for a name, or undefined when the scope holds none. A shadowed
   * global is absent from `skills` — the project copy won the name — but it still owns a directory,
   * and the scan is the only thing that knows it. Refuses an unreadable workspace rather than
   * answering "absent" for it: a caller that deletes by this answer must never act on a workspace
   * whose files it could not look at.
   */
  async dirFor(
    workspaceId: string,
    scope: SkillScope,
    name: string,
    root: string | undefined,
  ): Promise<string | undefined> {
    const projectDir = scope === "project" ? await this.checkedWorkspace(root) : undefined;
    const scan = await discoverSkills(this.globalRoot, projectDir);
    const found = scan.skills.find((skill) => skill.scope === scope && skill.name === name);
    if (found !== undefined) return found.dir;
    return scope === "global" ? scan.shadowed.find((entry) => entry.name === name)?.dir : undefined;
  }

  private readEnabled(workspaceId: string): Map<string, boolean> {
    const rows = this.db
      .prepare("SELECT workspace_id, scope, name, enabled FROM skills")
      .all() as Array<{ workspace_id: string; scope: SkillScope; name: string; enabled: number }>;
    const flags = new Map<string, boolean>();
    for (const row of rows) {
      if (row.workspace_id !== "" && row.workspace_id !== workspaceId) continue;
      flags.set(`${row.workspace_id}|${row.scope}|${row.name}`, row.enabled === 1);
    }
    return flags;
  }

  private enabledFor(workspaceId: string, flags: Map<string, boolean>, skill: DiscoveredSkill): boolean {
    const key = `${skill.scope === "global" ? "" : workspaceId}|${skill.scope}|${skill.name}`;
    return flags.get(key) ?? true;
  }

  private persist(workspaceId: string, skill: DiscoveredSkill): void {
    this.db
      .prepare(
        "INSERT INTO skills (id, workspace_id, scope, name, dir, hash, manifest_json, enabled) VALUES (?,?,?,?,?,?,?,1) " +
          "ON CONFLICT (workspace_id, scope, name) DO UPDATE SET dir = excluded.dir, hash = excluded.hash, manifest_json = excluded.manifest_json",
      )
      .run(
        uuidv7(),
        skill.scope === "global" ? "" : workspaceId,
        skill.scope,
        skill.name,
        skill.dir,
        skill.hash,
        JSON.stringify({ name: skill.name, description: skill.description }),
      );
  }

  /** Scans both roots, refreshes hashes in the DB, and returns every usable row with its flag. */
  async list(
    workspaceId: string,
    root: string | undefined,
  ): Promise<{ skills: SkillRowView[]; shadowed: string[]; warnings: string[] }> {
    const noir = root === undefined ? undefined : join(root, ".noir");
    const untrusted = root !== undefined && (await hasUntrustedNoir(root));
    const projectDir = noir === undefined || untrusted ? undefined : join(noir, "skills");
    const scan = await discoverSkills(this.globalRoot, projectDir);
    const warnings = [...scan.warnings];
    // A linked `.noir` must never send the scan outside the workspace; report it and list globals.
    if (untrusted && noir !== undefined) warnings.push(`project:${noir}: .noir is not a directory`);
    for (const skill of scan.skills) this.persist(workspaceId, skill);
    const flags = this.readEnabled(workspaceId);
    return {
      skills: scan.skills.map((skill) => ({
        scope: skill.scope,
        name: skill.name,
        description: skill.description,
        hash: skill.hash,
        enabled: this.enabledFor(workspaceId, flags, skill),
      })),
      shadowed: scan.shadowed.map((entry) => entry.name),
      warnings: warnings.sort(compareCodeUnits),
    };
  }

  async setEnabled(
    workspaceId: string,
    root: string | undefined,
    scope: SkillScope,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    const listed = await this.list(workspaceId, root);
    const skill = listed.skills.find((row) => row.scope === scope && row.name === name);
    if (skill === undefined) throw new RpcFault(ErrorCodes.notFound, `Skill not found: ${name}`);
    this.db
      .prepare("UPDATE skills SET enabled = ? WHERE workspace_id = ? AND scope = ? AND name = ?")
      .run(enabled ? 1 : 0, scope === "global" ? "" : workspaceId, scope, name);
    if (root !== undefined) await this.materialize(workspaceId, root);
  }

  async read(
    workspaceId: string,
    root: string | undefined,
    scope: SkillScope,
    name: string,
  ): Promise<{ content: string; hash: string; truncated: false }> {
    const projectDir =
      root === undefined || (await hasUntrustedNoir(root)) ? undefined : join(root, ".noir", "skills");
    const scan = await discoverSkills(this.globalRoot, projectDir);
    const found = scan.skills.find((row) => row.scope === scope && row.name === name);
    if (found === undefined) throw new RpcFault(ErrorCodes.notFound, `Skill not found: ${name}`);
    const content = await readFile(join(found.dir, "SKILL.md"), "utf8");
    return { content, hash: found.hash, truncated: false };
  }

  /**
   * Writes the effective set for one workspace into `<workspace>/.noir/skills-engine` plus its
   * manifest. One directory per workspace makes precedence intrinsic: `discoverSkills` never
   * yields a global copy whose name a project skill claims, even when that project skill is
   * disabled, so disabling it cannot resurrect the global one. Each winner replaces only its own
   * `<name>` directory; anything else in the engine root is left alone. The workspace must exist
   * as a directory (a linked root is followed, a missing one is never recreated) while `.noir`
   * must be a real directory (no write goes through a linked `.noir` or engine root); filesystem
   * failures propagate so the caller can decide.
   */
  async materialize(workspaceId: string, root: string): Promise<void> {
    const rootMarker = await stat(root);
    if (!rootMarker.isDirectory()) throw new Error("Workspace root is not a directory");
    const noir = join(root, ".noir");
    await ensureRealDirectory(noir, "Workspace .noir");
    const projectDir = join(noir, "skills");
    // Created on materialize, never by `list`: listing a workspace must not write into it. Unlike
    // `rootFor`, a linked or non-directory leaf is tolerated here rather than refused: `materialize`
    // never writes through the leaf, `discoverSkills` refuses to scan it and reports it as a warning,
    // and failing the whole engine write would deny the workspace its global skills.
    if ((await lstatOrUndefined(projectDir)) === undefined) await mkdir(projectDir, { recursive: true });
    const scan = await discoverSkills(this.globalRoot, projectDir);
    const flags = this.readEnabled(workspaceId);
    const target = join(noir, "skills-engine");
    await ensureRealDirectory(target, "Skills engine root");
    const manifest: SkillManifest = { version: 1, skills: [] };
    const winners = scan.skills.filter((skill) => this.enabledFor(workspaceId, flags, skill));
    const names = new Set(winners.map((skill) => skill.name));
    // Windows can hold only one spelling per name, so a pre-fix manifest may carry both `DUP`
    // and `dup`; either spelling must keep the freshly materialized winner.
    const namesLower =
      process.platform === "win32" ? new Set([...names].map((name) => name.toLowerCase())) : undefined;
    // Read before writing: this is the only record of which directories this engine owns.
    const previous = await this.manifestFor(root);
    for (const skill of winners) {
      const temp = join(target, `.tmp-${randomUUID()}`);
      const destination = join(target, skill.name);
      const old = join(target, `.old-${randomUUID()}`);
      let movedOld = false;
      try {
        await copySkill(skill.dir, temp);
        // Move the old copy aside first: renaming over a non-empty directory fails on Windows.
        try {
          await rename(destination, old);
          movedOld = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temp, destination);
        if (movedOld) await rm(old, { recursive: true, force: true });
      } catch (error) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        if (movedOld) {
          // Put the previous copy back; only drop it when the restore itself cannot happen.
          await rename(old, destination).catch(() => rm(old, { recursive: true, force: true }).catch(() => undefined));
        }
        throw error;
      }
      manifest.skills.push({ name: skill.name, scope: skill.scope, hash: skill.hash, description: skill.description });
    }
    for (const name of previous.keys()) {
      if (names.has(name) || namesLower?.has(name.toLowerCase()) === true) continue;
      // A hand-edited manifest must not turn into a path outside the engine root.
      if (!SKILL_NAME.test(name)) continue;
      await rm(join(target, name), { recursive: true, force: true });
    }
    await writeJsonAtomically(join(noir, "skills-engine.json"), manifest);
  }

  /** Scope and hash as materialized for this workspace; absent when nothing was written. */
  async manifestFor(root: string | undefined): Promise<Map<string, { scope: SkillScope; hash: string }>> {
    const merged = new Map<string, { scope: SkillScope; hash: string }>();
    if (root === undefined) return merged;
    try {
      const noir = join(root, ".noir");
      const noirMarker = await lstat(noir);
      // A linked `.noir` is not this workspace's own state; do not read a manifest through it.
      if (noirMarker.isSymbolicLink() || !noirMarker.isDirectory()) return merged;
      const file = join(noir, "skills-engine.json");
      const marker = await lstat(file);
      // A manifest replaced by a link is not one this service wrote; treat it as absent.
      if (marker.isSymbolicLink() || !marker.isFile()) return merged;
      const manifest = JSON.parse(await readFile(file, "utf8")) as SkillManifest;
      for (const skill of manifest.skills) merged.set(skill.name, { scope: skill.scope, hash: skill.hash });
    } catch {
      // No manifest means nothing was materialized for this workspace, so nothing is attributed.
    }
    return merged;
  }
}
