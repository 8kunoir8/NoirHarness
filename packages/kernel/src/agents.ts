import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ErrorCodes,
  PayloadSchemas,
  PermissionCategory,
  RpcFault,
  type AgentCreateParams,
  type AgentRosterEntry,
  type AgentUpdateParams,
  type AgentView,
} from "@noir/protocol";
import type { EventStore } from "./eventStore.js";
import { DEFAULT_AGENT_ID } from "./defaultAgent.js";
import type { ModelService } from "./models.js";
import { parsePermissionPolicy } from "./policy.js";
import type { SessionService } from "./sessions.js";

const STATUS_URGENCY: Record<AgentRosterEntry["status"], number> = {
  needs_you: 0,
  working: 1,
  error: 2,
  idle: 3,
};

/** The newest `permission.requested` for a session, plus the category its approval row kept. */
type ApprovalRequest = {
  seq: number;
  payloadJson: string;
  approvalId: string | null;
  category: PermissionCategory | null;
};

type ActiveSessionState = {
  kind: AgentRosterEntry["activeToolKind"];
  usage: AgentRosterEntry["usage"];
  request: ApprovalRequest | null;
  /** The newest `permission.resolved`; a request is pending only while it is the later event. */
  resolvedSeq: number | null;
};

/** Malformed JSON is no worse than a missing event: both read as `null`. */
function parsePayloadJson(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
}

/**
 * The active session's unanswered approval. It mirrors the session list's rule — a request counts
 * only while it is newer than every resolve — and falls back to the joined approval row's category
 * when the stored payload cannot be read, so the office bubble always has something to show.
 */
function pendingApprovalFrom(state: ActiveSessionState | undefined): AgentRosterEntry["pendingApproval"] {
  const request = state?.request;
  if (request === null || request === undefined) return null;
  const resolvedSeq = state?.resolvedSeq ?? null;
  if (resolvedSeq !== null && resolvedSeq > request.seq) return null;
  const parsed = PayloadSchemas["permission.requested"].safeParse(parsePayloadJson(request.payloadJson));
  if (parsed.success) {
    return { approvalId: parsed.data.approvalId, title: parsed.data.title, category: parsed.data.category };
  }
  if (request.category === null) return null;
  return { approvalId: request.approvalId ?? "", title: "", category: request.category };
}

const AGENT_COLUMNS =
  "id, name, role, engine_id, model_ref, permission_policy, default_workspace_id, mcp_server_ids, archived_at, created_at";

/** A row written before migration 7 has no `mcp_server_ids`; a malformed one reads as no bindings. */
function parseServerIds(text: unknown): string[] {
  if (typeof text !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toView(row: Record<string, unknown>): AgentView {
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as string,
    engineId: row.engine_id as AgentView["engineId"],
    modelRef: (row.model_ref as string | null) ?? null,
    permissionPolicy: parsePermissionPolicy(row.permission_policy as string),
    defaultWorkspaceId: (row.default_workspace_id as string | null) ?? null,
    mcpServerIds: parseServerIds(row.mcp_server_ids),
    archivedAt: (row.archived_at as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

/**
 * Agent profiles. A profile is a template for future sessions: it is read when a session starts and
 * never mutated by a running session, so every write here only affects sessions created afterwards.
 */
export class AgentService {
  constructor(
    private readonly db: Database.Database,
    private readonly models: ModelService,
    private readonly sessions: SessionService,
    private readonly events: EventStore,
  ) {}

  /** Non-archived agents first by default; archived profiles keep their row and their sessions. */
  list(includeArchived = false): AgentView[] {
    const where = includeArchived ? "" : "WHERE archived_at IS NULL";
    const rows = this.db.prepare(`SELECT ${AGENT_COLUMNS} FROM agents ${where} ORDER BY lower(name), id`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map(toView);
  }

  create(params: AgentCreateParams): AgentView {
    if (params.modelRef !== null) this.assertModel(params.engineId, params.modelRef);
    this.assertWorkspace(params.defaultWorkspaceId);
    this.assertNameAvailable(params.name);
    const view: AgentView = {
      id: uuidv7(),
      name: params.name,
      role: params.role,
      engineId: params.engineId,
      modelRef: params.modelRef,
      permissionPolicy: params.permissionPolicy,
      defaultWorkspaceId: params.defaultWorkspaceId,
      mcpServerIds: params.mcpServerIds ?? [],
      archivedAt: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, engine_id, model_ref, permission_policy, default_workspace_id, mcp_server_ids, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        view.id,
        view.name,
        view.role,
        view.engineId,
        view.modelRef,
        JSON.stringify(view.permissionPolicy),
        view.defaultWorkspaceId,
        JSON.stringify(view.mcpServerIds),
        view.createdAt,
      );
    return view;
  }

  /** Applies only the supplied fields; `null` clears `modelRef`/`defaultWorkspaceId` and replaces the policy. */
  update(params: AgentUpdateParams): AgentView {
    const existing = this.view(params.id);
    const engineId = params.engineId ?? existing.engineId;
    const modelRef = params.modelRef === undefined ? existing.modelRef : params.modelRef;
    const defaultWorkspaceId = params.defaultWorkspaceId === undefined ? existing.defaultWorkspaceId : params.defaultWorkspaceId;

    if (params.name !== undefined) this.assertNameAvailable(params.name, params.id);
    // Naming a model or switching the engine is what needs validation; a stored model disabled later
    // must not block editing the rest of the profile.
    if ((params.modelRef !== undefined || params.engineId !== undefined) && modelRef !== null) {
      this.assertModel(engineId, modelRef);
    }
    if (params.defaultWorkspaceId !== undefined) this.assertWorkspace(defaultWorkspaceId);

    const sets: string[] = [];
    const values: unknown[] = [];
    if (params.name !== undefined) {
      sets.push("name = ?");
      values.push(params.name);
    }
    if (params.role !== undefined) {
      sets.push("role = ?");
      values.push(params.role);
    }
    if (params.engineId !== undefined) {
      sets.push("engine_id = ?");
      values.push(engineId);
    }
    if (params.modelRef !== undefined) {
      sets.push("model_ref = ?");
      values.push(modelRef);
    }
    if (params.permissionPolicy !== undefined) {
      sets.push("permission_policy = ?");
      values.push(JSON.stringify(params.permissionPolicy));
    }
    if (params.defaultWorkspaceId !== undefined) {
      sets.push("default_workspace_id = ?");
      values.push(defaultWorkspaceId);
    }
    if (params.mcpServerIds !== undefined) {
      sets.push("mcp_server_ids = ?");
      values.push(JSON.stringify(params.mcpServerIds));
    }
    if (sets.length === 0) return existing;
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...values, params.id);
    return this.view(params.id);
  }

  /**
   * Idempotent in both directions; archiving frees the name for a new non-archived agent. The default
   * profile is the exception: `session.create` resolves it whenever a chat names no agent, so archiving
   * it would leave that call with nothing to start.
   */
  archive(id: string, archived: boolean): void {
    const row = this.db.prepare("SELECT name, archived_at FROM agents WHERE id = ?").get(id) as
      | { name: string; archived_at: number | null }
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Agent not found");
    if ((row.archived_at !== null) === archived) return;
    if (id === DEFAULT_AGENT_ID && archived) {
      throw new RpcFault(ErrorCodes.conflict, "The default agent cannot be archived");
    }
    // Unarchiving into a name taken meanwhile would break the uniqueness invariant.
    if (!archived) this.assertNameAvailable(row.name, id);
    this.db.prepare("UPDATE agents SET archived_at = ? WHERE id = ?").run(archived ? Date.now() : null, id);
  }

  view(id: string): AgentView {
    const row = this.db.prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Agent not found");
    return toView(row);
  }

  /**
   * The office snapshot. Status folds over every session the agent owns with a fixed precedence, so a
   * pending approval is never hidden by a sibling session's error. The active fields describe the
   * newest session that is still open; a closed session has nothing to open.
   */
  roster(): AgentRosterEntry[] {
    const sessions = this.sessions.all();
    // One batched lookup for every open session: the cost stays flat as the roster grows.
    const state = this.openSessionState();
    // Work is a turn in flight, not a status: a chat created a second ago is `starting` too, and an
    // agent with nothing to run must read idle rather than look busy on an empty conversation.
    const executing = this.sessions.executingIds();
    const entries = this.list().map((agent): AgentRosterEntry => {
      const mine = sessions.filter((session) => session.agentId === agent.id);
      // `created_at` is millisecond-granular, so a tie needs the id to stay deterministic.
      const active = mine
        .filter((session) => session.status !== "closed")
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
      const activeState = active === undefined ? undefined : state.get(active.id);
      return {
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        status: mine.some((session) => session.pendingApproval)
          ? "needs_you"
          : mine.some((session) => session.status !== "waiting" && executing.has(session.id))
            ? "working"
            : mine.some((session) => session.status === "error")
              ? "error"
              : "idle",
        activeSessionId: active?.id ?? null,
        activeSessionStatus: active?.status ?? null,
        activeToolKind: activeState?.kind ?? null,
        sessionCount: mine.length,
        lastActivityAt: mine.reduce((latest, session) => Math.max(latest, session.lastEventAt), agent.createdAt),
        usage: activeState?.usage ?? null,
        pendingApproval: pendingApprovalFrom(activeState),
      };
    });
    return entries.sort((a, b) => {
      const byStatus = STATUS_URGENCY[a.status] - STATUS_URGENCY[b.status];
      if (byStatus !== 0) return byStatus;
      const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return byName !== 0 ? byName : a.agentId.localeCompare(b.agentId);
    });
  }

  /**
   * The newest `tool.started` kind, `usage.updated` reading and permission event per open session, in
   * one query. Closed sessions can never be active, so they are excluded before ranking. The
   * approval row is joined so a corrupt request payload still contributes its category.
   *
   * A rewind abandons a range of the log, and the office must not show a tool, a reading or an
   * approval from inside one — the same filter `events.visible` applies, as SQL. Ranges are few and
   * only exist for sessions that were rewound.
   */
  private openSessionState(): Map<string, ActiveSessionState> {
    const rewound = this.db
      .prepare("SELECT DISTINCT session_id FROM events WHERE type = 'session.rewound'")
      .pluck()
      .all() as string[];
    const ranges = rewound.flatMap((sessionId) =>
      this.events.rewoundRanges(sessionId).map((range) => ({ sessionId, ...range })),
    );
    const exclusion = ranges.map(() => "AND NOT (e.session_id = ? AND e.seq >= ? AND e.seq < ?)").join(" ");
    const rows = this.db
      .prepare(
        `SELECT session_id, type, payload_json, seq, approval_id, approval_kind FROM (
           SELECT e.session_id, e.type, e.payload_json, e.seq, a.id AS approval_id, a.kind AS approval_kind,
                  ROW_NUMBER() OVER (PARTITION BY e.session_id, e.type ORDER BY e.seq DESC, e.rowid DESC) AS rn
           FROM events e
           LEFT JOIN approvals a ON a.event_id = e.id
           WHERE e.type IN ('tool.started', 'usage.updated', 'permission.requested', 'permission.resolved')
             AND e.session_id IN (SELECT id FROM sessions WHERE status <> 'closed')
             ${exclusion}
         ) WHERE rn = 1`,
      )
      .all(...ranges.flatMap((range) => [range.sessionId, range.from, range.to])) as Array<{
        session_id: string;
        type: string;
        payload_json: string;
        seq: number;
        approval_id: string | null;
        approval_kind: string | null;
      }>;
    const state = new Map<string, ActiveSessionState>();
    for (const row of rows) {
      const current = state.get(row.session_id) ?? { kind: null, usage: null, request: null, resolvedSeq: null };
      if (row.type === "tool.started") {
        const started = PayloadSchemas["tool.started"].safeParse(parsePayloadJson(row.payload_json));
        current.kind = started.success ? (started.data.kind ?? null) : null;
      } else if (row.type === "usage.updated") {
        const usage = PayloadSchemas["usage.updated"].safeParse(parsePayloadJson(row.payload_json));
        current.usage = usage.success ? { used: usage.data.contextUsed, size: usage.data.contextWindow } : null;
      } else if (row.type === "permission.requested") {
        const category = PermissionCategory.safeParse(row.approval_kind);
        current.request = {
          seq: row.seq,
          payloadJson: row.payload_json,
          approvalId: row.approval_id,
          category: category.success ? category.data : null,
        };
      } else {
        current.resolvedSeq = row.seq;
      }
      state.set(row.session_id, current);
    }
    return state;
  }

  private assertNameAvailable(name: string, exceptId?: string): void {
    const sql =
      exceptId === undefined
        ? "SELECT id FROM agents WHERE lower(name) = lower(?) AND archived_at IS NULL"
        : "SELECT id FROM agents WHERE lower(name) = lower(?) AND archived_at IS NULL AND id <> ?";
    const row = exceptId === undefined ? this.db.prepare(sql).get(name) : this.db.prepare(sql).get(name, exceptId);
    if (row !== undefined) throw new RpcFault(ErrorCodes.conflict, `Agent name already exists: ${name}`);
  }

  private assertModel(engineId: AgentView["engineId"], modelRef: string): void {
    const model = this.models.enabledModel(modelRef);
    if (model === undefined) throw new RpcFault(ErrorCodes.notFound, "Model not found");
    this.models.assertEngine(model.providerId, engineId);
  }

  private assertWorkspace(workspaceId: string | null): void {
    if (workspaceId === null) return;
    const row = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
  }
}
