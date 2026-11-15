import { describe, expect, it } from "vitest";
import { SessionStatus } from "../src/events.js";
import {
  canTransition,
  INTERRUPTIBLE_STATUSES,
  LIVE_STATUSES,
  SESSION_STATUS_FACTS,
  SESSION_TRANSITIONS,
  statusSqlList,
  WORKING_STATUSES,
} from "../src/lifecycle.js";

describe("session status facts", () => {
  it("answers for every status, so a new one cannot fall into a branch by omission", () => {
    for (const status of SessionStatus.options) {
      expect(SESSION_STATUS_FACTS[status]).toBeDefined();
      expect(SESSION_TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.keys(SESSION_STATUS_FACTS).sort()).toEqual([...SessionStatus.options].sort());
    expect(Object.keys(SESSION_TRANSITIONS).sort()).toEqual([...SessionStatus.options].sort());
  });

  it("keeps an approval wait live and interruptible but not working", () => {
    expect(SESSION_STATUS_FACTS.waiting).toEqual({
      live: true,
      working: false,
      interruptible: true,
      terminal: false,
    });
    // A session that failed is resumable, so `error` is neither live nor terminal.
    expect(SESSION_STATUS_FACTS.error).toEqual({
      live: false,
      working: false,
      interruptible: false,
      terminal: false,
    });
  });

  it("derives the status lists from the facts rather than from a second literal", () => {
    expect([...LIVE_STATUSES]).toEqual(["starting", "running", "waiting"]);
    // `starting` is a birth, not work: a session no turn has reached has nothing executing.
    expect([...WORKING_STATUSES]).toEqual(["running"]);
    expect([...INTERRUPTIBLE_STATUSES]).toEqual(["running", "waiting"]);
  });

  it("does not call a session that has never run a turn working", () => {
    expect(SESSION_STATUS_FACTS.starting).toEqual({
      live: true,
      working: false,
      interruptible: false,
      terminal: false,
    });
    expect(SESSION_STATUS_FACTS.running.working).toBe(true);
  });

  it("interpolates the lists as SQL literals, in enum order", () => {
    // Pinned exactly: these strings are spliced into `status IN (…)` queries, so a change here is a
    // change to every query at once and must be deliberate.
    expect(statusSqlList(LIVE_STATUSES)).toBe("'starting','running','waiting'");
    expect(statusSqlList(WORKING_STATUSES)).toBe("'running'");
    expect(statusSqlList([])).toBe("");
  });
});

describe("session transitions", () => {
  it("never leaves a closed session", () => {
    for (const status of SessionStatus.options) expect(canTransition("closed", status)).toBe(false);
  });

  it("allows the moves the kernel makes, and refuses the rest", () => {
    expect(canTransition("idle", "running")).toBe(true);
    expect(canTransition("running", "waiting")).toBe(true);
    expect(canTransition("waiting", "running")).toBe(true);
    expect(canTransition("error", "running")).toBe(true);
    expect(canTransition("starting", "waiting")).toBe(false);
  });
});
