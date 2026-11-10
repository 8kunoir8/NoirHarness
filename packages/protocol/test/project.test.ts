import { describe, expect, it } from "vitest";
import { reduceSession } from "../src/project.js";
import type { SessionState } from "../src/project.js";
import type { AgentEvent, EventType } from "../src/events.js";

function ev(seq: number, type: EventType, payload: unknown): AgentEvent {
  return {
    v: 1, id: `e${seq}`, seq, ts: 1000 + seq, sessionId: "s1", agentId: "a1",
    type, payload,
    provenance: { engine: "acp", engineName: "fake", adapterVersion: "0" },
  };
}

describe("reduceSession", () => {
  it("folds status, title, message blocks, usage and file changes", () => {
    const events = [
      ev(1, "session.created", { title: "New chat" }),
      ev(2, "session.status", { status: "running" }),
      ev(3, "session.updated", { title: "Fix auth" }),
      ev(4, "message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: "Hi" } }),
      ev(5, "message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: " there" } }),
      ev(6, "message.completed", { messageId: "m1", status: "done" }),
      ev(7, "usage.updated", { inputTokens: 10, outputTokens: 5, contextUsed: 15, contextWindow: 100, costUsd: 0.01 }),
      ev(8, "file.changed", { path: "src/a.ts", change: "modified", add: 3, del: 1 }),
    ];

    const state = events.reduce((acc, e) => reduceSession(acc, e), undefined as SessionState | undefined)!;

    expect(state.status).toBe("running");
    expect(state.title).toBe("Fix auth");
    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", blocks: [{ type: "text", text: "Hi" }, { type: "text", text: " there" }], status: "done" },
    ]);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, contextUsed: 15, contextWindow: 100, costUsd: 0.01 });
    expect(state.changedFiles).toEqual([{ path: "src/a.ts", change: "modified", add: 3, del: 1 }]);
  });

  it("is order-independent for the same final sequence", () => {
    const events = [
      ev(1, "session.created", { title: "x" }),
      ev(2, "session.status", { status: "idle" }),
    ];
    const once = events.reduce((acc, e) => reduceSession(acc, e), undefined as SessionState | undefined);
    const twice = events.reduce((acc, e) => reduceSession(acc, e), undefined as SessionState | undefined);
    expect(once).toEqual(twice);
  });

  it("projects session.closed into closed status", () => {
    const events = [
      ev(1, "session.created", { title: "x" }),
      ev(2, "session.closed", {}),
    ];
    const state = events.reduce((acc, e) => reduceSession(acc, e), undefined as SessionState | undefined)!;
    expect(state.status).toBe("closed");
  });

  it("records the first skill.loaded per name and ignores repeats", () => {
    const once = reduceSession(undefined, ev(1, "skill.loaded", { name: "demo", scope: "project", hash: "h1" }));
    expect(once.skillsLoaded).toEqual([{ name: "demo", scope: "project", hash: "h1" }]);

    const twice = reduceSession(once, ev(2, "skill.loaded", { name: "demo", scope: "global", hash: "h2" }));
    expect(twice).toBe(once);
    expect(twice.skillsLoaded).toEqual([{ name: "demo", scope: "project", hash: "h1" }]);

    const appended = reduceSession(twice, ev(3, "skill.loaded", { name: "other", scope: "global", hash: "h3" }));
    expect(appended.skillsLoaded).toEqual([
      { name: "demo", scope: "project", hash: "h1" },
      { name: "other", scope: "global", hash: "h3" },
    ]);
  });

  it("rejects a payload that does not match its event type", () => {
    const bad = ev(1, "session.status", {status: "nonsense"});
    expect(() => reduceSession(undefined, bad)).toThrow();
  });
});
