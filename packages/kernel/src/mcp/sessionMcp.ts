import type { McpServerView } from "@noir/protocol";
import type { EngineMcpTool } from "@noir/engine-core";
import { McpClient } from "./client.js";

const NAMESPACE = "mcp__";
/**
 * Chat-completions providers reject a whole request whose tool list holds a bad name, so a server's
 * tool has to fit `[A-Za-z0-9_-]{1,64}` — including the namespace — or it is dropped, not sent.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `mcp__<server>__<tool>`; server names cannot contain `__`, so the split is unambiguous. */
function namespaced(server: string, tool: string): string {
  return `${NAMESPACE}${server}__${tool}`;
}

interface Route {
  client: McpClient;
  /** The tool's own name, without the namespace. */
  tool: string;
}

/**
 * The MCP side of one session: it spawns the session's servers, aggregates the tools they advertise
 * under `mcp__<server>__<tool>`, and routes calls back to the process that owns them.
 *
 * One manager per session, disposed with the session. A server that fails to start does not fail the
 * session — its tools are simply absent and `warnings` says why.
 */
export class SessionMcpManager {
  #clients = new Map<string, McpClient>();
  #routes = new Map<string, Route>();
  #warnings: string[] = [];
  #tools: EngineMcpTool[] = [];
  #started = false;

  constructor(
    private readonly servers: readonly McpServerView[],
    private readonly workspacePath: string,
    private readonly callTimeoutMs?: number,
  ) {}

  /** Tools for the provider, already namespaced. Empty until `initialize` resolves. */
  get tools(): EngineMcpTool[] {
    return this.#tools;
  }

  /** Servers that could not start, as `name: reason`. Surfaced in the session's transcript. */
  get warnings(): string[] {
    return this.#warnings;
  }

  get pids(): number[] {
    const pids: number[] = [];
    for (const client of this.#clients.values()) {
      if (client.pid !== undefined) pids.push(client.pid);
    }
    return pids;
  }

  /** Idempotent: a second call after a successful start is a no-op. */
  async initialize(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const enabled = this.servers.filter((server) => server.enabled);
    await Promise.all(enabled.map((server) => this.#startServer(server)));
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const route = this.#routes.get(name);
    if (route === undefined) throw new Error(`Unknown MCP tool ${name}`);
    return route.client.callTool(route.tool, args);
  }

  async dispose(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#routes.clear();
    this.#tools = [];
    await Promise.all(clients.map((client) => client.stop()));
  }

  async #startServer(server: McpServerView): Promise<void> {
    const client = new McpClient({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: this.workspacePath,
      ...(this.callTimeoutMs === undefined ? {} : { callTimeoutMs: this.callTimeoutMs }),
    });
    this.#clients.set(server.name, client);
    try {
      await client.start();
      const tools = await client.listTools();
      for (const tool of tools) {
        const name = namespaced(server.name, tool.name);
        // A name the provider would reject, or a duplicate from a second server, must not reach
        // the tool list: one bad entry fails the whole request, not just that tool.
        if (!TOOL_NAME.test(tool.name) || !TOOL_NAME.test(name)) {
          this.#warnings.push(`${server.name}: skipped tool ${tool.name} (name too long or not [A-Za-z0-9_-])`);
          continue;
        }
        if (this.#routes.has(name)) {
          this.#warnings.push(`${server.name}: skipped tool ${tool.name} (duplicate ${name})`);
          continue;
        }
        this.#routes.set(name, { client, tool: tool.name });
        this.#tools.push({
          name,
          description: `[${server.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema,
        });
      }
    } catch (error) {
      this.#clients.delete(server.name);
      await client.stop();
      const reason = error instanceof Error ? error.message : String(error);
      this.#warnings.push(`${server.name}: ${reason}`);
    }
  }
}
