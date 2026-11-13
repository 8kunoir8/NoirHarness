import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, RpcFault, ScheduleCreateParams, ScheduleUpdateParams } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { ProjectService } from "../src/projects.js";
import { ScheduleService } from "../src/schedules.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir sched "));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = new Date(2026, 2, 10, 10, 7).getTime();

function setup() {
  const db = openDb(":memory:");
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const schedule = new ScheduleService(db);
  const root = tempDir();
  mkdirSync(root, { recursive: true });
  const workspace = workspaces.createLocal(projects.add(root).id);
  // A real agent row keeps the foreign key honest without starting an engine.
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run("ag-1", "A", "default", "acp");
  return { db, schedule, workspaceId: workspace.id };
}

function expectFault(fn: () => unknown, code: number, message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcFault);
    expect((error as RpcFault).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    return;
  }
  expect.unreachable("expected RpcFault");
}

const base = { agentId: "ag-1", name: "Nightly", prompt: "summarize", intervalMinutes: 1440, anchorMinutes: 540 };

// The handler parses before it calls the service, so defaults and trimming are the schema's job.
// Feeding the service raw input would test a contract nothing uses.
const createInput = (workspaceId: string, overrides: Record<string, unknown> = {}) =>
  ScheduleCreateParams.parse({ ...base, workspaceId, ...overrides });

describe("ScheduleService create", () => {
  it("computes the first run in the future and lists it", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    expect(created.nextRunAt).toBe(new Date(2026, 2, 11, 9, 0).getTime());
    expect(created.enabled).toBe(true);
    expect(created.running).toBe(false);
    expect(schedule.list(workspaceId).map((row) => row.name)).toEqual(["Nightly"]);
  });

  it("rejects a missing agent and a duplicate name", () => {
    const { schedule, workspaceId } = setup();
    expectFault(() => schedule.create(createInput(workspaceId, { agentId: "nope" }), T0), ErrorCodes.notFound, /Agent/);
    schedule.create(createInput(workspaceId), T0);
    expectFault(() => schedule.create(createInput(workspaceId), T0), ErrorCodes.conflict, /already exists/);
  });
});

describe("ScheduleService update", () => {
  it("keeps nextRunAt when only the prompt changes", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    const updated = schedule.update(ScheduleUpdateParams.parse({ id: created.id, prompt: "  new  " }), T0 + 60_000);
    expect(updated.prompt).toBe("new");
    expect(updated.nextRunAt).toBe(created.nextRunAt);
  });

  it("recomputes nextRunAt from now when the cadence changes", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    const updated = schedule.update(
      ScheduleUpdateParams.parse({ id: created.id, intervalMinutes: 15, anchorMinutes: 0 }),
      T0 + 60_000,
    );
    expect(updated.nextRunAt).toBe(new Date(2026, 2, 10, 10, 15).getTime());
  });

  it("re-aligns instead of recording a missed wall when a stale schedule is enabled", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    schedule.update(ScheduleUpdateParams.parse({ id: created.id, enabled: false }), T0);
    // A week later the stored instant is long past; enabling must not fire a missed row.
    const enabled = schedule.update(
      ScheduleUpdateParams.parse({ id: created.id, enabled: true }),
      T0 + 7 * 86_400_000,
    );
    expect(enabled.nextRunAt).toBeGreaterThan(T0 + 7 * 86_400_000);
    expect(enabled.nextRunAt).toBe(new Date(2026, 2, 18, 9, 0).getTime());
  });

  it("rejects an unknown id and a name taken in the same workspace", () => {
    const { schedule, workspaceId } = setup();
    const first = schedule.create(createInput(workspaceId), T0);
    schedule.create(createInput(workspaceId, { name: "Other" }), T0);
    expectFault(
      () => schedule.update(ScheduleUpdateParams.parse({ id: "nope", prompt: "x" }), T0),
      ErrorCodes.notFound,
      /not found/,
    );
    expectFault(
      () => schedule.update(ScheduleUpdateParams.parse({ id: first.id, name: "Other" }), T0),
      ErrorCodes.conflict,
      /already exists/,
    );
  });
});

describe("ScheduleService runs", () => {
  it("derives running from the newest run's session, and stops counting a closed one", () => {
    const { db, schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)",
    ).run("s-1", workspaceId, "ag-1", "acp", "running", T0);
    const runId = schedule.recordRun({
      scheduleId: created.id,
      status: "fired",
      dueAt: created.nextRunAt,
      startedAt: created.nextRunAt,
      reason: null,
      nextRunAt: created.nextRunAt + 86_400_000,
    });
    schedule.attachSession(runId, "s-1");
    expect(schedule.view(created.id).running).toBe(true);

    db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run("s-1");
    expect(schedule.view(created.id).running).toBe(false);
  });

  it("pages runs on dueAt descending and stops at the end", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    for (let i = 0; i < 3; i += 1) {
      schedule.recordRun({
        scheduleId: created.id,
        status: "skipped",
        dueAt: T0 + i,
        startedAt: T0 + i,
        reason: "busy",
        nextRunAt: T0 + 86_400_000,
      });
    }
    const first = schedule.runs(created.id, 2, undefined);
    expect(first.runs.map((row) => row.dueAt)).toEqual([T0 + 2, T0 + 1]);
    expect(first.nextBefore).toBe(T0 + 1);
    const second = schedule.runs(created.id, 2, first.nextBefore ?? undefined);
    expect(second.runs.map((row) => row.dueAt)).toEqual([T0]);
    expect(second.nextBefore).toBeNull();
  });

  it("advances the schedule and stamps lastRunAt inside the fire transaction", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    const nextRunAt = created.nextRunAt + 86_400_000;
    schedule.recordRun({
      scheduleId: created.id,
      status: "fired",
      dueAt: created.nextRunAt,
      startedAt: created.nextRunAt + 20,
      reason: null,
      nextRunAt,
    });
    const after = schedule.view(created.id);
    expect(after.nextRunAt).toBe(nextRunAt);
    expect(after.lastRunAt).toBe(created.nextRunAt + 20);
  });

  it("keeps manual runs strictly after the newest due instant", () => {
    const { schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    schedule.recordRun({
      scheduleId: created.id,
      status: "fired",
      dueAt: T0,
      startedAt: T0,
      reason: null,
      nextRunAt: created.nextRunAt,
    });
    expect(schedule.nextDueAt(created.id, T0)).toBe(T0 + 1);
    expect(schedule.nextDueAt(created.id, T0 + 5)).toBe(T0 + 5);
  });
});

describe("ScheduleService remove", () => {
  it("drops the runs and keeps the session", () => {
    const { db, schedule, workspaceId } = setup();
    const created = schedule.create(createInput(workspaceId), T0);
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)",
    ).run("s-1", workspaceId, "ag-1", "acp", "idle", T0);
    db.prepare("UPDATE sessions SET schedule_id = ? WHERE id = ?").run(created.id, "s-1");
    const runId = schedule.recordRun({
      scheduleId: created.id,
      status: "fired",
      dueAt: T0,
      startedAt: T0,
      reason: null,
      nextRunAt: created.nextRunAt,
    });
    schedule.attachSession(runId, "s-1");
    schedule.remove(created.id);
    expect(schedule.list(workspaceId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedule_runs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT schedule_id FROM sessions WHERE id = 's-1'").get()).toEqual({ schedule_id: null });
  });
});
