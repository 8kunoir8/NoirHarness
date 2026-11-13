import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type {
  Engine,
  EnginePermissionRequest,
  EnginePromptResult,
  EngineMcpServer,
  EngineSession,
  EngineUpdate,
  PermissionDecision,
  PermissionOptionKind,
} from "@noir/engine-core";
import { JsonRpcClient, type JsonRpcTransport } from "./jsonRpc.js";
import { ClientRequestHandler } from "./terminals.js";

export * from "@noir/engine-core";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 1_000;

/** Provenance version stamped on events this adapter produces. Keep in sync with package.json. */
export const ADAPTER_VERSION = "0.0.0";

const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  },
};

export interface AcpSession {
  readonly sessionId: string;
  readonly configOptions: unknown[];
  prompt(
    content: Array<{ type: "text"; text: string }>,
    handlers: {
      onUpdate(update: EngineUpdate): void;
      onPermission(request: EnginePermissionRequest): Promise<PermissionDecision>;
    },
  ): Promise<EnginePromptResult>;
  cancel(): Promise<void>;
  setConfigOption(configId: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export interface AcpClient {
  readonly client: JsonRpcClient;
  readonly pid: number;
  newSession(cwd: string, mcpServers?: ReadonlyArray<EngineMcpServer>): Promise<AcpSession>;
  dispose(): Promise<void>;
}

export interface CreateAcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  turnTimeoutMs?: number;
  cancelGraceMs?: number;
  requestTimeoutMs?: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}

/** Newline-framed JSON-RPC over a child process's stdin/stdout. */
class ChildTransport implements JsonRpcTransport {
  readonly pid: number;
  readonly #child: ChildProcess;
  readonly #lineHandlers: Array<(line: string) => void> = [];
  readonly #closeHandlers: Array<(error?: Error) => void> = [];
  readonly #exitPromise: Promise<void>;
  #buffer = "";
  #disposed = false;
  #exited = false;
  #closeEmitted = false;
  #killTimer: NodeJS.Timeout | undefined;

  constructor(command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }) {
    const env = opts.env === undefined ? { ...process.env } : { ...process.env, ...opts.env };
    this.#child = spawn(command, args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.#child.pid ?? -1;

    let resolveExit: () => void = () => undefined;
    this.#exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const child = this.#child;
    // A write racing the agent's exit emits EPIPE on stdin; never let that become uncaught.
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#ingest(chunk));
    // stderr carries agent logs only; it is never protocol data.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (process.env.NOIR_ACP_DEBUG === "1") console.error(chunk.trimEnd());
    });
    child.on("exit", (code, signal) => {
      this.#exited = true;
      resolveExit();
      const failed = code !== null && code !== 0;
      this.#emitClose(failed ? new Error(`ACP agent exited with code ${code}${signal === null ? "" : ` (${signal})`}`) : undefined);
    });
    child.on("error", (error) => {
      this.#exited = true;
      resolveExit();
      this.#emitClose(error);
    });
  }

  write(line: string): void {
    const stdin = this.#child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) throw new Error("ACP agent stdin is closed");
    stdin.write(`${line}\n`);
  }

  onLine(handler: (line: string) => void): void {
    this.#lineHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.#closeHandlers.push(handler);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#child.stdin?.end();
    } catch {
      // stdin may already be gone.
    }
    this.#killTimer = setTimeout(() => {
      if (!this.#exited) this.#child.kill();
    }, 2_000);
    this.#killTimer.unref();
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.#exited) return;
    const exited = await Promise.race([this.#exitPromise.then(() => true), delay(timeoutMs).then(() => false)]);
    if (exited) return;
    this.#child.kill();
    await Promise.race([this.#exitPromise, delay(1_000)]);
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== "") {
        for (const handler of this.#lineHandlers) handler(line);
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #emitClose(error?: Error): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    for (const handler of this.#closeHandlers) handler(error);
  }
}

interface ActiveTurn {
  onUpdate(update: EngineUpdate): void;
  onPermission(request: EnginePermissionRequest): Promise<PermissionDecision>;
  timedOut: boolean;
  arm(): void;
  timer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  expire: ((error: Error) => void) | undefined;
  requestId: number | undefined;
}

function messageUpdate(update: JsonObject, reasoning: boolean): EngineUpdate {
  const content = asObject(update.content);
  if (content === undefined || content.type !== "text" || typeof content.text !== "string") {
    return { kind: "raw", update };
  }
  const messageId = typeof update.messageId === "string" ? update.messageId : "";
  return { kind: "message", messageId, text: content.text, reasoning };
}

/** What the `tool_call` update advertised, kept so later snapshots can be interpreted. */
interface TrackedTool {
  kind: string | undefined;
  /** The title the UI already renders; a bash title is the `$ `-prefixed command. */
  title: string;
}

function contentText(content: unknown, tool: TrackedTool | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    const record = asObject(part);
    if (record === undefined || record.type !== "content") continue;
    const inner = asObject(record.content);
    if (inner !== undefined && inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
  }
  // omp prefixes execute-tool content with the rendered command ("$ echo hi"), which the tool card
  // already shows as its title; only the result text belongs in the streamed output. Compare the
  // whole first part so a non-command line that merely starts with "$ " is never dropped.
  const first = parts[0];
  if (
    first !== undefined
    && first.startsWith("$ ")
    && tool?.kind === "execute"
    && first === tool.title
  ) {
    parts.shift();
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function toolStatus(value: unknown): "pending" | "in_progress" | "completed" | "failed" | undefined {
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function mapUpdate(update: JsonObject, tools: Map<string, TrackedTool>): EngineUpdate | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return messageUpdate(update, false);
    case "agent_thought_chunk":
      return messageUpdate(update, true);
    case "tool_call": {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const title = typeof update.title === "string" ? update.title : "";
      tools.set(toolCallId, { kind: typeof update.kind === "string" ? update.kind : undefined, title });
      return {
        kind: "tool.started",
        toolCallId,
        title,
        toolKind: typeof update.kind === "string" ? update.kind : "other",
        rawInput: update.rawInput,
      };
    }
    case "tool_call_update": {
      const status = toolStatus(update.status);
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      if (status === undefined) return { kind: "raw", update };
      const text = contentText(update.content, tools.get(toolCallId));
      return text === undefined
        ? { kind: "tool.updated", toolCallId, status }
        : { kind: "tool.updated", toolCallId, status, text };
    }
    case "usage_update": {
      const { size, used } = update;
      if (typeof size !== "number" || typeof used !== "number") return { kind: "raw", update };
      const cost = asObject(update.cost);
      const amount = cost !== undefined && typeof cost.amount === "number" ? cost.amount : undefined;
      return amount === undefined
        ? { kind: "usage", size, used }
        : { kind: "usage", size, used, costAmount: amount };
    }
    case "plan": {
      const entries = Array.isArray(update.entries)
        ? update.entries.map((entry) => {
            const record = asObject(entry);
            return {
              content: typeof record?.content === "string" ? record.content : "",
              status: typeof record?.status === "string" ? record.status : "",
            };
          })
        : [];
      return { kind: "plan", entries };
    }
    case "session_info_update":
      return typeof update.title === "string" ? { kind: "title", title: update.title } : undefined;
    default:
      return { kind: "raw", update };
  }
}

function toPromptResult(response: unknown): EnginePromptResult {
  const record = asObject(response);
  const stopReason = record !== undefined && typeof record.stopReason === "string" ? record.stopReason : "end_turn";
  const usage = record === undefined ? undefined : asObject(record.usage);
  if (usage === undefined || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return { stopReason, timedOut: false };
  }
  return typeof usage.totalTokens === "number"
    ? {
        stopReason,
        timedOut: false,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
      }
    : { stopReason, timedOut: false, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } };
}

function optionKind(value: unknown): PermissionOptionKind {
  switch (value) {
    case "allow_once":
    case "allow_always":
    case "reject_once":
    case "reject_always":
      return value;
    default:
      // An option we cannot name is never auto-approved.
      return "reject_once";
  }
}

function selectedOptionId(
  decision: PermissionDecision,
  options: EnginePermissionRequest["options"],
): string | undefined {
  let target: PermissionOptionKind;
  switch (decision) {
    case "allow_once":
      target = "allow_once";
      break;
    case "allow_always":
      target = "allow_always";
      break;
    case "reject":
      target = "reject_once";
      break;
    case "reject_always":
      target = "reject_always";
      break;
    default:
      return undefined;
  }
  return options.find((option) => option.kind === target)?.optionId;
}

class AcpSessionImpl implements AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly #owner: AcpRuntime;
  #configOptions: unknown[];
  #activeTurn: ActiveTurn | undefined;
  #closed = false;
  /** Tool metadata from `tool_call`, keyed by id, for interpreting later updates. */
  readonly #tools = new Map<string, TrackedTool>();

  constructor(owner: AcpRuntime, sessionId: string, cwd: string, configOptions: unknown[]) {
    this.#owner = owner;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.#configOptions = configOptions;
  }

  get configOptions(): unknown[] {
    return this.#configOptions;
  }

  get activeTurn(): ActiveTurn | undefined {
    return this.#activeTurn;
  }

  async prompt(
    content: Array<{ type: "text"; text: string }>,
    handlers: {
      onUpdate(update: EngineUpdate): void;
      onPermission(request: EnginePermissionRequest): Promise<PermissionDecision>;
    },
  ): Promise<EnginePromptResult> {
    if (this.#closed) throw new Error(`ACP session ${this.sessionId} is closed`);
    if (this.#activeTurn !== undefined) throw new Error(`ACP session ${this.sessionId} already has a prompt in flight`);

    const turn: ActiveTurn = {
      onUpdate: handlers.onUpdate,
      onPermission: handlers.onPermission,
      timedOut: false,
      arm: () => undefined,
      timer: undefined,
      graceTimer: undefined,
      expire: undefined,
      requestId: undefined,
    };
    turn.arm = () => {
      if (turn.timedOut) return;
      clearTimeout(turn.timer);
      turn.timer = setTimeout(() => this.#onTurnTimeout(turn), this.#owner.turnTimeoutMs);
    };
    this.#activeTurn = turn;
    turn.arm();

    try {
      let settle: (value: unknown) => void = () => undefined;
      let expire: (error: Error) => void = () => undefined;
      const settled = new Promise<unknown>((resolveResponse, rejectResponse) => {
        settle = resolveResponse;
        expire = rejectResponse;
      });
      turn.expire = expire;
      // `0` disables the client-wide request timeout: the turn watchdog + cancel grace own this deadline.
      const request = this.#owner.client.requestWithId(
        "session/prompt",
        { sessionId: this.sessionId, prompt: content },
        0,
      );
      turn.requestId = request.id;
      request.promise.then(settle, expire);
      const response = await settled;
      if (turn.timedOut) return { stopReason: "cancelled", timedOut: true };
      return toPromptResult(response);
    } finally {
      clearTimeout(turn.timer);
      clearTimeout(turn.graceTimer);
      turn.expire = undefined;
      this.#activeTurn = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.#owner.client.notify("session/cancel", { sessionId: this.sessionId });
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const response = await this.#owner.client.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    });
    const configOptions = asObject(response)?.configOptions;
    if (Array.isArray(configOptions)) this.#configOptions = configOptions;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#owner.forgetSession(this.sessionId);
    try {
      await this.#owner.client.request("session/close", { sessionId: this.sessionId }, CLOSE_TIMEOUT_MS);
    } catch {
      // Teardown must never hang or throw: the agent may already be gone or ignoring this frame.
    }
  }

  applyUpdate(raw: unknown): void {
    const update = asObject(raw);
    if (update === undefined) return;
    const turn = this.#activeTurn;
    if (turn !== undefined) turn.arm();

    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      this.#configOptions = update.configOptions;
    }

    const mapped = mapUpdate(update, this.#tools);
    if (mapped === undefined) return;
    turn?.onUpdate(mapped);
  }

  #onTurnTimeout(turn: ActiveTurn): void {
    if (turn.timedOut || this.#activeTurn !== turn) return;
    turn.timedOut = true;
    clearTimeout(turn.timer);
    try {
      this.#owner.client.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      // Transport gone: the grace timer below still settles the turn.
    }
    turn.graceTimer = setTimeout(() => {
      // The agent ignored the cancel: drop the frame so it cannot linger in the pending map forever.
      if (turn.requestId !== undefined) this.#owner.client.abandon(turn.requestId);
      turn.expire?.(
        new Error(`ACP prompt did not settle ${this.#owner.cancelGraceMs}ms after session/cancel`),
      );
    }, this.#owner.cancelGraceMs);
  }
}

class AcpRuntime implements AcpClient {
  readonly client: JsonRpcClient;
  readonly pid: number;
  readonly turnTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly #transport: ChildTransport;
  readonly #handlers: ClientRequestHandler;
  readonly #sessions = new Map<string, AcpSessionImpl>();
  #disposed = false;

  constructor(transport: ChildTransport, client: JsonRpcClient, turnTimeoutMs: number, cancelGraceMs: number) {
    this.#transport = transport;
    this.client = client;
    this.pid = transport.pid;
    this.turnTimeoutMs = turnTimeoutMs;
    this.cancelGraceMs = cancelGraceMs;
    this.#handlers = new ClientRequestHandler((sessionId) => this.#cwdFor(sessionId));
    client.onRequest((method, params) => this.#handleRequest(method, params));
    client.onNotification((method, params) => this.#handleNotification(method, params));
  }

  async newSession(cwd: string, mcpServers: ReadonlyArray<EngineMcpServer> = []): Promise<AcpSession> {
    if (!isAbsolute(cwd)) throw new Error(`ACP session cwd must be absolute: ${cwd}`);
    const absolute = resolve(cwd);
    // ACP spells stdio servers with `env` as `{name, value}[]`; the kernel stores a plain record.
    const wireServers = mcpServers.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    }));
    const response = await this.client.request("session/new", { cwd: absolute, mcpServers: wireServers });
    const record = asObject(response);
    const sessionId = record?.sessionId;
    if (typeof sessionId !== "string") throw new Error("ACP session/new did not return a sessionId");

    const configOptions = Array.isArray(record?.configOptions) ? record.configOptions : [];
    const hasModel = configOptions.some((option) => asObject(option)?.category === "model");
    if (!hasModel) {
      throw new Error(
        `ACP session ${sessionId} has no model config option; the agent profile has no usable model`,
      );
    }

    const session = new AcpSessionImpl(this, sessionId, absolute, configOptions);
    this.#sessions.set(sessionId, session);
    return session;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.#sessions.values()) {
      try {
        await this.client.request("session/close", { sessionId: session.sessionId }, CLOSE_TIMEOUT_MS);
      } catch {
        // Best effort: the agent may already be gone.
      }
    }
    this.#sessions.clear();
    this.#handlers.dispose();
    this.client.dispose();
    await this.#transport.waitForExit(2_500);
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #cwdFor(sessionId: unknown): string | undefined {
    if (typeof sessionId === "string") return this.#sessions.get(sessionId)?.cwd;
    const first = this.#sessions.values().next();
    return first.done ? undefined : first.value.cwd;
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") return await this.#handlePermission(params);
    return await this.#handlers.handle(method, params);
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const record = asObject(params);
    if (record === undefined || typeof record.sessionId !== "string") return;
    const session = this.#sessions.get(record.sessionId);
    session?.applyUpdate(record.update);
  }

  async #handlePermission(params: unknown): Promise<unknown> {
    const cancelled = { outcome: { outcome: "cancelled" } };
    const record = asObject(params);
    if (record === undefined) return cancelled;

    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const toolCall = asObject(record.toolCall);
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions.map((option) => {
      const entry = asObject(option);
      return {
        optionId: typeof entry?.optionId === "string" ? entry.optionId : "",
        name: typeof entry?.name === "string" ? entry.name : "",
        kind: optionKind(entry?.kind),
      };
    });

    const request: EnginePermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : "",
        title: typeof toolCall?.title === "string" ? toolCall.title : "",
        ...(typeof toolCall?.kind === "string" ? { kind: toolCall.kind } : {}),
        ...(toolCall?.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
      },
      options,
    };

    const turn = this.#sessions.get(sessionId)?.activeTurn;
    if (turn === undefined) return cancelled;

    let decision: PermissionDecision;
    try {
      decision = await turn.onPermission(request);
    } catch {
      return cancelled;
    }
    const optionId = selectedOptionId(decision, options);
    if (optionId === undefined || optionId === "") return cancelled;
    return { outcome: { outcome: "selected", optionId } };
  }
}

export async function createAcpClient(opts: CreateAcpClientOptions): Promise<AcpClient> {
  const transport = new ChildTransport(
    opts.command,
    opts.args,
    opts.env === undefined ? { cwd: opts.cwd } : { cwd: opts.cwd, env: opts.env },
  );
  // Bound every non-prompt request (initialize, session/new, config, …): a spawned agent that never
  // speaks ACP must fail fast instead of wedging the caller. Prompts pass `0` and rely on the turn
  // watchdog instead.
  const client = new JsonRpcClient(transport, {
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const runtime = new AcpRuntime(
    transport,
    client,
    opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
  );
  try {
    await client.request("initialize", INITIALIZE_PARAMS);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  return runtime;
}

/**
 * One `AcpClient` (and so one child process) per engine instance, matching what `EngineManager`
 * does today: the session owns the client and reaps it on dispose, so no call site can leak the
 * child by forgetting the second half of a two-object teardown.
 */
export function createAcpEngine(opts: CreateAcpClientOptions): Engine {
  return {
    id: "acp",
    capabilities: {
      streaming: true,
      tools: true,
      diffs: true,
      approvals: true,
      subagents: true,
      steering: true,
      modelSelection: true,
    },
    async start(startOpts) {
      const client = await createAcpClient(opts);
      let session: AcpSession;
      try {
        session = await client.newSession(startOpts.cwd, startOpts.mcpServers ?? []);
      } catch (error) {
        await client.dispose().catch(() => undefined);
        throw error;
      }
      const engineSession: EngineSession = {
        pid: client.pid,
        prompt: (content, handlers) => session.prompt(content, handlers),
        interrupt: () => session.cancel(),
        setModel: async (model) =>
          session.setConfigOption("model", `${model.providerName}/${model.modelId}`),
        dispose: async () => {
          await session.close().catch(() => undefined);
          await client.dispose().catch(() => undefined);
        },
      };
      return engineSession;
    },
  };
}

export { ClientRequestHandler, resolveInsideWorkspace } from "./terminals.js";
export { JsonRpcClient, JsonRpcError, JsonRpcMethodError } from "./jsonRpc.js";
export type { JsonRpcTransport } from "./jsonRpc.js";

export { createRpcEngine, type RpcEngineOptions } from "./rpc.js";
