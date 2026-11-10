import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startKernel, type Kernel } from "../src/index.js";

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
    expect(files.find((file) => file.path === "a.txt")).toEqual({ path: "a.txt", change: "modified", add: 1, del: 0 });
    expect(files.find((file) => file.path === "c.txt")).toEqual({ path: "c.txt", change: "created", add: 2, del: 0 });
    expect(files.find((file) => file.path === "b.txt")).toEqual({ path: "b.txt", change: "deleted", add: 0, del: 1 });
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
    expect(status.result).toEqual({ isRepo: false, branch: null, files: [] });
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
    expect(status.result.files).toEqual([{ path: "tracked.txt", change: "modified", add: 1, del: 0 }]);

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
    expect(status.result.files).toEqual([{ path: "fresh.txt", change: "created", add: 3, del: 0 }]);
  });

  it("caps the read of a huge untracked file and says so in its patch", async () => {
    const root = tempDir();
    initRepo(root);
    const cap = 2 * 1024 * 1024;
    // The first line fills the whole cap, so a capped head is one line while the file has two.
    writeFileSync(join(root, "big.log"), `${"a".repeat(cap)}\n${"b".repeat(1_000)}\n`);
    const { kernel, workspaceId } = await setupWorkspace(root);

    const status = await call(kernel, "git.status", { workspaceId });
    expect(status.result.files).toEqual([{ path: "big.log", change: "created", add: 1, del: 0 }]);

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
      { path: "renamed.txt", change: "modified", add: 0, del: 0 },
    ]);
    expect(files.find((file) => file.path === "a.txt")).toBeUndefined();
    expect(files.filter((file) => file.path === "renamed.txt")).toHaveLength(1);
  });
});
