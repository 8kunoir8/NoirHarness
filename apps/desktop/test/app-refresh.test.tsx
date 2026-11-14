import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@noir/protocol";

// `App` imports the socket module directly, so the listener it registers can only be reached
// through the same mock the component tree is handed.
const appApi = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  kernelInfo: vi.fn(async () => ({ port: 1, token: "t", buildMatches: true, daemon: true })),
  reportArmed: vi.fn(),
  offEvent: vi.fn((_listener?: unknown) => undefined),
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
    throw new Error("unmocked request");
  }),
}));
vi.mock("../src/renderer/api.js", () => appApi);

import { App } from "../src/renderer/App.js";

const WORKSPACE = {
  id: "w1",
  projectId: "p1",
  path: "C:/ws",
  branch: "main",
  kind: "git",
  status: "clean",
};

/** A broadcast frame; the shell's listener only reads `type` for this decision. */
function frame(type: AgentEvent["type"]): AgentEvent {
  return {
    v: 1,
    id: `${type}-1`,
    seq: 1,
    ts: 1,
    sessionId: "s1",
    agentId: "a1",
    parentAgentId: null,
    turnId: null,
    type,
    payload: {},
    provenance: { engine: "native", engineName: "test", adapterVersion: "1" },
  };
}

describe("App file-event refresh", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("rescans git after a rewind has rewritten the work tree", async () => {
    const listeners: Array<(event: AgentEvent) => void> = [];
    // `loadAll` connects first without a listener; the subscription effect is the call that carries one.
    appApi.connect.mockImplementation(async (listener?: unknown) => {
      if (typeof listener === "function") listeners.push(listener as (event: AgentEvent) => void);
    });
    appApi.request.mockReset();
    appApi.request.mockImplementation(async (method: string): Promise<unknown> => {
      switch (method) {
        case "system.health":
          return { status: "ok", pid: 1, engineDir: "engine" };
        case "project.list":
          return { projects: [] };
        case "workspace.list":
          return { workspaces: [WORKSPACE] };
        case "model.list":
          return { models: [] };
        case "session.list":
          return { sessions: [], total: 0, nextCursor: null };
        case "session.subscribe":
          return { events: [], lastSeq: 0 };
        case "git.status":
          return { branch: "main", ahead: 0, behind: 0, files: [] };
        default:
          throw new Error(method);
      }
    });

    render(<App />);

    // The workspace landing is what schedules the first scan; only then is a second one meaningful.
    await waitFor(() =>
      expect(appApi.request.mock.calls.filter(([method]) => method === "git.status")).toHaveLength(1),
    );
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));

    // The effect re-registers when the workspace lands; the newest listener shares the same refs.
    act(() => {
      listeners.at(-1)!(frame("session.rewound"));
    });
    // The refresh is debounced, so the rewind's scan follows a beat after the frame.
    await waitFor(() =>
      expect(appApi.request.mock.calls.filter(([method]) => method === "git.status")).toHaveLength(2),
    );
  });
});
