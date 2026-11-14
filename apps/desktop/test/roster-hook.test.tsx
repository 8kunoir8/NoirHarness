import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRosterEntry } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import { useRoster } from "../src/renderer/useRoster.js";

const api = vi.hoisted(() => ({
  connect: vi.fn((): Promise<void> => Promise.resolve()),
  offEvent: vi.fn(),
}));

// Hoisted above the import of `useRoster`, so the hook sees the doubles.
vi.mock("../src/renderer/api.js", () => ({ connect: api.connect, offEvent: api.offEvent }));

function entry(agentId: string): AgentRosterEntry {
  return {
    agentId,
    name: agentId,
    role: "Coder",
    status: "idle",
    activeSessionId: null,
    activeSessionStatus: null,
    activeToolKind: null,
    sessionCount: 0,
    lastActivityAt: 0,
    usage: null,
    pendingApproval: null,
  };
}

/** The hook asks generically; this fake answers one method, so the answer type is the caller's. */
function answering(impl: (method: string) => Promise<unknown>): RequestFn {
  return <T,>(method: string): Promise<T> => impl(method) as Promise<T>;
}

describe("useRoster", () => {
  it("reads the roster only once the socket is open", async () => {
    // The window's own load may still be opening the socket: a request sent now would be refused
    // and the roster would stay empty until an unrelated event arrived.
    let connected = false;
    api.connect.mockImplementation(async () => {
      connected = true;
    });
    const request = answering(async (method) => {
      if (!connected) throw new Error("kernel not connected");
      if (method !== "agent.roster") throw new Error(`unexpected ${method}`);
      return { agents: [entry("a-1")], generatedAt: 1 };
    });

    const { result } = renderHook(() => useRoster(request, { subscribe: true, initial: true }));

    await waitFor(() => expect(result.current.roster?.map((candidate) => candidate.agentId)).toEqual(["a-1"]));
    expect(api.connect).toHaveBeenCalled();
  });

  it("says nobody is in the roster when the read really fails", async () => {
    api.connect.mockImplementation(async () => undefined);
    const request = answering(async () => {
      throw new Error("kernel is down");
    });

    const { result } = renderHook(() => useRoster(request, { subscribe: true, initial: true }));

    await waitFor(() => expect(result.current.roster).toEqual([]));
  });
});
