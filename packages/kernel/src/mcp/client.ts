import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

/** What one MCP server advertises. `inputSchema` is passed to the provider as the parameter schema. */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientOptions {
  /**
   * `stdio` spawns `command` and speaks newline JSON-RPC on its pipes; `http` POSTs to `url`.
   * Exactly one of the two is set: `start` picks the transport by which one is present rather than
   * by a separate tag that could disagree with them.
   */
  command?: string | null;
  url?: string | null;
  args: string[];
  env: Record<string, string>;
  headers?: Record<string, string>;
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

/**
 * Windows ships `npx` and friends as `.cmd` shims, and Node refuses to spawn one directly
 * (`npx` is ENOENT, `npx.cmd` is EINVAL). `cmd.exe /c` is the only way to run it — but cmd reads
 * the line before any escaping rule can protect `%`, so a literal `%PATH%` in an argument would be
 * expanded and a trailing backslash would swallow the closing quote.
 *
 * So no argument text is written on the command line at all: each one rides in its own environment
 * variable and the line only holds `"%NAME%"`. cmd expands that reference exactly once, so the
 * value arrives verbatim — including `%` — whatever it contains. The two quoting hazards that
 * survive are handled before the value is stored: `"` is doubled (cmd's own convention inside
 * quotes) and a trailing backslash is doubled, because the target's CRT would otherwise read it as
 * escaping the closing quote.
 *
 * The only argument this cannot carry is one with a newline in it: cmd ends the line there. The
 * `NOIR_MCP_ARG_*` variables are visible to the server too; the name is prefixed so that a server
 * reading its own environment cannot mistake one for its own setting.
 */
function windowsCommandLine(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  const parts = args.map((value, index) => {
    if (value === "") return '""';
    const name = `NOIR_MCP_ARG_${index}`;
    env[name] = value.replace(/"/g, '""').replace(/\\+$/, (run) => run + run);
    return `"%${name}%"`;
  });
  // The command itself is user text too; only its quoting can be fixed on the line.
  const head = /[\s"&|<>^%]/.test(command) ? `"${command}"` : command;
  return [head, ...parts].join(" ");
}

/** cmd.exe resolves a bare `npx` to its `.cmd`; a native executable is spawned directly. */
function isWindowsShim(command: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.(cmd|bat)$/i.test(command)) return true;
  // A bare name that is not an executable resolves to a shim on PATH; cmd.exe is what finds it.
  return !/\.(exe|com)$/i.test(command);
}

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
 * One MCP server. Two transports, chosen by which address the row carries:
 *
 * - `command` — stdio: newline-delimited JSON-RPC 2.0 on the child's stdin/stdout. The kernel owns
 *   the process: a session spawns it on its first MCP turn and kills it when the session ends.
 *   Lines that are not JSON-RPC (a server's banner or debug logging) are recorded on `stderr` and
 *   skipped, because plenty of servers print to stdout before they are ready.
 * - `url` — Streamable HTTP: one POST per message, answered as JSON or as an SSE stream. There is
 *   no process to own; `stop` only ends the requests in flight.
 */
export class McpClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #stdoutBuffer = "";
  #stderr = "";
  #stopping = false;
  /** The `Mcp-Session-Id` an HTTP server handed back at initialize, when it keeps one. */
  #sessionId: string | undefined;
  readonly #command: string | null;
  readonly #url: string | null;

  constructor(private readonly options: McpClientOptions) {
    this.#command = options.command ?? null;
    this.#url = options.url ?? null;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Everything the server wrote to stderr, capped at 64 KiB; diagnostics only. */
  get stderr(): string {
    return this.#stderr;
  }

  /** How this client is named in an error: the url for HTTP, the program for stdio. */
  get #label(): string {
    return this.#url ?? this.#command ?? "MCP server";
  }

  async start(): Promise<void> {
    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    if (this.#url !== null) {
      await this.#httpRequest(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "NoirHarness", version: "0.1.0" } },
        startupTimeoutMs,
        "initialize",
      );
      await this.#httpNotify("notifications/initialized", {});
      return;
    }
    const command = this.#command;
    if (command === null) throw new Error("MCP client has neither a command nor a url");
    if (this.#child !== undefined) return;
    const env = { ...process.env, ...this.options.env };
    const shim = isWindowsShim(command);
    const child = shim
      ? spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `"${windowsCommandLine(command, this.options.args, env)}"`], {
          ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // The line is already quoted for cmd; Node must not quote it again.
          windowsVerbatimArguments: true,
        })
      : spawn(command, this.options.args, {
          ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
          env,
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
    child.on("error", (error) => this.#fail(`MCP server "${command}" failed: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.#stopping) return;
      this.#fail(`MCP server "${command}" exited (${signal ?? `code ${code ?? "unknown"}`})`);
    });

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
    this.#stopping = true;
    this.#rejectAll("MCP client stopped");
    const child = this.#child;
    this.#child = undefined;
    // An HTTP server owns no process here; abandoning the requests in flight is the whole stop.
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (isWindowsShim(this.#command ?? "") && child.pid !== undefined) {
      // The server is a grandchild of cmd.exe; killing the wrapper alone would orphan it.
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
      return;
    }
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
      throw new Error(`MCP server "${this.#label}" is not running`);
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number, label: string): Promise<unknown> {
    if (this.#url !== null) return this.#httpRequest(method, params, timeoutMs, label);
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

  /**
   * One JSON-RPC message over Streamable HTTP. The reply may be a single JSON body or a
   * `text/event-stream` whose frames each hold one message; the answer to this id ends the wait,
   * whatever else the stream carries.
   */
  async #httpRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<unknown> {
    const id = this.#nextId++;
    let response: Response;
    try {
      response = await this.#httpPost({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    } catch (error) {
      // `AbortSignal.timeout` surfaces as a bare DOMException; name the server and the budget.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP ${label} failed after ${timeoutMs} ms: ${reason}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`MCP ${label} rejected: HTTP ${response.status}${body === "" ? "" : ` ${body}`}`);
    }
    const kind = response.headers.get("content-type") ?? "";
    let settled: Incoming;
    if (kind.includes("text/event-stream")) {
      const streamed = await this.#readStream(response, id, label);
      if (streamed instanceof Error) throw streamed;
      settled = streamed;
    } else {
      const parsed = IncomingMessage.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new Error(`MCP ${label} returned a malformed message`);
      settled = parsed.data;
    }
    if (settled.error !== undefined) {
      const { code, message } = settled.error;
      throw new Error(`MCP error ${code ?? ""}: ${message ?? "unknown error"}`.trim());
    }
    return settled.result;
  }

  async #httpNotify(method: string, params: Record<string, unknown>): Promise<void> {
    const response = await this.#httpPost({ jsonrpc: "2.0", method, params }, DEFAULT_STARTUP_TIMEOUT_MS);
    // A notification has no reply to read; some servers answer 202 with no body at all.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`MCP ${method} rejected: HTTP ${response.status}`);
  }

  #httpPost(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Either answer is legal; naming both is what lets the server pick.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...this.options.headers,
    };
    if (this.#sessionId !== undefined) headers["mcp-session-id"] = this.#sessionId;
    return fetch(this.#url ?? "", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).then((response) => {
      // The session id arrives on the initialize reply; every later request has to echo it.
      const session = response.headers.get("mcp-session-id");
      if (this.#sessionId === undefined && session !== null && session !== "") this.#sessionId = session;
      return response;
    });
  }

  /**
   * Reads SSE frames until the one answering `id` arrives, then abandons the stream. A frame may
   * carry any number of `data:` lines, but a single JSON-RPC message is the only shape that matters.
   */
  async #readStream(response: Response, id: number, label: string): Promise<Incoming | Error> {
    if (response.body === null) return new Error(`MCP ${label} sent an empty event stream`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames end at a blank line; `\r\n\r\n` is what a stricter server sends.
        for (let at = buffer.search(/\r?\n\r?\n/); at !== -1; at = buffer.search(/\r?\n\r?\n/)) {
          const separator = /\r?\n\r?\n/.exec(buffer)?.[0] ?? "\n\n";
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + separator.length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (data === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const message = IncomingMessage.safeParse(parsed);
          if (message.success && message.data.id === id) return message.data;
        }
      }
      return new Error(`MCP ${label} stream ended without an answer to ${id}`);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
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
