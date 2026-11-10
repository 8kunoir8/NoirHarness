import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ModelView } from "@noir/protocol";
import { ChatHeader } from "../src/renderer/ChatHeader.js";
import { emptyChatState, reduceChat, type ChatState } from "../src/renderer/events.js";
import { formatDuration, formatTokens } from "../src/renderer/format.js";
import { ToolCard } from "../src/renderer/ToolCard.js";

function event(seq: number, ts: number, type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    v: 1,
    id: `e-${seq}`,
    seq,
    ts,
    sessionId: "s1",
    agentId: "a1",
    parentAgentId: null,
    turnId: null,
    type,
    payload,
    provenance: { engine: "native", engineName: "test", adapterVersion: "1" },
  };
}

function replay(events: AgentEvent[]): ChatState {
  return events.reduce(reduceChat, emptyChatState());
}

describe("reduceChat projections", () => {
  it("tracks usage, files, plan and turn timing across a scripted turn", () => {
    const state = replay([
      event(1, 1_000, "turn.started", { turnId: "t1", index: 0 }),
      event(2, 1_200, "tool.started", { toolCallId: "tool-1", title: "Run tests" }),
      event(3, 1_400, "tool.output", { toolCallId: "tool-1", chunk: "ok" }),
      event(4, 2_000, "usage.updated", {
        inputTokens: 1_200,
        outputTokens: 340,
        contextUsed: 12_000,
        contextWindow: 200_000,
        costUsd: 0.0123,
      }),
      event(5, 2_100, "file.changed", { path: "src/a.ts", change: "modified", add: 4, del: 1 }),
      event(6, 2_200, "file.changed", { path: "src/a.ts", change: "modified", add: 9, del: 2 }),
      event(7, 2_300, "file.changed", { path: "src/b.ts", change: "created", add: 3, del: 0 }),
      event(8, 2_400, "plan.updated", {
        items: [
          { text: "Read the kernel", status: "done" },
          { text: "Wire the shell", status: "active" },
        ],
      }),
      event(9, 6_500, "turn.completed", { turnId: "t1", status: "interrupted" }),
    ]);

    expect(state.usage).toEqual({
      used: 12_000,
      size: 200_000,
      inputTokens: 1_200,
      outputTokens: 340,
      costUsd: 0.0123,
    });
    expect(state.files).toEqual([
      { path: "src/a.ts", change: "modified", add: 9, del: 2 },
      { path: "src/b.ts", change: "created", add: 3, del: 0 },
    ]);
    expect(state.plan.map((item) => item.status)).toEqual(["done", "active"]);
    expect(state.lastTurn).toEqual({ status: "interrupted", ms: 5_500 });
    expect(state.turnStartedAt).toBeUndefined();
    expect(state.activeTurnId).toBeUndefined();
    expect(state.tools[0]?.output).toBe("ok");
  });

  it("keeps the turn timer running until the turn settles", () => {
    const started = replay([event(1, 1_000, "turn.started", { turnId: "t1", index: 0 })]);
    expect(started.turnStartedAt).toBe(1_000);
    expect(started.activeTurnId).toBe("t1");
  });

  it("records a failed turn with its duration and error", () => {
    const state = replay([
      event(1, 1_000, "turn.started", { turnId: "t1", index: 0 }),
      event(2, 3_000, "turn.failed", { turnId: "t1", message: "engine died" }),
    ]);
    expect(state.lastTurn).toEqual({ status: "failed", ms: 2_000 });
    expect(state.error).toBe("engine died");
    expect(state.turnStartedAt).toBeUndefined();
  });
});

describe("stopped sessions", () => {
  it("keeps the restart reason until the next turn starts", () => {
    let state = replay([event(1, 1_000, "session.status", { status: "error", reason: "kernel_restart" })]);
    expect(state.status).toBe("error");
    expect(state.stopReason).toBe("kernel_restart");
    state = reduceChat(state, event(2, 1_100, "turn.started", { turnId: "t2", index: 1 }));
    expect(state.stopReason).toBeUndefined();
  });
});

const models: ModelView[] = [
  {
    id: "m1",
    providerId: "p1",
    modelId: "mock-1",
    displayName: "Mock One",
    contextWindow: 200_000,
    maxTokens: null,
    enabled: true,
    createdAt: 1,
  },
  {
    id: "m2",
    providerId: "p1",
    modelId: "mock-2",
    displayName: "Mock Two",
    contextWindow: 200_000,
    maxTokens: null,
    enabled: true,
    createdAt: 1,
  },
];

describe("ChatHeader", () => {
  it("shows the context meter, picks a model and interrupts", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const onInterrupt = vi.fn();
    render(
      <ChatHeader
        title="Shell work"
        status="running"
        modelId="m1"
        models={models}
        usage={{ used: 50_000, size: 200_000, inputTokens: 1_500, outputTokens: 200, costUsd: 0.02 }}
        turnStartedAt={Date.now()}
        canInterrupt
        onInterrupt={onInterrupt}
        onModelChange={onModelChange}
      />,
    );

    const meter = screen.getByRole("meter", { name: "Context used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByTestId("usage-meter").textContent).toContain("25% of 200k");
    expect(screen.getByTestId("session-status").textContent).toBe("running");

    await user.selectOptions(screen.getByLabelText("Model"), "m2");
    expect(onModelChange).toHaveBeenCalledWith("m2");

    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("hides the interrupt button when the turn is idle", () => {
    render(
      <ChatHeader
        title=""
        status="idle"
        modelId={null}
        models={[]}
        lastTurn={{ status: "completed", ms: 4_200 }}
        canInterrupt={false}
        onInterrupt={() => undefined}
        onModelChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Untitled session" })).toBeTruthy();
    expect(screen.getByText("last turn 4.2s")).toBeTruthy();
  });
});

describe("ToolCard", () => {
  it("keeps the output collapsed once the call settles", () => {
    render(
      <ul>
        <ToolCard tool={{ id: "t1", title: "Run tests", status: "completed", output: "all green" }} />
      </ul>,
    );
    const card = screen.getByTestId("tool-card");
    expect(card.getAttribute("data-status")).toBe("completed");
    expect(card.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("all green")).toBeTruthy();
  });

  it("expands while the call is running", () => {
    render(
      <ul>
        <ToolCard tool={{ id: "t2", title: "Run tests", status: "running", output: "" }} />
      </ul>,
    );
    expect(screen.getByTestId("tool-card").querySelector("details")?.open).toBe(true);
    expect(screen.getByText("No output yet.")).toBeTruthy();
  });
});

describe("format helpers", () => {
  it("rounds tokens and durations for the meters", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_100)).toBe("12k");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatDuration(420)).toBe("0.4s");
    expect(formatDuration(12_300)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });
});
