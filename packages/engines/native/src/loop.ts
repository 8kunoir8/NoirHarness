import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Engine,
  EngineCapabilities,
  EngineHistoryMessage,
  EnginePromptResult,
  EngineSession,
  EngineStartOptions,
} from "@noir/engine-core";
import { ProviderHttpError, streamChat } from "./client.js";
import {
  NATIVE_TOOLS,
  PERMISSION_DENIED,
  readMaterializedSkill,
  runTool,
  toolKind,
  toolTitle,
  type ToolContext,
} from "./tools.js";

const MAX_TOOL_ROUNDS = 24;
const INVALID_STREAM = "Native engine returned an invalid stream chunk";

type Usage = NonNullable<EnginePromptResult["usage"]>;

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface RequestResult {
  text: string;
  toolCalls: ToolCall[];
  finish: string | undefined;
  usage: Usage | undefined;
}

type PromptHandlers = Parameters<EngineSession["prompt"]>[1];

/** The subset of a chat-completions stream chunk the loop consumes. */
const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().nonnegative().optional(),
                  id: z.string().nullish(),
                  function: z
                    .object({
                      name: z.string().nullish(),
                      arguments: z.string().nullish(),
                    })
                    .nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .nullish(),
});

type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

const CAPABILITIES: EngineCapabilities = {
  streaming: true,
  tools: true,
  diffs: true,
  approvals: true,
  subagents: false,
  steering: false,
  modelSelection: true,
};

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function systemPrompt(opts: EngineStartOptions): string {
  const skills = opts.skills.length === 0 ? "none" : opts.skills.map((skill) => skill.name).join(", ");
  return [
    "You are a coding agent running inside NoirHarness.",
    `Workspace root: ${opts.cwd}`,
    "Use the provided tools for filesystem and shell work. Paths are relative to the workspace root.",
    `Enabled skills: ${skills}`,
  ].join("\n");
}

function wireMessages(opts: EngineStartOptions, history: EngineHistoryMessage[]): WireMessage[] {
  const messages: WireMessage[] = [{ role: "system", content: systemPrompt(opts) }];
  for (const message of history) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: message.text });
        break;
      case "assistant":
        messages.push({
          role: "assistant",
          content: message.text,
          ...(message.toolCalls === undefined || message.toolCalls.length === 0
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }),
        });
        break;
      case "tool":
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          name: message.name,
          content: message.text,
        });
        break;
    }
  }
  return messages;
}

class NativeSession implements EngineSession {
  readonly #opts: EngineStartOptions;
  readonly #history: EngineHistoryMessage[];
  #model: EngineStartOptions["model"];
  #controller = new AbortController();
  #busy = false;
  #disposed = false;

  constructor(opts: EngineStartOptions) {
    this.#opts = opts;
    this.#history = [...opts.history];
    this.#model = opts.model;
  }

  async prompt(
    content: Array<{ type: "text"; text: string }>,
    handlers: PromptHandlers,
  ): Promise<EnginePromptResult> {
    if (this.#disposed) throw new Error("Native session is disposed");
    if (this.#busy) throw new Error("Native session already has a prompt in flight");
    this.#busy = true;
    try {
      const text = content.map((block) => block.text).join("\n");
      this.#history.push({ role: "user", text });
      // One controller per turn: interrupt() aborts the live fetch and the live tool call.
      this.#controller = new AbortController();
      const messageId = `native-${randomUUID()}`;
      let usage: Usage | undefined;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (this.#controller.signal.aborted) return { stopReason: "cancelled", timedOut: false };
        const response = await this.#request();
        if (response.usage !== undefined) usage = response.usage;
        if (response.text !== "") {
          handlers.onUpdate({ kind: "message", messageId, text: response.text, reasoning: false });
        }
        if (response.toolCalls.length === 0) {
          return {
            stopReason: response.finish ?? "stop",
            timedOut: false,
            ...(usage === undefined ? {} : { usage }),
          };
        }
        this.#history.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) await this.#runTool(call, handlers);
      }
      throw new Error("Tool loop limit reached");
    } catch (error) {
      // An interrupt aborts the fetch (and any running shell), which is a settled turn, not a fault.
      if (this.#controller.signal.aborted || isAbortError(error)) {
        return { stopReason: "cancelled", timedOut: false };
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async interrupt(): Promise<void> {
    this.#controller.abort();
  }

  async setModel(model: EngineStartOptions["model"]): Promise<void> {
    this.#model = model;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
  }

  async #request(): Promise<RequestResult> {
    const body = {
      model: this.#model.modelId,
      stream: true,
      stream_options: { include_usage: true },
      messages: wireMessages(this.#opts, this.#history),
      tools: NATIVE_TOOLS,
      tool_choice: "auto",
      ...(this.#model.maxTokens === null ? {} : { max_tokens: this.#model.maxTokens }),
    };

    const fragments: Array<{ id: string | undefined; name: string | undefined; arguments: string }> = [];
    let text = "";
    let finish: string | undefined;
    let usage: Usage | undefined;

    try {
      const stream = streamChat({
        baseUrl: this.#opts.baseUrl,
        apiKey: this.#opts.apiKey,
        body,
        signal: this.#controller.signal,
      });
      for await (const raw of stream) {
        const parsed = ChunkSchema.safeParse(raw);
        if (!parsed.success) throw new Error(INVALID_STREAM);
        const chunk = parsed.data;
        const choice = chunk.choices?.[0];
        if (choice !== undefined) {
          const delta = choice.delta;
          if (delta?.content !== undefined && delta.content !== null) text += delta.content;
          for (const fragment of delta?.tool_calls ?? []) {
            const index = fragment.index ?? fragments.length;
            const call = (fragments[index] ??= { id: undefined, name: undefined, arguments: "" });
            if (fragment.id !== undefined && fragment.id !== null) call.id = fragment.id;
            if (fragment.function?.name !== undefined && fragment.function.name !== null) {
              call.name = fragment.function.name;
            }
            if (fragment.function?.arguments !== undefined && fragment.function.arguments !== null) {
              call.arguments += fragment.function.arguments;
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            finish = choice.finish_reason;
          }
        }
        const reported = chunk.usage;
        if (reported !== undefined && reported !== null) {
          if (typeof reported.prompt_tokens === "number" && typeof reported.completion_tokens === "number") {
            usage = {
              inputTokens: reported.prompt_tokens,
              outputTokens: reported.completion_tokens,
              ...(typeof reported.total_tokens === "number" ? { totalTokens: reported.total_tokens } : {}),
            };
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        const hint = error.status === 401 || error.status === 403 ? " Check the provider API key." : "";
        throw new Error(`HTTP ${error.status}: ${error.body.trim()}${hint}`);
      }
      // A malformed frame and a malformed payload are the same protocol failure to the caller.
      if (error instanceof Error && (error.message === "invalid SSE chunk" || error.message === INVALID_STREAM)) {
        throw new Error(INVALID_STREAM);
      }
      throw error;
    }

    return {
      text,
      finish,
      usage,
      toolCalls: fragments.map((fragment, index) => ({
        id: fragment.id ?? `call_${index}`,
        name: fragment.name ?? "",
        arguments: fragment.arguments,
      })),
    };
  }

  async #runTool(call: ToolCall, handlers: PromptHandlers): Promise<void> {
    const args = parseArguments(call.arguments);
    handlers.onUpdate({
      kind: "tool.started",
      toolCallId: call.id,
      title: toolTitle(call.name, args),
      toolKind: toolKind(call.name),
      rawInput: args,
    });

    let text: string;
    let status: "completed" | "failed" = "completed";
    try {
      text = await runTool(call.name, args, this.#toolContext(handlers));
      if (text === PERMISSION_DENIED) status = "failed";
    } catch (error) {
      if (error instanceof z.ZodError) {
        text = `Tool input invalid: ${error.issues[0]?.message ?? "invalid arguments"}`;
      } else {
        text = error instanceof Error ? error.message : "Tool failed";
      }
      status = "failed";
    }

    handlers.onUpdate({ kind: "tool.updated", toolCallId: call.id, status, text });
    this.#history.push({ role: "tool", toolCallId: call.id, name: call.name, text });
  }

  #toolContext(handlers: PromptHandlers): ToolContext {
    return {
      sessionId: this.#opts.sessionId,
      workspaceRoot: this.#opts.cwd,
      signal: this.#controller.signal,
      onPermission: handlers.onPermission,
      skills: this.#opts.skills,
      readSkill: (name) => readMaterializedSkill(this.#opts.cwd, name),
    };
  }
}

/** The in-process engine that owns the OpenAI-compatible turn loop. */
export class NativeEngine implements Engine {
  readonly id = "native" as const;
  readonly capabilities: EngineCapabilities = CAPABILITIES;

  async start(opts: EngineStartOptions): Promise<EngineSession> {
    return new NativeSession(opts);
  }
}

export function createNativeEngine(): Engine {
  return new NativeEngine();
}

export const nativeEngine: Engine = new NativeEngine();
