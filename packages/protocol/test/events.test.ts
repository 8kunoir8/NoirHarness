import { describe, expect, it } from "vitest";
import { PayloadSchemas } from "../src/events.js";

describe("PayloadSchemas", () => {
  it("keeps the kernel restart reason on a status event", () => {
    const parsed = PayloadSchemas["session.status"].parse({ status: "error", reason: "kernel_restart" });
    expect(parsed).toEqual({ status: "error", reason: "kernel_restart" });
  });
});
