import { describe, expect, it } from "vitest";
import { formatCadence } from "../src/renderer/format.js";

describe("formatCadence", () => {
  it("names the minute an hourly cadence starts on", () => {
    expect(formatCadence(60, 15)).toBe("hourly at :15");
    expect(formatCadence(60, 0)).toBe("hourly");
  });

  it("names the phase of a sub-hour cadence only when it has one", () => {
    expect(formatCadence(15, 0)).toBe("every 15 min");
    expect(formatCadence(15, 7)).toBe("every 15 min from :07");
    expect(formatCadence(30, 20)).toBe("every 30 min from :20");
  });

  it("says when a cadence starts, never what minute it lands on", () => {
    // A 90-minute cadence hits :15, then :45, then :15 again; "from" is true, "at" would not be.
    expect(formatCadence(90, 15)).toBe("every 90 min from :15");
    expect(formatCadence(120, 5)).toBe("every 120 min from :05");
  });

  it("ignores a wall-clock anchor left over from a daily cadence", () => {
    expect(formatCadence(60, 540)).toBe("hourly");
    expect(formatCadence(15, 540)).toBe("every 15 min");
  });

  it("keeps the daily and weekly forms", () => {
    expect(formatCadence(1_440, 540)).toBe("daily at 09:00");
    expect(formatCadence(7 * 1_440, 540)).toBe("weekly at 09:00");
    expect(formatCadence(3 * 1_440, 0)).toBe("every 3 days at 00:00");
  });
});
