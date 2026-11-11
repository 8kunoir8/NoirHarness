import { describe, expect, it } from "vitest";
import { reconstructHistory, type HistoryEvent, type HistoryLimits } from "../src/history.js";

let seq = 0;

function event(type: string, payload: unknown, turnId: string | null = "t1"): HistoryEvent {
  seq += 1;
  return { seq, type, turnId, payload };
}

function user(text: string, messageId: string, turnId: string): HistoryEvent {
  return event("message.delta", { messageId, role: "user", block: { type: "text", text } }, turnId);
}

function assistant(text: string, messageId: string, turnId: string): HistoryEvent {
  return event("message.delta", { messageId, role: "assistant", block: { type: "text", text } }, turnId);
}

const WIDE = { contextWindow: 100_000, maxTokens: null };

/** Most cases care about the messages only; the trim count has its own test. */
function rebuild(events: HistoryEvent[], limits: HistoryLimits = WIDE) {
  return reconstructHistory(events, limits).messages;
}

describe("reconstructHistory", () => {
  it("rebuilds user turns, assistant tool calls and their results", () => {
    const events: HistoryEvent[] = [
      user("hi", "u1", "t1"),
      assistant("a", "m1", "t1"),
      event(
        "tool.started",
        {
          toolCallId: "call_1",
          title: "Read note.txt",
          kind: "read",
          toolName: "fs.read",
          argumentsJson: JSON.stringify({ path: "note.txt" }),
        },
        "t1",
      ),
      event("tool.output", { toolCallId: "call_1", chunk: "x" }, "t1"),
      event("tool.completed", { toolCallId: "call_1", status: "completed" }, "t1"),
      user("again", "u2", "t2"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "a",
        toolCalls: [{ id: "call_1", name: "fs.read", arguments: '{"path":"note.txt"}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "fs.read", text: "x" },
      { role: "user", text: "again" },
    ]);
  });

  it("replays the provider's own tool name and raw arguments", () => {
    const events: HistoryEvent[] = [
      assistant("running", "m1", "t1"),
      event(
        "tool.started",
        {
          toolCallId: "call_1",
          title: "Read note.txt",
          toolName: "fs.read",
          argumentsJson: JSON.stringify({ path: "note.txt", limit: 4 }),
        },
        "t1",
      ),
      event("tool.completed", { toolCallId: "call_1", status: "completed" }, "t1"),
    ];

    expect(rebuild(events)).toEqual([
      {
        role: "assistant",
        text: "running",
        toolCalls: [{ id: "call_1", name: "fs.read", arguments: '{"path":"note.txt","limit":4}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "fs.read", text: "" },
    ]);
  });

  it("drops a tool call the log cannot name instead of inventing a function", () => {
    const events: HistoryEvent[] = [
      user("go", "u1", "t1"),
      assistant("a", "m1", "t1"),
      // Written before the kernel persisted the provider's call: only a display title survives.
      event("tool.started", { toolCallId: "call_1", title: "Read note.txt", kind: "read" }, "t1"),
      event("tool.output", { toolCallId: "call_1", chunk: "x" }, "t1"),
      assistant("b", "m1", "t1"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "ab" },
    ]);
  });

  it("drops a tool call whose stored arguments are not JSON", () => {
    const events: HistoryEvent[] = [
      user("go", "u1", "t1"),
      assistant("running", "m1", "t1"),
      // `parseArguments` tolerates a partial provider fragment, so the log can hold this verbatim.
      event(
        "tool.started",
        { toolCallId: "call_1", title: "Read", toolName: "fs.read", argumentsJson: '{"path":' },
        "t1",
      ),
      event("tool.output", { toolCallId: "call_1", chunk: "x" }, "t1"),
      assistant("finished", "m1", "t1"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "runningfinished" },
    ]);
  });

  it("starts a new assistant message for each settled tool round", () => {
    const events: HistoryEvent[] = [
      user("go", "u1", "t1"),
      event("tool.started", { toolCallId: "call_1", title: "One", toolName: "fs.list", argumentsJson: "{}" }, "t1"),
      event("tool.completed", { toolCallId: "call_1", status: "completed" }, "t1"),
      event("tool.started", { toolCallId: "call_2", title: "Two", toolName: "fs.list", argumentsJson: "{}" }, "t1"),
      event("tool.completed", { toolCallId: "call_2", status: "completed" }, "t1"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "call_1", name: "fs.list", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_1", name: "fs.list", text: "" },
      { role: "assistant", text: "", toolCalls: [{ id: "call_2", name: "fs.list", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_2", name: "fs.list", text: "" },
    ]);
  });

  it("keeps a single assistant message per round and joins text deltas", () => {
    const events: HistoryEvent[] = [
      user("go", "u1", "t1"),
      assistant("Hello", "m1", "t1"),
      assistant(" world", "m1", "t1"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "Hello world" },
    ]);
  });

  it("drops reasoning blocks and unattributable events", () => {
    const events: HistoryEvent[] = [
      user("go", "u1", "t1"),
      event("message.delta", { messageId: "m1", role: "assistant", block: { type: "reasoning", text: "think" } }, "t1"),
      event("message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: "done" } }, "t1"),
      event("session.status", { status: "idle" }, "t1"),
      event("message.delta", { messageId: "u2", role: "user", block: { type: "text", text: "orphan" } }, null),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("carries a failed tool's message as its result", () => {
    const events: HistoryEvent[] = [
      assistant("running", "m1", "t1"),
      event(
        "tool.started",
        { toolCallId: "call_1", title: "echo hi", kind: "shell", toolName: "shell.exec", argumentsJson: '{"command":"echo hi"}' },
        "t1",
      ),
      event("tool.failed", { toolCallId: "call_1", message: "Permission denied by the user" }, "t1"),
      assistant("denied", "m1", "t1"),
    ];

    expect(rebuild(events)).toEqual([
      {
        role: "assistant",
        text: "running",
        toolCalls: [{ id: "call_1", name: "shell.exec", arguments: '{"command":"echo hi"}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "shell.exec", text: "Permission denied by the user" },
      { role: "assistant", text: "denied" },
    ]);
  });

  it("groups a queued turn's prompt ahead of its own assistant events, after the running turn", () => {
    const events: HistoryEvent[] = [
      user("first", "u1", "t1"),
      user("second", "u2", "t2"),
      assistant("first answer", "m1", "t1"),
      assistant("second answer", "m2", "t2"),
    ];

    expect(rebuild(events)).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "second" },
      { role: "assistant", text: "second answer" },
    ]);
  });

  it("drops the oldest whole turn until the estimate fits the budget and reports the count", () => {
    const oldest = "a".repeat(1_000);
    const newest = "b".repeat(1_000);
    const events: HistoryEvent[] = [user(oldest, "u1", "t1"), user(newest, "u2", "t2")];

    // 2,400 - 100 - 2,000 = 300 tokens ≈ 1,200 chars: the 1,000-char tail fits, both do not.
    const trimmed = reconstructHistory(events, { contextWindow: 2_400, maxTokens: 100 });
    expect(trimmed.messages).toEqual([{ role: "user", text: newest }]);
    expect(trimmed.trimmedTurns).toBe(1);
    // 4,000 - 2,000 = 2,000 tokens ≈ 8,000 chars: the whole 2,000-char log fits.
    const whole = reconstructHistory(events, { contextWindow: 4_000, maxTokens: null });
    expect(whole.messages).toHaveLength(2);
    expect(whole.trimmedTurns).toBe(0);
  });

  it("never splits a turn and never drops the newest one", () => {
    const events: HistoryEvent[] = [
      user("c".repeat(1_000), "u1", "t1"),
      assistant("d".repeat(1_000), "m1", "t1"),
      user("e".repeat(4_000), "u2", "t2"),
      assistant("f".repeat(4_000), "m2", "t2"),
    ];

    expect(rebuild(events, { contextWindow: 2_400, maxTokens: 100 })).toEqual([
      { role: "user", text: "e".repeat(4_000) },
      { role: "assistant", text: "f".repeat(4_000) },
    ]);

    // The newest turn alone overflows a tiny window; it is still kept rather than emptied.
    expect(rebuild(events, { contextWindow: 100, maxTokens: null })).toHaveLength(2);
  });

  it("returns nothing when the log holds no conversation", () => {
    expect(rebuild([event("session.status", { status: "idle" }, null)])).toEqual([]);
  });
});
