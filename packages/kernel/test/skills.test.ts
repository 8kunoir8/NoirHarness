import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** A directory link that also works without the Windows developer-mode privilege. */
function linkDirectory(target: string, path: string): void {
  if (process.platform === "win32") symlinkSync(target, path, "junction");
  else symlinkSync(target, path, "dir");
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
    // A shadowed entry carries its directory, because the directory name need not match the name.
    expect(scan.shadowed.map((entry) => [entry.name, entry.dir])).toEqual([["shared", join(global, "shared")]]);
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

  it("refuses a skill with more than 8 MiB of content", async () => {
    const global = root();
    const dir = skill(global, "heavy", "d");
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(join(dir, `part-${index}.bin`), Buffer.alloc(1024 * 1024, 120));
    }
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills).toEqual([]);
    expect(scan.warnings.join("\n")).toContain("heavy");
    expect(scan.warnings.join("\n")).toContain("more than");
  });

  it("warns about a symlinked root and does not scan it", async (context) => {
    const outside = root();
    skill(outside, "outside", "outside");
    const project = root();
    mkdirSync(join(project, ".noir"), { recursive: true });
    try {
      linkDirectory(outside, join(project, ".noir", "skills"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    const scan = await discoverSkills(join(project, "missing-global"), join(project, ".noir", "skills"));
    expect(scan.skills).toEqual([]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain("symlink");
  });

  const windowsOnly = process.platform === "win32" ? it : it.skip;
  windowsOnly("treats case-only names as duplicates on Windows", async () => {
    const global = root();
    const first = skill(global, "first", "one");
    writeFileSync(join(first, "SKILL.md"), "---\nname: dup\ndescription: one\n---\n");
    const second = skill(global, "second", "two");
    writeFileSync(join(second, "SKILL.md"), "---\nname: DUP\ndescription: two\n---\n");
    const scan = await discoverSkills(global, undefined);
    expect(scan.skills.map((s) => s.name)).toEqual(["dup"]);
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toContain('duplicate name "DUP"');
  });

  windowsOnly("drops a global skill that differs only by case from a project skill", async () => {
    const global = root();
    const upper = skill(global, "upper", "global");
    writeFileSync(join(upper, "SKILL.md"), "---\nname: DUP\ndescription: global\n---\n");
    const project = root();
    const lower = skill(project, "lower", "project");
    writeFileSync(join(lower, "SKILL.md"), "---\nname: dup\ndescription: project\n---\n");
    const scan = await discoverSkills(global, project);
    expect(scan.skills.map((s) => [s.name, s.scope])).toEqual([["dup", "project"]]);
    expect(scan.shadowed.map((entry) => [entry.name, entry.dir])).toEqual([["DUP", upper]]);
    expect(scan.warnings.join("\n")).toContain("differs only by case");
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
    writeFileSync(join(project, ".noir", "skills-engine", "notes.txt"), "keep me");
    mkdirSync(join(project, ".noir", "skills-engine", "user-dir"), { recursive: true });
    writeFileSync(join(project, ".noir", "skills-engine", "user-dir", "keep.txt"), "keep me too");
    rmSync(join(project, ".noir", "skills"), { recursive: true, force: true });
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    expect(existsSync(join(project, ".noir", "skills-engine", "p"))).toBe(false);
    expect(readFileSync(join(project, ".noir", "skills-engine", "notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(project, ".noir", "skills-engine", "user-dir", "keep.txt"), "utf8")).toBe("keep me too");
  });

  it("propagates a materialize failure when the engine root is not a directory", async () => {
    const { service: s } = service();
    const project = root();
    skill(projectSkills(project), "p", "project");
    await s.list("ws-1", project);
    const engine = join(project, ".noir", "skills-engine");
    writeFileSync(engine, "not a directory");
    try {
      await expect(s.materialize("ws-1", project)).rejects.toThrow();
    } finally {
      rmSync(engine, { force: true });
    }
  });

  it("replaces a materialized skill in place", async () => {
    const { service: s } = service();
    const project = root();
    const source = skill(projectSkills(project), "p", "first");
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    writeFileSync(join(source, "SKILL.md"), "---\nname: p\ndescription: second\n---\n");
    await s.list("ws-1", project);
    await s.materialize("ws-1", project);
    const engine = join(project, ".noir", "skills-engine");
    expect(readFileSync(join(engine, "p", "SKILL.md"), "utf8")).toContain("description: second");
    expect(readdirSync(engine).filter((name) => name.startsWith(".tmp-") || name.startsWith(".old-"))).toEqual([]);
  });

  it("refuses to materialize through a symlinked engine root", async (context) => {
    const { service: s } = service();
    const project = root();
    skill(projectSkills(project), "p", "project");
    const outside = root();
    try {
      linkDirectory(outside, join(project, ".noir", "skills-engine"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    await expect(s.materialize("ws-1", project)).rejects.toThrow(/symlink/i);
    expect(existsSync(join(outside, "p"))).toBe(false);
  });

  it("ignores a symlinked manifest", async (context) => {
    const { service: s } = service();
    const project = root();
    const outside = root();
    const manifest = join(outside, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        skills: [{ name: "hidden", scope: "project", hash: "h".repeat(64), description: "outside" }],
      } satisfies SkillManifest),
    );
    mkdirSync(join(project, ".noir"), { recursive: true });
    try {
      symlinkSync(manifest, join(project, ".noir", "skills-engine.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    expect([...(await s.manifestFor(project)).keys()]).toEqual([]);
  });

  it("refuses to scan or read through a symlinked .noir", async (context) => {
    const { service: s } = service();
    const project = root();
    const outside = root();
    skill(outside, "leaked", "outside");
    writeFileSync(
      join(outside, "skills-engine.json"),
      JSON.stringify({
        version: 1,
        skills: [{ name: "hidden", scope: "project", hash: "h".repeat(64), description: "outside" }],
      } satisfies SkillManifest),
    );
    try {
      linkDirectory(outside, join(project, ".noir"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    const listed = await s.list("ws-1", project);
    expect(listed.skills).toEqual([]);
    expect(listed.warnings.join("\n")).toContain(".noir is not a directory");
    await expect(s.read("ws-1", project, "project", "leaked")).rejects.toThrow(/not found/i);
    expect([...(await s.manifestFor(project)).keys()]).toEqual([]);
  });

  it("materializes through a symlinked workspace root", async (context) => {
    const { service: s } = service();
    const real = root();
    skill(projectSkills(real), "p", "project");
    const link = join(root(), "workspace-link");
    try {
      linkDirectory(real, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    await s.materialize("ws-1", link);
    expect(readFileSync(join(real, ".noir", "skills-engine", "p", "SKILL.md"), "utf8")).toContain("description: project");
  });

  it("rejects materialize for a removed workspace without recreating it", async () => {
    const { service: s } = service();
    const project = root();
    skill(projectSkills(project), "p", "project");
    await s.list("ws-1", project);
    rmSync(project, { recursive: true, force: true });
    await expect(s.materialize("ws-1", project)).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(project)).toBe(false);
  });
});

describe("skill sources table", () => {
  it("stores one provenance row per workspace, scope and name", () => {
    const { db } = service();
    const insert = db.prepare(
      "INSERT INTO skill_sources (id, workspace_id, scope, name, kind, url, ref, commit_sha, hash, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run("a", "", "global", "shared", "git", "https://e.test/r.git", "main", "abc", "h1", 1);
    insert.run("b", "ws-1", "project", "shared", "local", "/tmp/shared", null, null, "h2", 2);
    const rows = db.prepare("SELECT workspace_id, scope, name FROM skill_sources ORDER BY id").all();
    expect(rows).toEqual([
      { workspace_id: "", scope: "global", name: "shared" },
      { workspace_id: "ws-1", scope: "project", name: "shared" },
    ]);
    // The same triple twice is the same skill's provenance, not a second row.
    expect(() =>
      insert.run("c", "", "global", "shared", "git", "https://e.test/r.git", "main", "def", "h3", 3),
    ).toThrow(/UNIQUE/);
  });
});
