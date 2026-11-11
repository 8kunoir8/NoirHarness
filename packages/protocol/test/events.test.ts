import { describe, expect, it } from "vitest";
import { PayloadSchemas } from "../src/events.js";

describe("PayloadSchemas", () => {
  it("keeps the kernel restart reason on a status event", () => {
    const parsed = PayloadSchemas["session.status"].parse({ status: "error", reason: "kernel_restart" });
    expect(parsed).toEqual({ status: "error", reason: "kernel_restart" });
  });

  it("accepts a tool.started without a kind and with a kernel kind", () => {
    expect(PayloadSchemas["tool.started"].parse({ toolCallId: "c1", title: "Read a" })).toEqual({
      toolCallId: "c1",
      title: "Read a",
    });
    expect(PayloadSchemas["tool.started"].parse({ toolCallId: "c1", title: "Read a", kind: "read" })).toEqual({
      toolCallId: "c1",
      title: "Read a",
      kind: "read",
    });
    // The engine vocabulary stays out of the wire schema.
    expect(PayloadSchemas["tool.started"].safeParse({ toolCallId: "c1", title: "x", kind: "execute" }).success).toBe(false);
  });

  it("accepts an auto permission decision and rejects anything outside the policy vocabulary", () => {
    expect(PayloadSchemas["permission.auto"].parse({ category: "shell", title: "echo hi", decision: "allow_once" })).toEqual({
      category: "shell",
      title: "echo hi",
      decision: "allow_once",
    });
    expect(
      PayloadSchemas["permission.requested"].safeParse({
        approvalId: "a1",
        category: "launch",
        title: "x",
        options: [{ optionId: "reject", name: "Reject", kind: "reject" }],
      }).success,
    ).toBe(false);
    expect(PayloadSchemas["permission.auto"].safeParse({ category: "shell", title: "x", decision: "ask" }).success).toBe(
      false,
    );
  });
});
