import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type ModelCreateParams, type ModelView } from "@noir/protocol";

/** An enabled model whose provider is enabled; `providerName` completes the engine selector. */
export interface EnabledModelRef {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
}

const ENABLED_MODEL_SELECT = `
  SELECT m.id AS id, m.provider_id AS provider_id, p.name AS provider_name, m.model_id AS model_id,
         m.created_at AS created_at
  FROM models m
  JOIN providers p ON p.id = m.provider_id
  WHERE m.enabled = 1 AND p.enabled = 1`;

function toRef(row: Record<string, unknown>): EnabledModelRef {
  return {
    id: row.id as string,
    providerId: row.provider_id as string,
    providerName: row.provider_name as string,
    modelId: row.model_id as string,
  };
}

export class ModelService {
  constructor(private readonly db: Database.Database) {}

  /** Every enabled model of an enabled provider, oldest first (the fallback default order). */
  enabledModels(): EnabledModelRef[] {
    const rows = this.db.prepare(`${ENABLED_MODEL_SELECT} ORDER BY m.created_at ASC, m.id ASC`).all() as Array<Record<string, unknown>>;
    return rows.map(toRef);
  }

  enabledModel(id: string): EnabledModelRef | undefined {
    const row = this.db.prepare(`${ENABLED_MODEL_SELECT} AND m.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRef(row);
  }

  /** `settings.defaultModelId` when it still names an enabled model, else the oldest enabled model. */
  defaultModel(): EnabledModelRef | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = 'defaultModelId'").get() as { value_json: string } | undefined;
    if (row !== undefined) {
      try {
        const value: unknown = JSON.parse(row.value_json);
        if (typeof value === "string") {
          const configured = this.enabledModel(value);
          if (configured !== undefined) return configured;
        }
      } catch {
        // A malformed setting falls back to the oldest enabled model.
      }
    }
    return this.enabledModels()[0];
  }


  create(params: ModelCreateParams): ModelView {
    const provider = this.db.prepare("SELECT id FROM providers WHERE id = ?").get(params.providerId);
    if (!provider) throw new RpcFault(ErrorCodes.notFound, "Provider not found");
    const exists = this.db.prepare("SELECT id FROM models WHERE provider_id = ? AND model_id = ?").get(params.providerId, params.modelId);
    if (exists) throw new RpcFault(ErrorCodes.conflict, "Model already exists for this provider");
    const row: ModelView = {
      id: uuidv7(),
      providerId: params.providerId,
      modelId: params.modelId,
      displayName: params.displayName ?? params.modelId,
      contextWindow: params.contextWindow,
      maxTokens: params.maxTokens ?? null,
      enabled: params.enabled,
      createdAt: Date.now(),
    };
    this.db.prepare(
      "INSERT INTO models (id, provider_id, model_id, display_name, context_window, max_tokens, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(row.id, row.providerId, row.modelId, row.displayName, row.contextWindow, row.maxTokens, row.enabled ? 1 : 0, row.createdAt);
    return row;
  }

  list(providerId?: string): ModelView[] {
    const sql = `SELECT m.id, m.provider_id, m.model_id, m.display_name, m.context_window, m.max_tokens,
                        m.enabled, m.created_at
                 FROM models m
                 ${providerId ? "WHERE m.provider_id = ?" : ""}
                 ORDER BY m.display_name`;
    const rows = (providerId ? this.db.prepare(sql).all(providerId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      providerId: r.provider_id as string,
      modelId: r.model_id as string,
      displayName: r.display_name as string,
      contextWindow: (r.context_window as number | null) ?? 200_000,
      maxTokens: (r.max_tokens as number | null) ?? null,
      enabled: (r.enabled as number) === 1,
      createdAt: r.created_at as number,
    }));
  }

  remove(id: string): void {
    const result = this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
    if (result.changes === 0) throw new RpcFault(ErrorCodes.notFound, "Model not found");
  }
}
