import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    mkdirSync(join(r.root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(r.root, "node_modules", "pkg", "index.js"), "x\n");
    writeFileSync(join(r.root, ".gitignore"), "secret.txt\n");
    writeFileSync(join(r.root, "secret.txt"), "x\n");
    writeFileSync(join(r.root, "a.txt"), "one\n");
    const row = await r.capture("t-1", 1);
    expect(row.notCaptured).toBeGreaterThanOrEqual(2);
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
