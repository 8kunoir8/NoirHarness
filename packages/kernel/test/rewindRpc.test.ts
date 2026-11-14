import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Kernel } from "../src/index.js";
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
});
