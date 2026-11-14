/**
 * The neutral engine contract shared by every engine implementation.
 *
 * Engines only produce updates; the kernel owns turns, approvals, commands, usage projection,
 * and session status.
 */

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type PermissionDecision = "allow_once" | "allow_always" | "reject" | "reject_always";

export interface EnginePromptResult {
  stopReason: string;
  timedOut: boolean;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
}

export type EngineUpdate =
  | { kind: "message"; messageId: string; text: string; reasoning: boolean }
  | {
      kind: "tool.started";
      toolCallId: string;
      title: string;
      toolKind: string;
      rawInput: unknown;
      /** The provider's own function name and raw arguments, when the engine knows them. */
      toolName?: string;
      argumentsJson?: string;
    }
  | {
      kind: "tool.updated";
      toolCallId: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      text?: string;
    }
  | { kind: "usage"; size: number; used: number; costAmount?: number }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }
  | { kind: "title"; title: string }
  | { kind: "raw"; update: unknown };

export interface EnginePermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title: string; kind?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: PermissionOptionKind }>;
}

export interface EngineCapabilities {
  streaming: boolean;
  tools: boolean;
  diffs: boolean;
  approvals: boolean;
  subagents: boolean;
  steering: boolean;
  modelSelection: boolean;
}

export type EngineHistoryMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; name: string; text: string };

/**
 * A tool an MCP server advertises, already namespaced `mcp__<server>__<tool>`. `parameters` is the
 * server's JSON Schema, passed to the provider unchanged.
 */
export interface EngineMcpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One MCP server a session may use. The ACP engine hands these to `session/new` as `mcpServers`,
 * which is why the shape carries the transport: an agent spawns a stdio server itself and reaches
 * an HTTP one directly, and it cannot infer which from an absent command.
 */
export type EngineMcpServer =
  | { transport: "stdio"; name: string; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; name: string; url: string; headers: Record<string, string> };

export interface EngineStartOptions {
  sessionId: string;
  cwd: string;
  model: { providerName: string; modelId: string; contextWindow: number; maxTokens: number | null };
  baseUrl: string;
  apiKey: string;
  history: EngineHistoryMessage[];
  skills: Array<{ name: string; scope: "global" | "project"; description: string }>;
  turnTimeoutMs: number;
  /** Tools discovered from the session's MCP servers; the native engine appends them to its own. */
  mcpTools?: EngineMcpTool[];
  /** Runs one namespaced MCP tool. The kernel owns the subprocess, so the engine only asks. */
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** The servers themselves, for engines that speak MCP natively (ACP). */
  mcpServers?: EngineMcpServer[];
}

export interface EngineSession {
  prompt(
    content: Array<{ type: "text"; text: string }>,
    handlers: {
      onUpdate(update: EngineUpdate): void;
      onPermission(request: EnginePermissionRequest): Promise<PermissionDecision>;
      onSkillRead(name: string): void;
    },
  ): Promise<EnginePromptResult>;
  interrupt(): Promise<void>;
  /** Child pid when the engine is a process (ACP); absent for in-process engines. */
  readonly pid?: number;
  setModel?(model: EngineStartOptions["model"]): Promise<void>;
  dispose(): Promise<void>;
}

export interface Engine {
  id: "acp" | "native";
  capabilities: EngineCapabilities;
  start(opts: EngineStartOptions): Promise<EngineSession>;
}
