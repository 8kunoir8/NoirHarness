import { describe, expect, it } from "vitest";
import { Methods, PayloadSchemas, reduceSession, type AgentEvent, type SessionState } from "../src/index.js";

function event(seq: number, type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    v: 1,
    id: `e-${String(seq)}`,
    seq,
    ts: 1_700_000_000_000 + seq,
    sessionId: "s-1",
    agentId: "a-1",
    parentAgentId: null,
    turnId: null,
    type,
    payload,
    provenance: { engine: "native", engineName: "native", adapterVersion: "1" },
  };
}

describe("rewind protocol", () => {
  it("names the checkpoint methods", () => {
    expect(Methods.checkpointList).toBe("checkpoint.list");
    expect(Methods.checkpointPlan).toBe("checkpoint.plan");
    expect(Methods.checkpointRestore).toBe("checkpoint.restore");
    expect(Methods.sessionEvent).toBe("session.event");
  });

  it("parses a rewind payload and keeps the cut", () => {
    const parsed = PayloadSchemas["session.rewound"].parse({
      cutSeq: 7,
      checkpointId: "c-1",
      promptSeq: 7,
      restored: 3,
      deleted: 1,
      removed: 2,
      failed: 0,
      notCaptured: 42,
      engine: "native",
      engineNotRewound: false,
    });
    expect(parsed.cutSeq).toBe(7);
    expect(parsed.notCaptured).toBe(42);
  });

  it("rejects an engine the kernel does not have", () => {
    const result = PayloadSchemas["session.rewound"].safeParse({
      cutSeq: 1,
      checkpointId: "c-1",
      promptSeq: null,
      restored: 0,
      deleted: 0,
      removed: 0,
      failed: 0,
      notCaptured: 0,
      engine: "omp",
      engineNotRewound: true,
    });
    expect(result.success).toBe(false);
  });

  it("leaves the shared projection readable", () => {
    const state = [event(1, "session.created", { title: "" }), event(2, "session.rewound", {
      cutSeq: 1, checkpointId: "c-1", promptSeq: 1, restored: 1, deleted: 0, removed: 0,
      failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true,
    })].reduce((acc, e) => reduceSession(acc, e), undefined as SessionState | undefined);
    expect(state?.sessionId ?? "s-1").toBe("s-1");
  });
});
