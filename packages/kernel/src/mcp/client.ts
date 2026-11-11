import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

/** What one MCP server advertises. `inputSchema` is passed to the provider as the parameter schema. */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The session workspace, so a server resolves relative paths the way the agent does. */
  cwd?: string;
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Enough of a server's stderr to diagnose a failure without holding unbounded memory. */
const STDERR_LIMIT = 64 * 1024;
const STOP_GRACE_MS = 3_000;

/** Server answers are untrusted JSON-RPC: a malformed one is a broken server, not a crash here. */
const IncomingMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional(), data: z.unknown().optional() }).optional(),
});

const ToolListResult = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional(),
    }),
  ),
});

const ToolCallResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional(),
  /** Some servers answer a call with a plain string instead of content blocks. */
  result: z.string().optional(),
});

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

type Incoming = z.infer<typeof IncomingMessage>;

/** Text blocks joined; images and embedded resources carry no text for the transcript. */
function contentText(result: z.infer<typeof ToolCallResult>): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text !== undefined) parts.push(block.text);
  }
  if (parts.length === 0 && result.result !== undefined) return result.result;
  return parts.join("\n");
}

/**
 * One MCP server over stdio: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout.
 *
 * The kernel owns the process: a session spawns it on its first MCP turn and kills it when the
 * session ends. Lines that are not JSON-RPC (a server's banner or debug logging) are recorded on
 * `stderr` and skipped, because plenty of servers print to stdout before they are ready.
 */
export class McpClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #stdoutBuffer = "";
  #stderr = "";
  #stopping = false;

  constructor(private readonly options: McpClientOptions) {}

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Everything the server wrote to stderr, capped at 64 KiB; diagnostics only. */
  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) return;
    const child = spawn(this.options.command, this.options.args, {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => this.#fail(`MCP server "${this.options.command}" failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.#stopping) return;
      this.#fail(`MCP server "${this.options.command}" exited (${signal ?? `code ${code ?? "unknown"}`})`);
    });

    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    await this.#request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "NoirHarness", version: "0.1.0" },
      },
      startupTimeoutMs,
      "initialize",
    );
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolSpec[]> {
    const result = await this.#request(
      "tools/list",
      {},
      this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "tools/list",
    );
    const parsed = ToolListResult.safeParse(result);
    if (!parsed.success) throw new Error(`MCP tools/list returned an unexpected result${this.#stderrSuffix()}`);
    return parsed.data.tools.map((tool) =>
      tool.description === undefined
        ? { name: tool.name, inputSchema: tool.inputSchema ?? { type: "object", properties: {} } }
        : {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          },
    );
  }

  /** The tool's text output; a server-reported `isError` rejects with that text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.#request(
      "tools/call",
      { name, arguments: args },
      this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      name,
    );
    const parsed = ToolCallResult.safeParse(result);
    if (!parsed.success) throw new Error(`MCP tool ${name} returned an unexpected result`);
    const text = contentText(parsed.data);
    if (parsed.data.isError === true) throw new Error(text === "" ? `MCP tool ${name} failed` : text);
    return text;
  }

  /** SIGTERM, then SIGKILL after a grace period. Safe to call more than once. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    this.#child = undefined;
    this.#rejectAll("MCP client stopped");
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || !stdin.writable) {
      throw new Error(`MCP server "${this.options.command}" is not running`);
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number, label: string): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${label} timed out after ${timeoutMs} ms${this.#stderrSuffix()}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #consume(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const lines = this.#stdoutBuffer.split("\n");
    this.#stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text === "") continue;
      let message: Incoming;
      try {
        message = IncomingMessage.parse(JSON.parse(text));
      } catch {
        // Not JSON-RPC: a banner or a debug print. Keep it for diagnostics and move on.
        this.#stderr = (this.#stderr + `[stdout] ${text}\n`).slice(-STDERR_LIMIT);
        continue;
      }
      this.#settle(message);
    }
  }

  #settle(message: Incoming): void {
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const detail = message.error.message ?? "unknown error";
      pending.reject(new Error(`MCP error ${message.error.code ?? ""}: ${detail}`.trim()));
      return;
    }
    pending.resolve(message.result);
  }

  /** Ends every in-flight request; the process is gone or the client is being stopped. */
  #fail(reason: string): void {
    this.#rejectAll(reason);
  }

  #rejectAll(reason: string): void {
    if (this.#pending.size === 0) return;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason}${this.#stderrSuffix()}`));
      this.#pending.delete(id);
    }
  }

  #stderrSuffix(): string {
    const detail = this.#stderr.trim();
    return detail === "" ? "" : `\n${detail.slice(-2000)}`;
  }
}
