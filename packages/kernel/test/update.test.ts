import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { UpdateService, compareVersions, latestTag } from "../src/update.js";

const dirs: string[] = [];
const opened: Database.Database[] = [];
const saved = {
  url: process.env.NOIR_UPDATE_URL,
  git: process.env.NOIR_GIT_COMMAND,
  version: process.env.NOIR_APP_VERSION,
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** A database and data dir pair, the two things the service reads. */
function rig(): { service: UpdateService; dataDir: string } {
  const dataDir = tempDir("noir update data ");
  const db = openDb(join(dataDir, "noir.db"));
  opened.push(db);
  return { service: new UpdateService(db, dataDir), dataDir };
}

/** A bare repository carrying tags, so the channel is exercised without a network. */
function taggedOrigin(): string {
  const work = tempDir("noir update origin ");
  const bare = join(work, "origin.git");
  git(work, "init", "-q", "--bare", bare);
  const seed = join(work, "seed");
  git(work, "init", "-q", seed);
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "T");
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  for (const tag of ["v0.1.9", "v0.2.0", "nightly"]) git(seed, "tag", tag);
  git(seed, "push", "-q", bare, "HEAD:refs/heads/main", "--tags");
  return bare;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["NOIR_UPDATE_URL", saved.url],
    ["NOIR_GIT_COMMAND", saved.git],
    ["NOIR_APP_VERSION", saved.version],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("compareVersions", () => {
  it("compares fields numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("treats a missing field as zero", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("orders a prerelease below its release", () => {
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-alpha", "1.2.3-beta")).toBeLessThan(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3-beta.1")).toBe(0);
  });

  it("cannot order a tag that does not parse", () => {
    expect(compareVersions("nightly", "v1.0.0")).toBe(0);
  });
});

describe("latestTag", () => {
  it("ignores tags that do not parse", () => {
    expect(latestTag(["nightly", "v0.2.0", "v0.1.9"])).toBe("v0.2.0");
    expect(latestTag(["release", "stable"])).toBeNull();
    expect(latestTag([])).toBeNull();
  });

  it("compares numerically across tags", () => {
    expect(latestTag(["v0.9.0", "v0.10.0", "v0.10.0-beta"])).toBe("v0.10.0");
  });
});

describe("UpdateService", () => {
  it("reads the tags once, answers from the cache inside 24 hours, and forces on request", async () => {
    const { service } = rig();
    const origin = taggedOrigin();
    process.env.NOIR_UPDATE_URL = origin;
    process.env.NOIR_APP_VERSION = "0.1.0";

    const first = await service.check(false);
    expect(first).toMatchObject({
      current: "0.1.0",
      latest: "v0.2.0",
      status: "available",
      dismissed: false,
      url: origin,
    });
    expect(first.reason).toBeUndefined();
    expect(first.checkedAt).toBeGreaterThan(0);

    // No git at all now: a check inside the window must answer from the cache without shelling out.
    process.env.NOIR_GIT_COMMAND = join(tempDir("noir update missing "), "no-such-git");
    const cached = await service.check(false);
    expect(cached).toMatchObject({ latest: "v0.2.0", status: "available", checkedAt: first.checkedAt });

    const forced = await service.check(true);
    expect(forced.status).toBe("failed");
    expect(forced.reason).toBeTruthy();
    expect(forced.latest).toBe("v0.2.0");
    expect(forced.checkedAt).toBeGreaterThanOrEqual(first.checkedAt);
  });

  it("records a failure without advancing the answer", async () => {
    const { service } = rig();
    process.env.NOIR_UPDATE_URL = join(tempDir("noir update absent "), "nowhere.git");
    process.env.NOIR_GIT_COMMAND = join(tempDir("noir update nogit "), "no-such-git");
    process.env.NOIR_APP_VERSION = "0.1.0";

    const failed = await service.check(false);
    expect(failed.status).toBe("failed");
    expect(failed.latest).toBeNull();
    expect(failed.reason).toBeTruthy();
    expect(failed.checkedAt).toBeGreaterThan(0);

    // The attempt is recorded, so the next passive check is answered without another attempt.
    const quiet = await service.check(false);
    expect(quiet).toMatchObject({ status: "current", latest: null, checkedAt: failed.checkedAt });
    expect(quiet.reason).toBeUndefined();
  });

  it("reports the running version and acknowledges a dismissal", async () => {
    const { service } = rig();
    process.env.NOIR_UPDATE_URL = taggedOrigin();
    process.env.NOIR_APP_VERSION = "0.1.0";

    expect(service.dismiss("v0.2.0")).toEqual({ ok: true });
    const dismissed = await service.check(false);
    expect(dismissed).toMatchObject({ status: "available", latest: "v0.2.0", dismissed: true });

    // A newer build than the tag is up to date; the dismissal still names v0.2.0, so it stands.
    process.env.NOIR_APP_VERSION = "0.3.0";
    const current = await service.check(false);
    expect(current).toMatchObject({ current: "0.3.0", status: "current", latest: "v0.2.0", dismissed: true });
  });
});
