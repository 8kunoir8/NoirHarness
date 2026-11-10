import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
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
  if (files.length > MAX_SKILL_FILES) throw new Error(`more than ${MAX_SKILL_FILES} files`);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // A symlink inside a skill could point outside the workspace; skip it rather than follow.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await listFiles(absolute, rel, files);
    else if (entry.isFile()) files.push(rel);
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
    hash.update(rel.replaceAll(sep, "/"));
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function readSkill(scope: SkillScope, dir: string): Promise<{ name: string; description: string; hash: string }> {
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error("not a directory");
  const body = await readFile(join(dir, "SKILL.md"));
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
  const entries = await readdir(rootDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(rootDir, entry.name);
    try {
      const read = await readSkill(scope, dir);
      if (!skills.has(read.name)) skills.set(read.name, { scope, dir, ...read });
    } catch (error) {
      warnings.push(`${scope}:${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
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
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    shadowed: shadowed.sort(),
    warnings: warnings.sort(),
  };
}
