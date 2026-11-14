import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointService, type CheckpointRow } from "../src/checkpoints.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

const dirs: string[] = [];
/** Open handles keep the WAL files locked on Windows, so the files go only after the close. */
const opened: Database.Database[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitOut(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

interface Rig {
  db: Database.Database;
  events: EventStore;
  checkpoints: CheckpointService;
  root: string;
  dataDir: string;
  sessionId: string;
  workspaceId: string;
  capture: (turnId: string, seq: number, label?: "turn" | "pre-restore") => Promise<CheckpointRow>;
}

function rig(): Rig {
  const dataDir = tempDir("noir checkpoints data ");
  const root = tempDir("noir checkpoints root ");
  const db = openDb(join(dataDir, "noir.db"));
  opened.push(db);
  const events = new EventStore(db);
  const checkpoints = new CheckpointService(db, events, { dataDir });
  const workspaceId = "w-1";
  const sessionId = "s-1";
  db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)").run("p-1", "p", root, Date.now());
  db.prepare("INSERT INTO workspaces (id, project_id, path, kind, status, created_at) VALUES (?,?,?,?,?,?)").run(workspaceId, "p-1", root, "local", "ready", Date.now());
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run("a-1", "Agent", "default", "native");
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)").run(sessionId, workspaceId, "a-1", "native", "idle", Date.now());
  return {
    db, events, checkpoints, root, dataDir, sessionId, workspaceId,
    capture: (turnId, seq, label) => checkpoints.capture({ sessionId, workspaceId, workspaceRoot: root, turnId, seq, ...(label === undefined ? {} : { label }) }),
  };
}

/** The two steps the RPC handler runs; these tests care about the pair, not the gap between them. */
async function restore(r: Rig, checkpointId: string) {
  const prepared = await r.checkpoints.prepareRestore(r.sessionId, checkpointId);
  return r.checkpoints.applyRestore(r.sessionId, prepared);
}

describe("checkpoint capture", () => {
  it("writes a tree that holds the work tree's files", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);

    expect(row.error).toBeNull();
    expect(row.treeSha).toMatch(/^[0-9a-f]{40,64}$/);
    const store = join(r.dataDir, "checkpoints", r.workspaceId);
    expect(gitOut(store, "rev-parse", `refs/noir/${r.sessionId}/${row.id}`)).toBe(row.commitSha);
    expect(gitOut(store, "cat-file", "-p", `${row.treeSha}:a.txt`)).toBe("one");
  });

  it("never opens the workspace's own repository", async () => {
    const r = rig();
    execFileSync("git", ["init", "-q"], { cwd: r.root });
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    const store = join(r.dataDir, "checkpoints", r.workspaceId);
    expect(gitOut(store, "ls-tree", "--name-only", row.commitSha as string).split("\n")).not.toContain(".git");
    // The user's index is untouched: the file is still untracked there.
    expect(gitOut(r.root, "status", "--porcelain")).toBe("?? a.txt");
  });

  it("refuses an LFS work tree and records why", async () => {
    const r = rig();
    writeFileSync(join(r.root, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    const row = await r.capture("t-1", 1);
    expect(row.error).toBe("LFS worktrees are not supported");
    expect(row.treeSha).toBeNull();
  });

  it("records a missing git binary instead of throwing", async () => {
    const dataDir = tempDir("noir checkpoints nogit ");
    const root = tempDir("noir checkpoints nogit root ");
    const db = openDb(join(dataDir, "noir.db"));
    opened.push(db);
    const service = new CheckpointService(db, new EventStore(db), { dataDir, gitCommand: join(dataDir, "no-such-git") });
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)").run("p-1", "p", root, Date.now());
    db.prepare("INSERT INTO workspaces (id, project_id, path, kind, status, created_at) VALUES (?,?,?,?,?,?)").run("w-1", "p-1", root, "local", "ready", Date.now());
    db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run("a-1", "Agent", "default", "native");
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)").run("s-1", "w-1", "a-1", "native", "idle", Date.now());

    const row = await service.capture({ sessionId: "s-1", workspaceId: "w-1", workspaceRoot: root, turnId: "t-1", seq: 1 });
    expect(row.treeSha).toBeNull();
    expect(row.error).toMatch(/ENOENT|no-such-git/);
    await expect(service.availability("w-1")).resolves.toEqual({ available: false, reason: "git is not available" });
  });

  it("counts what it could not capture", async () => {
    const r = rig();
    mkdirSync(join(r.root, "node_modules", "pkg", "sub"), { recursive: true });
    writeFileSync(join(r.root, "node_modules", "pkg", "index.js"), "x\n");
    writeFileSync(join(r.root, "node_modules", "pkg", "sub", "b.js"), "x\n");
    writeFileSync(join(r.root, ".gitignore"), "secret.txt\n");
    writeFileSync(join(r.root, "secret.txt"), "x\n");
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    expect(row.notCaptured).toBeGreaterThanOrEqual(3);
  });

  it("refuses a data dir that is the workspace root", async () => {
    const root = tempDir("noir checkpoints self ");
    const db = openDb(join(root, "noir.db"));
    opened.push(db);
    const service = new CheckpointService(db, new EventStore(db), { dataDir: root });
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)").run("p-1", "p", root, Date.now());
    db.prepare("INSERT INTO workspaces (id, project_id, path, kind, status, created_at) VALUES (?,?,?,?,?,?)").run("w-1", "p-1", root, "local", "ready", Date.now());
    db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run("a-1", "Agent", "default", "native");
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)").run("s-1", "w-1", "a-1", "native", "idle", Date.now());

    const row = await service.capture({ sessionId: "s-1", workspaceId: "w-1", workspaceRoot: root, turnId: "t-1", seq: 1 });
    expect(row.error).toBe("The workspace root is the checkpoint data directory");
    expect(row.treeSha).toBeNull();
    expect(existsSync(join(root, "checkpoints", "w-1"))).toBe(false);
    // `plan` refreshes before it checks for a tree, so the store guard is what has to stop it.
    await expect(service.plan("s-1", row.id)).rejects.toThrow(/checkpoint data directory/);
  });

  it("lists accepted checkpoints and hides the abandoned ones", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    // The abandoned turn's prompt takes seq 1 — the seq the first capture recorded.
    const first = await r.capture("t-1", 1);
    r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "message.delta",
      payload: { messageId: "m1", role: "user", block: { type: "text", text: "doomed" } },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    });
    // The marker is seq 2, so the abandoned range is [1, 2) and the row at 1 goes with it.
    r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "session.rewound", turnId: null,
      payload: { cutSeq: 1, checkpointId: first.id, promptSeq: 1, restored: 0, deleted: 0, removed: 0, failed: 0, notCaptured: 0, engine: "native", engineNotRewound: false },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    });
    const second = await r.capture("t-2", 3);

    const listed = r.checkpoints.entries(r.sessionId).map((entry) => entry.id);
    expect(listed).toEqual([second.id]);

    // A pre-restore checkpoint records the seq the marker is about to take, so it must survive.
    const safety = await r.capture("safety", 2, "pre-restore");
    expect(r.checkpoints.entries(r.sessionId).map((entry) => entry.id)).toEqual([second.id, safety.id]);
  });
});

describe("checkpoint plan and restore", () => {
  it("puts modified, deleted and created files back where they were", async () => {
    const r = rig();
    writeFileSync(join(r.root, "keep.txt"), "original\n");
    writeFileSync(join(r.root, "gone.txt"), "delete me\n");
    const row = await r.capture("t-1", 1);

    writeFileSync(join(r.root, "keep.txt"), "changed\n");
    rmSync(join(r.root, "gone.txt"));
    writeFileSync(join(r.root, "new.txt"), "created after\n");

    const plan = await r.checkpoints.plan(r.sessionId, row.id);
    expect(plan).toMatchObject({ restored: 1, deleted: 1, removed: 1, failed: [] });

    const result = await restore(r, row.id);
    expect(result).toMatchObject({ ok: true, restored: 1, deleted: 1, removed: 1, failed: [] });
    expect(readFileSync(join(r.root, "keep.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(r.root, "gone.txt"), "utf8")).toBe("delete me\n");
    expect(() => readFileSync(join(r.root, "new.txt"))).toThrow();
  });

  it("keeps CRLF bytes byte-for-byte", async () => {
    const r = rig();
    writeFileSync(join(r.root, "win.txt"), "a\r\nb\r\n");
    const row = await r.capture("t-1", 1);
    writeFileSync(join(r.root, "win.txt"), "rewritten\n");
    await restore(r, row.id);
    expect(readFileSync(join(r.root, "win.txt"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("does not touch what it never captured", async () => {
    const r = rig();
    mkdirSync(join(r.root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(r.root, "node_modules", "pkg", "index.js"), "module\n");
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    writeFileSync(join(r.root, "a.txt"), "two\n");
    writeFileSync(join(r.root, "node_modules", "pkg", "later.js"), "later\n");
    await restore(r, row.id);
    expect(readFileSync(join(r.root, "node_modules", "pkg", "index.js"), "utf8")).toBe("module\n");
    expect(readFileSync(join(r.root, "node_modules", "pkg", "later.js"), "utf8")).toBe("later\n");
  });

  it("appends the rewind event and never deletes a row", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    const promptSeq = r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "message.delta", turnId: "t-1",
      payload: { messageId: "m-1", role: "user", block: { type: "text", text: "do the thing" } },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    }).seq;

    const count = (): number => {
      const totals = r.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(r.sessionId) as { n: number } | undefined;
      return totals?.n ?? 0;
    };
    const before = count();
    const result = await restore(r, row.id);
    expect(count()).toBe(before + 1);

    const marker = r.events.at(r.sessionId, result.eventSeq);
    expect(marker?.type).toBe("session.rewound");
    expect(marker?.payload).toMatchObject({ cutSeq: 1, promptSeq, engine: "native", engineNotRewound: false });
    expect(r.events.visible(r.sessionId).some((event) => event.seq === promptSeq)).toBe(false);
    expect(r.events.visible(r.sessionId).some((event) => event.type === "session.rewound")).toBe(true);
  });

  it("captures a pre-restore checkpoint that can itself be rewound to", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    // The turn the checkpoint precedes: the first rewind abandons it, and undoing that rewind has to
    // bring it back — files and conversation both.
    r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "message.delta", turnId: "t-1",
      payload: { messageId: "m-1", role: "user", block: { type: "text", text: "one" } },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    });
    r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "message.delta", turnId: "t-1",
      payload: { messageId: "m-2", role: "assistant", block: { type: "text", text: "done" } },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    });
    writeFileSync(join(r.root, "a.txt"), "two\n");
    await restore(r, row.id);

    const safety = r.checkpoints.entries(r.sessionId).find((entry) => entry.label === "pre-restore");
    expect(safety).toBeDefined();
    // The marker waited at the seq the safety checkpoint recorded, so it is that seq an undo cuts at.
    const firstMarkerSeq = safety!.seq;
    expect(r.events.at(r.sessionId, firstMarkerSeq)?.type).toBe("session.rewound");
    expect(r.events.visible(r.sessionId).filter((event) => event.type === "message.delta")).toHaveLength(0);

    writeFileSync(join(r.root, "a.txt"), "three\n");
    await restore(r, safety!.id);
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("two\n");

    // The conversation came back with the files: the undone marker is hidden, only the undo's own
    // marker remains, and the checkpoint that started it is offered again.
    const visible = r.events.visible(r.sessionId);
    const markers = visible.filter((event) => event.type === "session.rewound");
    expect(markers.map((event) => event.seq)).not.toContain(firstMarkerSeq);
    expect(markers).toHaveLength(1);
    expect(visible.filter((event) => event.type === "message.delta")).toHaveLength(2);
    expect(r.checkpoints.entries(r.sessionId).map((entry) => entry.id)).toContain(row.id);
  });

  it("keeps the pre-restore checkpoint listed when the queue drop lands before the marker", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    writeFileSync(join(r.root, "a.txt"), "two\n");

    const prepared = await r.checkpoints.prepareRestore(r.sessionId, row.id);
    // What `afterRewind` emits between the two steps: a dropped queued turn's failure, which takes a
    // seq above the safety row's capture and below the marker's.
    r.events.append({
      sessionId: r.sessionId, agentId: "a-1", type: "turn.failed", turnId: null,
      payload: { turnId: "t-2", message: "The turn was abandoned by a rewind" },
      provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
    });
    const result = await r.checkpoints.applyRestore(r.sessionId, prepared);

    // The row must sit at the range's `to`, or `entries()` hides the one snapshot that undoes it.
    const safety = r.checkpoints.entries(r.sessionId).find((entry) => entry.label === "pre-restore");
    expect(safety?.seq).toBe(result.eventSeq);
    expect(r.events.at(r.sessionId, result.eventSeq)?.type).toBe("session.rewound");
  });

  it("refuses to restore when the current state cannot be captured", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    writeFileSync(join(r.root, "a.txt"), "two\n");
    // LFS attributes appear after the checkpoint, so the pre-restore capture is the one refused.
    writeFileSync(join(r.root, ".gitattributes"), "*.bin filter=lfs\n");
    await expect(r.checkpoints.prepareRestore(r.sessionId, row.id)).rejects.toThrow(/could not be captured/);
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("two\n");
  });

  it("refuses a locked store before any of the restore's writes", async () => {
    const r = rig();
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    writeFileSync(join(r.root, "a.txt"), "two\n");
    writeFileSync(join(r.root, "new.txt"), "created after\n");
    // Another git holds the store's index: the safety capture cannot record what is about to be lost.
    writeFileSync(join(r.dataDir, "checkpoints", r.workspaceId, ".git", "index.lock"), "");
    const before = r.checkpoints.entries(r.sessionId).map((entry) => entry.id);

    await expect(r.checkpoints.prepareRestore(r.sessionId, row.id)).rejects.toThrow(/could not be captured/);

    // Refused before the queue is anywhere near it: no byte of the work tree moved.
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(r.root, "new.txt"), "utf8")).toBe("created after\n");
    const added = r.checkpoints.entries(r.sessionId).filter((entry) => !before.includes(entry.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ label: "pre-restore" });
    expect(added[0]?.error).not.toBeNull();
  });

  it("refuses a checkpoint that never captured a tree", async () => {
    const r = rig();
    writeFileSync(join(r.root, ".gitattributes"), "*.bin filter=lfs\n");
    const row = await r.capture("t-1", 1);
    await expect(r.checkpoints.plan(r.sessionId, row.id)).rejects.toThrow(/LFS/);
    await expect(r.checkpoints.prepareRestore(r.sessionId, row.id)).rejects.toThrow(/LFS/);
  });
});
