import { describe, expect, it } from "vitest";
import { advance, anchoredOn, MAX_ADVANCE_STEPS, nextAfter, occurrencesBetween } from "../src/cadence.js";

const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo, d, h, mi).getTime();

describe("advance", () => {
  it("keeps a daily 09:00 schedule at 09:00 on the next local day", () => {
    const next = new Date(advance(at(2026, 2, 10, 9, 0), 1440));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([11, 9, 0]);
  });

  it("carries a sub-day cadence across local midnight", () => {
    const next = new Date(advance(at(2026, 2, 10, 23, 50), 15));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([11, 0, 5]);
  });

  it("lands exactly on midnight when the interval fills the day", () => {
    const next = new Date(advance(at(2026, 2, 10, 0, 0), 1440));
    expect([next.getDate(), next.getHours(), next.getMinutes()]).toEqual([11, 0, 0]);
  });
});

describe("anchoredOn", () => {
  it("is the anchor on the local day of its argument", () => {
    const instant = new Date(anchoredOn(at(2026, 2, 10, 16, 42), 540));
    expect([instant.getDate(), instant.getHours(), instant.getMinutes()]).toEqual([10, 9, 0]);
  });
});

describe("occurrencesBetween", () => {
  it("returns the start untouched when it is still future", () => {
    const start = at(2026, 2, 10, 9, 0);
    expect(occurrencesBetween(start, 1440, at(2026, 2, 10, 8, 0))).toEqual({ next: start, count: 0 });
  });

  it("counts the occurrences a catch-up skips and lands on the next future one", () => {
    // Due daily at 09:00; the app wakes on the 13th at 10:00, so the 10th-13th were missed.
    expect(occurrencesBetween(at(2026, 2, 10, 9, 0), 1440, at(2026, 2, 13, 10, 0))).toEqual({
      next: at(2026, 2, 14, 9, 0),
      count: 4,
    });
  });

  it("re-aligns to the schedule's phase, not the tick's clock, when the budget runs out", () => {
    // A 15-minute cadence anchored on the hour, left closed for two years. The answer must still be
    // a quarter hour, not "one interval after whenever the app happened to open".
    const after = at(2027, 0, 1, 10, 7);
    expect(occurrencesBetween(at(2025, 0, 1, 0, 0), 15, after, 0)).toEqual({
      next: at(2027, 0, 1, 10, 15),
      count: MAX_ADVANCE_STEPS,
    });
  });

  it("re-aligns instead of walking when the gap exceeds the step budget", () => {
    const after = at(2027, 0, 1, 0, 0);
    expect(occurrencesBetween(at(2026, 0, 1, 0, 0), 1, after)).toEqual({
      next: advance(after, 1),
      count: MAX_ADVANCE_STEPS,
    });
  });
});

describe("nextAfter", () => {
  it("is the same answer as occurrencesBetween().next", () => {
    const from = at(2026, 2, 10, 9, 0);
    const after = at(2026, 2, 13, 10, 0);
    expect(nextAfter(from, 1440, after)).toBe(occurrencesBetween(from, 1440, after).next);
  });

  it("keeps a sub-day anchor as the minute each hour lands on", () => {
    // "Hourly at :15": the chain starts on the anchor, so every step is at :15, never :00.
    const start = anchoredOn(at(2026, 2, 10, 9, 0), 15);
    expect(nextAfter(start, 60, at(2026, 2, 10, 10, 0), 15)).toBe(at(2026, 2, 10, 10, 15));
    // Past the step budget the re-aligned answer still carries the phase.
    expect(nextAfter(start, 60, at(2027, 0, 1, 10, 0), 15)).toBe(at(2027, 0, 1, 10, 15));
  });
});

