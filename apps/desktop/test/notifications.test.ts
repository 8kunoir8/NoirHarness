import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@noir/protocol";
import { ScheduleWatcher } from "../src/notifications.js";

function event(type: AgentEvent["type"], sessionId: string, payload: unknown, seq = 1): AgentEvent {
  return {
    v: 1,
    id: `evt-${seq}`,
    seq,
    ts: 0,
    sessionId,
    agentId: "a1",
    type,
    payload,
    provenance: { engine: "acp", engineName: "test", adapterVersion: "0" },
  };
}

function harness() {
  const shown: Array<{ title: string; body: string }> = [];
  const watcher = new ScheduleWatcher({ show: (title, body) => shown.push({ title, body }) });
  return { watcher, shown };
}

describe("schedule notifications", () => {
  it("reports a scheduled run once it finishes, with the title it learned on the way", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s1", { title: "", scheduleId: "sched-1" }));
    watcher.observe(event("session.updated", "s1", { title: "Nightly tidy" }, 2));
    watcher.observe(event("turn.completed", "s1", { turnId: "t1" }, 3));
    expect(shown).toEqual([{ title: "Scheduled run finished", body: "Nightly tidy" }]);
    expect(watcher.sessions()).toEqual(["s1"]);
  });

  it("ignores a session a person started", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s2", { title: "My chat" }));
    watcher.observe(event("turn.completed", "s2", { turnId: "t1" }, 2));
    expect(shown).toEqual([]);
    expect(watcher.sessions()).toEqual([]);
  });

  it("says why a scheduled run failed", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s3", { title: "", scheduleId: "sched-2" }));
    watcher.observe(event("turn.failed", "s3", { turnId: "t1", message: "provider refused the key" }, 2));
    expect(shown[0]?.title).toBe("Scheduled run failed");
    expect(shown[0]?.body).toContain("provider refused the key");
  });

  it("does not repeat itself when a replay delivers the completion twice", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s4", { title: "", scheduleId: "sched-3" }));
    watcher.observe(event("turn.completed", "s4", { turnId: "t1" }, 2));
    watcher.observe(event("turn.completed", "s4", { turnId: "t1" }, 2));
    expect(shown).toHaveLength(1);
  });

  it("keeps a long failure short enough to read", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s5", { title: "", scheduleId: "sched-4" }));
    watcher.observe(event("turn.failed", "s5", { turnId: "t1", message: "x".repeat(400) }, 2));
    expect((shown[0]?.body ?? "").length).toBeLessThanOrEqual(140);
    expect(shown[0]?.body ?? "").toContain("…");
  });

  it("survives a payload that is not an object", () => {
    const { watcher, shown } = harness();
    watcher.observe(event("session.created", "s6", "nonsense"));
    watcher.observe(event("turn.completed", "s6", null, 2));
    expect(shown).toEqual([]);
  });
});
