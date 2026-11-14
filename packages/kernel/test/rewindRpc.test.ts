import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Kernel } from "../src/index.js";
import { EngineManager } from "../src/engineManager.js";
import { startKernel } from "./support.js";

const dirs: string[] = [];
const kernels: Kernel[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir rewind "));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Captures the manager the handlers close over, so a test can hold the rewind reservation across
 * another caller's RPC. `reconcileAll` runs once per `startKernel`, before any RPC can arrive.
 */
async function startKernelWithManager(opts: { dataDir?: string } = {}): Promise<{ kernel: Kernel; manager: EngineManager }> {
  let manager: EngineManager | undefined;
  const original = EngineManager.prototype.reconcileAll;
  EngineManager.prototype.reconcileAll = function (this: EngineManager) {
    manager = this;
    return original.call(this);
  };
  try {
    const kernel = await startKernel(opts);
    if (manager === undefined) throw new Error("the kernel did not build an engine manager");
    return { kernel, manager };
  } finally {
    EngineManager.prototype.reconcileAll = original;
  }
}

/**
 * No RPC creates a checkpoint, so a test that needs a real tree seeds the store and one row here,
 * in the layout `CheckpointService` builds: a git dir whose work tree is the workspace.
 */
function seedCheckpoint(args: { dataDir: string; root: string; workspaceId: string; sessionId: string; seq?: number }): void {
  const store = join(args.dataDir, "checkpoints", args.workspaceId);
  execFileSync("git", ["init", "--quiet", store], { stdio: "ignore" });
  execFileSync("git", ["-C", store, "config", "core.worktree", args.root]);
  writeFileSync(join(args.root, "kept.txt"), "one\n");
  execFileSync("git", ["-C", store, "add", "-A", "--", "."]);
  const tree = execFileSync("git", ["-C", store, "write-tree"], { encoding: "utf8" }).trim();
  const db = new Database(join(args.dataDir, "noir.db"));
  try {
    db.prepare(
      `INSERT INTO checkpoints (id, workspace_id, session_id, turn_id, seq, tree_sha, commit_sha, label, created_at, not_captured, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("c-1", args.workspaceId, args.sessionId, null, args.seq ?? 1, tree, null, "turn", Date.now(), 0, null);
  } finally {
    db.close();
  }
}

async function call(kernel: Kernel, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${kernel.port}/?token=${kernel.token}`);
  await once(ws, "open");
  // `session.create` broadcasts its `session.created` to every live socket, this one included, so
  // the first frame on the wire is not always the reply. Only a frame carrying the request id is.
  const { promise, resolve } = Promise.withResolvers<any>();
  ws.on("message", (data) => {
    const parsed = JSON.parse(String(data));
    if (parsed.id === 1) resolve(parsed);
  });
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const envelope = await promise;
  ws.close();
  if (envelope.error !== undefined) {
    throw Object.assign(new Error(`${method}: ${envelope.error.message}`), { code: envelope.error.code });
  }
  return envelope;
}

describe("rewind over RPC", () => {
  it("reports availability and an empty list for a fresh session", async () => {
    const root = tempDir();
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    const listed = await call(kernel, "checkpoint.list", { sessionId: session.result.id });
    expect(listed.result).toMatchObject({ checkpoints: [], available: true });

    const health = await call(kernel, "system.health");
    expect(health.result.checkpoints).toBe("ok");
  });

  it("answers session.event, and refuses one that does not exist", async () => {
    const root = tempDir();
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    const first = await call(kernel, "session.event", { sessionId: session.result.id, seq: 1 });
    expect(first.result.event.type).toBe("session.created");

    await expect(call(kernel, "session.event", { sessionId: session.result.id, seq: 9_999 })).rejects.toThrow(/Event not found/);
  });

  it("refuses an unknown checkpoint and an unknown session", async () => {
    const kernel = await startKernel({ dataDir: tempDir() });
    kernels.push(kernel);
    await expect(call(kernel, "checkpoint.plan", { sessionId: "nope", checkpointId: "nope" })).rejects.toThrow(/Session not found/);
    await expect(call(kernel, "checkpoint.list", { sessionId: "nope" })).rejects.toThrow(/Session not found/);
  });

  it("refuses a locked store without appending a marker or failing a queued turn", async () => {
    const root = tempDir();
    const dataDir = tempDir();
    const kernel = await startKernel({ dataDir });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    // No RPC creates a checkpoint, so the row and the store are seeded here: one usable tree, and a
    // live lock on the index the safety capture would need.
    const db = new Database(join(dataDir, "noir.db"));
    try {
      db.prepare(
        `INSERT INTO checkpoints (id, workspace_id, session_id, turn_id, seq, tree_sha, commit_sha, label, created_at, not_captured, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run("c-1", workspace.result.id, session.result.id, null, 1, "0".repeat(40), null, "turn", Date.now(), 0, null);
    } finally {
      db.close();
    }
    const store = join(dataDir, "checkpoints", workspace.result.id);
    execFileSync("git", ["init", "--quiet", store], { stdio: "ignore" });
    writeFileSync(join(store, ".git", "index.lock"), "");

    const failure: unknown = await call(kernel, "checkpoint.restore", { sessionId: session.result.id, checkpointId: "c-1" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not be captured/);
    expect(failure).toMatchObject({ code: -32009 });

    const replay = await call(kernel, "session.subscribe", { sessionId: session.result.id, sinceSeq: 0 });
    const types = replay.result.events.map((event: { type: string }) => event.type);
    expect(types).not.toContain("session.rewound");
    expect(types).not.toContain("turn.failed");
  });

  it("refuses checkpoint.plan while a rewind holds the workspace", async () => {
    const root = tempDir();
    const dataDir = tempDir();
    const { kernel, manager } = await startKernelWithManager({ dataDir });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    // No RPC creates a checkpoint, so the store and its row are seeded here with a real tree: the
    // same call must succeed once the reservation is gone.
    seedCheckpoint({ dataDir, root, workspaceId: workspace.result.id, sessionId: session.result.id });

    manager.beginRewind(workspace.result.id);
    try {
      const failure: unknown = await call(kernel, "checkpoint.plan", { sessionId: session.result.id, checkpointId: "c-1" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/A rewind is already running/);
      expect(failure).toMatchObject({ code: -32009 });
    } finally {
      manager.endRewind(workspace.result.id);
    }

    const planned = await call(kernel, "checkpoint.plan", { sessionId: session.result.id, checkpointId: "c-1" });
    expect(planned.result).toEqual({ restored: 0, deleted: 0, removed: 0, failed: [] });
  });

  it("refuses a restore while a plan is in flight, and restores once it is gone", async () => {
    const root = tempDir();
    const dataDir = tempDir();
    const { kernel, manager } = await startKernelWithManager({ dataDir });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    seedCheckpoint({ dataDir, root, workspaceId: workspace.result.id, sessionId: session.result.id });
    writeFileSync(join(root, "kept.txt"), "two\n");

    manager.beginPlan(workspace.result.id);
    try {
      const failure: unknown = await call(kernel, "checkpoint.restore", { sessionId: session.result.id, checkpointId: "c-1" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/A checkpoint plan is still running/);
      expect(failure).toMatchObject({ code: -32009 });
    } finally {
      manager.endPlan(workspace.result.id);
    }

    // The refused restore reserved nothing: the checkpoint is still listed and still applies.
    const listed = await call(kernel, "checkpoint.list", { sessionId: session.result.id });
    expect(listed.result.checkpoints.map((row: { id: string }) => row.id)).toContain("c-1");
    const restored = await call(kernel, "checkpoint.restore", { sessionId: session.result.id, checkpointId: "c-1" });
    expect(restored.result).toMatchObject({ ok: true, restored: 1, deleted: 0, removed: 0, failed: [] });
    expect(readFileSync(join(root, "kept.txt"), "utf8")).toBe("one\n");
  });

  it("names the running rewind when a second restore asks for the same workspace", async () => {
    const root = tempDir();
    const { kernel, manager } = await startKernelWithManager({ dataDir: tempDir() });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });

    manager.beginRewind(workspace.result.id);
    try {
      const failure: unknown = await call(kernel, "checkpoint.restore", { sessionId: session.result.id, checkpointId: "c-1" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/A rewind is already running/);
      expect((failure as Error).message).not.toMatch(/A turn is running/);
      expect(failure).toMatchObject({ code: -32009 });
    } finally {
      manager.endRewind(workspace.result.id);
    }
  });

  it("replays the turn an undone rewind brought back, even from a cursor above it", async () => {
    const root = tempDir();
    const dataDir = tempDir();
    const kernel = await startKernel({ dataDir });
    kernels.push(kernel);
    const project = await call(kernel, "project.add", { path: root });
    const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
    const session = await call(kernel, "session.create", { workspaceId: workspace.result.id });
    const sessionId: string = session.result.id;

    // A checkpoint at seq 1 cuts at the start of the log, so the marker has something real to hide.
    seedCheckpoint({ dataDir, root, workspaceId: workspace.result.id, sessionId, seq: 1 });
    const restored = await call(kernel, "checkpoint.restore", { sessionId, checkpointId: "c-1" });
    const cut = await call(kernel, "session.subscribe", { sessionId, sinceSeq: 0 });
    expect(cut.result.events.map((event: { type: string }) => event.type)).toEqual(["session.rewound"]);
    const cursor: number = cut.result.lastSeq;
    expect(cursor).toBe(restored.result.eventSeq);

    // Restoring the safety capture hides the marker, so the range it closed comes back — all of it
    // below `cursor`. A delta from that cursor would answer with the new marker alone.
    const listed = await call(kernel, "checkpoint.list", { sessionId });
    const safety = (listed.result.checkpoints as Array<{ id: string; label: string }>).find((row) => row.label === "pre-restore");
    if (safety === undefined) throw new Error("the first restore wrote no pre-restore checkpoint");
    await call(kernel, "checkpoint.restore", { sessionId, checkpointId: safety.id });

    const resumed = await call(kernel, "session.subscribe", { sessionId, sinceSeq: cursor });
    expect(resumed.result.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, cursor + 1]);
    expect(resumed.result.lastSeq).toBe(cursor + 1);
  });
});
