import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ErrorCodes,
  RpcFault,
  type ScheduleCreateParams,
  type ScheduleRunStatus,
  type ScheduleRunView,
  type ScheduleUpdateParams,
  type ScheduleView,
} from "@noir/protocol";
import { anchoredOn, nextAfter } from "./cadence.js";

/** The columns a fire needs; narrower than `ScheduleView` because `running` is a query, not a field. */
export interface ScheduleRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  anchorMinutes: number;
  nextRunAt: number;
}

interface ScheduleRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  anchor_minutes: number;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
}

interface RunRow {
  id: string;
  schedule_id: string;
  status: ScheduleRunStatus;
  due_at: number;
  started_at: number;
  session_id: string | null;
  reason: string | null;
}

const COLUMNS =
  "id, workspace_id, agent_id, name, prompt, interval_minutes, anchor_minutes, enabled, next_run_at, last_run_at, created_at";
const RUN_COLUMNS = "id, schedule_id, status, due_at, started_at, session_id, reason";

/** A session in one of these states still owns its schedule: a fire now would double up. */
const ACTIVE_SESSION: Record<string, true> = { starting: true, running: true, waiting: true };

export class ScheduleService {
  constructor(private readonly db: Database.Database) {}

  list(workspaceId?: string): ScheduleView[] {
    const rows = (
      workspaceId === undefined
        ? this.db.prepare(`SELECT ${COLUMNS} FROM schedules ORDER BY name`).all()
        : this.db.prepare(`SELECT ${COLUMNS} FROM schedules WHERE workspace_id = ? ORDER BY name`).all(workspaceId)
    ) as ScheduleRow[];
    return rows.map((row) => this.toView(row));
  }

  view(id: string): ScheduleView {
    return this.toView(this.row(id));
  }

  record(id: string): ScheduleRecord {
    const row = this.row(id);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      name: row.name,
      prompt: row.prompt,
      intervalMinutes: row.interval_minutes,
      anchorMinutes: row.anchor_minutes,
      nextRunAt: row.next_run_at,
    };
  }

  private row(id: string): ScheduleRow {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM schedules WHERE id = ?`).get(id) as ScheduleRow | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Schedule not found");
    return row;
  }

  private toView(row: ScheduleRow): ScheduleView {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      name: row.name,
      prompt: row.prompt,
      intervalMinutes: row.interval_minutes,
      anchorMinutes: row.anchor_minutes,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      running: this.isRunning(row.id),
    };
  }

  /** Enabled schedules whose due instant has arrived, oldest first. */
  due(now: number): ScheduleRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
      .all(now) as Array<{ id: string }>;
    return rows.map((row) => this.record(row.id));
  }

  /** The earliest armed instant, or undefined when nothing is enabled. */
  earliestEnabled(): number | undefined {
    const row = this.db.prepare("SELECT MIN(next_run_at) AS at FROM schedules WHERE enabled = 1").get() as
      | { at: number | null }
      | undefined;
    return row?.at ?? undefined;
  }

  create(input: ScheduleCreateParams, now: number): ScheduleView {
    const workspace = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(input.workspaceId);
    if (workspace === undefined) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
    const agent = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(input.agentId);
    if (agent === undefined) throw new RpcFault(ErrorCodes.notFound, "Agent not found");
    this.assertNameFree(input.workspaceId, input.name, null);

    const id = uuidv7();
    const nextRunAt = nextAfter(anchoredOn(now, input.anchorMinutes), input.intervalMinutes, now);
    this.db
      .prepare(
        `INSERT INTO schedules (id, workspace_id, agent_id, name, prompt, interval_minutes, anchor_minutes, enabled, next_run_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.agentId,
        input.name,
        input.prompt,
        input.intervalMinutes,
        input.anchorMinutes,
        input.enabled ? 1 : 0,
        nextRunAt,
        now,
      );
    return this.view(id);
  }

  update(input: ScheduleUpdateParams, now: number): ScheduleView {
    const existing = this.row(input.id);
    const name = input.name ?? existing.name;
    if (name !== existing.name) this.assertNameFree(existing.workspace_id, name, existing.id);

    const interval = input.intervalMinutes ?? existing.interval_minutes;
    const anchor = input.anchorMinutes ?? existing.anchor_minutes;
    const enabled = input.enabled ?? existing.enabled === 1;
    const cadenceChanged = input.intervalMinutes !== undefined || input.anchorMinutes !== undefined;
    // Re-enabling or re-timing must not replay a wall of `missed` rows for the time it was off.
    const nextRunAt =
      cadenceChanged || (enabled && existing.enabled === 0)
        ? nextAfter(anchoredOn(now, anchor), interval, now)
        : existing.next_run_at;

    this.db
      .prepare(
        "UPDATE schedules SET name = ?, prompt = ?, interval_minutes = ?, anchor_minutes = ?, enabled = ?, next_run_at = ? WHERE id = ?",
      )
      .run(name, input.prompt ?? existing.prompt, interval, anchor, enabled ? 1 : 0, nextRunAt, existing.id);
    return this.view(existing.id);
  }

  remove(id: string): void {
    this.row(id);
    // Runs cascade; sessions keep their transcript and lose only the pointer, by the FK rules.
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /**
   * A run is only live if its own session is. The newest `fired` run answers that, not the newest
   * run: once a skip is recorded the newest row is the skip, and reading it would report a still-
   * working session as free and fire a second one on top of it.
   */
  isRunning(scheduleId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT s.status AS session_status
         FROM schedule_runs r JOIN sessions s ON s.id = r.session_id
         WHERE r.schedule_id = ? AND r.status = 'fired' ORDER BY r.due_at DESC LIMIT 1`,
      )
      .get(scheduleId) as { session_status: string } | undefined;
    return row !== undefined && ACTIVE_SESSION[row.session_status] === true;
  }

  /** A manual run's due instant: after every recorded run, so the (scheduleId, due_at) cursor stays strict. */
  nextDueAt(scheduleId: string, now: number): number {
    const row = this.db
      .prepare("SELECT MAX(due_at) AS at FROM schedule_runs WHERE schedule_id = ?")
      .get(scheduleId) as { at: number | null } | undefined;
    const newest = row?.at ?? null;
    return newest === null ? now : Math.max(now, newest + 1);
  }

  /**
   * Records a fire and advances the schedule in one transaction. Advancing first is what makes a
   * crash between the record and the session create unable to double-fire.
   */
  recordRun(input: {
    scheduleId: string;
    status: ScheduleRunStatus;
    dueAt: number;
    startedAt: number;
    reason: string | null;
    nextRunAt: number;
  }): string {
    const id = uuidv7();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO schedule_runs (id, schedule_id, status, due_at, started_at, session_id, reason) VALUES (?,?,?,?,?,?,?)",
        )
        .run(id, input.scheduleId, input.status, input.dueAt, input.startedAt, null, input.reason);
      this.db
        .prepare("UPDATE schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
        .run(input.nextRunAt, input.startedAt, input.scheduleId);
    })();
    return id;
  }

  /** A manual run does not touch the cadence; only `last_run_at` learns about it. */
  recordManualRun(input: { scheduleId: string; dueAt: number; startedAt: number }): string {
    const id = uuidv7();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO schedule_runs (id, schedule_id, status, due_at, started_at, session_id, reason) VALUES (?,?,?,?,?,?,?)",
        )
        .run(id, input.scheduleId, "fired", input.dueAt, input.startedAt, null, null);
      this.db.prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(input.startedAt, input.scheduleId);
    })();
    return id;
  }

  attachSession(runId: string, sessionId: string): void {
    this.db.prepare("UPDATE schedule_runs SET session_id = ? WHERE id = ?").run(sessionId, runId);
  }

  failRun(runId: string, reason: string): void {
    this.db.prepare("UPDATE schedule_runs SET status = 'failed', reason = ? WHERE id = ?").run(reason, runId);
  }

  runView(runId: string): ScheduleRunView {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Schedule run not found");
    return toRunView(row);
  }

  runs(
    scheduleId: string,
    limit: number,
    before: number | undefined,
  ): { runs: ScheduleRunView[]; nextBefore: number | null } {
    this.row(scheduleId);
    // One row past the page settles whether another page exists; a full page alone cannot.
    const probe = limit + 1;
    const rows = (
      before === undefined
        ? this.db
            .prepare(`SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC LIMIT ?`)
            .all(scheduleId, probe)
        : this.db
            .prepare(
              `SELECT ${RUN_COLUMNS} FROM schedule_runs WHERE schedule_id = ? AND due_at < ? ORDER BY due_at DESC LIMIT ?`,
            )
            .all(scheduleId, before, probe)
    ) as RunRow[];
    const page = rows.slice(0, limit);
    const nextBefore = rows.length > limit ? (page.at(-1)?.due_at ?? null) : null;
    return { runs: page.map(toRunView), nextBefore };
  }

  private assertNameFree(workspaceId: string, name: string, ignoreId: string | null): void {
    const row = this.db
      .prepare("SELECT id FROM schedules WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name) as { id: string } | undefined;
    if (row !== undefined && row.id !== ignoreId) {
      throw new RpcFault(ErrorCodes.conflict, `A schedule named "${name}" already exists in this workspace`);
    }
  }
}

function toRunView(row: RunRow): ScheduleRunView {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status,
    dueAt: row.due_at,
    startedAt: row.started_at,
    sessionId: row.session_id,
    reason: row.reason,
  };
}
