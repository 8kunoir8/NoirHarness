import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type EngineKind, type PermissionPolicy, type SessionStatus, type SessionView } from "@noir/protocol";
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

export interface SessionRow { id: string; workspaceId: string; agentId: string; engine: EngineKind; title: string; status: SessionStatus; modelId: string | null; createdAt: number; }

export interface SessionCreateOptions { modelId?: string | undefined; agentId?: string | undefined }

/** What a session froze from its agent profile at creation; later profile edits never reach it. */
export interface SessionSnapshot {
  agentId?: string;
  engine?: EngineKind;
  modelId?: string | null;
  permissionPolicy?: PermissionPolicy;
}

interface AgentStartRow { engine_id: EngineKind; model_ref: string | null; permission_policy: string; archived_at: number | null }

/** Missing keys mean `ask`; a hand-edited or older row is read as the defaults rather than breaking session start. */
function parsePolicy(text: string): PermissionPolicy {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as PermissionPolicy) : {};
  } catch {
    return {};
  }
}

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

  /**
   * Starts a session. Without an `agentId` this keeps the M1 behaviour: a fresh `"Agent"` profile row
   * (role `"default"`, engine `"acp"`) and no model, so the kernel default applies at start.
   *
   * With an agent, the profile's engine and model are read once and frozen into `config_snapshot_json`;
   * an explicit `modelId` wins and decides the engine, matching the spec's model resolution order.
   * A null model still means "the kernel default at start", which `engineRegistry` resolves per turn.
   */
  create(workspaceId: string, opts: SessionCreateOptions = {}): SessionRow {
    const ws = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!ws) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");

    let agentId = opts.agentId;
    let modelId = opts.modelId;
    let engine: EngineKind;
    let permissionPolicy: PermissionPolicy = {};

    if (agentId === undefined) {
      engine = modelId === undefined ? "acp" : this.requireEnabledModel(modelId).engine;
      agentId = uuidv7();
      this.db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run(agentId, "Agent", "default", "acp");
    } else {
      const agent = this.agentForStart(agentId);
      modelId = modelId ?? agent.model_ref ?? undefined;
      engine = modelId === undefined ? agent.engine_id : this.requireEnabledModel(modelId).engine;
      permissionPolicy = parsePolicy(agent.permission_policy);
    }

    const snapshot = JSON.stringify({ agentId, engine, modelId: modelId ?? null, permissionPolicy });
    const row: SessionRow = { id: uuidv7(), workspaceId, agentId, engine, title: "", status: "starting", modelId: modelId ?? null, createdAt: Date.now() };
    this.db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at, model_id, config_snapshot_json) VALUES (?,?,?,?,?,?,?,?)").run(
      row.id, row.workspaceId, row.agentId, row.engine, row.status, row.createdAt, row.modelId, snapshot,
    );
    this.events.append({ sessionId: row.id, agentId, type: "session.created", payload: { title: "" }, provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" } });
    this.events.append({ sessionId: row.id, agentId, type: "session.status", payload: { status: "starting" }, provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" } });
    return row;
  }

  /** The config frozen into `config_snapshot_json`; unreadable or foreign JSON reads as empty. */
  snapshot(sessionId: string): SessionSnapshot {
    const row = this.db.prepare("SELECT config_snapshot_json FROM sessions WHERE id = ?").get(sessionId) as
      | { config_snapshot_json: string }
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    try {
      const value: unknown = JSON.parse(row.config_snapshot_json);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SessionSnapshot) : {};
    } catch {
      return {};
    }
  }

  setStatus(sessionId: string, to: SessionStatus, opts?: { from?: SessionStatus; reason?: string }): void {
    const row = this.db.prepare("SELECT status, agent_id, engine FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; agent_id: string; engine: EngineKind } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    const from = opts?.from ?? row.status;
    if (from !== row.status) throw new RpcFault(ErrorCodes.conflict, `Session is ${row.status}, not ${from}`);
    assertTransition(from, to);
    if (to === "closed") {
      this.events.append({ sessionId, agentId: row.agent_id, type: "session.closed", payload: {}, provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" } });
      return;
    }
    const payload = opts?.reason === undefined ? { status: to } : { status: to, reason: opts.reason };
    this.events.append({ sessionId, agentId: row.agent_id, type: "session.status", payload, provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" } });
  }

  /** Switches the session's model. The engine applies it on the next turn; a live engine is not restarted. */
  setModel(sessionId: string, modelId: string): SessionView {
    const row = this.db.prepare("SELECT status, engine FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; engine: EngineKind } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    if (row.status === "closed") throw new RpcFault(ErrorCodes.conflict, "Session is closed");
    const model = this.requireEnabledModel(modelId);
    if (model.engine !== row.engine) throw new RpcFault(ErrorCodes.conflict, "Model engine differs from the session engine");
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

  /** Reads the profile directly: `SessionService` must not depend on `AgentService`, which depends on it. */
  private agentForStart(agentId: string): AgentStartRow {
    const row = this.db.prepare("SELECT engine_id, model_ref, permission_policy, archived_at FROM agents WHERE id = ?").get(agentId) as
      | AgentStartRow
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Agent not found");
    if (row.archived_at !== null) throw new RpcFault(ErrorCodes.conflict, "Agent is archived");
    return row;
  }

  private requireEnabledModel(modelId: string): { engine: EngineKind } {
    const model = this.db.prepare(
      "SELECT m.enabled AS model_enabled, m.engine AS engine, p.enabled AS provider_enabled, p.api_kind AS api_kind FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?",
    ).get(modelId) as { model_enabled: number; engine: EngineKind; provider_enabled: number; api_kind: string } | undefined;
    if (!model) throw new RpcFault(ErrorCodes.notFound, "Model not found");
    if (model.model_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model is disabled");
    if (model.provider_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model provider is disabled");
    if (model.engine === "native" && model.api_kind !== "openai-completions") {
      throw new RpcFault(ErrorCodes.conflict, "Native engine supports openai-completions providers only");
    }
    return model;
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
