import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type SessionStatus, type SessionView } from "@noir/protocol";
import type { EventStore } from "./eventStore.js";

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  starting: ["idle", "running", "error", "closed"],
  idle: ["running", "closed", "error"],
  running: ["waiting", "idle", "error", "closed"],
  waiting: ["running", "idle", "error", "closed"],
  error: ["idle", "running", "closed"],
  closed: [],
};

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new RpcFault(ErrorCodes.conflict, `Invalid session transition ${from} -> ${to}`);
}

export interface SessionRow { id: string; workspaceId: string; agentId: string; engine: string; title: string; status: SessionStatus; modelId: string | null; createdAt: number; }

interface SessionMeta { lastSeq: number; lastTs: number; pendingApproval: boolean }

function toView(r: Record<string, unknown>, meta: SessionMeta): SessionView {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    engine: r.engine as string,
    title: r.title as string,
    status: r.status as SessionStatus,
    modelId: (r.model_id as string | null) ?? null,
    createdAt: r.created_at as number,
    lastEventSeq: meta.lastSeq,
    lastEventAt: meta.lastTs,
    pendingApproval: meta.pendingApproval,
  };
}

const VIEW_COLUMNS = "id, workspace_id, agent_id, engine, title, status, model_id, created_at";

/** Newest event per session, in one grouped pass; empty sessions fall back to the row's creation time. */
const EVENTS_BY_SESSION = "SELECT session_id, MAX(seq) AS last_seq, MAX(ts) AS last_ts FROM events GROUP BY session_id";

/** Sessions whose newest permission event is still a request. */
const PENDING_APPROVALS = `
  SELECT e.session_id AS session_id
  FROM events e
  JOIN (
    SELECT session_id, MAX(seq) AS seq FROM events
    WHERE type IN ('permission.requested', 'permission.resolved')
    GROUP BY session_id
  ) latest ON latest.session_id = e.session_id AND latest.seq = e.seq
  WHERE e.type = 'permission.requested'`;

function metaFor(
  createdAt: number,
  stats: ReadonlyMap<string, { last_seq: number; last_ts: number }>,
  pending: ReadonlySet<string>,
  sessionId: string,
): SessionMeta {
  const row = stats.get(sessionId);
  return {
    lastSeq: row?.last_seq ?? 0,
    lastTs: row?.last_ts ?? createdAt,
    pendingApproval: pending.has(sessionId),
  };
}

export class SessionService {
  constructor(private readonly db: Database.Database, private readonly events: EventStore) {}

  create(workspaceId: string, modelId?: string): SessionRow {
    const ws = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!ws) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
    if (modelId !== undefined) this.requireEnabledModel(modelId);
    const agentId = uuidv7();
    this.db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run(agentId, "Agent", "default", "acp");
    const row: SessionRow = { id: uuidv7(), workspaceId, agentId, engine: "acp", title: "", status: "starting", modelId: modelId ?? null, createdAt: Date.now() };
    this.db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at, model_id) VALUES (?,?,?,?,?,?,?)").run(
      row.id, row.workspaceId, row.agentId, row.engine, row.status, row.createdAt, row.modelId,
    );
    this.events.append({ sessionId: row.id, agentId, type: "session.created", payload: { title: "" }, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
    this.events.append({ sessionId: row.id, agentId, type: "session.status", payload: { status: "starting" }, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
    return row;
  }

  setStatus(sessionId: string, to: SessionStatus, opts?: { from?: SessionStatus; reason?: string }): void {
    const row = this.db.prepare("SELECT status, agent_id FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; agent_id: string } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    const from = opts?.from ?? row.status;
    if (from !== row.status) throw new RpcFault(ErrorCodes.conflict, `Session is ${row.status}, not ${from}`);
    assertTransition(from, to);
    if (to === "closed") {
      this.events.append({ sessionId, agentId: row.agent_id, type: "session.closed", payload: {}, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
      return;
    }
    const payload = opts?.reason === undefined ? { status: to } : { status: to, reason: opts.reason };
    this.events.append({ sessionId, agentId: row.agent_id, type: "session.status", payload, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
  }

  /** Switches the session's model. The engine applies it on the next turn; a live engine is not restarted. */
  setModel(sessionId: string, modelId: string): SessionView {
    const row = this.db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    if (row.status === "closed") throw new RpcFault(ErrorCodes.conflict, "Session is closed");
    this.requireEnabledModel(modelId);
    this.db.prepare("UPDATE sessions SET model_id = ? WHERE id = ?").run(modelId, sessionId);
    return this.view(sessionId);
  }

  view(sessionId: string): SessionView {
    const row = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    return toView(row, this.metaForOne(row));
  }

  list(): SessionView[] {
    const rows = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];
    const stats = new Map<string, { last_seq: number; last_ts: number }>();
    for (const row of this.db.prepare(EVENTS_BY_SESSION).all() as Array<{ session_id: string; last_seq: number; last_ts: number }>) {
      stats.set(row.session_id, row);
    }
    const pending = new Set((this.db.prepare(PENDING_APPROVALS).all() as Array<{ session_id: string }>).map((row) => row.session_id));
    return rows.map((row) => toView(row, metaFor(row.created_at as number, stats, pending, row.id as string)));
  }

  private requireEnabledModel(modelId: string): void {
    const model = this.db.prepare(
      "SELECT m.enabled AS model_enabled, p.enabled AS provider_enabled FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?",
    ).get(modelId) as { model_enabled: number; provider_enabled: number } | undefined;
    if (!model) throw new RpcFault(ErrorCodes.notFound, "Model not found");
    if (model.model_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model is disabled");
    if (model.provider_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model provider is disabled");
  }

  private metaForOne(row: Record<string, unknown>): SessionMeta {
    const stat = this.db.prepare("SELECT MAX(seq) AS last_seq, MAX(ts) AS last_ts FROM events WHERE session_id = ?")
      .get(row.id as string) as { last_seq: number | null; last_ts: number | null };
    const pending = this.db.prepare(
      "SELECT type FROM events WHERE session_id = ? AND type IN ('permission.requested', 'permission.resolved') ORDER BY seq DESC LIMIT 1",
    ).get(row.id as string) as { type: string } | undefined;
    return {
      lastSeq: stat.last_seq ?? 0,
      lastTs: stat.last_ts ?? (row.created_at as number),
      pendingApproval: pending?.type === "permission.requested",
    };
  }
}
