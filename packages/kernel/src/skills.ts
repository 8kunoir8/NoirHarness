import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  /** Global names hidden by a project skill of the same name. */
  shadowed: string[];
  /** `"<scope>:<dir>: <reason>"` for every directory that could not be used. */
  warnings: string[];
}

const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Code-unit order, so output does not move with the machine's locale. */
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = text.slice(3, end).replace(/^\r?\n/, "");
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
    const bytes = await readFile(join(dir, ...rel.split("/")));
    total += bytes.length;
    if (total > MAX_SKILL_BYTES) throw new Error(`more than ${MAX_SKILL_BYTES} bytes`);
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
  const body = await readFile(file);
  if (body.length > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md is larger than 1 MiB");
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
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT") return;
    warnings.push(`${scope}:${rootDir}: ${failure.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(rootDir, entry.name);
    try {
      const read = await readSkill(scope, dir);
      if (skills.has(read.name)) {
        warnings.push(`${scope}:${dir}: duplicate name "${read.name}"`);
        continue;
      }
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
  const shadowed: string[] = [];
  await scanRoot("project", projectDir, skills, warnings);
  const projectNames = new Set(skills.keys());
  const global = new Map<string, DiscoveredSkill>();
  const globalWarnings: string[] = [];
  await scanRoot("global", globalDir, global, globalWarnings);
  warnings.push(...globalWarnings);
  for (const [name, skill] of global) {
    if (projectNames.has(name)) {
      shadowed.push(name);
      continue;
    }
    skills.set(name, skill);
  }
  return {
    skills: [...skills.values()].sort((a, b) => compareCodeUnits(a.name, b.name)),
    shadowed: shadowed.sort(compareCodeUnits),
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

async function replaceDir(staging: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

export class SkillService {
  constructor(private readonly db: Database.Database, private readonly dataDir: string) {}

  private get globalRoot(): string {
    return join(this.dataDir, "skills");
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
    const projectDir = root === undefined ? undefined : join(root, ".noir", "skills");
    const scan = await discoverSkills(this.globalRoot, projectDir);
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
      shadowed: scan.shadowed,
      warnings: scan.warnings,
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
      .prepare(
        "INSERT INTO skills (id, workspace_id, scope, name, dir, hash, manifest_json, enabled) VALUES (?,?,?,?,?,?,?,?) " +
          "ON CONFLICT (workspace_id, scope, name) DO UPDATE SET enabled = excluded.enabled",
      )
      .run(uuidv7(), scope === "global" ? "" : workspaceId, scope, name, "", skill.hash, "{}", enabled ? 1 : 0);
    if (root !== undefined) await this.materialize(workspaceId, root);
  }

  async read(
    workspaceId: string,
    root: string | undefined,
    scope: SkillScope,
    name: string,
  ): Promise<{ content: string; hash: string; truncated: false }> {
    const listed = await this.list(workspaceId, root);
    const skill = listed.skills.find((row) => row.scope === scope && row.name === name);
    if (skill === undefined) throw new RpcFault(ErrorCodes.notFound, `Skill not found: ${name}`);
    const projectDir = root === undefined ? undefined : join(root, ".noir", "skills");
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
   * disabled, so disabling it cannot resurrect the global one. The directory is staged and
   * renamed in; a read-only workspace simply ends up with no materialized skills.
   */
  async materialize(workspaceId: string, root: string): Promise<void> {
    const noir = join(root, ".noir");
    const scan = await discoverSkills(this.globalRoot, join(noir, "skills"));
    const flags = this.readEnabled(workspaceId);
    const target = join(noir, "skills-engine");
    const staging = `${target}.tmp-${randomUUID()}`;
    const manifest: SkillManifest = { version: 1, skills: [] };
    try {
      await mkdir(noir, { recursive: true });
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      for (const skill of scan.skills) {
        if (!this.enabledFor(workspaceId, flags, skill)) continue;
        await copySkill(skill.dir, join(staging, skill.name));
        manifest.skills.push({ name: skill.name, scope: skill.scope, hash: skill.hash, description: skill.description });
      }
      await replaceDir(staging, target);
      await writeJsonAtomically(join(noir, "skills-engine.json"), manifest);
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Scope and hash as materialized for this workspace; absent when nothing was written. */
  async manifestFor(root: string | undefined): Promise<Map<string, { scope: SkillScope; hash: string }>> {
    const merged = new Map<string, { scope: SkillScope; hash: string }>();
    if (root === undefined) return merged;
    try {
      const manifest = JSON.parse(await readFile(join(root, ".noir", "skills-engine.json"), "utf8")) as SkillManifest;
      for (const skill of manifest.skills) merged.set(skill.name, { scope: skill.scope, hash: skill.hash });
    } catch {
      // No manifest means nothing was materialized for this workspace, so nothing is attributed.
    }
    return merged;
  }
}
