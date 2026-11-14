import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionView } from "@noir/protocol";
import {
  appendUserMessage,
  emptyChatState,
  reduceChat,
  runningToolTitle,
  useSessionEvents,
} from "../src/renderer/events.js";

const api = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  reportArmed: vi.fn(),
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
  scheduleId: null,
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

  it("shows an MCP server's startup failure once and ignores other raw payloads", () => {
    const warning = { engine: "mcp", payload: { warning: "calc: spawn ENOENT" } };
    let state = reduceChat(emptyChatState(), makeEvent(1, "engine.raw", warning));
    state = reduceChat(state, makeEvent(2, "engine.raw", warning));
    state = reduceChat(state, makeEvent(3, "engine.raw", { engine: "native", payload: { trimmedTurns: 1 } }));

    expect(state.notices).toEqual(["calc: spawn ENOENT"]);
  });

  it("renders an MCP startup failure as a notice in the transcript", async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method !== "session.subscribe") throw new Error(method);
      return {
        events: [makeEvent(1, "engine.raw", { engine: "mcp", payload: { warning: "calc: spawn ENOENT" } })],
        lastSeq: 1,
      };
    });
    render(<ChatHarness request={request as unknown as RequestFn} />);

    expect(await screen.findByText("calc: spawn ENOENT")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Setup notices" })).toBeTruthy();
  });

  it("surfaces a file ref once and ignores a repeated path", () => {
    let state = reduceChat(emptyChatState(), makeEvent(1, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "file_ref", path: "notes.md" },
    }));
    state = reduceChat(state, makeEvent(2, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "file_ref", path: "notes.md" },
    }));
    state = reduceChat(state, makeEvent(3, "message.delta", {
      messageId: "m1", role: "assistant", block: { type: "diff_ref", path: "notes.md", blobRef: "blob-1" },
    }));

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.blocks).toEqual([{ kind: "file", path: "notes.md" }]);
  });

  it("keeps the first skill.loaded per name", () => {
    let state = reduceChat(emptyChatState(), makeEvent(1, "skill.loaded", { name: "demo", scope: "project", hash: "first" }));
    state = reduceChat(state, makeEvent(2, "skill.loaded", { name: "demo", scope: "global", hash: "second" }));

    expect(state.skillsLoaded).toEqual([{ name: "demo", scope: "project", hash: "first" }]);
  });

  it("ignores the persisted user prompt the sender already rendered", () => {
    const optimistic = appendUserMessage(emptyChatState(), "hello", "req-1");
    const replayed = reduceChat(optimistic, makeEvent(1, "message.delta", {
      messageId: "req-1", role: "user", block: { type: "text", text: "hello" },
    }));
    const completed = reduceChat(replayed, makeEvent(2, "message.completed", { messageId: "req-1", status: "done" }));

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toEqual({ id: "req-1", role: "user", blocks: [{ kind: "text", text: "hello" }], status: "done" });
    expect(completed.lastSeq).toBe(2);
  });

  it("describes the turn with the newest tool still running", () => {
    let state = reduceChat(emptyChatState(), makeEvent(1, "tool.started", { toolCallId: "t1", title: "Read the map" }));
    expect(runningToolTitle(state)).toBe("Read the map");

    state = reduceChat(state, makeEvent(2, "tool.completed", { toolCallId: "t1", status: "completed" }));
    expect(runningToolTitle(state)).toBeUndefined();

    // Two calls in flight: the later one is what the agent is doing now.
    state = reduceChat(state, makeEvent(3, "tool.started", { toolCallId: "t2", title: "Run `pnpm test`" }));
    state = reduceChat(state, makeEvent(4, "tool.started", { toolCallId: "t3", title: "Grepping the tree" }));
    expect(runningToolTitle(state)).toBe("Grepping the tree");

    state = reduceChat(state, makeEvent(5, "tool.failed", { toolCallId: "t3", message: "boom" }));
    expect(runningToolTitle(state)).toBe("Run `pnpm test`");
  });

  it("ignores a second append for a prompt the event log rendered first", () => {
    const streamed = reduceChat(emptyChatState(), makeEvent(1, "message.delta", {
      messageId: "req-2", role: "user", block: { type: "text", text: "hello" },
    }));

    expect(appendUserMessage(streamed, "hello", "req-2")).toBe(streamed);
  });
});


/** Chat is a pure view over lifted events; tests need the same shape App supplies. */
function ChatHarness({ request, onPreview }: { request: RequestFn; onPreview?: (path: string) => void }) {
  const events = useSessionEvents(session.id, request);
  return <Chat session={session} models={[]} request={request} events={events} onPreview={onPreview} />;
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
    expect(screen.queryByRole("group", { name: "Skills loaded" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Allow always" }));
    expect(request).toHaveBeenCalledWith("approval.respond", { approvalId: "ap1", decision: "allow_always" });
  });

  it("offers a preview for a referenced pdf and keeps other files inert", async () => {
    const onPreview = vi.fn();
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "session.subscribe") {
        return {
          events: [
            makeEvent(1, "message.delta", { messageId: "m1", role: "assistant", block: { type: "file_ref", path: "notes.pdf" } }),
            makeEvent(2, "message.delta", { messageId: "m1", role: "assistant", block: { type: "diff_ref", path: "notes.txt", blobRef: "b1" } }),
          ],
          lastSeq: 2,
        };
      }
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} onPreview={onPreview} />);

    expect(await screen.findByText("notes.pdf")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.txt" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Preview notes.pdf" }));
    expect(onPreview).toHaveBeenCalledWith("notes.pdf");
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
    const skills = await screen.findByRole("group", { name: "Skills loaded" });
    expect(skills.textContent).toContain("demo");
    expect(screen.getByTitle("a".repeat(12)).textContent).toBe("demo");

    const transcript = document.querySelector("ol.messages");
    expect(transcript).not.toBeNull();
    expect(skills.compareDocumentPosition(transcript!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders one user bubble when the kernel echoes the prompt back", async () => {
    const listeners: Array<(event: AgentEvent) => void> = [];
    api.connect.mockImplementationOnce(async (listener?: unknown) => {
      listeners.push(listener as (event: AgentEvent) => void);
    });
    const settled = Promise.withResolvers<unknown>();
    const request = vi.fn((method: string, params?: unknown): Promise<unknown> => {
      if (method === "session.subscribe") return Promise.resolve({ events: [], lastSeq: 0 });
      if (method === "session.prompt") {
        const { requestId, content } = params as { requestId: string; content: Array<{ text: string }> };
        // The kernel persists the prompt and broadcasts it before `session.prompt` resolves.
        act(() => {
          listeners[0]!(makeEvent(1, "message.delta", {
            messageId: requestId, role: "user", block: { type: "text", text: content[0]!.text },
          }));
          listeners[0]!(makeEvent(2, "message.completed", { messageId: requestId, status: "done" }));
        });
        return settled.promise;
      }
      throw new Error(method);
    });

    render(<ChatHarness request={request as unknown as RequestFn} />);
    await userEvent.type(screen.getByLabelText("Prompt"), "hello{Enter}");
    await waitFor(() => {
      expect(request.mock.calls.some(([method]) => method === "session.prompt")).toBe(true);
    });

    await act(async () => {
      settled.resolve({ turnId: "t-1", queued: false });
      await settled.promise;
    });

    const bubbles = await screen.findAllByText("hello");
    expect(bubbles).toHaveLength(1);
    expect(document.querySelectorAll("li.message-user")).toHaveLength(1);
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
