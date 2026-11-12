import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { ErrorCodes } from "@noir/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/migrations.js";
import { SkillService } from "../src/skills.js";
import { SkillSourceService, fetchSkill, parseGitTarget, parseLocalTarget } from "../src/skillSources.js";
import { git, gitAvailable, plainSkill, serveSmartHttp, skillRepo } from "./smartHttp.js";

/**
 * Fails one `cp` into an `.installing-` temp, so a mid-update filesystem failure is observable
 * without a race. Every other call goes to the real implementation.
 */
const copyGate = vi.hoisted(() => ({
  fail: undefined as (() => void) | undefined,
  reached: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      if (copyGate.fail !== undefined && String(args[1]).includes(".installing-")) {
        copyGate.reached = true;
        copyGate.fail();
      }
      return actual.cp(...args);
    },
  };
});

const root = mkdtempSync(join(tmpdir(), "noir src "));
const realDir = join(root, "real");
mkdirSync(realDir);
const link = join(root, "link");
if (process.platform === "win32") symlinkSync(realDir, link, "junction");
else symlinkSync(realDir, link, "dir");
const file = join(root, "afile");
writeFileSync(file, "plain");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fetch target validation", () => {
  it("accepts https anywhere", () => {
    expect(parseGitTarget("https://example.test/r.git", undefined)).toEqual({
      kind: "git", url: "https://example.test/r.git", ref: undefined,
    });
  });

  it("accepts http only on loopback, comparing the whole hostname", () => {
    for (const url of ["http://127.0.0.1:8080/r.git", "http://localhost/r.git", "http://[::1]/r.git"]) {
      expect(parseGitTarget(url, undefined).kind).toBe("git");
    }
    // A prefix is not a loopback address, and 127.0.0.2 is not on the allowlist.
    for (const url of ["http://127.0.0.1.evil/r.git", "http://localhost.evil/r.git", "http://127.0.0.2/r.git"]) {
      expect(() => parseGitTarget(url, undefined)).toThrow(/not an accepted transport/);
    }
  });

  it("refuses every transport that could execute or prompt", () => {
    for (const url of ["ext::sh -c id", "ssh://git@h/r.git", "git://h/r.git", "file:///c/r.git"]) {
      expect(() => parseGitTarget(url, undefined)).toThrow(/not an accepted transport/);
    }
    // A Windows path parses as protocol "c:", so it must fail as a URL or as a transport.
    expect(() => parseGitTarget(String.raw`C:\tmp\r`, undefined)).toThrow(/not a URL|not an accepted transport/);
  });

  it("refuses credentials in the URL", () => {
    expect(() => parseGitTarget("https://user:tok@h/r.git", undefined)).toThrow(/credentials/);
    expect(() => parseGitTarget("https://user@h/r.git", undefined)).toThrow(/credentials/);
  });

  it("validates ref as an argv-safe token", () => {
    const pinned = parseGitTarget("https://h/r.git", "release/1.2");
    expect(pinned.kind === "git" ? pinned.ref : undefined).toBe("release/1.2");
    for (const ref of ["--upload-pack=id", "a b", "../x", "", "a".repeat(129)]) {
      expect(() => parseGitTarget("https://h/r.git", ref)).toThrow(/invalid ref/i);
    }
  });

  it("accepts an absolute local directory and refuses a link", async () => {
    expect(await parseLocalTarget(realDir)).toEqual({ kind: "local", path: resolve(realDir) });
    await expect(parseLocalTarget(link)).rejects.toThrow(/symlink/);
    await expect(parseLocalTarget(join(root, "missing"))).rejects.toThrow(/not a directory/);
    await expect(parseLocalTarget("relative/path")).rejects.toThrow(/absolute/);
  });

  it("normalizes the path before stat, so a trailing separator cannot smuggle a link", async () => {
    await expect(parseLocalTarget(link + sep)).rejects.toThrow(/symlink/);
    expect(await parseLocalTarget(root + sep)).toEqual({ kind: "local", path: resolve(root) });
  });

  it("reports a path that traverses a file as an invalid parameter, not an internal error", async () => {
    await expect(parseLocalTarget(join(file, "x"))).rejects.toMatchObject({ code: ErrorCodes.invalidParams });
  });
});

const scratch = (): string => mkdtempSync(join(tmpdir(), "noir fetch "));

describe("fetching a skill", () => {
  it.skipIf(!gitAvailable())("clones a git source, pins its commit, and reads the manifest", async () => {
    const work = scratch();
    const repo = join(work, "repo");
    mkdirSync(repo);
    skillRepo(repo, "my-skill", "GIT BODY");
    const bare = join(work, "bare.git");
    git(work, ["clone", "-q", "--bare", repo, bare]);
    const served = await serveSmartHttp(bare);
    try {
      const fetched = await fetchSkill(
        parseGitTarget(served.url, undefined),
        join(work, "staging"),
      );
      expect(fetched.name).toBe("my-skill");
      expect(fetched.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(join(fetched.dir, "SKILL.md"), "utf8")).toContain("GIT BODY");
      expect(fetched.hash).toHaveLength(64);
      await fetched.cleanup();
    } finally {
      await served.close();
    }
  });

  it("copies a local directory without linking to it", async () => {
    const work = scratch();
    const source = join(work, "src");
    plainSkill(source, "local-skill");
    // A working copy's `.git` is skipped, as the git branch deletes it; building it needs no git binary.
    mkdirSync(join(source, ".git"));
    writeFileSync(join(source, ".git", "config"), "");
    const fetched = await fetchSkill(await parseLocalTarget(source), join(work, "staging"));
    expect(fetched.commit).toBeNull();
    expect(fetched.dir.startsWith(source)).toBe(false);
    expect(readdirSync(join(fetched.dir, ".."))).toEqual(["local-skill"]);
    await fetched.cleanup();
    expect(existsSync(fetched.dir)).toBe(false);
  });

  it("refuses a symlink inside a local source and removes the staging copy", async () => {
    const work = scratch();
    const source = join(work, "src");
    plainSkill(source, "linked");
    const skill = join(source, "linked");
    const outside = join(work, "outside");
    mkdirSync(outside);
    // A link inside the tree would stage bytes the recorded hash cannot cover.
    if (process.platform === "win32") symlinkSync(outside, join(skill, "escape"), "junction");
    else symlinkSync(outside, join(skill, "escape"), "dir");
    await expect(fetchSkill(await parseLocalTarget(source), join(work, "staging"))).rejects.toThrow(
      /contains a symbolic link: linked[\\/]escape/,
    );
    expect(existsSync(join(work, "staging")) ? readdirSync(join(work, "staging")) : []).toEqual([]);
  });

  it("refuses a source over the file cap and removes the staging copy", async () => {
    const work = scratch();
    const source = join(work, "src");
    plainSkill(source, "big");
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(source, "big", `f${index}.txt`), "x");
    }
    await expect(fetchSkill(await parseLocalTarget(source), join(work, "staging"))).rejects.toThrow(/more than 200 files/);
    expect(existsSync(join(work, "staging")) ? readdirSync(join(work, "staging")) : []).toEqual([]);
  });

  it("refuses a source over the staging cap and removes the staging copy", async () => {
    const work = scratch();
    const source = join(work, "src");
    plainSkill(source, "skill");
    const junk = join(source, "junk");
    mkdirSync(junk);
    // 2001 files take seconds to create on Windows, longer than the default test timeout.
    for (let index = 0; index < 2001; index += 1) {
      writeFileSync(join(junk, `f${index}.txt`), "x");
    }
    await expect(fetchSkill(await parseLocalTarget(source), join(work, "staging"))).rejects.toThrow(/more than 2000 files/);
    expect(existsSync(join(work, "staging")) ? readdirSync(join(work, "staging")) : []).toEqual([]);
  }, 30_000);

  it("fetches a local source without a git binary at all", async () => {
    const work = scratch();
    const source = join(work, "src");
    plainSkill(source, "gitless");
    process.env.NOIR_GIT_COMMAND = join(work, "no-such-git");
    try {
      const fetched = await fetchSkill(await parseLocalTarget(source), join(work, "staging"));
      expect(fetched.name).toBe("gitless");
      await fetched.cleanup();
    } finally {
      delete process.env.NOIR_GIT_COMMAND;
    }
  });
});

it("refuses ext:: without starting any process", async () => {
  const work = mkdtempSync(join(tmpdir(), "noir ext "));
  // git writes this trace as it starts, even when it then refuses the transport. A `.cmd` fake
  // cannot stand in for it: Node refuses to spawn one without a shell, so the marker would never
  // appear and the test could not fail.
  const marker = join(work, "git-trace");
  process.env.GIT_TRACE = marker;
  try {
    // The guard throws while parsing, before fetchSkill can reach execFile, so git never starts.
    const dangerous = async (): Promise<void> => {
      await fetchSkill(parseGitTarget("ext::sh -c touch", undefined), join(work, "staging"));
    };
    await expect(dangerous()).rejects.toThrow(/not an accepted transport/);
  } finally {
    delete process.env.GIT_TRACE;
  }
  expect(existsSync(marker)).toBe(false);
});

function service(): { db: Database.Database; service: SkillService; dataDir: string } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const dataDir = scratch();
  return { db, service: new SkillService(db, dataDir), dataDir };
}

describe("skill sources", () => {
  it("installs into the scope root and records provenance", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "installed");
    const workspace = join(work, "ws");
    mkdirSync(workspace);

    await sources.install("ws-1", workspace, "project", "local", source, undefined);

    expect(existsSync(join(workspace, ".noir", "skills", "installed", "SKILL.md"))).toBe(true);
    const listed = await skills.list("ws-1", workspace);
    expect(listed.skills.map((s) => [s.name, s.scope])).toEqual([["installed", "project"]]);
    const record = sources.sourcesFor("ws-1").get("project|installed");
    expect(record?.kind).toBe("local");
    // Install refuses a second copy of the same name in the same scope.
    await expect(sources.install("ws-1", workspace, "project", "local", source, undefined)).rejects.toThrow(/already installed/);
  });

  it("installs the same name into the other scope, and it shadows", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const first = join(work, "a");
    const second = join(work, "b");
    mkdirSync(first);
    mkdirSync(second);
    plainSkill(first, "dup", "GLOBAL");
    plainSkill(second, "dup", "PROJECT");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    await sources.install("ws-1", workspace, "global", "local", first, undefined);
    await sources.install("ws-1", workspace, "project", "local", second, undefined);
    const listed = await skills.list("ws-1", workspace);
    expect(listed.skills.map((s) => [s.scope, s.name])).toEqual([["project", "dup"]]);
    // The global copy is the shadowed one: the project skill wins the name.
    expect(listed.shadowed).toEqual(["dup"]);
  });

  it("leaves no partial directory when an install cannot place the files", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "partial");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    copyGate.fail = () => {
      throw new Error("simulated write failure");
    };
    try {
      await expect(sources.install("ws-1", workspace, "project", "local", source, undefined)).rejects.toThrow(/simulated write failure/);
    } finally {
      copyGate.fail = undefined;
    }
    expect(readdirSync(join(workspace, ".noir", "skills"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill_sources").get()).toEqual({ n: 0 });
    expect((await skills.list("ws-1", workspace)).skills).toEqual([]);
  });

  it("refuses an update whose fetched hash is not the one shown, and changes nothing", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "pinned", "ONE");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    const installed = await sources.install("ws-1", workspace, "project", "local", source, undefined);
    const rowHash = db.prepare("SELECT hash FROM skill_sources WHERE name = ?").pluck();

    writeFileSync(join(source, "pinned", "SKILL.md"), "---\nname: pinned\ndescription: d\n---\n\nTWO\n");
    const before = readFileSync(join(workspace, ".noir", "skills", "pinned", "SKILL.md"), "utf8");

    await expect(sources.update("ws-1", workspace, "project", "pinned", installed.hash)).rejects.toThrow(/changed since it was shown/);
    expect(readFileSync(join(workspace, ".noir", "skills", "pinned", "SKILL.md"), "utf8")).toBe(before);
    expect(rowHash.get("pinned")).toBe(installed.hash);

    const checked = await sources.checkUpdate("ws-1", "project", "pinned");
    expect(checked.changed).toBe(true);
    await sources.update("ws-1", workspace, "project", "pinned", checked.hash);
    expect(readFileSync(join(workspace, ".noir", "skills", "pinned", "SKILL.md"), "utf8")).toContain("TWO");
    expect(rowHash.get("pinned")).toBe(checked.hash);
  });

  it("restores the previous copy when the new one cannot be placed", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "restored", "ONE");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    const installed = await sources.install("ws-1", workspace, "project", "local", source, undefined);
    writeFileSync(join(source, "restored", "SKILL.md"), "---\nname: restored\ndescription: d\n---\n\nTWO\n");
    const checked = await sources.checkUpdate("ws-1", "project", "restored");
    const skillsRoot = join(workspace, ".noir", "skills");
    const destination = join(skillsRoot, "restored");
    // What the failure saw: the old copy already moved aside, the destination free.
    const during = { destinationExisted: true, asidePresent: false };
    copyGate.reached = false;
    copyGate.fail = () => {
      during.destinationExisted = existsSync(destination);
      during.asidePresent = readdirSync(skillsRoot).some((name) => name.startsWith("restored.previous-"));
      throw new Error("simulated write failure");
    };
    try {
      await expect(sources.update("ws-1", workspace, "project", "restored", checked.hash)).rejects.toThrow(/simulated write failure/);
    } finally {
      copyGate.fail = undefined;
    }

    expect(copyGate.reached).toBe(true);
    expect(during).toEqual({ destinationExisted: false, asidePresent: true });
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("ONE");
    expect(readdirSync(skillsRoot).filter((name) => name.includes(".installing-") || name.includes(".previous-"))).toEqual([]);
    expect(db.prepare("SELECT hash FROM skill_sources WHERE name = ?").pluck().get("restored")).toBe(installed.hash);
    expect(readFileSync(join(workspace, ".noir", "skills-engine", "restored", "SKILL.md"), "utf8")).toContain("ONE");
  });

  it("checkUpdate writes nothing", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "steady");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    await sources.install("ws-1", workspace, "project", "local", source, undefined);
    const before = readFileSync(join(workspace, ".noir", "skills", "steady", "SKILL.md"), "utf8");
    const rows = db.prepare("SELECT hash FROM skill_sources").all();
    const checked = await sources.checkUpdate("ws-1", "project", "steady");
    expect(checked.changed).toBe(false);
    expect(readFileSync(join(workspace, ".noir", "skills", "steady", "SKILL.md"), "utf8")).toBe(before);
    expect(db.prepare("SELECT hash FROM skill_sources").all()).toEqual(rows);
  });

  it("removes the directory, the row, and the engine copy", async () => {
    const { db, service: skills, dataDir } = service();
    const sources = new SkillSourceService(db, skills, dataDir);
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(source);
    plainSkill(source, "gone");
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    await sources.install("ws-1", workspace, "project", "local", source, undefined);
    expect(existsSync(join(workspace, ".noir", "skills-engine", "gone"))).toBe(true);

    await sources.remove("ws-1", workspace, "project", "gone");
    expect(existsSync(join(workspace, ".noir", "skills", "gone"))).toBe(false);
    expect(existsSync(join(workspace, ".noir", "skills-engine", "gone"))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill_sources").get()).toEqual({ n: 0 });
    expect((await skills.list("ws-1", workspace)).skills).toEqual([]);
  });

  it("refuses a skill name that could escape the root", async () => {
    const work = scratch();
    const source = join(work, "src");
    mkdirSync(join(source, "evil"), { recursive: true });
    writeFileSync(join(source, "evil", "SKILL.md"), "---\nname: ../../escape\ndescription: d\n---\n\nX\n");
    await expect(fetchSkill(await parseLocalTarget(source), join(work, "staging"))).rejects.toThrow(/not a valid skill name/);
    expect(existsSync(join(work, "escape"))).toBe(false);
  });
});
