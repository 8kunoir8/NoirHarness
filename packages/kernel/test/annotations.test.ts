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

async function setupRepo(): Promise<{ kernel: Kernel; workspaceId: string; root: string }> {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "one\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");

  const kernel = await startKernel({ dataDir: tempDir() });
  kernels.push(kernel);
  const project = await call(kernel, "project.add", { path: root });
  const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
  return { kernel, workspaceId: workspace.result.id, root };
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
});
