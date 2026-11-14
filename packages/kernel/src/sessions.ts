import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { canTransition, ErrorCodes, LIVE_STATUSES, statusSqlList, RpcFault, type EngineKind, type PermissionPolicy, type SessionStatus, type SessionView } from "@noir/protocol";
import type { EventStore } from "./eventStore.js";
import type { ModelService } from "./models.js";
import { parsePermissionPolicy } from "./policy.js";

function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) throw new RpcFault(ErrorCodes.conflict, `Invalid session transition ${from} -> ${to}`);
}

export interface SessionListOptions {
  limit?: number | undefined;
  cursor?: string | undefined;
  filter?: "all" | "needs_you" | "working" | "done" | undefined;
  search?: string | undefined;
  workspaceId?: string | undefined;
}

export interface SessionListPage {
  sessions: SessionView[];
  total: number;
  nextCursor: string | null;
}

export interface SessionRow { id: string; workspaceId: string; agentId: string; engine: EngineKind; title: string; status: SessionStatus; modelId: string | null; createdAt: number; }

export interface SessionCreateOptions {
  modelId?: string | undefined;
  agentId?: string | undefined;
  /** The schedule that fired this session; never set for a session a person started. */
  scheduleId?: string | undefined;
}

/** What a session froze from its agent profile at creation; later profile edits never reach it. */
export interface SessionSnapshot {
  agentId?: string;
  engine?: EngineKind;
  modelId?: string | null;
  permissionPolicy?: PermissionPolicy;
}

interface AgentStartRow { engine_id: EngineKind; model_ref: string | null; permission_policy: string; archived_at: number | null }

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
    scheduleId: (r.schedule_id as string | null) ?? null,
    createdAt: r.created_at as number,
    lastEventSeq: meta.lastSeq,
    lastEventAt: meta.lastTs,
    pendingApproval: meta.pendingApproval,
  };
}

const VIEW_COLUMNS = "id, workspace_id, agent_id, engine, title, status, model_id, schedule_id, created_at";
/** A page is what a window can render without scrolling for its life; 200 is a ceiling, not a target. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** Newest event per session, in one grouped pass; empty sessions fall back to the row's creation time. */
const EVENTS_BY_SESSION = "SELECT session_id, MAX(seq) AS last_seq, MAX(ts) AS last_ts FROM events GROUP BY session_id";

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
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventStore,
    private readonly models: ModelService,
  ) {}

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
      // A native session without a model still runs the kernel default per turn, so that default must
      // speak the native protocol; the session row keeps `model_id` NULL and resolves it at start.
      if (engine === "native" && modelId === undefined) this.assertNativeDefault();
      permissionPolicy = parsePermissionPolicy(agent.permission_policy);
    }

    const snapshot = JSON.stringify({ agentId, engine, modelId: modelId ?? null, permissionPolicy });
    const row: SessionRow = { id: uuidv7(), workspaceId, agentId, engine, title: "", status: "starting", modelId: modelId ?? null, createdAt: Date.now() };
    this.db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at, model_id, schedule_id, config_snapshot_json) VALUES (?,?,?,?,?,?,?,?,?)").run(
      row.id, row.workspaceId, row.agentId, row.engine, row.status, row.createdAt, row.modelId, opts.scheduleId ?? null, snapshot,
    );
    this.events.append({
      sessionId: row.id,
      agentId,
      type: "session.created",
      // The witness that reports a finished run needs to know which sessions were fires.
      payload: { title: "", ...(opts.scheduleId === undefined ? {} : { scheduleId: opts.scheduleId }) },
      provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" },
    });
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

  /**
   * The only writer of session status. The transition table is the guard, and it is enforced here
   * rather than at the call sites: a caller that skips a step gets a fault naming both ends instead
   * of a session that quietly went from `starting` to `waiting`. There is no compare-and-set
   * parameter — better-sqlite3 is synchronous, so the read below cannot interleave with another
   * writer, and a caller-supplied `from` would only be a second, weaker copy of the same check.
   */
  setStatus(sessionId: string, to: SessionStatus, opts?: { reason?: string }): void {
    const row = this.db.prepare("SELECT status, agent_id, engine FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; agent_id: string; engine: EngineKind } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    assertTransition(row.status, to);
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

  /**
   * Sets the title the user typed. It travels as a `session.updated` event rather than a bare
   * `UPDATE`, so every window subscribed to the session sees the new name through the same reducer
   * that applies an engine's own title, and the projection updates the row.
   */
  rename(sessionId: string, title: string): SessionView {
    const row = this.db.prepare("SELECT agent_id, engine FROM sessions WHERE id = ?").get(sessionId) as
      | { agent_id: string; engine: EngineKind }
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    this.events.append({
      sessionId,
      agentId: row.agent_id,
      type: "session.updated",
      payload: { title: title.trim() },
      provenance: { engine: row.engine, engineName: "none", adapterVersion: "0" },
    });
    return this.view(sessionId);
  }

  /**
   * Copies a session's conversation into a new one. Lifecycle events stay behind: the fork was never
   * starting, never running and never closed, and replaying the parent's statuses would make it look
   * as though it were. Everything else — messages, tool calls, usage, changed files — comes along in
   * order, so the transcript reads the same and the next turn continues from it.
   */
  fork(sessionId: string, upToSeq?: number): { session: SessionView; copiedEvents: number } {
    const parent = this.db
      .prepare("SELECT workspace_id, agent_id, model_id, title, status FROM sessions WHERE id = ?")
      .get(sessionId) as
      | { workspace_id: string; agent_id: string; model_id: string | null; title: string; status: SessionStatus }
      | undefined;
    if (parent === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");

    const created = this.create(parent.workspace_id, {
      agentId: parent.agent_id,
      ...(parent.model_id === null ? {} : { modelId: parent.model_id }),
    });
    const copiedEvents = this.events.copyPrefix(sessionId, created.id, {
      ...(upToSeq === undefined ? {} : { upToSeq }),
      skip: ["session.created", "session.status", "session.closed"],
    });
    const title = parent.title.trim() === "" ? "Fork" : `Fork of ${parent.title}`;
    this.events.append({
      sessionId: created.id,
      agentId: created.agentId,
      type: "session.updated",
      payload: { title },
      provenance: { engine: created.engine, engineName: "none", adapterVersion: "0" },
    });
    // Nothing is running in a fork, and `starting` would claim a start that never comes.
    this.setStatus(created.id, "idle");
    return { session: this.view(created.id), copiedEvents };
  }

  view(sessionId: string): SessionView {
    const row = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    return toView(row, this.metaForOne(row));
  }

  /**
   * Removes a session and everything it wrote. Turns, events, approvals and file changes leave with
   * it through the schema's cascades, and a schedule run keeps its row with the link cleared. This is
   * the one irreversible call on the session surface, so the RPC handler closes a live session first:
   * an engine still streaming would otherwise write to rows that no longer exist.
   */
  remove(sessionId: string): void {
    const removed = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId).changes;
    if (removed === 0) throw new RpcFault(ErrorCodes.notFound, "Session not found");
  }

  /**
   * One page of sessions, newest first. The filters are answered here rather than in the window:
   * a filter that only sees the current page would quietly hide matches on the pages below it.
   */
  list(opts: SessionListOptions = {}): SessionListPage {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.workspaceId !== undefined) {
      where.push("workspace_id = ?");
      args.push(opts.workspaceId);
    }
    const pendingIds = [...this.pendingSessions()];
    const placeholders = pendingIds.map(() => "?").join(", ");
    switch (opts.filter) {
      case "done":
        where.push("status = 'closed'");
        break;
      case "working":
        // "Working" for a filter is live-but-not-awaiting-you: an approval wait is live and must not
        // hide under the Working tab, which has its own Needs-you tab.
        where.push(`status IN (${statusSqlList(LIVE_STATUSES)})`);
        if (pendingIds.length > 0) {
          where.push(`id NOT IN (${placeholders})`);
          args.push(...pendingIds);
        }
        break;
      case "needs_you":
        if (pendingIds.length > 0) {
          where.push(`(status = 'error' OR id IN (${placeholders}))`);
          args.push(...pendingIds);
        } else {
          where.push("status = 'error'");
        }
        break;
      default:
        break;
    }
    if (opts.search !== undefined && opts.search.trim() !== "") {
      where.push("title LIKE ? ESCAPE '\\'");
      args.push(`%${opts.search.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    const filtered = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM sessions ${filtered}`)
      .get(...args) as { total: number };

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (opts.cursor !== undefined) {
      const [createdAt, id] = opts.cursor.split(/:(.*)/s) as [string, string];
      pageWhere.push("(created_at < ? OR (created_at = ? AND id < ?))");
      pageArgs.push(Number(createdAt), Number(createdAt), id);
    }
    const clause = pageWhere.length === 0 ? "" : `WHERE ${pageWhere.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT ${VIEW_COLUMNS} FROM sessions ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...pageArgs, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      sessions: page.length === 0 ? [] : this.views(page),
      total,
      nextCursor: rows.length > limit && last !== undefined ? `${String(last.created_at as number)}:${String(last.id as string)}` : null,
    };
  }

  /**
   * Every session, newest first. For the kernel's own bookkeeping — the agent roster and the live
   * count — where a page would answer a different question than the one being asked.
   */
  all(): SessionView[] {
    const rows = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions ORDER BY created_at DESC, id DESC`).all() as Array<Record<string, unknown>>;
    return rows.length === 0 ? [] : this.views(rows);
  }

  /**
   * Sessions whose newest visible permission event is still a request.
   *
   * The SQL narrows to candidates that have a permission event at all — or a rewind, which can
   * change the answer — and `visibleMeta` owns the actual verdict, so this filter and the view it
   * filters can never disagree.
   */
  private pendingSessions(): Set<string> {
    const candidates = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM events
          WHERE type IN ('permission.requested', 'permission.resolved', 'session.rewound')`,
      )
      .pluck()
      .all() as string[];
    return new Set(candidates.filter((id) => this.events.visibleMeta(id).pendingApproval));
  }

  /** Fills in the per-session metadata a view carries, for rows already narrowed by `list`. */
  private views(rows: readonly Record<string, unknown>[]): SessionView[] {
    const stats = new Map<string, { last_seq: number; last_ts: number }>();
    for (const row of this.db.prepare(EVENTS_BY_SESSION).all() as Array<{ session_id: string; last_seq: number; last_ts: number }>) {
      stats.set(row.session_id, row);
    }
    const pending = this.pendingSessions();
    // A rewound session's newest events may be abandoned ones, so its meta is computed from the
    // visible log; the grouped query above is still right for every other session.
    const rewound = new Set(
      this.db.prepare("SELECT DISTINCT session_id FROM events WHERE type = 'session.rewound'").pluck().all() as string[],
    );
    return rows.map((row) => {
      const id = row.id as string;
      const meta = rewound.has(id)
        ? this.metaForOne(row)
        : metaFor(row.created_at as number, stats, pending, id);
      return toView(row, meta);
    });
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

  /** The kernel default a native session would fall back to must speak the native protocol. */
  private assertNativeDefault(): void {
    const fallback = this.models.defaultModel();
    if (fallback === undefined) throw new RpcFault(ErrorCodes.conflict, "No model is configured for this session");
    this.models.assertEngine(fallback.providerId, "native");
  }

  private requireEnabledModel(modelId: string): { engine: EngineKind } {
    const model = this.db.prepare(
      "SELECT m.enabled AS model_enabled, m.engine AS engine, p.enabled AS provider_enabled, p.id AS provider_id FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?",
    ).get(modelId) as { model_enabled: number; engine: EngineKind; provider_enabled: number; provider_id: string } | undefined;
    if (!model) throw new RpcFault(ErrorCodes.notFound, "Model not found");
    if (model.model_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model is disabled");
    if (model.provider_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model provider is disabled");
    this.models.assertEngine(model.provider_id, model.engine);
    return model;
  }

  private metaForOne(row: Record<string, unknown>): SessionMeta {
    const meta = this.events.visibleMeta(row.id as string);
    return {
      lastSeq: meta.lastSeq,
      lastTs: meta.lastSeq === 0 ? (row.created_at as number) : meta.lastTs,
      pendingApproval: meta.pendingApproval,
    };
  }
}
