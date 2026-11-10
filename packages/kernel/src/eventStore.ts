import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { AgentEvent as AgentEventSchema, PayloadSchemas, type AgentEvent, type EventType } from "@noir/protocol";

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
  constructor(private readonly db: Database.Database, private readonly onEvent?: (event: AgentEvent) => void) {}

  append(input: AppendInput): AgentEvent {
    const payload = PayloadSchemas[input.type].parse(input.payload);
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
