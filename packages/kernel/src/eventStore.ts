import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { AgentEvent as AgentEventSchema, PayloadSchemas, type AgentEvent, type EventType } from "@noir/protocol";
import { Redactor } from "./redact.js";

export interface AppendInput {
  sessionId: string;
  agentId: string;
  type: EventType;
  payload: unknown;
  parentAgentId?: string | null;
  turnId?: string | null;
  provenance: AgentEvent["provenance"];
  ts?: number;
}

export class EventStore {
  constructor(
    private readonly db: Database.Database,
    private readonly onEvent?: (event: AgentEvent) => void,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  append(input: AppendInput): AgentEvent {
    const payload = PayloadSchemas[input.type].parse(this.redactor.redact(input.payload));
    const tx = this.db.transaction(() => {
      const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?").get(input.sessionId) as { seq: number };
      const event: AgentEvent = AgentEventSchema.parse({
        v: 1, id: uuidv7(), seq, ts: input.ts ?? Date.now(),
        sessionId: input.sessionId, agentId: input.agentId, type: input.type, payload,
        parentAgentId: input.parentAgentId ?? null, turnId: input.turnId ?? null,
        provenance: input.provenance,
      });
      this.db.prepare(`INSERT INTO events (id, session_id, seq, ts, type, agent_id, parent_agent_id, turn_id, payload_json, provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        event.id, event.sessionId, event.seq, event.ts, event.type, event.agentId, event.parentAgentId, event.turnId, JSON.stringify(payload), JSON.stringify(event.provenance),
      );
      this.project(event, payload);
      return event;
    });
    const event = tx();
    this.onEvent?.(event);
    return event;
  }

  /**
   * The ranges a rewind abandoned, as `[from, to)`: `from` is the checkpoint's seq (the turn about
   * to start) and `to` is the rewind event's own seq, which stays visible.
   */
  rewoundRanges(sessionId: string): Array<{ from: number; to: number }> {
    const rows = this.db
      .prepare("SELECT seq, payload_json FROM events WHERE session_id = ? AND type = 'session.rewound' ORDER BY seq ASC")
      .all(sessionId) as Array<{ seq: number; payload_json: string }>;
    const ranges = rows.flatMap((row) => {
      const payload: unknown = JSON.parse(row.payload_json);
      const cut = typeof payload === "object" && payload !== null && "cutSeq" in payload ? payload.cutSeq : undefined;
      return typeof cut === "number" ? [{ from: cut, to: row.seq }] : [];
    });
    // A rewind of a `pre-restore` row cuts at the seq its marker took, so that marker lands inside
    // the new range: the rewind it made is being undone and it hides nothing any more. Latest-first,
    // because only a range that still stands can undo one — a chain of three restores keeps the
    // oldest range when the middle one is itself undone.
    const kept: Array<{ from: number; to: number }> = [];
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const range = ranges[index];
      if (range === undefined) continue;
      if (!kept.some((other) => range.to >= other.from && range.to < other.to)) kept.push(range);
    }
    return kept.reverse();
  }

  /** Everything a reader may see: the log minus the abandoned ranges. */
  visible(sessionId: string, sinceSeq = 0): AgentEvent[] {
    const ranges = this.rewoundRanges(sessionId);
    return this.list(sessionId, sinceSeq).filter(
      (event) => !ranges.some((range) => event.seq >= range.from && event.seq < range.to),
    );
  }

  /** One event by seq, abandoned or not: the marker's `Load the prompt again` reads across the cut. */
  at(sessionId: string, seq: number): AgentEvent | undefined {
    return this.list(sessionId, seq - 1).find((event) => event.seq === seq);
  }

  /** The seq the next append will take, so a turn can name its cut before it writes anything. */
  nextSeq(sessionId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number };
    return row.next;
  }

  /** Newest visible event, without loading the log. Ranges are few, so the clauses are few. */
  visibleMeta(sessionId: string): { lastSeq: number; lastTs: number; pendingApproval: boolean } {
    const ranges = this.rewoundRanges(sessionId);
    const exclusion = ranges.map(() => "AND NOT (seq >= ? AND seq < ?)").join(" ");
    const args = ranges.flatMap((range) => [range.from, range.to]);
    const stat = this.db
      .prepare(`SELECT MAX(seq) AS last_seq, MAX(ts) AS last_ts FROM events WHERE session_id = ? ${exclusion}`)
      .get(sessionId, ...args) as { last_seq: number | null; last_ts: number | null };
    const pending = this.db
      .prepare(
        `SELECT type FROM events WHERE session_id = ? ${exclusion} AND type IN ('permission.requested', 'permission.resolved') ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, ...args) as { type: string } | undefined;
    return { lastSeq: stat.last_seq ?? 0, lastTs: stat.last_ts ?? 0, pendingApproval: pending?.type === "permission.requested" };
  }

  /**
   * Copies one session's history into another, renumbered after whatever the target already has.
   *
   * Inserted rather than re-appended: these events already passed validation and redaction once,
   * and replaying them would re-run projections and announce old turns on a live socket. Ids are
   * fresh because an event id is unique, and the sequence is what replay reads.
   */
  copyPrefix(sourceSessionId: string, targetSessionId: string, opts: { upToSeq?: number; skip?: readonly EventType[] } = {}): number {
    // A marker copied into another session would carry cut seqs that no longer mean anything there,
    // so a fork receives the visible prefix and none of the rewinds that shaped it.
    const skip = new Set<string>([...(opts.skip ?? []), "session.rewound"]);
    const ranges = this.rewoundRanges(sourceSessionId);
    const rows = this.db
      .prepare(
        `SELECT seq, ts, type, agent_id, parent_agent_id, turn_id, payload_json, provenance_json
           FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq ASC`,
      )
      .all(sourceSessionId, opts.upToSeq ?? Number.MAX_SAFE_INTEGER) as Array<{
      seq: number; ts: number; type: string; agent_id: string; parent_agent_id: string | null;
      turn_id: string | null; payload_json: string; provenance_json: string;
    }>;
    const kept = rows.filter(
      (row) => !skip.has(row.type) && !ranges.some((range) => row.seq >= range.from && row.seq < range.to),
    );
    if (kept.length === 0) return 0;
    const insert = this.db.prepare(
      "INSERT INTO events (id, session_id, seq, ts, type, agent_id, parent_agent_id, turn_id, payload_json, provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    const tx = this.db.transaction(() => {
      const { base } = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS base FROM events WHERE session_id = ?")
        .get(targetSessionId) as { base: number };
      kept.forEach((row, index) => {
        insert.run(uuidv7(), targetSessionId, base + index + 1, row.ts, row.type, row.agent_id, row.parent_agent_id, row.turn_id, row.payload_json, row.provenance_json);
      });
    });
    tx();
    return kept.length;
  }

  list(sessionId: string, sinceSeq = 0): AgentEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC").all(sessionId, sinceSeq) as Array<Record<string, unknown>>;
    return rows.map((r) => AgentEventSchema.parse({
      v: 1, id: r.id, seq: r.seq, ts: r.ts, sessionId: r.session_id, agentId: r.agent_id,
      parentAgentId: r.parent_agent_id ?? null, turnId: r.turn_id ?? null,
      type: r.type, payload: JSON.parse(r.payload_json as string),
      provenance: JSON.parse(r.provenance_json as string),
    }));
  }

  private project(event: AgentEvent, payload: unknown): void {
    if (event.type === "session.status") {
      this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run((payload as { status: string }).status, event.sessionId);
    } else if (event.type === "session.updated") {
      this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run((payload as { title: string }).title, event.sessionId);
    } else if (event.type === "session.closed") {
      this.db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(event.ts, event.sessionId);
    } else if (event.type === "turn.started") {
      const p = payload as { turnId: string; index: number };
      // The manager inserts the row before delivering (so queued turns are durable); the event
      // marks the delivery boundary without clobbering the client_request_id.
      this.db.prepare(
        `INSERT INTO turns (id, session_id, idx, status, started_at) VALUES (?,?,?,'running',?)
         ON CONFLICT(id) DO UPDATE SET status = 'running', started_at = excluded.started_at`,
      ).run(p.turnId, event.sessionId, p.index, event.ts);
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      const p = payload as { turnId: string; status?: "completed" | "interrupted" };
      const status = event.type === "turn.completed" ? (p.status ?? "completed") : "failed";
      this.db.prepare("UPDATE turns SET status = ?, ended_at = ? WHERE id = ?").run(status, event.ts, p.turnId);
    } else if (event.type === "file.changed") {
      const p = payload as { path: string; change: string; add: number; del: number };
      this.db.prepare("INSERT INTO file_changes (id, session_id, turn_id, path, change, \"add\", del, applied_at) VALUES (?,?,?,?,?,?,?,?)").run(
        uuidv7(), event.sessionId, event.turnId, p.path, p.change, p.add, p.del, event.ts,
      );
    }
  }
}
