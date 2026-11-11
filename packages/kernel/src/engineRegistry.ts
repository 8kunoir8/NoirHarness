import type Database from "better-sqlite3";
import type { EngineStartOptions } from "@noir/engine-core";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import type { ModelService } from "./models.js";
import type { ProviderService } from "./providers.js";

export interface EngineRegistryDeps {
  db: Database.Database;
  providers: ProviderService;
  models: ModelService;
}

/**
 * The enabled model a session's turns run against, completed with the provider endpoint and key.
 *
 * The session's model wins; a session without one uses the kernel default, matching the ACP
 * selector's precedence. The join is inner on that already-resolved id, so "no model chosen"
 * falls back instead of failing to join.
 */
export function resolveModelFor(
  sessionId: string,
  deps: EngineRegistryDeps,
): EngineStartOptions["model"] & { baseUrl: string; apiKey: string } {
  const session = deps.db.prepare("SELECT model_id FROM sessions WHERE id = ?").get(sessionId) as
    | { model_id: string | null }
    | undefined;
  if (session === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");

  const modelId = session.model_id ?? deps.models.defaultModel()?.id;
  if (modelId === undefined) throw new RpcFault(ErrorCodes.conflict, "No model is configured for this session");

  const row = deps.db
    .prepare(
      `SELECT m.model_id, m.context_window, m.max_tokens, p.name AS provider_name, p.base_url, p.id AS provider_id
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1`,
    )
    .get(modelId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new RpcFault(ErrorCodes.conflict, "The session model is disabled or missing");

  return {
    providerName: row.provider_name as string,
    modelId: row.model_id as string,
    contextWindow: row.context_window as number,
    maxTokens: (row.max_tokens as number | null) ?? null,
    baseUrl: row.base_url as string,
    // A missing vault entry throws notFound here, so the turn fails with a message that never carries the key.
    apiKey: deps.providers.getKey(row.provider_id as string),
  };
}
