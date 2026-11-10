import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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
  return JSON.parse(String(data));
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function setupRepo(): Promise<{ kernel: Kernel; workspaceId: string; root: string }> {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "gone\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");

  const kernel = await startKernel({ dataDir: tempDir() });
  kernels.push(kernel);
  const project = await call(kernel, "project.add", { path: root });
  const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
  return { kernel, workspaceId: workspace.result.id, root };
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
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const status = await call(kernel, "git.status", { workspaceId: workspace.result.id });
    expect(status.result).toEqual({ isRepo: false, branch: null, files: [] });
  });
});
