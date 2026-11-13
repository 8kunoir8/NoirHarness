import { describe, expect, it } from "vitest";
import {
  ScheduleCreateParams,
  ScheduleListResult,
  ScheduleRunsParams,
  ScheduleRunView,
  ScheduleUpdateParams,
  ScheduleView,
} from "../src/schedules.js";

describe("schedule params", () => {
  it("defaults anchor and enabled, and trims the name", () => {
    const parsed = ScheduleCreateParams.parse({
      workspaceId: "ws-1",
      agentId: "ag-1",
      name: "  Nightly  ",
      prompt: "summarize the diff",
      intervalMinutes: 1440,
    });
    expect(parsed.name).toBe("Nightly");
    expect(parsed.anchorMinutes).toBe(0);
    expect(parsed.enabled).toBe(true);
  });

  it("rejects an interval below one minute and an anchor past end of day", () => {
    const base = { workspaceId: "w", agentId: "a", name: "n", prompt: "p" };
    expect(() => ScheduleCreateParams.parse({ ...base, intervalMinutes: 0 })).toThrow();
    expect(() => ScheduleCreateParams.parse({ ...base, intervalMinutes: 15, anchorMinutes: 1440 })).toThrow();
  });

  it("requires at least one field to change on update", () => {
    expect(() => ScheduleUpdateParams.parse({ id: "s-1" })).toThrow(/at least one field/i);
    expect(ScheduleUpdateParams.parse({ id: "s-1", enabled: false }).enabled).toBe(false);
  });

  it("clamps runs paging to 100 and defaults to 20", () => {
    expect(ScheduleRunsParams.parse({ id: "s-1" }).limit).toBe(20);
    expect(() => ScheduleRunsParams.parse({ id: "s-1", limit: 101 })).toThrow();
  });
});

describe("schedule views", () => {
  it("round-trips a schedule with a null lastRunAt", () => {
    const view = {
      id: "s-1",
      workspaceId: "ws-1",
      agentId: "ag-1",
      name: "Nightly",
      prompt: "p",
      intervalMinutes: 1440,
      anchorMinutes: 540,
      enabled: true,
      nextRunAt: 1_700_000_000_000,
      lastRunAt: null,
      createdAt: 1_600_000_000_000,
      running: false,
    };
    expect(ScheduleView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(ScheduleListResult.parse({ schedules: [view] }).schedules).toHaveLength(1);
  });

  it("accepts a fired run with no session and rejects an unknown status", () => {
    const run = {
      id: "r-1",
      scheduleId: "s-1",
      status: "fired" as const,
      dueAt: 10,
      startedAt: 11,
      sessionId: null,
      reason: null,
    };
    expect(ScheduleRunView.parse(run)).toEqual(run);
    expect(() => ScheduleRunView.parse({ ...run, status: "cancelled" })).toThrow();
  });
});
