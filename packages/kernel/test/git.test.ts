import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ErrorCodes } from "@noir/protocol";
import { gitCommit, gitStage, gitStatus, gitUnstage } from "../src/gitService.js";
import type { Kernel } from "../src/index.js";
import { startKernel } from "./support.js";

const dirs: string[] = [];
const kernels: Kernel[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir git "));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function call(kernel: Kernel, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${kernel.port}/?token=${kernel.token}`);
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const [data] = await reply;
  ws.close();
  const envelope = JSON.parse(String(data));
  if (envelope.error !== undefined) {
    throw Object.assign(new Error(`${method}: ${envelope.error.message}`), { code: envelope.error.code });
  }
  expect(envelope.result).toBeDefined();
  return envelope;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function initRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
}

async function setupWorkspace(root: string): Promise<{ kernel: Kernel; workspaceId: string }> {
  const kernel = await startKernel({ dataDir: tempDir() });
  kernels.push(kernel);
  const project = await call(kernel, "project.add", { path: root });
  const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
  return { kernel, workspaceId: workspace.result.id };
}

async function setupRepo(): Promise<{ kernel: Kernel; workspaceId: string; root: string }> {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "gone\n");
  initRepo(root);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");

  const { kernel, workspaceId } = await setupWorkspace(root);
  return { kernel, workspaceId, root };
}

describe("git.* RPCs", () => {
  it("reports modified, created and deleted files with line counts", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "c.txt"), "new\nb\n");
    unlinkSync(join(root, "b.txt"));

    const status = await call(kernel, "git.status", { workspaceId });
    const files = status.result.files as Array<{ path: string; change: string; add: number; del: number }>;
    expect(status.result.isRepo).toBe(true);
    expect(status.result.branch).not.toBe("");
    expect(files.find((file) => file.path === "a.txt")).toEqual({
      path: "a.txt",
      change: "modified",
      add: 1,
      del: 0,
      index: null,
      worktree: "modified",
    });
    expect(files.find((file) => file.path === "c.txt")).toEqual({
      path: "c.txt",
      change: "created",
      add: 2,
      del: 0,
      index: null,
      worktree: "created",
    });
    expect(files.find((file) => file.path === "b.txt")).toEqual({
      path: "b.txt",
      change: "deleted",
      add: 0,
      del: 1,
      index: null,
      worktree: "deleted",
    });
  });

  it("returns a unified diff for a tracked change and a synthetic one for a new file", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "c.txt"), "new\n");

    const tracked = await call(kernel, "git.diff", { workspaceId, path: "a.txt" });
    expect(tracked.result.diff).toContain("+++ b/a.txt");
    expect(tracked.result.diff).toContain("+two");

    const created = await call(kernel, "git.diff", { workspaceId, path: "c.txt" });
    expect(created.result.diff).toContain("+new");
  });

  it("reports a non-repository workspace instead of failing", async () => {
    const root = tempDir();
    writeFileSync(join(root, "x.txt"), "x");
    const { kernel, workspaceId } = await setupWorkspace(root);
    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result).toEqual({ isRepo: false, branch: null, ahead: 0, behind: 0, files: [] });
  });

  it("reports only paths inside a workspace nested in a repository", async () => {
    const repo = tempDir();
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "tracked.txt"), "one\n");
    writeFileSync(join(repo, "outside.txt"), "out\n");
    initRepo(repo);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    const { kernel, workspaceId } = await setupWorkspace(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "outside.txt"), "out\nmore\n");

    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result.files).toEqual([
      { path: "tracked.txt", change: "modified", add: 1, del: 0, index: null, worktree: "modified" },
    ]);

    const diff = await call(kernel, "git.diff", { workspaceId, path: "tracked.txt" });
    expect(diff.result.diff).toContain("+two");

    await expect(call(kernel, "git.diff", { workspaceId, path: "../outside.txt" })).rejects.toThrow(
      /Path must not contain/,
    );
  });

  it("lists untracked files in a repository with no commit yet", async () => {
    const root = tempDir();
    initRepo(root);
    writeFileSync(join(root, "fresh.txt"), "a\n\nb\n");
    const { kernel, workspaceId } = await setupWorkspace(root);

    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result.isRepo).toBe(true);
    expect(status.result.branch).toBeNull();
    expect(status.result.files).toEqual([
      { path: "fresh.txt", change: "created", add: 3, del: 0, index: null, worktree: "created" },
    ]);
  });

  it("caps the read of a huge untracked file and says so in its patch", async () => {
    const root = tempDir();
    initRepo(root);
    const cap = 2 * 1024 * 1024;
    // The first line fills the whole cap, so a capped head is one line while the file has two.
    writeFileSync(join(root, "big.log"), `${"a".repeat(cap)}\n${"b".repeat(1_000)}\n`);
    const { kernel, workspaceId } = await setupWorkspace(root);

    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result.files).toEqual([
      { path: "big.log", change: "created", add: 1, del: 0, index: null, worktree: "created" },
    ]);

    const diff = await call(kernel, "git.diff", { workspaceId, path: "big.log" });
    expect(diff.result.diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff.result.diff.endsWith("+[truncated: file is larger than 2 MiB]\n")).toBe(true);
    expect(diff.result.diff).not.toContain("b".repeat(1_000));
    expect(diff.result.diff.length).toBeLessThan(cap + 4_096);
  });

  it("returns a deletion patch for a staged deletion", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    git(root, "rm", "-q", "b.txt");

    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result.files.find((file: { path: string }) => file.path === "b.txt")).toEqual({
      path: "b.txt",
      change: "deleted",
      add: 0,
      del: 1,
      index: "deleted",
      worktree: null,
    });

    const diff = await call(kernel, "git.diff", { workspaceId, path: "b.txt" });
    expect(diff.result.diff).toContain("-gone");
  });

  it("reports a staged rename once at its destination", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    git(root, "mv", "a.txt", "renamed.txt");

    const status = await call(kernel, "git.status", { workspaceId });
    const files = status.result.files as Array<{ path: string; change: string; add: number; del: number }>;
    expect(files.filter((file) => file.path === "renamed.txt")).toEqual([
      { path: "renamed.txt", change: "modified", add: 0, del: 0, index: "modified", worktree: null },
    ]);
    expect(files.find((file) => file.path === "a.txt")).toBeUndefined();
    expect(files.filter((file) => file.path === "renamed.txt")).toHaveLength(1);
  });

  it("hides the app's own .noir directory from status", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    mkdirSync(join(root, ".noir", "skills-engine", "p"), { recursive: true });
    writeFileSync(join(root, ".noir", "skills-engine.json"), "{}");
    writeFileSync(join(root, ".noir", "skills-engine", "p", "SKILL.md"), "materialized");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");

    const status = await call(kernel, "git.status", { workspaceId });
    const paths = (status.result.files as Array<{ path: string }>).map((file) => file.path);
    expect(paths).toContain("a.txt");
    expect(paths.some((path) => path === ".noir" || path.startsWith(".noir/"))).toBe(false);
  });
});

/** A repository with one commit, no kernel: the mutation tests exercise the service itself. */
function committedRepo(): string {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "gone\n");
  initRepo(root);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

function gitText(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

describe("git mutations", () => {
  it("stages one path and reports both sides of a file that is staged and modified", async () => {
    const root = committedRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");

    const staged = await gitStage(root, ["a.txt"]);
    const row = staged.files.find((file) => file.path === "a.txt");
    expect(row?.index).toBe("modified");
    expect(row?.worktree).toBeNull();

    // Edited after staging: one row, both sides non-null.
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const both = await gitStatus(root);
    const combined = both.files.find((file) => file.path === "a.txt");
    expect(combined?.index).toBe("modified");
    expect(combined?.worktree).toBe("modified");
    expect(both.files.filter((file) => file.path === "a.txt")).toHaveLength(1);
    expect(both.ahead).toBe(0);
    expect(both.behind).toBe(0);
  });

  it("unstages on a repository with no commit yet", async () => {
    const root = tempDir();
    initRepo(root);
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", "a.txt");

    const after = await gitUnstage(root, ["a.txt"]);
    const row = after.files.find((file) => file.path === "a.txt");
    expect(row?.index).toBeNull();
    expect(row?.worktree).toBe("created");
    expect(gitText(root, "ls-files")).toBe("");
  });

  it("refuses an empty message and a clean index", async () => {
    const root = committedRepo();

    await expect(gitCommit(root, "   ")).rejects.toThrow(/commit message/i);
    const empty = await gitCommit(root, "wip").catch((error: unknown) => error);
    expect(empty).toMatchObject({ code: ErrorCodes.conflict, message: "Nothing staged to commit" });
  });

  it("commits what is staged and leaves the rest alone", async () => {
    const root = committedRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    git(root, "add", "a.txt");
    writeFileSync(join(root, "b.txt"), "gone\nmore\n");

    const result = await gitCommit(root, "  feat: one  ");
    expect(result.summary).toBe("feat: one");
    expect(result.sha).toBe(gitText(root, "rev-parse", "HEAD"));
    expect(gitText(root, "log", "-1", "--pretty=%s")).toBe("feat: one");

    const b = result.status.files.find((file) => file.path === "b.txt");
    expect(b?.index).toBeNull();
    expect(b?.worktree).toBe("modified");
    expect(result.status.files.some((file) => file.path === "a.txt")).toBe(false);
  });

  it("serializes two commits fired together on one workspace", async () => {
    const root = committedRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    git(root, "add", "a.txt");
    const before = Number(gitText(root, "rev-list", "--count", "HEAD"));

    const first = gitCommit(root, "first");
    const second = gitCommit(root, "second");
    const done = await first;
    // The second waited for the first, so it judges the index the first left behind and refuses.
    await expect(second).rejects.toThrow(/Nothing staged to commit/);
    expect(done.summary).toBe("first");
    expect(Number(gitText(root, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(gitText(root, "log", "-1", "--pretty=%s")).toBe("first");
  });

  it("reports ahead and behind against a real upstream", async () => {
    const work = tempDir();
    const origin = join(work, "origin.git");
    git(work, "init", "-q", "--bare", origin);
    const root = tempDir();
    initRepo(root);
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    git(root, "remote", "add", "origin", origin);
    git(root, "push", "-q", "-u", "origin", "HEAD");
    for (const subject of ["two", "three"]) {
      writeFileSync(join(root, "a.txt"), `${subject}\n`);
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", subject);
    }

    const ahead = await gitStatus(root);
    expect(ahead.ahead).toBe(2);
    expect(ahead.behind).toBe(0);

    // One commit lands upstream from a second clone; after a fetch this branch is 2 and 1.
    const other = tempDir();
    git(work, "clone", "-q", origin, other);
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "T");
    writeFileSync(join(other, "upstream.txt"), "x\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "upstream");
    git(other, "push", "-q", "origin", "HEAD");
    git(root, "fetch", "-q", "origin");

    const diverged = await gitStatus(root);
    expect(diverged.ahead).toBe(2);
    expect(diverged.behind).toBe(1);
  });
});

describe("git mutations over RPC", () => {
  it("stages, unstages and commits through the dispatch table", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");

    const staged = await call(kernel, "git.stage", { workspaceId, paths: ["a.txt"] });
    expect(staged.result.files.find((file: { path: string }) => file.path === "a.txt").index).toBe("modified");

    const committed = await call(kernel, "git.commit", { workspaceId, message: "rpc commit" });
    expect(committed.result.summary).toBe("rpc commit");
    expect(committed.result.status.files).toEqual([]);

    writeFileSync(join(root, "a.txt"), "one\nthree\n");
    git(root, "add", "a.txt");
    const unstaged = await call(kernel, "git.unstage", { workspaceId, paths: ["a.txt"] });
    expect(unstaged.result.files.find((file: { path: string }) => file.path === "a.txt").index).toBeNull();
  });

  it("refuses a path outside the workspace", async () => {
    const { kernel, workspaceId } = await setupRepo();
    await expect(call(kernel, "git.stage", { workspaceId, paths: ["../escape.txt"] })).rejects.toThrow(
      /Path must not contain/,
    );
    await expect(call(kernel, "git.commit", { workspaceId, message: "" })).rejects.toThrow(/commit message/i);
  });
});
