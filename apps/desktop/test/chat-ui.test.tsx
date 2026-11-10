import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionView } from "@noir/protocol";
import { emptyChatState, reduceChat, useSessionEvents } from "../src/renderer/events.js";

const api = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  offEvent: vi.fn((_listener?: unknown) => undefined),
  request: vi.fn(async () => {
    throw new Error("not connected");
  }),
}));
vi.mock("../src/renderer/api.js", () => api);

import { Chat } from "../src/renderer/Chat.js";
import type { RequestFn } from "../src/renderer/api.js";

function makeEvent(seq: number, type: AgentEvent["type"], payload: unknown, sessionId = "s1"): AgentEvent {
  return {
    v: 1,
    id: `e-${sessionId}-${seq}`,
    seq,
    ts: seq,
    sessionId,
    agentId: "a1",
    parentAgentId: null,
    turnId: null,
    type,
    payload,
    provenance: { engine: "native", engineName: "test", adapterVersion: "1" },
  };
}

const session: SessionView = {
  id: "s1",
  workspaceId: "w1",
  agentId: "a1",
  engine: "acp",
  title: "Test session",
  status: "running",
  modelId: null,
  createdAt: 1,
  lastEventSeq: 0,
  lastEventAt: 1,
  pendingApproval: false,
};

describe("reduceChat", () => {
  it("merges deltas by message and marks completion", () => {
    let state = emptyChatState();
    state = reduceChat(state, makeEvent(1, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "text", text: "Hel" },
    }));
    state = reduceChat(state, makeEvent(2, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "text", text: "lo" },
    }));
    state = reduceChat(state, makeEvent(3, "message.completed", { messageId: "m1", status: "done" }));

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.blocks).toEqual([{ kind: "text", text: "Hello" }]);
    expect(state.messages[0]?.status).toBe("done");
    expect(state.lastSeq).toBe(3);
  });

  it("ignores duplicates, stale frames and other sessions", () => {
    const first = reduceChat(emptyChatState(), makeEvent(2, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "text", text: "once" },
    }));
    const duplicate = reduceChat(first, makeEvent(2, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "text", text: "twice" },
    }));
    const stale = reduceChat(first, makeEvent(1, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "text", text: "old" },
    }));
    const other = reduceChat(first, makeEvent(3, "session.status", { status: "idle" }, "s2"));

    expect(duplicate).toBe(first);
    expect(stale).toBe(first);
    expect(other).toBe(first);
    expect(first.messages[0]?.blocks).toEqual([{ kind: "text", text: "once" }]);
  });

  it("tolerates a gap and unknown payloads", () => {
    let state = emptyChatState();
    state = reduceChat(state, makeEvent(5, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "reasoning", text: "thinking" },
    }));
    expect(state.messages[0]?.blocks).toEqual([{ kind: "reasoning", text: "thinking" }]);
    expect(state.lastSeq).toBe(5);

    const unknown = reduceChat(state, makeEvent(6, "engine.raw", { nonsense: true }));
    expect(unknown.lastSeq).toBe(6);
    expect(unknown.messages).toHaveLength(1);
  });
});


/** Chat is a pure view over lifted events; tests need the same shape App supplies. */
function ChatHarness({ request }: { request: RequestFn }) {
  const events = useSessionEvents(session.id, request);
  return <Chat session={session} models={[]} request={request} events={events} />;
}
describe("Chat", () => {
  it("renders streamed text, tool cards and a permission dialog", async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "session.subscribe") {
        return {
          events: [
            makeEvent(1, "message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: "Hello world" } }),
            makeEvent(2, "tool.started", { toolCallId: "t1", title: "Run tests" }),
            makeEvent(3, "tool.completed", { toolCallId: "t1", status: "completed" }),
            makeEvent(4, "permission.requested", {
              approvalId: "ap1",
              category: "shell",
              title: "Allow the shell command?",
              options: [
                { optionId: "o1", name: "Allow once", kind: "allow_once" },
                { optionId: "o2", name: "Allow always", kind: "allow_always" },
                { optionId: "o3", name: "Reject", kind: "reject" },
                { optionId: "o4", name: "Never allow", kind: "reject_always" },
              ],
            }),
          ],
          lastSeq: 4,
        };
      }
      if (method === "approval.respond") return { ok: true };
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} />);

    expect(await screen.findByText("Hello world")).toBeTruthy();
    expect(screen.getByText("Run tests")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Permission required" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Allow always" }));
    expect(request).toHaveBeenCalledWith("approval.respond", { approvalId: "ap1", decision: "allow_always" });
  });

  it("sends prompts on Enter with a fresh requestId and keeps Shift+Enter for newlines", async () => {
    let turns = 0;
    const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === "session.subscribe") return { events: [], lastSeq: 0 };
      if (method === "session.prompt") {
        turns += 1;
        return { turnId: `t-${turns}`, queued: false };
      }
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} />);
    const prompt = screen.getByLabelText("Prompt");

    await userEvent.type(prompt, "hello{Enter}");
    await waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "session.prompt")).toHaveLength(1);
    });

    await userEvent.type(prompt, "a{Shift>}{Enter}{/Shift}b");
    expect((prompt as HTMLTextAreaElement).value).toBe("a\nb");
    expect(request.mock.calls.filter(([method]) => method === "session.prompt")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "session.prompt")).toHaveLength(2);
    });

    const sent = request.mock.calls
      .filter(([method]) => method === "session.prompt")
      .map(([, params]) => params as { requestId: string; content: Array<{ type: string; text: string }> });
    expect(sent[0]?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(sent[1]?.content).toEqual([{ type: "text", text: "a\nb" }]);
    expect(sent[0]?.requestId).not.toBe(sent[1]?.requestId);
  });

  it("shows loaded skills above the transcript", async () => {
    const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
      if (method === "session.subscribe") {
        return {
          events: [
            makeEvent(1, "session.status", { status: "running" }),
            makeEvent(2, "skill.loaded", { name: "demo", scope: "project", hash: "a".repeat(64) }),
          ],
          lastSeq: 2,
        };
      }
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} />);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Skills loaded" }).textContent).toContain("demo"),
    );
  });

  it("shows a failed request and keeps the draft", async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "session.subscribe") return { events: [], lastSeq: 0 };
      if (method === "session.prompt") throw new Error("engine unavailable");
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} />);
    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;

    await userEvent.type(prompt, "keep me");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toContain("engine unavailable");
    expect(prompt.value).toBe("keep me");
  });
});

describe("useSessionEvents", () => {
  it("merges live frames buffered before the replay and unsubscribes on unmount", async () => {
    const listeners: Array<(event: AgentEvent) => void> = [];
    api.connect.mockImplementationOnce(async (listener?: unknown) => {
      listeners.push(listener as (event: AgentEvent) => void);
    });
    const deferred = Promise.withResolvers<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "session.subscribe") return deferred.promise;
      throw new Error(method);
    });

    const { result, unmount } = renderHook(() => useSessionEvents("s1", request as unknown as RequestFn));
    await waitFor(() => expect(listeners).toHaveLength(1));
    const listener = listeners[0]!;

    act(() => {
      listener(makeEvent(2, "message.delta", {
        messageId: "m1", role: "assistant", block: { type: "text", text: "world" },
      }));
    });
    expect(result.current.state.messages).toHaveLength(0);

    await act(async () => {
      deferred.resolve({
        events: [makeEvent(1, "message.delta", {
          messageId: "m1", role: "assistant", block: { type: "text", text: "Hello " },
        })],
        lastSeq: 1,
      });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.state.messages[0]?.blocks).toEqual([{ kind: "text", text: "Hello world" }]);
    });
    expect(result.current.state.lastSeq).toBe(2);

    unmount();
    expect(api.offEvent).toHaveBeenCalledWith(listener);
  });
});
