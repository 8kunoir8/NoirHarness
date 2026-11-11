import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ErrorCodes,
  RpcFault,
  type AgentCreateParams,
  type AgentUpdateParams,
  type AgentView,
} from "@noir/protocol";
import type { ModelService } from "./models.js";
import { parsePermissionPolicy } from "./policy.js";

const AGENT_COLUMNS = "id, name, role, engine_id, model_ref, permission_policy, default_workspace_id, archived_at, created_at";

function toView(row: Record<string, unknown>): AgentView {
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as string,
    engineId: row.engine_id as AgentView["engineId"],
    modelRef: (row.model_ref as string | null) ?? null,
    permissionPolicy: parsePermissionPolicy(row.permission_policy as string),
    defaultWorkspaceId: (row.default_workspace_id as string | null) ?? null,
    archivedAt: (row.archived_at as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

/**
 * Agent profiles. A profile is a template for future sessions: it is read when a session starts and
 * never mutated by a running session, so every write here only affects sessions created afterwards.
 */
export class AgentService {
  constructor(private readonly db: Database.Database, private readonly models: ModelService) {}

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
      archivedAt: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, engine_id, model_ref, permission_policy, default_workspace_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        view.id,
        view.name,
        view.role,
        view.engineId,
        view.modelRef,
        JSON.stringify(view.permissionPolicy),
        view.defaultWorkspaceId,
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
    if (sets.length === 0) return existing;
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...values, params.id);
    return this.view(params.id);
  }

  /** Idempotent in both directions; archiving frees the name for a new non-archived agent. */
  archive(id: string, archived: boolean): void {
    const row = this.db.prepare("SELECT name, archived_at FROM agents WHERE id = ?").get(id) as
      | { name: string; archived_at: number | null }
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Agent not found");
    if ((row.archived_at !== null) === archived) return;
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
