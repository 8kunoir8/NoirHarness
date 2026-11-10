import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, hashSkillDir, parseSkillFrontmatter } from "../src/skills.js";

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
