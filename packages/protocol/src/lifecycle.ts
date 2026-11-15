import { SessionStatus } from "./events.js";

/**
 * What each session status means to everything that is not the kernel's own turn loop.
 *
 * The app had this knowledge in nine places with three different answers: `liveness.ts` and
 * `schedules.ts` each kept a private `{starting, running, waiting}` map, `agents.ts` folded
 * "working" out of two of them, the chat composer asked a third question of the same enum, and the
 * renderer re-derived all three from `SessionStatus` in four components. Naming the facts once is
 * what makes them checkable — a status added to the enum now fails every consumer that forgets it,
 * instead of quietly falling into whichever branch the if-chain happened to end on.
 */
export interface SessionStatusFacts {
  /** The session still owns work, so killing the kernel would discard it. A replacement must ask. */
  live: boolean;
  /** A turn is executing. An approval wait is live but not working: nothing runs until it answers. */
  working: boolean;
  /** `session.interrupt` has something to stop. Interrupting an approval wait drops the turn. */
  interruptible: boolean;
  /** Nothing may start here again. The only status that refuses a prompt for being finished. */
  terminal: boolean;
}

export const SESSION_STATUS_FACTS: Readonly<Record<SessionStatus, SessionStatusFacts>> = {
  idle: { live: false, working: false, interruptible: false, terminal: false },
  // `starting` is what a session is born as: the row exists, no turn has ever reached it. It says
  // nothing about work — a chat created a second ago and one whose engine is coming up for its first
  // turn both carry it — so "a turn is in flight" is a `turns` row, which only the kernel can read.
  starting: { live: true, working: false, interruptible: false, terminal: false },
  running: { live: true, working: true, interruptible: true, terminal: false },
  waiting: { live: true, working: false, interruptible: true, terminal: false },
  error: { live: false, working: false, interruptible: false, terminal: false },
  closed: { live: false, working: false, interruptible: false, terminal: true },
};

const statusesWhere = (fact: keyof SessionStatusFacts): readonly SessionStatus[] =>
  SessionStatus.options.filter((status) => SESSION_STATUS_FACTS[status][fact]);

export const LIVE_STATUSES = statusesWhere("live");
export const WORKING_STATUSES = statusesWhere("working");
export const INTERRUPTIBLE_STATUSES = statusesWhere("interruptible");

/**
 * A SQL `IN` list for the same sets, so a query cannot drift from the table above.
 *
 * These are compile-time literals from a closed enum, never user input: the only reason they are
 * interpolated rather than bound is that `status IN ('a','b')` keeps the query readable, and the
 * test beside this module pins the string to the table.
 */
export const statusSqlList = (statuses: readonly SessionStatus[]): string =>
  statuses.map((status) => `'${status}'`).join(",");

/**
 * The legal moves. `closed` is terminal; `error` is not — a failed session resumes on the next
 * prompt. The kernel still decides *when* to move; this only says whether a move is a bug.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  starting: ["idle", "running", "error", "closed"],
  idle: ["running", "closed", "error"],
  running: ["waiting", "idle", "error", "closed"],
  waiting: ["running", "idle", "error", "closed"],
  error: ["idle", "running", "closed"],
  closed: [],
};

export const canTransition = (from: SessionStatus, to: SessionStatus): boolean =>
  SESSION_TRANSITIONS[from].includes(to);
