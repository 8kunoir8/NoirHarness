import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The hook subscribes through the module-level `connect`/`offEvent` pair; a fake registry makes the
// rewind frame deliverable, which is the whole point of the test.
const listeners = new Set<(event: unknown) => void>();
vi.mock("../src/renderer/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/api.js")>();
  return {
    ...actual,
    connect: async (listener: (event: unknown) => void): Promise<void> => void listeners.add(listener),
    offEvent: (listener: (event: unknown) => void): void => void listeners.delete(listener),
  };
});

import { useSessionEvents } from "../src/renderer/events.js";

describe("useSessionEvents after a rewind", () => {
  it("replays from zero so the abandoned turns disappear", async () => {
    let replay = 0;
    const request = <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== "session.subscribe") return Promise.reject(new Error(`unexpected ${method}`));
      // A rebuild must ask for the whole log, including the range a rewind abandoned locally.
      expect(params).toMatchObject({ sessionId: "s-1", sinceSeq: 0 });
      replay += 1;
      // The first replay still holds the message; after the rewind the kernel answers without it.
      const messages = replay === 1
        ? [{ v: 1, id: "e-1", seq: 1, ts: 1, sessionId: "s-1", agentId: "a-1", parentAgentId: null, turnId: "t-1", type: "message.delta", payload: { messageId: "m-1", role: "user", block: { type: "text", text: "gone" } }, provenance: { engine: "acp", engineName: "acp", adapterVersion: "1" } }]
        : [{
            v: 1, id: "e-2", seq: 2, ts: 2, sessionId: "s-1", agentId: "a-1", parentAgentId: null, turnId: null,
            type: "session.rewound",
            payload: { cutSeq: 1, checkpointId: "c-1", promptSeq: 1, restored: 1, deleted: 0, removed: 0, failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true },
            provenance: { engine: "acp", engineName: "acp", adapterVersion: "1" },
          }];
      return Promise.resolve({ events: messages, lastSeq: 2 } as T);
    };

    const { result } = renderHook(() => useSessionEvents("s-1", request));
    await waitFor(() => expect(result.current.state.messages).toHaveLength(1));

    act(() => {
      for (const listener of listeners) {
        listener({
          v: 1, id: "e-2", seq: 2, ts: 2, sessionId: "s-1", agentId: "a-1", parentAgentId: null, turnId: null,
          type: "session.rewound",
          payload: { cutSeq: 1, checkpointId: "c-1", promptSeq: 1, restored: 1, deleted: 0, removed: 0, failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true },
          provenance: { engine: "acp", engineName: "acp", adapterVersion: "1" },
        });
      }
    });

    await waitFor(() => expect(result.current.state.rewinds).toHaveLength(1));
    expect(result.current.state.messages).toHaveLength(0);
    expect(replay).toBe(2);
  });
});
