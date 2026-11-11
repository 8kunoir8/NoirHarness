import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ErrorCodes,
  RpcFault,
  type McpServerCreateParams,
  type McpServerUpdateParams,
  type McpServerView,
} from "@noir/protocol";

interface McpServerRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  env_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** A row whose JSON columns cannot be read is a hand-edited row; fail loudly rather than guess. */
function decodeJson<T>(text: string, column: string, id: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RpcFault(ErrorCodes.internal, `MCP server ${id} has an unreadable ${column}`);
  }
}

function toView(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: decodeJson<string[]>(row.args_json, "args", row.id),
    env: decodeJson<Record<string, string>>(row.env_json, "env", row.id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, name, command, args_json, env_json, enabled, created_at, updated_at";

/**
 * The configured MCP servers. This service owns the rows only; spawning and speaking MCP belong to
 * `McpClient`, and the per-session wiring to `SessionMcpManager`.
 */
export class McpService {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): McpServerView[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM mcp_servers ORDER BY lower(name), id`).all() as McpServerRow[];
    return rows.map(toView);
  }

  get(id: string): McpServerView | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | undefined;
    return row === undefined ? null : toView(row);
  }

  getByName(name: string): McpServerView | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM mcp_servers WHERE name = ?`).get(name) as McpServerRow | undefined;
    return row === undefined ? null : toView(row);
  }

  /** The enabled subset of `ids`, in the service's own order. Unknown or disabled ids are dropped. */
  forAgent(ids: readonly string[]): McpServerView[] {
    const wanted = new Set(ids);
    return this.list().filter((server) => server.enabled && wanted.has(server.id));
  }

  create(params: McpServerCreateParams): McpServerView {
    if (this.getByName(params.name) !== null) throw new RpcFault(ErrorCodes.conflict, "MCP server name already exists");
    const at = this.now();
    const view: McpServerView = {
      id: `mcp-${uuidv7()}`,
      name: params.name,
      command: params.command,
      args: params.args,
      env: params.env,
      enabled: params.enabled,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO mcp_servers (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        view.id,
        view.name,
        view.command,
        JSON.stringify(view.args),
        JSON.stringify(view.env),
        view.enabled ? 1 : 0,
        view.createdAt,
        view.updatedAt,
      );
    return view;
  }

  /** Applies only the supplied fields; a rename must stay unique. */
  update(params: McpServerUpdateParams): McpServerView {
    const existing = this.get(params.id);
    if (existing === null) throw new RpcFault(ErrorCodes.notFound, "MCP server not found");
    if (params.name !== undefined) {
      const holder = this.getByName(params.name);
      if (holder !== null && holder.id !== params.id) {
        throw new RpcFault(ErrorCodes.conflict, "MCP server name already exists");
      }
    }

    const next: McpServerView = {
      ...existing,
      ...(params.name === undefined ? {} : { name: params.name }),
      ...(params.command === undefined ? {} : { command: params.command }),
      ...(params.args === undefined ? {} : { args: params.args }),
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
      updatedAt: this.now(),
    };
    this.db
      .prepare("UPDATE mcp_servers SET name = ?, command = ?, args_json = ?, env_json = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(
        next.name,
        next.command,
        JSON.stringify(next.args),
        JSON.stringify(next.env),
        next.enabled ? 1 : 0,
        next.updatedAt,
        next.id,
      );
    return next;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  /** One switch for the Setup panel; returns how many rows changed. */
  setAllEnabled(enabled: boolean): number {
    return this.db
      .prepare("UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE enabled <> ?")
      .run(enabled ? 1 : 0, this.now(), enabled ? 1 : 0).changes;
  }
}
