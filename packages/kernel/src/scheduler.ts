import { ErrorCodes, RpcFault, type ScheduleRunStatus, type ScheduleRunView } from "@noir/protocol";
import { occurrencesBetween } from "./cadence.js";
import type { ScheduleRecord, ScheduleService } from "./schedules.js";

/** `setTimeout` stores its delay in 32 bits; a larger one is clamped by the runtime to 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The shortest wait between two attempts, so a row stuck in the past cannot spin the loop. */
const MIN_TIMER_DELAY_MS = 1_000;

/**
 * A tick that lands this far past the due instant is on time. Event-loop latency and a slow disk
 * both fit here; without the slack every fire would record itself as missed.
 */
const DEFAULT_SLACK_MS = 60_000;

export interface SchedulerOptions {
  schedules: ScheduleService;
  /** The seam that lets a test assert a fire without starting an engine. */
  createSession: (schedule: ScheduleRecord) => string;
  prompt: (sessionId: string, runId: string, text: string) => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  slackMs?: number;
}

/**
 * One armed timer aimed at the earliest enabled `next_run_at`. Every decision is recorded before it
 * is acted on, so a crash between the record and the session create reads as "started and died"
 * rather than firing twice.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    this.stopped = false;
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /**
   * Re-aims the timer at whatever is earliest now. A schedule written or resumed through RPC is not
   * seen by a timer armed before it existed, and without this the fire would wait for a restart.
   */
  reschedule(): void {
    this.arm();
  }

  /** Classifies and performs every due schedule. Synchronous: a turn is never awaited. */
  tick(): void {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const now = (this.opts.now ?? Date.now)();
      for (const schedule of this.opts.schedules.due(now)) {
        try {
          this.fire(schedule, now);
        } catch (error) {
          // One bad row must not take the process down or starve the schedules behind it. The
          // record that failed left `next_run_at` in the past, so the arm floor keeps this from
          // becoming a 0 ms loop; the row is retried once per floor.
          this.failed(schedule, now, error);
        }
      }
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  /** Best-effort: moving the broken row past `now` needs a write that may itself be what failed. */
  private failed(schedule: ScheduleRecord, now: number, error: unknown): void {
    try {
      this.opts.schedules.deferAfterFailure(schedule.id, now, messageOf(error));
    } catch {
      // Nothing left to do: the arm floor throttles the retry.
    }
  }

  /** A manual fire. Bypasses the clock but not the overlap rule, and never moves the cadence. */
  runNow(id: string): ScheduleRunView {
    const schedule = this.opts.schedules.record(id);
    if (this.opts.schedules.isRunning(id)) {
      throw new RpcFault(ErrorCodes.conflict, "This schedule is already running");
    }
    const now = (this.opts.now ?? Date.now)();
    const runId = this.opts.schedules.recordManualRun({
      scheduleId: id,
      dueAt: this.opts.schedules.nextDueAt(id, now),
      startedAt: now,
    });
    const sessionId = this.openSession(schedule, runId);
    if (sessionId !== undefined) this.dispatch(sessionId, runId, schedule.prompt);
    return this.opts.schedules.runView(runId);
  }

  private fire(schedule: ScheduleRecord, now: number): void {
    const slack = this.opts.slackMs ?? DEFAULT_SLACK_MS;
    const late = now - schedule.nextRunAt;
    // Overlap first: a run that has been waiting on a person for days is still working, and
    // "skipped, still working" is truer than "missed while the app was closed".
    const status: ScheduleRunStatus = this.opts.schedules.isRunning(schedule.id)
      ? "skipped"
      : late > slack
        ? "missed"
        : "fired";
    const { next, count } = occurrencesBetween(
      schedule.nextRunAt,
      schedule.intervalMinutes,
      now,
      schedule.anchorMinutes,
    );
    const runId = this.opts.schedules.recordRun({
      scheduleId: schedule.id,
      status,
      dueAt: schedule.nextRunAt,
      startedAt: now,
      reason: reasonFor(status, count),
      nextRunAt: next,
    });
    if (status !== "fired") return;
    const sessionId = this.openSession(schedule, runId);
    if (sessionId === undefined) return;
    this.dispatch(sessionId, runId, schedule.prompt);
  }

  /**
   * Deliberately detached: a turn can run for the full engine timeout, and the timer must be free to
   * arm the next schedule meanwhile. A rejection before a turn exists leaves a session that will
   * never start, so the run records why instead of reading "fired" with nothing to show.
   */
  private dispatch(sessionId: string, runId: string, text: string): void {
    void this.opts.prompt(sessionId, runId, text).catch((error: unknown) => {
      this.opts.schedules.failRun(runId, `The prompt never reached the agent: ${messageOf(error)}`);
    });
  }

  /** Creates the session and links it to the run; a failure marks the run and returns undefined. */
  private openSession(schedule: ScheduleRecord, runId: string): string | undefined {
    try {
      const sessionId = this.opts.createSession(schedule);
      this.opts.schedules.attachSession(runId, sessionId);
      return sessionId;
    } catch (error) {
      this.opts.schedules.failRun(runId, messageOf(error));
      return undefined;
    }
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    (this.opts.clearTimer ?? clearTimeout)(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.disarm();
    if (this.stopped) return;
    const next = this.opts.schedules.earliestEnabled();
    if (next === undefined) return;
    const due = next - (this.opts.now ?? Date.now)();
    // A row stuck in the past — a fire that threw before recording itself — would otherwise re-arm
    // at 0 ms and spin. A second between attempts is invisible to a human and cheap for the loop.
    // Node also stores the delay in 32 bits: anything larger silently becomes 1 ms, so a schedule
    // over ~24.8 days out would wake at once and spin the same way. Sleeping the maximum and
    // re-arming is exact, because `tick()` re-reads the clock.
    const delay = Math.min(Math.max(due, MIN_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
    const timer = (this.opts.setTimer ?? setTimeout)(() => this.tick(), delay);
    // Nothing to wake for must not keep the process alive; a test double need not implement it.
    timer.unref?.();
    this.timer = timer;
  }
}

function reasonFor(status: ScheduleRunStatus, count: number): string | null {
  if (status === "missed") return `${count} run${count === 1 ? "" : "s"} missed while the app was closed`;
  if (status === "skipped") return "the previous run was still working";
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
