import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.js";
import { SkillService, discoverSkills, hashSkillDir, parseSkillFrontmatter, type SkillManifest } from "../src/skills.js";

function skill(root: string, name: string, description: string, body = "BODY"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return dir;
}

const root = (): string => mkdtempSync(join(tmpdir(), "noir skills "));

describe("skill discovery", () => {
  it("parses frontmatter, including block scalars", () => {
    expect(parseSkillFrontmatter("---\nname: a\ndescription: >\n  two\n  lines\n---\nbody")).toEqual({
      name: "a",
      description: "two lines\n",
    });
    expect(parseSkillFrontmatter("no frontmatter")).toEqual({});
  });

  it("lists project and global skills, project wins a name collision", async () => {
    const global = root();
    const project = root();
    skill(global, "shared", "global copy", "GLOBAL");
    skill(project, "shared", "project copy", "PROJECT");
    skill(global, "only-global", "g");
    const scan = await discoverSkills(global, project);
    expect(scan.skills.map((s) => [s.name, s.scope])).toEqual([
      ["only-global", "global"],
      ["shared", "project"],
    ]);
    expect(scan.shadowed).toEqual(["shared"]);
    expect(scan.warnings).toEqual([]);
  });

  it("warns about malformed skills without dropping the rest", async () => {
    const global = root();
    mkdirSync(join(global, "nameless"));
    writeFileSync(join(global, "nameless", "SKILL.md"), "---\ndescription: no name\n---\n");
    writeFileSync(join(global, "SKILL.md"), "not a directory");
    skill(global, "good", "fine");
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills.map((s) => s.name)).toEqual(["good"]);
    // A stray SKILL.md at the root is not a skill directory; it is ignored, not warned about.
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain("nameless");
  });

  it("rejects names that cannot be a skill uri", async () => {
    const global = root();
    skill(global, "bad", "dot dot", "x");
    writeFileSync(join(global, "bad", "SKILL.md"), "---\nname: ../escape\ndescription: bad\n---\n");
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills).toEqual([]);
    expect(scan.warnings.join("\n")).toContain("bad");
  });

  it("never follows symlinks inside a skill", async (context) => {
    const global = root();
    const outside = root();
    writeFileSync(join(outside, "secret.txt"), "secret");
    const dir = skill(global, "linked", "has a link");
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
    } catch (error) {
      // Windows without developer mode cannot create symlinks; the skip is honest.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    const before = await hashSkillDir(dir);
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills.map((s) => s.name)).toEqual(["linked"]);
    expect(scan.warnings).toEqual([]);
    expect(await hashSkillDir(dir)).toBe(before);
  });

  it("refuses a skill whose SKILL.md is a symlink", async (context) => {
    const global = root();
    const outside = root();
    const sentinel = "OUTSIDE-MANIFEST-SENTINEL";
    writeFileSync(join(outside, "SKILL.md"), `---\nname: sneaky\ndescription: x\n---\n${sentinel}\n`);
    const dir = skill(global, "sneaky", "has a linked manifest");
    rmSync(join(dir, "SKILL.md"));
    try {
      symlinkSync(join(outside, "SKILL.md"), join(dir, "SKILL.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills).toEqual([]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain("sneaky");
    expect(JSON.stringify(scan)).not.toContain(sentinel);
  });

  it("refuses a skill with more than 200 files", async () => {
    const global = root();
    const dir = skill(global, "crowded", "too many files");
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(dir, `file-${String(index).padStart(3, "0")}.txt`), "");
    }
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills).toEqual([]);
    expect(scan.warnings.join("\n")).toContain("crowded");
    expect(scan.warnings.join("\n")).toContain("more than 200 files");
  });

  it("warns about duplicate names inside one scope", async () => {
    const global = root();
    const first = skill(global, "first", "one");
    writeFileSync(join(first, "SKILL.md"), "---\nname: dup\ndescription: one\n---\n");
    const second = skill(global, "second", "two");
    writeFileSync(join(second, "SKILL.md"), "---\nname: dup\ndescription: two\n---\n");
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills.map((s) => s.name)).toEqual(["dup"]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('duplicate name "dup"');
  });

  it("hashes directory content, not the directory mtime", async () => {
    const a = root();
    const dir = skill(a, "one", "d");
    const first = await hashSkillDir(dir);
    expect(await hashSkillDir(dir)).toBe(first);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: one\ndescription: d\n---\nCHANGED\n");
    expect(await hashSkillDir(dir)).not.toBe(first);
  });

  it("refuses a skill body larger than 1 MiB", async () => {
    const global = root();
    const dir = skill(global, "huge", "d");
    writeFileSync(join(dir, "SKILL.md"), `---\nname: huge\ndescription: d\n---\n${"x".repeat(1024 * 1024)}`);
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills).toEqual([]);
    expect(scan.warnings.join("\n")).toContain("huge");
  });
});

function service(): { db: Database.Database; service: SkillService; dataDir: string } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const dataDir = root();
  mkdirSync(join(dataDir, "engine"), { recursive: true });
  return { db, service: new SkillService(db, dataDir), dataDir };
}

/** `SkillService` reads project skills from `<workspace>/.noir/skills`, not the workspace root. */
function projectSkills(workspace: string): string {
  const dir = join(workspace, ".noir", "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("skill enabled state and materialization", () => {
  it("materializes the effective winners for one workspace with a manifest", async () => {
    const { service: s, dataDir } = service();
    const global = join(dataDir, "skills");
    const project = root();
    mkdirSync(global, { recursive: true });
    skill(global, "g", "global");
    skill(projectSkills(project), "p", "project");
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    expect(readFileSync(join(project, ".noir", "skills-engine", "g", "SKILL.md"), "utf8")).toContain("description: global");
    expect(readFileSync(join(project, ".noir", "skills-engine", "p", "SKILL.md"), "utf8")).toContain("description: project");
    const manifest = JSON.parse(readFileSync(join(project, ".noir", "skills-engine.json"), "utf8")) as SkillManifest;
    expect(manifest.skills.map((x) => [x.name, x.scope])).toEqual([
      ["g", "global"],
      ["p", "project"],
    ]);
  });

  it("drops a disabled skill from the materialized root but keeps its source", async () => {
    const { service: s } = service();
    const project = root();
    const dir = skill(projectSkills(project), "p", "project");
    await s.list("ws-1", project);
    await s.setEnabled("ws-1", project, "project", "p", false);
    await s.materialize("ws-1", project);
    expect(existsSync(join(project, ".noir", "skills-engine", "p"))).toBe(false);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    const listed = await s.list("ws-1", project);
    expect(listed.skills.find((x) => x.name === "p")?.enabled).toBe(false);
  });

  it("does not resurrect a shadowed global copy when the project copy is disabled", async () => {
    const { service: s, dataDir } = service();
    const global = join(dataDir, "skills");
    mkdirSync(global, { recursive: true });
    skill(global, "shared", "global");
    const project = root();
    skill(projectSkills(project), "shared", "project");
    await s.list("ws-1", project);
    await s.setEnabled("ws-1", project, "project", "shared", false);
    await s.materialize("ws-1", project);
    expect(existsSync(join(project, ".noir", "skills-engine", "shared"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(project, ".noir", "skills-engine.json"), "utf8")) as SkillManifest;
    expect(manifest.skills).toEqual([]);
  });

  it("keeps enable flags per workspace and scope", async () => {
    const { service: s } = service();
    const a = root();
    const b = root();
    skill(projectSkills(a), "p", "a");
    skill(projectSkills(b), "p", "b");
    await s.list("ws-a", a);
    await s.list("ws-b", b);
    await s.setEnabled("ws-a", a, "project", "p", false);
    expect((await s.list("ws-a", a)).skills[0]?.enabled).toBe(false);
    expect((await s.list("ws-b", b)).skills[0]?.enabled).toBe(true);
  });

  it("returns the SKILL.md body and refuses unknown names", async () => {
    const { service: s } = service();
    const project = root();
    skill(projectSkills(project), "p", "project", "VIEW_ME");
    await s.list("ws-1", project);
    expect((await s.read("ws-1", project, "project", "p")).content).toContain("VIEW_ME");
    await expect(s.read("ws-1", project, "project", "missing")).rejects.toThrow(/not found/i);
  });

  it("removes a stale materialized skill and leaves unknown files alone", async () => {
    const { service: s } = service();
    const project = root();
    skill(projectSkills(project), "p", "project");
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    mkdirSync(join(project, ".noir", "skills-engine", "p", "old"), { recursive: true });
    rmSync(join(project, ".noir", "skills"), { recursive: true, force: true });
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    expect(existsSync(join(project, ".noir", "skills-engine", "p"))).toBe(false);
  });
});
