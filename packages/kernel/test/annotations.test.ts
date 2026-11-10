import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startKernel, type Kernel } from "../src/index.js";

const dirs: string[] = [];
const kernels: Kernel[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir notes "));
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

/** A git repository whose tracked `a.txt` is committed as "one\n" and then modified to "one\ntwo\n". */
function repoWithChange(): string {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "one\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  return root;
}

async function attachWorkspace(kernel: Kernel, root: string): Promise<string> {
  const project = await call(kernel, "project.add", { path: root });
  const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
  return workspace.result.id;
}

async function setupRepo(): Promise<{ kernel: Kernel; workspaceId: string; root: string }> {
  const root = repoWithChange();
  const kernel = await startKernel({ dataDir: tempDir() });
  kernels.push(kernel);
  return { kernel, workspaceId: await attachWorkspace(kernel, root), root };
}

describe("annotation.* RPCs", () => {
  it("stores a note against the current diff and marks it stale after the file changes", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    const added = await call(kernel, "annotation.add", { workspaceId, path: "a.txt", line: 2, note: "why?" });
    expect(added.error).toBeUndefined();
    expect(added.result.stale).toBe(false);

    const fresh = await call(kernel, "annotation.list", { workspaceId, path: "a.txt" });
    expect(fresh.result.annotations).toHaveLength(1);
    expect(fresh.result.annotations[0]).toMatchObject({ line: 2, note: "why?", stale: false });
    expect(typeof fresh.result.diffHash).toBe("string");

    writeFileSync(join(root, "a.txt"), "one\nchanged\ntwo\n");
    const stale = await call(kernel, "annotation.list", { workspaceId, path: "a.txt" });
    expect(stale.result.diffHash).not.toBe(fresh.result.diffHash);
    expect(fresh.result.annotations[0].stale).toBe(false);
    expect(stale.result.annotations[0].stale).toBe(true);
  });

  it("deletes a note and rejects an empty note", async () => {
    const { kernel, workspaceId } = await setupRepo();
    const added = await call(kernel, "annotation.add", { workspaceId, path: "a.txt", line: 1, note: "keep" });
    const removed = await call(kernel, "annotation.delete", { id: added.result.id });
    expect(removed.result).toEqual({ ok: true });
    const listed = await call(kernel, "annotation.list", { workspaceId, path: "a.txt" });
    expect(listed.result.annotations).toEqual([]);

    const blank = await call(kernel, "annotation.add", { workspaceId, path: "a.txt", line: 1, note: "  " });
    expect(blank.error.code).toBe(-32602);
  });

  it("treats equivalent client paths as the same note", async () => {
    const { kernel, workspaceId } = await setupRepo();
    const added = await call(kernel, "annotation.add", { workspaceId, path: "./a.txt", line: 2, note: "why?" });
    expect(added.error).toBeUndefined();

    const listed = await call(kernel, "annotation.list", { workspaceId, path: "a.txt" });
    expect(listed.result.annotations).toHaveLength(1);
    expect(listed.result.annotations[0]).toMatchObject({ id: added.result.id, note: "why?", stale: false });
  });

  it("rejects a note on a tracked file with no diff", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    writeFileSync(join(root, "a.txt"), "one\n");

    const rejected = await call(kernel, "annotation.add", { workspaceId, path: "a.txt", line: 1, note: "nothing" });
    expect(rejected.error.code).toBe(-32602);
  });

  it("lists no notes and rejects adds for a workspace outside a repository", async () => {
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    const root = tempDir();
    writeFileSync(join(root, "b.txt"), "hi\n");
    const workspaceId = await attachWorkspace(kernel, root);

    const listed = await call(kernel, "annotation.list", { workspaceId, path: "b.txt" });
    expect(listed.error).toBeUndefined();
    expect(listed.result.annotations).toEqual([]);
    expect(typeof listed.result.diffHash).toBe("string");

    const rejected = await call(kernel, "annotation.add", { workspaceId, path: "b.txt", line: 1, note: "x" });
    expect(rejected.error.code).toBe(-32602);
  });

  it("keeps notes scoped to one workspace", async () => {
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    const first = await attachWorkspace(kernel, repoWithChange());
    const second = await attachWorkspace(kernel, repoWithChange());
    await call(kernel, "annotation.add", { workspaceId: first, path: "a.txt", line: 2, note: "first" });
    await call(kernel, "annotation.add", { workspaceId: second, path: "a.txt", line: 2, note: "second" });

    const firstList = await call(kernel, "annotation.list", { workspaceId: first, path: "a.txt" });
    const secondList = await call(kernel, "annotation.list", { workspaceId: second, path: "a.txt" });
    expect(firstList.result.annotations.map((annotation: { note: string }) => annotation.note)).toEqual(["first"]);
    expect(secondList.result.annotations.map((annotation: { note: string }) => annotation.note)).toEqual(["second"]);
  });

  it("annotates a file that was never committed", async () => {
    const { kernel, workspaceId, root } = await setupRepo();
    writeFileSync(join(root, "fresh.txt"), "brand new\n");

    const added = await call(kernel, "annotation.add", { workspaceId, path: "fresh.txt", line: 1, note: "new" });
    expect(added.error).toBeUndefined();
    expect(added.result.stale).toBe(false);

    const listed = await call(kernel, "annotation.list", { workspaceId, path: "fresh.txt" });
    expect(listed.result.annotations[0]).toMatchObject({ note: "new", stale: false });
  });
});
