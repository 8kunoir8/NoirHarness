import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, SessionView } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import { Chat } from "../src/renderer/Chat.js";
import { Composer, type ComposerProps } from "../src/renderer/Composer.js";

function composerProps(patch: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: "",
    onDraftChange: () => undefined,
    status: "idle",
    queued: false,
    hasApproval: false,
    sendDisabled: false,
    onSend: vi.fn(),
    onQueue: vi.fn(),
    onInterrupt: vi.fn(),
    onCancelQueued: vi.fn(),
    ...patch,
  };
}

function event(seq: number, type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    v: 1,
    id: `e-${seq}`,
    seq,
    ts: seq * 100,
    sessionId: "s1",
    agentId: "a1",
    parentAgentId: null,
    turnId: null,
    type,
    payload,
    provenance: { engine: "native", engineName: "test", adapterVersion: "1" },
  };
}

const approval: AgentEvent = event(1, "permission.requested", {
  approvalId: "ap1",
  category: "shell",
  title: "Run tests?",
  options: [
    { optionId: "o1", name: "Allow once", kind: "allow_once" },
    { optionId: "o2", name: "Reject", kind: "reject" },
  ],
});

const session: SessionView = {
  id: "s1",
  workspaceId: "w1",
  agentId: "a1",
  engine: "acp",
  title: "Shell",
  status: "running",
  modelId: null,
  createdAt: 1,
  lastEventSeq: 0,
  lastEventAt: 1,
  pendingApproval: false,
};

describe("Composer", () => {
  it("sends on Enter and keeps Shift+Enter for newlines", async () => {
    const user = userEvent.setup();
    const props = composerProps({ draft: "hello" });
    render(<Composer {...props} />);
    const prompt = screen.getByLabelText("Prompt");

    await user.type(prompt, "{Enter}");
    expect(props.onSend).toHaveBeenCalledTimes(1);

    await user.type(prompt, "a{Shift>}{Enter}{/Shift}b");
    expect(props.onSend).toHaveBeenCalledTimes(1);
    // The controlled value never changes here, so only the callback proves the newline path.
    expect(props.onQueue).not.toHaveBeenCalled();
  });

  it("queues with ⌘Enter and shows the queue state while streaming", async () => {
    const user = userEvent.setup();
    const props = composerProps({ draft: "later", status: "streaming" });
    const { rerender } = render(<Composer {...props} />);

    await user.type(screen.getByLabelText("Prompt"), "{Meta>}{Enter}{/Meta}");
    expect(props.onQueue).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();

    rerender(<Composer {...props} queued />);
    expect(screen.getByTestId("composer-state").textContent).toContain("Queued");
    await user.click(screen.getByRole("button", { name: /Queued — runs after this turn · Cancel/ }));
    expect(props.onCancelQueued).toHaveBeenCalledTimes(1);
  });

  it("interrupts on Esc while streaming but leaves Esc to an open approval", async () => {
    const user = userEvent.setup();
    const props = composerProps({ status: "streaming" });
    const { rerender } = render(<Composer {...props} />);

    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);

    rerender(<Composer {...composerProps({ status: "streaming", hasApproval: true })} />);
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("Chat queue and approval keys", () => {
  it("shows the queued turn, cancels it through the kernel, and interrupts with ⌘.", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "session.subscribe") {
        return {
          events: [event(1, "session.status", { status: "running" }), event(2, "turn.started", { turnId: "t1", index: 0 })],
          lastSeq: 2,
        };
      }
      if (method === "session.prompt") return { turnId: "t2", queued: true };
      if (method === "session.cancelQueued") return { cancelled: true };
      if (method === "session.interrupt") return { interrupted: true };
      throw new Error(method);
    });

    render(<Chat session={session} models={[]} request={request as unknown as RequestFn} />);

    await waitFor(() => expect(screen.getByTestId("session-status").textContent).toBe("running"));
    await user.type(screen.getByLabelText("Prompt"), "second turn");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    const queuedButton = await screen.findByRole("button", { name: /Queued — runs after this turn/ });
    expect(screen.getByTestId("composer-state").textContent).toContain("Queued");

    await user.click(queuedButton);
    expect(request).toHaveBeenCalledWith("session.cancelQueued", { sessionId: "s1", turnId: "t2" });
    await waitFor(() => expect(screen.queryByText(/Queued — runs after this turn/)).toBeNull());

    await user.keyboard("{Meta>}.{/Meta}");
    expect(request).toHaveBeenCalledWith("session.interrupt", { sessionId: "s1" });
  });

  it("answers an approval by number and rejects on Esc", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "session.subscribe") return { events: [approval], lastSeq: 1 };
      if (method === "approval.respond") return { ok: true };
      throw new Error(method);
    });

    render(<Chat session={session} models={[]} request={request as unknown as RequestFn} />);

    await screen.findByRole("dialog", { name: "Permission required" });
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();

    await user.keyboard("1");
    expect(request).toHaveBeenCalledWith("approval.respond", { approvalId: "ap1", decision: "allow_once" });

    await user.keyboard("{Escape}");
    expect(request).toHaveBeenCalledWith("approval.respond", { approvalId: "ap1", decision: "reject" });
  });
});
