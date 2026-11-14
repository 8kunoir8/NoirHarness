import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { SessionService } from "../src/sessions.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "noir sessions "));
  dirs.push(root);
  const db = openDb(join(root, "noir.db"));
  dbs.push(db);
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events, new ModelService(db));
  const project = projects.add(root);
  const workspace = workspaces.createLocal(project.id);
  return { db, events, sessions, workspace };
}

function expectFault(fn: () => unknown, code: number, message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcFault);
    expect((error as RpcFault).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    return;
  }
  expect.unreachable("expected RpcFault");
}

describe("SessionService.remove", () => {
  it("takes the session's events with it and refuses an unknown id", () => {
    const { db, events, sessions, workspace } = setup();
    const session = sessions.create(workspace.id);
    const kept = sessions.create(workspace.id);
    expect(events.list(session.id).length).toBeGreaterThan(0);

    sessions.remove(session.id);

    expect(events.list(session.id)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(session.id)).toEqual({ n: 0 });
    expectFault(() => sessions.view(session.id), ErrorCodes.notFound, /Session not found/);
    // A neighbour is untouched: deleting is per row, not a wipe.
    expect(sessions.view(kept.id).id).toBe(kept.id);
    expect(events.list(kept.id).length).toBeGreaterThan(0);
    expectFault(() => sessions.remove(session.id), ErrorCodes.notFound, /Session not found/);
  });

  it("leaves no orphaned turn, approval or file-change row behind", () => {
    const { db, events, sessions, workspace } = setup();
    const session = sessions.create(workspace.id);
    // better-sqlite3 hands back `unknown`; the row shape is the query's own contract.
    const owner = db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(session.id) as { agent_id: string };
    const agentId = owner.agent_id;
    const now = Date.now();
    db.prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES (?,?,?,?,?)").run(
      "turn-1", session.id, 0, "completed", now,
    );
    db.prepare(
      "INSERT INTO approvals (id, session_id, event_id, kind, payload_json) VALUES (?,?,?,?,?)",
    ).run("ap-1", session.id, events.list(session.id)[0]?.id ?? "none", "shell", "{}");
    db.prepare(
      "INSERT INTO file_changes (id, session_id, path, change, \"add\", del, applied_at) VALUES (?,?,?,?,?,?,?)",
    ).run("fc-1", session.id, "src/a.ts", "modified", 1, 0, now);

    sessions.remove(session.id);

    for (const table of ["turns", "approvals", "file_changes", "events"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(session.id) as { n: number };
      expect([table, row.n]).toEqual([table, 0]);
    }
    // The agent row is the session's parent, not its child.
    expect(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?").get(agentId)).toEqual({ n: 1 });
  });
});
