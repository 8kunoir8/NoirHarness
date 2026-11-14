import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ErrorCodes,
  RpcFault,
  type McpServerCreateParams,
  type McpServerUpdateParams,
  type McpServerView,
  type McpTransport,
} from "@noir/protocol";

interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  url: string | null;
  args_json: string;
  env_json: string;
  headers_json: string;
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
    transport: row.transport,
    // The columns are nullable because only one transport uses each; the view keeps both as text
    // so a renderer never has to narrow before printing a server.
    command: row.command ?? "",
    args: decodeJson<string[]>(row.args_json, "args", row.id),
    env: decodeJson<Record<string, string>>(row.env_json, "env", row.id),
    url: row.url ?? "",
    headers: decodeJson<Record<string, string>>(row.headers_json, "headers", row.id),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A stdio server needs a command to spawn and an HTTP server needs a url to POST to. Nothing else
 * can tell them apart later, so storing a row that names neither would only defer the failure to
 * the first session that starts it.
 */
function requireShape(transport: McpTransport, command: string, url: string): void {
  if (transport === "http") {
    if (url === "") throw new RpcFault(ErrorCodes.invalidParams, "An http MCP server needs a url");
    if (!URL.canParse(url)) throw new RpcFault(ErrorCodes.invalidParams, `Not a URL: ${url}`);
    return;
  }
  if (command === "") throw new RpcFault(ErrorCodes.invalidParams, "A stdio MCP server needs a command");
}

const COLUMNS =
  "id, name, transport, command, url, args_json, env_json, headers_json, enabled, created_at, updated_at";

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
    const command = params.command ?? "";
    const url = params.url ?? "";
    requireShape(params.transport, command, url);
    const view: McpServerView = {
      id: `mcp-${uuidv7()}`,
      name: params.name,
      transport: params.transport,
      // Only the chosen transport's address is kept, so a create answers exactly what a re-read
      // would: a caller that sent both must not see a field the row does not hold.
      command: params.transport === "stdio" ? command : "",
      args: params.args,
      env: params.env,
      url: params.transport === "http" ? url : "",
      headers: params.headers,
      enabled: params.enabled,
      createdAt: at,
      updatedAt: at,
    };
    this.#write(view);
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

    const merged: McpServerView = {
      ...existing,
      ...(params.name === undefined ? {} : { name: params.name }),
      ...(params.transport === undefined ? {} : { transport: params.transport }),
      ...(params.command === undefined ? {} : { command: params.command }),
      ...(params.args === undefined ? {} : { args: params.args }),
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.url === undefined ? {} : { url: params.url }),
      ...(params.headers === undefined ? {} : { headers: params.headers }),
      ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
      updatedAt: this.now(),
    };
    // Switching a saved server between transports leaves the other transport's fields behind; the
    // shape rule reads the merged row, so a switch that drops the one required field is refused.
    requireShape(merged.transport, merged.command, merged.url);
    const next: McpServerView = {
      ...merged,
      command: merged.transport === "stdio" ? merged.command : "",
      url: merged.transport === "http" ? merged.url : "",
    };
    this.#write(next);
    return next;
  }

  /** The row for a view, in the order `COLUMNS` names them. */
  #write(view: McpServerView): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, transport = excluded.transport,
           command = excluded.command, url = excluded.url, args_json = excluded.args_json,
           env_json = excluded.env_json, headers_json = excluded.headers_json,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(
        view.id,
        view.name,
        view.transport,
        view.transport === "stdio" ? view.command : null,
        view.transport === "http" ? view.url : null,
        JSON.stringify(view.args),
        JSON.stringify(view.env),
        JSON.stringify(view.headers),
        view.enabled ? 1 : 0,
        view.createdAt,
        view.updatedAt,
      );
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
