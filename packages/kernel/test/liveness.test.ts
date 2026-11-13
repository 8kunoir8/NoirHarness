import { describe, expect, it } from "vitest";
import type { SessionView } from "@noir/protocol";
import { liveCount } from "../src/liveness.js";

const view = (status: SessionView["status"]) => ({ status }) as SessionView;

describe("liveCount", () => {
  it("counts the states whose death discards work", () => {
    expect(liveCount([view("starting"), view("running"), view("waiting")])).toBe(3);
  });

  it("ignores states that hold nothing", () => {
    expect(liveCount([view("idle"), view("error"), view("closed")])).toBe(0);
    expect(liveCount([view("running"), view("idle")])).toBe(1);
  });
});
