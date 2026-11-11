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
  | { kind: "tool.started"; toolCallId: string; title: string; toolKind: string; rawInput: unknown }
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

export interface EngineStartOptions {
  sessionId: string;
  cwd: string;
  model: { providerName: string; modelId: string; contextWindow: number; maxTokens: number | null };
  baseUrl: string;
  apiKey: string;
  history: EngineHistoryMessage[];
  skills: Array<{ name: string; scope: "global" | "project"; description: string }>;
  turnTimeoutMs: number;
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
