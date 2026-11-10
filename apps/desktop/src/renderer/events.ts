import { useCallback, useEffect, useState } from "react";
import {
  PayloadSchemas,
  type AgentEvent,
  type PermissionOption,
  type SessionStatus,
} from "@noir/protocol";
import {
  connect,
  offEvent,
  request as defaultRequest,
  type SessionSubscription,
} from "./api.js";
import type { RequestFn } from "./Settings.js";

export interface ChatBlock {
  kind: "text" | "reasoning";
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: ChatBlock[];
  status?: "streaming" | "done" | "interrupted" | "failed";
}

export interface ChatTool {
  id: string;
  title: string;
  status: string;
  output: string;
}

export interface ChatUsage {
  used: number;
  size: number;
  costUsd: number;
}

export interface ChatApproval {
  approvalId: string;
  title: string;
  options: PermissionOption[];
}

export interface ChatState {
  sessionId?: string;
  title?: string;
  messages: ChatMessage[];
  tools: ChatTool[];
  approval?: ChatApproval;
  status: SessionStatus;
  usage?: ChatUsage;
  error?: string;
  activeTurnId?: string;
  lastSeq: number;
}

export function emptyChatState(sessionId?: string): ChatState {
  const base: ChatState = { messages: [], tools: [], status: "idle", lastSeq: 0 };
  return sessionId === undefined ? base : { ...base, sessionId };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function without(state: ChatState, key: "error" | "activeTurnId" | "approval"): ChatState {
  const copy: ChatState = { ...state };
  if (key === "error") delete copy.error;
  else if (key === "activeTurnId") delete copy.activeTurnId;
  else delete copy.approval;
  return copy;
}

function appendBlock(message: ChatMessage, kind: ChatBlock["kind"], text: string): ChatMessage {
  const blocks = [...message.blocks];
  const last = blocks.at(-1);
  if (last !== undefined && last.kind === kind) {
    blocks[blocks.length - 1] = { kind, text: last.text + text };
  } else {
    blocks.push({ kind, text });
  }
  return { ...message, blocks };
}

function upsertTool(tools: ChatTool[], id: string, patch: Partial<ChatTool>): ChatTool[] {
  const index = tools.findIndex((tool) => tool.id === id);
  if (index === -1) {
    return [...tools, { title: "", status: "running", output: "", ...patch, id }];
  }
  const next = [...tools];
  next[index] = { ...next[index]!, ...patch, id };
  return next;
}

/**
 * Pure projection of kernel events onto one session's chat transcript.
 * Events from other sessions are ignored; `seq` deduplicates replays; a gap is
 * tolerated by applying what arrived (the subscription backfills from seq 0).
 */
export function reduceChat(state: ChatState, event: AgentEvent): ChatState {
  if (state.sessionId !== undefined && state.sessionId !== event.sessionId) return state;
  if (event.seq <= state.lastSeq) return state;

  const next: ChatState = { ...state, sessionId: event.sessionId, lastSeq: event.seq };

  switch (event.type) {
    case "session.created": {
      const parsed = PayloadSchemas["session.created"].safeParse(event.payload);
      return parsed.success ? { ...next, title: parsed.data.title } : next;
    }
    case "session.updated": {
      const parsed = PayloadSchemas["session.updated"].safeParse(event.payload);
      return parsed.success ? { ...next, title: parsed.data.title } : next;
    }
    case "session.status": {
      const parsed = PayloadSchemas["session.status"].safeParse(event.payload);
      return parsed.success ? { ...next, status: parsed.data.status } : next;
    }
    case "session.closed":
      return { ...next, status: "closed" };
    case "turn.started": {
      const parsed = PayloadSchemas["turn.started"].safeParse(event.payload);
      return parsed.success ? { ...without(next, "error"), activeTurnId: parsed.data.turnId } : next;
    }
    case "turn.completed":
      return without(next, "activeTurnId");
    case "turn.failed": {
      const parsed = PayloadSchemas["turn.failed"].safeParse(event.payload);
      return parsed.success ? { ...without(next, "activeTurnId"), error: parsed.data.message } : next;
    }
    case "message.delta": {
      const parsed = PayloadSchemas["message.delta"].safeParse(event.payload);
      if (!parsed.success) return next;
      const { messageId, role, block } = parsed.data;
      if (block.type === "tool_call") {
        return { ...next, tools: upsertTool(next.tools, block.toolCallId, { title: block.title, status: block.status }) };
      }
      if (block.type === "tool_result") {
        return { ...next, tools: upsertTool(next.tools, block.toolCallId, { status: block.status, output: block.output ?? "" }) };
      }
      if (block.type !== "text" && block.type !== "reasoning") return next;
      const kind: ChatBlock["kind"] = block.type === "text" ? "text" : "reasoning";
      const index = next.messages.findIndex((message) => message.id === messageId);
      const messages = [...next.messages];
      if (index === -1) {
        messages.push({ id: messageId, role, blocks: [{ kind, text: block.text }], status: "streaming" });
      } else {
        messages[index] = appendBlock(messages[index]!, kind, block.text);
      }
      return { ...next, messages };
    }
    case "message.completed": {
      const parsed = PayloadSchemas["message.completed"].safeParse(event.payload);
      if (!parsed.success) return next;
      const index = next.messages.findIndex((message) => message.id === parsed.data.messageId);
      if (index === -1) return next;
      const messages = [...next.messages];
      messages[index] = { ...messages[index]!, status: parsed.data.status };
      return { ...next, messages };
    }
    case "tool.started": {
      const parsed = PayloadSchemas["tool.started"].safeParse(event.payload);
      return parsed.success
        ? { ...next, tools: upsertTool(next.tools, parsed.data.toolCallId, { title: parsed.data.title, status: "running" }) }
        : next;
    }
    case "tool.output": {
      const parsed = PayloadSchemas["tool.output"].safeParse(event.payload);
      if (!parsed.success) return next;
      const existing = next.tools.find((tool) => tool.id === parsed.data.toolCallId);
      return {
        ...next,
        tools: upsertTool(next.tools, parsed.data.toolCallId, { output: (existing?.output ?? "") + parsed.data.chunk }),
      };
    }
    case "tool.completed": {
      const parsed = PayloadSchemas["tool.completed"].safeParse(event.payload);
      return parsed.success
        ? { ...next, tools: upsertTool(next.tools, parsed.data.toolCallId, { status: parsed.data.status }) }
        : next;
    }
    case "tool.failed": {
      const parsed = PayloadSchemas["tool.failed"].safeParse(event.payload);
      if (!parsed.success) return next;
      const existing = next.tools.find((tool) => tool.id === parsed.data.toolCallId);
      const output = existing === undefined || existing.output === ""
        ? parsed.data.message
        : `${existing.output}\n${parsed.data.message}`;
      return { ...next, tools: upsertTool(next.tools, parsed.data.toolCallId, { status: "failed", output }) };
    }
    case "permission.requested": {
      const parsed = PayloadSchemas["permission.requested"].safeParse(event.payload);
      return parsed.success
        ? { ...next, approval: { approvalId: parsed.data.approvalId, title: parsed.data.title, options: parsed.data.options } }
        : next;
    }
    case "permission.resolved": {
      const parsed = PayloadSchemas["permission.resolved"].safeParse(event.payload);
      if (!parsed.success) return next;
      return next.approval?.approvalId === parsed.data.approvalId ? without(next, "approval") : next;
    }
    case "usage.updated": {
      const parsed = PayloadSchemas["usage.updated"].safeParse(event.payload);
      return parsed.success
        ? { ...next, usage: { used: parsed.data.contextUsed, size: parsed.data.contextWindow, costUsd: parsed.data.costUsd } }
        : next;
    }
    default:
      return next;
  }
}

export function appendUserMessage(state: ChatState, text: string, id: string): ChatState {
  if (text.trim().length === 0) return state;
  const message: ChatMessage = { id, role: "user", blocks: [{ kind: "text", text }], status: "done" };
  return { ...state, messages: [...state.messages, message] };
}

function ordered(events: AgentEvent[]): AgentEvent[] {
  const seen = new Set<string>();
  const result: AgentEvent[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = `${event.sessionId}:${event.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

export interface SessionEvents {
  state: ChatState;
  appendUser: (text: string, id: string) => void;
}

/**
 * Replays `session.subscribe` from seq 0, then applies live notifications through
 * `reduceChat`. Events that land before the replay resolves are buffered and merged
 * in seq order, so StrictMode's double mount cannot lose or duplicate a frame.
 */
export function useSessionEvents(sessionId: string, requestFn: RequestFn = defaultRequest): SessionEvents {
  const [state, setState] = useState<ChatState>(() => emptyChatState(sessionId));

  useEffect(() => {
    let active = true;
    let replaying = true;
    const buffered: AgentEvent[] = [];
    setState(emptyChatState(sessionId));

    const listener = (event: AgentEvent): void => {
      if (event.sessionId !== sessionId) return;
      if (replaying) buffered.push(event);
      else if (active) setState((prev) => reduceChat(prev, event));
    };

    void connect(listener).catch(() => {
      // Live delivery is best effort; the replay below still reconstructs the history.
    });

    void (async () => {
      try {
        const subscription = await requestFn<SessionSubscription>("session.subscribe", { sessionId, sinceSeq: 0 });
        if (!active) return;
        const replay = Array.isArray(subscription?.events) ? subscription.events : [];
        setState((prev) => ordered([...replay, ...buffered]).reduce(reduceChat, prev));
      } catch (error) {
        if (active) setState((prev) => ({ ...prev, error: errorMessage(error) }));
      } finally {
        replaying = false;
        buffered.length = 0;
      }
    })();

    return () => {
      active = false;
      offEvent(listener);
    };
  }, [sessionId, requestFn]);

  const appendUser = useCallback((text: string, id: string) => {
    setState((prev) => appendUserMessage(prev, text, id));
  }, []);

  return { state, appendUser };
}
