import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

/** Private-field introspection: no public accessor exists for the store's db handle. */
type StoreInternals = { readonly db: Database.Database };

function makeStore() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1','p','/tmp/p',1)").run();
  db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES ('w1','p1','/tmp/p','main','local','ready',1)").run();
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES ('a1','A','default','acp')").run();
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('s1','w1','a1','acp','starting',1)").run();
  return new EventStore(db);
}

const provenance = { engine: "acp" as const, engineName: "fake", adapterVersion: "0" };

describe("EventStore", () => {
  it("assigns gap-free sequence numbers per session", () => {
    const store = makeStore();
    const a = store.append({ sessionId: "s1", agentId: "a1", type: "session.created", payload: { title: "x" }, provenance });
    const b = store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "running" }, provenance });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.list("s1", 1).map((e) => e.seq)).toEqual([2]);
  });

  it("projects status and title inside the append transaction", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "session.updated", payload: { title: "Renamed" }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "idle" }, provenance });
    const { db } = store as unknown as StoreInternals;
    const row = db.prepare("SELECT title, status FROM sessions WHERE id='s1'").get() as { title: string; status: string };
    expect(row).toEqual({ title: "Renamed", status: "idle" });
  });

  it("replays to identical state", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "running" }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m", role: "assistant", block: { type: "text", text: "hi" } }, provenance });
    const all = store.list("s1");
    expect(all).toHaveLength(2);
    expect(all[1]!.payload).toEqual({ messageId: "m", role: "assistant", block: { type: "text", text: "hi" } });
  });

  it("rejects an event with an invalid payload without writing it", () => {
    const store = makeStore();
    expect(() => store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "bogus" }, provenance })).toThrow();
    expect(store.list("s1")).toHaveLength(0);
  });
});
