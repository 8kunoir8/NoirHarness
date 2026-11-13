import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { ProjectService } from "../src/projects.js";
import { ScheduleService } from "../src/schedules.js";
import { Scheduler } from "../src/scheduler.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir fire "));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = new Date(2026, 2, 10, 10, 7).getTime();

function setup(startAt = T0) {
  const db = openDb(":memory:");
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const root = tempDir();
  mkdirSync(root, { recursive: true });
  const workspaceId = workspaces.createLocal(projects.add(root).id).id;
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run("ag-1", "A", "default", "acp");

  const schedules = new ScheduleService(db);
  let now = startAt;
  const sessionsCreated: string[] = [];
  const prompts: Array<{ sessionId: string; runId: string; text: string }> = [];
  const timers = new Map<NodeJS.Timeout, { fn: () => void; ms: number; cleared: boolean }>();

  // The scheduler's contract is "this id exists": the run row's FK proves it, so the double
  // inserts a real session instead of inventing an id.
  const createSession = (): string => {
    const id = `sess-${sessionsCreated.length + 1}`;
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)",
    ).run(id, workspaceId, "ag-1", "acp", "starting", now);
    sessionsCreated.push(id);
    return id;
  };
  const prompt = (sessionId: string, runId: string, text: string): Promise<unknown> => {
    prompts.push({ sessionId, runId, text });
    return Promise.resolve();
  };
  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    // A handle the scheduler only ever passes back to clearTimer; it reads no field of it.
    const handle = {} as NodeJS.Timeout;
    timers.set(handle, { fn, ms, cleared: false });
    return handle;
  };
  const clearTimer = (handle: NodeJS.Timeout): void => {
    const entry = timers.get(handle);
    if (entry !== undefined) entry.cleared = true;
  };

  const scheduler = new Scheduler({ schedules, now: () => now, createSession, prompt, setTimer, clearTimer });

  const create = (overrides: Partial<{ intervalMinutes: number; anchorMinutes: number; enabled: boolean }> = {}) =>
    schedules.create(
      {
        workspaceId,
        agentId: "ag-1",
        name: "Nightly",
        prompt: "summarize",
        intervalMinutes: overrides.intervalMinutes ?? 1440,
        anchorMinutes: overrides.anchorMinutes ?? 540,
        enabled: overrides.enabled ?? true,
      },
      now,
    );

  return {
    db,
    schedules,
    scheduler,
    timers,
    sessionsCreated,
    prompts,
    createSession,
    prompt,
    setTimer,
    clearTimer,
    create,
    at: (ms: number) => {
      now = ms;
    },
    now: () => now,
  };
}

describe("Scheduler.tick", () => {
  it("does nothing before the due instant", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt - 1);
    f.scheduler.tick();
    expect(f.sessionsCreated).toEqual([]);
    expect(f.schedules.runs(created.id, 20, undefined).runs).toEqual([]);
  });

  it("fires once, advances, and does not fire again at the same instant", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt);
    f.scheduler.tick();
    f.scheduler.tick();
    const { runs } = f.schedules.runs(created.id, 20, undefined);
    expect(runs.map((run) => run.status)).toEqual(["fired"]);
    expect(runs[0]?.sessionId).toBe("sess-1");
    expect(f.prompts).toEqual([{ sessionId: "sess-1", runId: runs[0]?.id, text: "summarize" }]);
    expect(f.schedules.view(created.id).nextRunAt).toBe(new Date(2026, 2, 12, 9, 0).getTime());
  });

  it("fires when the tick lands a few milliseconds late", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt + 20);
    f.scheduler.tick();
    expect(f.schedules.runs(created.id, 20, undefined).runs.map((run) => run.status)).toEqual(["fired"]);
  });

  it("records one missed run with a count and creates no session", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt + 3 * 86_400_000 + 3_600_000);
    f.scheduler.tick();
    const { runs } = f.schedules.runs(created.id, 20, undefined);
    expect(runs.map((run) => run.status)).toEqual(["missed"]);
    expect(runs[0]?.sessionId).toBeNull();
    expect(runs[0]?.reason).toMatch(/\b4 runs missed\b/);
    expect(f.sessionsCreated).toEqual([]);
    expect(f.schedules.view(created.id).nextRunAt).toBeGreaterThan(f.now());
  });

  it("skips while the previous run is still working and still advances", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt);
    f.scheduler.tick();
    // The fire already created sess-1; a real engine would leave it live while it works.
    f.db.prepare("UPDATE sessions SET status = 'waiting' WHERE id = 'sess-1'").run();
    f.at(created.nextRunAt + 86_400_000);
    f.scheduler.tick();
    const { runs } = f.schedules.runs(created.id, 20, undefined);
    expect(runs.map((run) => run.status)).toEqual(["skipped", "fired"]);
    expect(runs[0]?.reason).toMatch(/still working/);
    expect(f.schedules.view(created.id).nextRunAt).toBeGreaterThan(f.now());
  });

  it("keeps skipping while the same run is still working", () => {
    const f = setup();
    const created = f.create();
    f.at(created.nextRunAt);
    f.scheduler.tick();
    f.db.prepare("UPDATE sessions SET status = 'waiting' WHERE id = 'sess-1'").run();
    // Two more intervals pass with the first session still live: neither may start a second one.
    f.at(created.nextRunAt + 86_400_000);
    f.scheduler.tick();
    f.at(created.nextRunAt + 2 * 86_400_000);
    f.scheduler.tick();
    const { runs } = f.schedules.runs(created.id, 20, undefined);
    expect(runs.map((run) => run.status)).toEqual(["skipped", "skipped", "fired"]);
    expect(f.sessionsCreated).toEqual(["sess-1"]);
  });

  it("records failed and keeps the schedule enabled when the session cannot be created", () => {
    const f = setup();
    const created = f.create();
    const broken = new Scheduler({
      schedules: f.schedules,
      now: f.now,
      createSession: () => {
        throw new Error("Workspace not found");
      },
      prompt: f.prompt,
    });
    f.at(created.nextRunAt);
    broken.tick();
    const { runs } = f.schedules.runs(created.id, 20, undefined);
    expect(runs.map((run) => run.status)).toEqual(["failed"]);
    expect(runs[0]?.reason).toMatch(/Workspace not found/);
    expect(f.schedules.view(created.id).enabled).toBe(true);
  });

  it("does not wait for the turn before arming the next timer", () => {
    const f = setup();
    const created = f.create();
    const never = new Promise<never>(() => undefined);
    const slow = new Scheduler({
      schedules: f.schedules,
      now: f.now,
      createSession: f.createSession,
      prompt: () => never,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
    f.at(created.nextRunAt);
    slow.start();
    expect(f.schedules.runs(created.id, 20, undefined).runs.map((run) => run.status)).toEqual(["fired"]);
    // start() ticked synchronously; the pending prompt must not have blocked arming.
    expect([...f.timers.values()].filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(f.schedules.view(created.id).nextRunAt).toBeGreaterThan(f.now());
    slow.stop();
  });

  it("leaves no armed timer after stop", () => {
    const f = setup();
    f.create();
    f.scheduler.start();
    f.scheduler.stop();
    expect([...f.timers.values()].some((timer) => timer.cleared)).toBe(true);
    expect([...f.timers.values()].filter((timer) => !timer.cleared)).toEqual([]);
  });

  it("clamps an armed delay past the 32-bit limit instead of spinning", () => {
    const f = setup();
    // 69 days out: a bare setTimeout would overflow to 1 ms, fire at once, and re-arm forever.
    f.create({ intervalMinutes: 69 * 1_440 });
    f.scheduler.start();
    const armed = [...f.timers.values()].filter((timer) => !timer.cleared);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.ms).toBe(2 ** 31 - 1);

    // One chunk elapses and the schedule is still far out: it wakes, finds nothing due, and sleeps
    // another full chunk rather than spinning or firing early.
    f.at(f.now() + 2 ** 31 - 1);
    armed[0]?.fn();
    expect(f.sessionsCreated).toEqual([]);
    const next = [...f.timers.values()].filter((timer) => !timer.cleared);
    expect(next).toHaveLength(1);
    expect(next[0]?.ms).toBe(2 ** 31 - 1);
    expect(f.schedules.earliestEnabled()).toBeGreaterThan(f.now());
  });
});

describe("Scheduler.runNow", () => {
  it("fires without moving the cadence and refuses to stack on a live run", () => {
    const f = setup();
    const created = f.create();
    const before = f.schedules.view(created.id).nextRunAt;
    const run = f.scheduler.runNow(created.id);
    expect(run.status).toBe("fired");
    expect(run.sessionId).toBe("sess-1");
    expect(f.schedules.view(created.id).nextRunAt).toBe(before);

    f.db.prepare("UPDATE sessions SET status = 'running' WHERE id = 'sess-1'").run();
    expect(() => f.scheduler.runNow(created.id)).toThrow(RpcFault);
    try {
      f.scheduler.runNow(created.id);
    } catch (error) {
      expect((error as RpcFault).code).toBe(ErrorCodes.conflict);
    }
  });

  it("returns the failed row instead of throwing when the session cannot start", () => {
    const f = setup();
    const created = f.create();
    const broken = new Scheduler({
      schedules: f.schedules,
      now: f.now,
      createSession: () => {
        throw new Error("Agent not found");
      },
      prompt: f.prompt,
    });
    const run = broken.runNow(created.id);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/Agent not found/);
  });
});
