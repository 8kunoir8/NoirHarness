import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  Engine,
  EnginePermissionRequest,
  EnginePromptResult,
  EngineSession,
  EngineStartOptions,
  EngineUpdate,
  PermissionDecision,
  PermissionOptionKind,
} from "@noir/engine-core";
import type { CreateAcpClientOptions } from "./index.js";

/**
 * OMP's `--mode rpc` transport.
 *
 * The wire is newline-delimited JSON on stdio: a `ready` frame, `{type: command}` requests answered
 * by `{type:"response", command, success, error?}`, then a stream of `message_*`, `toolcall_*`,
 * `tool_execution_*`, `extension_ui_request`, `turn_end` per model turn, and a final
 * `prompt_result`. It is a richer stream than ACP
 * — per-message usage and cost, the tool's own `intent` sentence, and a resolved path in the result
 * — and it asks for approval through `extension_ui_request`, which is what lets it keep the
 * kernel's permission model.
 */
const MAX_FRAME_BYTES = 1_048_576;

type Frame = Record<string, unknown>;

function str(frame: Frame, key: string): string | undefined {
  const value = Object.getOwnPropertyDescriptor(frame, key)?.value;
  return typeof value === "string" ? value : undefined;
}

function obj(frame: Frame, key: string): Frame | undefined {
  const value = Object.getOwnPropertyDescriptor(frame, key)?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Frame) : undefined;
}

function num(frame: Frame, key: string): number | undefined {
  const value = Object.getOwnPropertyDescriptor(frame, key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * OMP labels the same three choices differently per tool — `Approve`, `Approve write for this
 * session`, `Deny` for a write; something else for a shell command. The shape is what matters:
 * a `Deny` rejects, an `Approve … for this session` is remembered, and a plain `Approve` is once.
 */
function kindOfOption(label: string): PermissionOptionKind {
  if (/^deny/i.test(label)) return "reject_once";
  if (/^approve/i.test(label)) return /session/i.test(label) ? "allow_always" : "allow_once";
  if (/^reject/i.test(label)) return "reject_once";
  return "allow_once";
}

/** The card's words, not omp's: every engine's approval must read the same to the person clicking. */
const OPTION_NAME: Record<PermissionOptionKind, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Reject",
  reject_always: "Always reject",
};

function optionIdFor(decision: PermissionDecision, options: readonly string[]): string {
  const wanted: PermissionOptionKind[] =
    decision === "reject_always"
      ? ["reject_always", "reject_once"]
      : decision === "reject"
        ? ["reject_once", "reject_always"]
        : [decision];
  for (const kind of wanted) {
    const match = options.find((option) => kindOfOption(option) === kind);
    if (match !== undefined) return match;
  }
  return options[0] ?? "Deny";
}

export interface RpcEngineOptions extends CreateAcpClientOptions {
  /** `always-ask` keeps the approval card in the loop; `write` (omp's default) does not ask at all. */
  approvalMode?: "always-ask" | "always-ask-cached" | "write" | "yolo";
}

export function createRpcEngine(opts: RpcEngineOptions): Engine {
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
    start: (startOpts) => startRpcSession(opts, startOpts),
  };
}

async function startRpcSession(opts: RpcEngineOptions, startOpts: EngineStartOptions): Promise<EngineSession> {
  const args = [...opts.args];
  // `--mode rpc` replaces the `acp` subcommand the ACP adapter ends with.
  const subcommand = args.at(-1);
  if (subcommand === "acp") args.pop();
  args.push("--mode", "rpc", "--approval-mode", opts.approvalMode ?? "always-ask");

  const child = spawn(opts.command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A write racing the agent's exit emits EPIPE on stdin; never let that become uncaught.
  child.stdin?.on("error", () => undefined);
  const rpc = new RpcChannel(child, startOpts.sessionId);

  try {
    await rpc.ready(30_000);
  } catch (error) {
    rpc.dispose();
    throw error;
  }

  let busy = false;
  const engineSession: EngineSession = {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    async prompt(content, handlers): Promise<EnginePromptResult> {
      if (busy) throw new Error("A turn is already running on this engine");
      busy = true;
      try {
        const text = content.map((block) => block.text).join("\n").trim();
        // Register the turn before the prompt: a `prompt_result` must never arrive before its waiter.
        const turn = rpc.turn(handlers.onUpdate, handlers.onPermission);
        rpc.ask({ type: "prompt", message: text });
        return await turn;
      } finally {
        busy = false;
      }
    },
    async interrupt() {
      rpc.ask({ type: "abort" });
    },
    async setModel(model) {
      rpc.ask({ type: "set_model", provider: model.providerName, modelId: model.modelId });
    },
    async dispose() {
      rpc.dispose();
    },
  };
  return engineSession;
}

type Handler = (update: EngineUpdate) => void;
type PermissionHandler = (request: EnginePermissionRequest) => Promise<PermissionDecision>;

/** One child, one line reader, and the promise a turn resolves through. */
class RpcChannel {
  private turnResolve: ((result: EnginePromptResult) => void) | undefined;
  private turnReject: ((error: Error) => void) | undefined;
  private update: Handler | undefined;
  private permission: PermissionHandler | undefined;
  /** The args a tool reported when it started, so an approval can name what it is about to touch. */
  private readonly toolArgs = new Map<string, { toolName: string; args: Frame }>();
  private lastUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  private disposed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly sessionId: string,
  ) {
    const rd = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rd.on("line", (line) => this.onLine(line));
    // stderr carries agent logs only; it is never protocol data, but an unread pipe would block the child.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (process.env.NOIR_ACP_DEBUG === "1") console.error(chunk.trimEnd());
    });
    child.on("exit", (code) => {
      if (this.disposed) return;
      this.fail(new Error(`omp exited with code ${String(code)}`));
    });
    child.on("error", (error) => {
      if (this.disposed) return;
      this.fail(error);
    });
  }

  ready(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("omp did not send a ready frame")), timeoutMs);
      this.onReady = () => {
        clearTimeout(timer);
        this.onReadyError = undefined;
        resolve();
      };
      this.onReadyError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  private onReady: (() => void) | undefined;
  private onReadyError: ((error: Error) => void) | undefined;

  /** Fire-and-forget: the reply is matched by command name where it matters, never awaited here. */
  ask(frame: Frame): void {
    if (this.child.stdin === null || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  turn(update: Handler, permission: PermissionHandler): Promise<EnginePromptResult> {
    this.update = update;
    this.permission = permission;
    return new Promise((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.child.stdin?.end();
    this.child.kill();
  }

  private fail(error: Error): void {
    this.onReadyError?.(error);
    this.turnReject?.(error);
    this.turnResolve = undefined;
    this.turnReject = undefined;
  }

  private onLine(line: string): void {
    if (line.length === 0 || line.length > MAX_FRAME_BYTES) return;
    let frame: Frame;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      frame = parsed as Frame;
    } catch {
      return;
    }
    const type = str(frame, "type");
    if (type === undefined) return;
    switch (type) {
      case "ready": {
        const version = num(frame, "protocolVersion");
        if (version !== undefined && version !== 1) {
          this.fail(new Error(`omp speaks rpc protocol ${String(version)}; this adapter speaks 1`));
          return;
        }
        this.onReady?.();
        this.onReady = undefined;
        return;
      }
      case "response": {
        const command = str(frame, "command");
        if (command === "prompt" && Object.getOwnPropertyDescriptor(frame, "success")?.value === false) {
          this.fail(new Error(str(frame, "error") ?? "omp refused the prompt"));
        }
        return;
      }
      case "message_start":
        this.startMessage(frame);
        return;
      case "message_update":
        this.updateMessage(frame);
        return;
      case "message_end": {
        // Usage arrives with the finished assistant message, once per model turn.
        const message = obj(frame, "message");
        if (message !== undefined && str(message, "role") === "assistant") this.emitUsage(message);
        return;
      }
      case "tool_execution_start": {
        const toolCallId = str(frame, "toolCallId") ?? "";
        const toolName = str(frame, "toolName") ?? "tool";
        const args = obj(frame, "args") ?? {};
        this.toolArgs.set(toolCallId, { toolName, args });
        this.update?.({
          kind: "tool.started",
          toolCallId,
          title: str(frame, "intent") ?? toolName,
          toolKind: toolName,
          rawInput: args,
          toolName,
          argumentsJson: JSON.stringify(args),
        });
        return;
      }
      case "tool_execution_end": {
        const failed = Object.getOwnPropertyDescriptor(frame, "isError")?.value === true;
        const toolCallId = str(frame, "toolCallId") ?? "";
        this.toolArgs.delete(toolCallId);
        const text = resultText(obj(frame, "result"));
        this.update?.({
          kind: "tool.updated",
          toolCallId,
          status: failed ? "failed" : "completed",
          ...(text === undefined ? {} : { text }),
        });
        return;
      }
      case "extension_ui_request":
        void this.onExtensionRequest(frame);
        return;
      case "turn_end":
        // One `turn_end` per model turn, so a tool loop sends several: the prompt is not over.
        return;
      case "prompt_result":
        this.endTurn(frame);
        return;
      default:
        return;
    }
  }

  private startMessage(frame: Frame): void {
    const message = obj(frame, "message");
    if (message === undefined) return;
    const role = str(message, "role");
    // Only the assistant's text is streamed by `message_update`; the user's message is the prompt.
    if (role !== "assistant") return;
    const messageId = str(frame, "messageId") ?? "assistant";
    for (const block of blocksOf(message)) {
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
        this.update?.({ kind: "message", messageId, text: block.thinking, reasoning: true });
      }
    }
  }

  private updateMessage(frame: Frame): void {
    const event = obj(frame, "assistantMessageEvent");
    if (event === undefined) return;
    const kind = str(event, "type");
    const messageId = str(frame, "messageId") ?? "assistant";
    if (kind === "text_delta") {
      const delta = str(event, "delta");
      if (delta !== undefined && delta !== "") this.update?.({ kind: "message", messageId, text: delta, reasoning: false });
      return;
    }
    if (kind === "thinking_delta") {
      const delta = str(event, "delta");
      if (delta !== undefined && delta !== "") this.update?.({ kind: "message", messageId, text: delta, reasoning: true });
    }
  }

  private emitUsage(message: Frame): void {
    const usage = obj(message, "usage");
    if (usage === undefined) return;
    const total = num(usage, "totalTokens") ?? 0;
    // A message that reports nothing would zero a meter that already shows real numbers.
    if (total === 0) return;
    this.lastUsage = {
      inputTokens: num(usage, "input") ?? 0,
      outputTokens: num(usage, "output") ?? 0,
      totalTokens: total,
    };
    const cost = obj(usage, "cost");
    const costAmount = cost === undefined ? undefined : num(cost, "total");
    this.update?.({
      kind: "usage",
      size: 0,
      used: total,
      ...(costAmount === undefined ? {} : { costAmount }),
    });
  }

  private async onExtensionRequest(frame: Frame): Promise<void> {
    const method = str(frame, "method");
    const id = str(frame, "id");
    if (method !== "select" || id === undefined || this.permission === undefined) {
      // Nothing else is a question the kernel can answer; leave it to omp's own default.
      return;
    }
    const title = str(frame, "title") ?? "Allow tool";
    const rawOptions = Object.getOwnPropertyDescriptor(frame, "options")?.value;
    const options = Array.isArray(rawOptions) ? rawOptions.filter((entry): entry is string => typeof entry === "string") : [];
    // The frame carries the tool's name and path in its title, not a structured call: the kernel
    // needs both, and `toolArgs` holds the arguments the tool already reported.
    const toolName = toolKindOf(title);
    const reported = [...this.toolArgs.values()].reverse().find((entry) => entry.toolName === toolName);
    const path = pathOf(title);
    const rawInput = reported?.args ?? (path === undefined ? {} : { path });
    const decision = await this.permission({
      sessionId: this.sessionId,
      toolCall: { toolCallId: id, title, kind: toolName, rawInput },
      options: options.map((option) => {
        const kind = kindOfOption(option);
        // The id is omp's label, because that is what the reply frame has to carry.
        return { optionId: option, name: OPTION_NAME[kind], kind };
      }),
    });
    this.ask({ type: "extension_ui_response", id, value: optionIdFor(decision, options) });
  }

  private endTurn(frame: Frame): void {
    const resolve = this.turnResolve;
    this.turnResolve = undefined;
    this.turnReject = undefined;
    this.update = undefined;
    this.permission = undefined;
    this.toolArgs.clear();
    const status = str(frame, "status");
    const stopReason = status === undefined || status === "completed" ? "stop" : "cancelled";
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    resolve?.({ stopReason, timedOut: false, ...(usage === undefined ? {} : { usage }) });
  }
}

function blocksOf(message: Frame): Array<Frame> {
  const raw = Object.getOwnPropertyDescriptor(message, "content")?.value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Frame => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function resultText(result: Frame | undefined): string | undefined {
  if (result === undefined) return undefined;
  return blocksOf(result)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/** The approval title omp sends is `Allow tool: <name>\nPath: <path>\n…`. */
function toolKindOf(title: string): string {
  const match = /^Allow tool:\s*(\S+)/.exec(title);
  return match?.[1] ?? "tool";
}

function pathOf(title: string): string | undefined {
  const match = /^Path:\s*(.+)$/m.exec(title);
  return match?.[1]?.trim();
}
