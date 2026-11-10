import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { ErrorCodes, ProviderView as ProviderViewSchema, RpcFault, type ApiKind, type ProviderCreateParams } from "@noir/protocol";

export type ProviderView = z.infer<typeof ProviderViewSchema>;

export interface Secrets {
  set(id: string, value: string): void;
  get(id: string): string | null;
  delete(id: string): void;
}

interface ProviderRow { id: string; name: string; base_url: string; api_kind: ApiKind; enabled: number; created_at: number; }

/** An enabled provider plus its vault key, for materializing the engine profile. Never logged. */
export interface EnabledProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: ApiKind;
  /** `null` when the vault entry is missing; profile sync skips that provider. */
  apiKey: string | null;
}

export class ProviderService {
  constructor(private readonly db: Database.Database, private readonly secrets: Secrets) {}

  create(params: ProviderCreateParams): ProviderView {
    const dup = this.db.prepare("SELECT id FROM providers WHERE name = ?").get(params.name);
    if (dup) throw new RpcFault(ErrorCodes.conflict, "Provider name already exists");
    const id = uuidv7();
    const createdAt = Date.now();
    this.secrets.set(id, params.apiKey);
    try {
      this.db.prepare("INSERT INTO providers (id, name, base_url, api_kind, api_key_ref, enabled, created_at) VALUES (?,?,?,?,?,?,?)").run(
        id, params.name, params.baseUrl, params.apiKind, id, params.enabled ? 1 : 0, createdAt,
      );
    } catch (error) {
      this.secrets.delete(id);
      throw error;
    }
    return { id, name: params.name, baseUrl: params.baseUrl, apiKind: params.apiKind, enabled: params.enabled, hasKey: true, createdAt };
  }

  list(): ProviderView[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY created_at DESC").all() as ProviderRow[]).map((r) => ({
      id: r.id, name: r.name, baseUrl: r.base_url, apiKind: r.api_kind,
      enabled: r.enabled === 1, hasKey: this.secrets.get(r.id) !== null, createdAt: r.created_at,
    }));
  }

  /** Enabled providers in insertion order, with their vault key when one exists. */
  enabledWithKeys(): EnabledProvider[] {
    const rows = this.db.prepare("SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC").all() as ProviderRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      apiKind: r.api_kind,
      apiKey: this.secrets.get(r.id),
    }));
  }

  getKey(id: string): string {
    const row = this.db.prepare("SELECT id FROM providers WHERE id = ?").get(id);
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Provider not found");
    const key = this.secrets.get(id);
    if (!key) throw new RpcFault(ErrorCodes.notFound, "Provider key not found");
    return key;
  }

  remove(id: string): void {
    const info = this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    if (info.changes === 0) throw new RpcFault(ErrorCodes.notFound, "Provider not found");
    this.secrets.delete(id);
  }
}
