import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type SessionStatus, type SessionView } from "@noir/protocol";
import type { EventStore } from "./eventStore.js";

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  starting: ["idle", "error", "closed"],
  idle: ["running", "closed", "error"],
  running: ["waiting", "idle", "error", "closed"],
  waiting: ["running", "idle", "error", "closed"],
  error: ["idle", "closed"],
  closed: [],
};

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new RpcFault(ErrorCodes.conflict, `Invalid session transition ${from} -> ${to}`);
}

export interface SessionRow { id: string; workspaceId: string; agentId: string; engine: string; title: string; status: SessionStatus; modelId: string | null; createdAt: number; }

function toView(r: Record<string, unknown>): SessionView {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    engine: r.engine as string,
    title: r.title as string,
    status: r.status as SessionStatus,
    modelId: (r.model_id as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

const VIEW_COLUMNS = "id, workspace_id, agent_id, engine, title, status, model_id, created_at";

export class SessionService {
  constructor(private readonly db: Database.Database, private readonly events: EventStore) {}

  create(workspaceId: string, modelId?: string): SessionRow {
    const ws = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!ws) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
    if (modelId !== undefined) {
      const model = this.db.prepare(
        "SELECT m.enabled AS model_enabled, p.enabled AS provider_enabled FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?",
      ).get(modelId) as { model_enabled: number; provider_enabled: number } | undefined;
      if (!model) throw new RpcFault(ErrorCodes.notFound, "Model not found");
      if (model.model_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model is disabled");
      if (model.provider_enabled !== 1) throw new RpcFault(ErrorCodes.conflict, "Model provider is disabled");
    }
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

  setStatus(sessionId: string, to: SessionStatus, opts?: { from?: SessionStatus }): void {
    const row = this.db.prepare("SELECT status, agent_id FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; agent_id: string } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    const from = opts?.from ?? row.status;
    if (from !== row.status) throw new RpcFault(ErrorCodes.conflict, `Session is ${row.status}, not ${from}`);
    assertTransition(from, to);
    if (to === "closed") {
      this.events.append({ sessionId, agentId: row.agent_id, type: "session.closed", payload: {}, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
      return;
    }
    this.events.append({ sessionId, agentId: row.agent_id, type: "session.status", payload: { status: to }, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
  }

  view(sessionId: string): SessionView {
    const row = this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    return toView(row);
  }

  list(): SessionView[] {
    return (this.db.prepare(`SELECT ${VIEW_COLUMNS} FROM sessions ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map(toView);
  }
}
