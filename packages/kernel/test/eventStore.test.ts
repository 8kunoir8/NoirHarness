import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { REDACTED, Redactor } from "../src/redact.js";

/** Private-field introspection: no public accessor exists for the store's db handle. */
type StoreInternals = { readonly db: Database.Database };

function makeStore(redactor?: Redactor) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1','p','/tmp/p',1)").run();
  db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES ('w1','p1','/tmp/p','main','local','ready',1)").run();
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES ('a1','A','default','acp')").run();
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('s1','w1','a1','acp','starting',1)").run();
  return new EventStore(db, undefined, redactor);
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

  it("redacts before persisting and stays schema-valid", () => {
    const store = makeStore(new Redactor({ secrets: ["sk-live-1234567890"] }));
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m", role: "user", block: { type: "text", text: "sk-live-1234567890" } }, provenance });
    expect(store.list("s1")[0]!.payload).toEqual({ messageId: "m", role: "user", block: { type: "text", text: REDACTED } });
    const { db } = store as unknown as StoreInternals;
    const dump = JSON.stringify(db.prepare("SELECT payload_json FROM events").all());
    expect(dump).not.toContain("sk-live-1234567890");
  });

  it("still rejects an invalid payload after redaction", () => {
    const store = makeStore();
    expect(() => store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "bogus", note: "sk-live-1234567890" }, provenance })).toThrow();
    const { db } = store as unknown as StoreInternals;
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("projects the turn status from the turn.completed payload", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "turn.started", payload: { turnId: "t1", index: 0 }, provenance, ts: 10 });
    store.append({ sessionId: "s1", agentId: "a1", type: "turn.started", payload: { turnId: "t2", index: 1 }, provenance, ts: 11 });
    store.append({ sessionId: "s1", agentId: "a1", type: "turn.completed", payload: { turnId: "t1", status: "interrupted" }, provenance, ts: 20 });
    store.append({ sessionId: "s1", agentId: "a1", type: "turn.completed", payload: { turnId: "t2" }, provenance, ts: 21 });
    const { db } = store as unknown as StoreInternals;
    const rows = db.prepare("SELECT id, status, ended_at FROM turns ORDER BY id").all();
    expect(rows).toEqual([
      { id: "t1", status: "interrupted", ended_at: 20 },
      { id: "t2", status: "completed", ended_at: 21 },
    ]);
  });
});

describe("rewound ranges", () => {
  /** `makeStore` seeds `s1`; the rewind helper keeps the payload shape in one place. */
  function rewind(store: EventStore, cutSeq: number): void {
    store.append({
      sessionId: "s1",
      agentId: "a1",
      type: "session.rewound",
      payload: {
        cutSeq, checkpointId: "c-1", promptSeq: cutSeq, restored: 0, deleted: 0, removed: 0,
        failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true,
      },
      provenance,
    });
  }

  it("hides the range and keeps the marker", () => {
    const store = makeStore();
    const kept = store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m-1", role: "user", block: { type: "text", text: "first" } }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m-2", role: "assistant", block: { type: "text", text: "doomed" } }, provenance });
    // `cutSeq` is the first seq the abandoned turn would have written (`nextSeq` at checkpoint
    // time), so the prompt before it stays visible.
    rewind(store, kept.seq + 1);

    const visible = store.visible("s1");
    expect(visible.map((event) => event.seq)).toEqual([kept.seq, kept.seq + 2]);
    expect(visible.map((event) => event.type)).toEqual(["message.delta", "session.rewound"]);
    expect(JSON.stringify(visible)).not.toContain("doomed");
  });

  it("resolves two rewinds independently", () => {
    const store = makeStore();
    const a = store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "a", role: "user", block: { type: "text", text: "a" } }, provenance });
    rewind(store, a.seq);
    const b = store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "b", role: "user", block: { type: "text", text: "b" } }, provenance });
    rewind(store, b.seq);

    const visible = store.visible("s1");
    expect(visible.filter((event) => event.type === "message.delta")).toEqual([]);
    expect(visible.filter((event) => event.type === "session.rewound")).toHaveLength(2);
  });

  it("brings an abandoned turn back when the rewind is undone", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m1", role: "user", block: { type: "text", text: "one" } }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m2", role: "assistant", block: { type: "text", text: "reply" } }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m3", role: "user", block: { type: "text", text: "two" } }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m4", role: "assistant", block: { type: "text", text: "reply two" } }, provenance });
    const rewind = (cutSeq: number, promptSeq: number | null) =>
      store.append({
        sessionId: "s1", agentId: "a1", type: "session.rewound", turnId: null,
        payload: { cutSeq, checkpointId: "c", promptSeq, restored: 0, deleted: 0, removed: 0, failed: 0, notCaptured: 0, engine: "native", engineNotRewound: false },
        provenance,
      });
    // Cut at 3: the second turn is abandoned and its marker (5) divides the transcript.
    rewind(3, 3);
    expect(store.visible("s1").map((event) => event.seq)).toEqual([1, 2, 5]);

    // A pre-restore row sits at seq 5, so undoing it cuts at 5: the turn comes back, marker gone.
    rewind(5, 3);
    expect(store.visible("s1").map((event) => event.seq)).toEqual([1, 2, 3, 4, 6]);

    // A third restore cuts at 6, the seq the second marker took: that marker goes, the first stands.
    rewind(6, null);
    expect(store.visible("s1").map((event) => event.seq)).toEqual([1, 2, 5, 7]);
  });

  it("reports meta from the visible log only", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "permission.requested", payload: { approvalId: "p-1", toolCallId: "c-1", title: "Run", category: "shell", options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] }, provenance });
    rewind(store, 1);

    const meta = store.visibleMeta("s1");
    expect(meta.pendingApproval).toBe(false);
    expect(meta.lastSeq).toBe(2);
    // `at` still reaches the abandoned row; that is what `Load the prompt again` needs.
    expect(store.at("s1", 1)?.type).toBe("permission.requested");
  });

  it("copies the visible prefix into a fork and leaves the marker behind", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "running" }, provenance });
    const prompt = store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "p", role: "user", block: { type: "text", text: "prompt" } }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "x", role: "assistant", block: { type: "text", text: "discarded" } }, provenance });
    rewind(store, prompt.seq + 1);

    const { db } = store as unknown as StoreInternals;
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('s2','w1','a1','acp','idle',1)").run();
    // The abandoned assistant row and the marker both stay out: a fork is a fresh branch of the
    // visible log, and a renumbered marker's cut would point at nothing.
    expect(store.copyPrefix("s1", "s2")).toBe(2);
    expect(store.list("s2").map((event) => event.type)).toEqual(["session.status", "message.delta"]);
    expect(store.list("s2")[1]?.payload).toMatchObject({ messageId: "p" });
  });
});
