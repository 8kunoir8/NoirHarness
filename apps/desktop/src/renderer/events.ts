import { useCallback, useEffect, useState } from "react";
import {
  PayloadSchemas,
  type AgentEvent,
  type LoadedSkillState,
  type PermissionOption,
  type SessionStatus,
} from "@noir/protocol";
import {
  connect,
  offEvent,
  request as defaultRequest,
  type RequestFn,
  type SessionSubscription,
} from "./api.js";

export type ChatBlock =
  | { kind: "text" | "reasoning"; text: string }
  /** A `file_ref`/`diff_ref` from the event log: a path, never concatenated with text. */
  | { kind: "file"; path: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: ChatBlock[];
  status?: "streaming" | "done" | "interrupted" | "failed";
  /** The turn this message belongs to; a rewind is addressed by turn, not by message. */
  turnId?: string;
  /** Seq of its first event, so markers and messages can be ordered together. */
  seq?: number;
}

/** One rewind as the transcript draws it: where the cut was and what the restore moved. */
export interface ChatRewind {
  seq: number;
  cutSeq: number;
  promptSeq: number | null;
  restored: number;
  deleted: number;
  removed: number;
  failed: number;
  notCaptured: number;
  engineNotRewound: boolean;
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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ChatApproval {
  approvalId: string;
  title: string;
  options: PermissionOption[];
}

export interface ChatFile {
  path: string;
  change: "created" | "modified" | "deleted";
  add: number;
  del: number;
}

export interface ChatPlanItem {
  text: string;
  status: "pending" | "active" | "done";
}

export interface ChatTurn {
  status: "completed" | "interrupted" | "failed";
  ms: number;
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
  turnStartedAt?: number;
  /** Why the kernel stopped this session; cleared when the next turn starts. */
  stopReason?: string;
  lastTurn?: ChatTurn;
  files: ChatFile[];
  plan: ChatPlanItem[];
  skillsLoaded: LoadedSkillState[];
  /** Kernel-side failures a turn did not stop for, e.g. an MCP server that would not start. */
  notices: string[];
  /** Every rewind the log still shows, in seq order; the transcript draws a marker per entry. */
  rewinds: ChatRewind[];
  lastSeq: number;
}

export function emptyChatState(sessionId?: string): ChatState {
  const base: ChatState = {
    messages: [],
    tools: [],
    files: [],
    plan: [],
    skillsLoaded: [],
    notices: [],
    rewinds: [],
    status: "idle",
    lastSeq: 0,
  };
  return sessionId === undefined ? base : { ...base, sessionId };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function without(
  state: ChatState,
  key: "error" | "activeTurnId" | "approval" | "turnStartedAt" | "stopReason",
): ChatState {
  const copy: ChatState = { ...state };
  if (key === "error") delete copy.error;
  else if (key === "activeTurnId") delete copy.activeTurnId;
  else if (key === "turnStartedAt") delete copy.turnStartedAt;
  else if (key === "stopReason") delete copy.stopReason;
  else delete copy.approval;
  return copy;
}

type TextBlock = Extract<ChatBlock, { text: string }>;

function isTextBlock(block: ChatBlock): block is TextBlock {
  return block.kind === "text" || block.kind === "reasoning";
}

function textBlock(kind: "text" | "reasoning", text: string): ChatBlock {
  return kind === "text" ? { kind: "text", text } : { kind: "reasoning", text };
}

function appendBlock(message: ChatMessage, kind: "text" | "reasoning", text: string): ChatMessage {
  const blocks: ChatBlock[] = [...message.blocks];
  const last = blocks.at(-1);
  if (last !== undefined && isTextBlock(last) && last.kind === kind) {
    blocks[blocks.length - 1] = textBlock(kind, last.text + text);
  } else {
    blocks.push(textBlock(kind, text));
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
      if (!parsed.success) return next;
      const { status, reason } = parsed.data;
      if (status === "error" && reason !== undefined) return { ...next, status, stopReason: reason };
      return { ...without(next, "stopReason"), status };
    }
    case "session.closed":
      return { ...next, status: "closed" };
    case "session.rewound": {
      const parsed = PayloadSchemas["session.rewound"].safeParse(event.payload);
      if (!parsed.success) return next;
      return {
        ...next,
        rewinds: [
          ...next.rewinds,
          {
            seq: event.seq,
            cutSeq: parsed.data.cutSeq,
            promptSeq: parsed.data.promptSeq,
            restored: parsed.data.restored,
            deleted: parsed.data.deleted,
            removed: parsed.data.removed,
            failed: parsed.data.failed,
            notCaptured: parsed.data.notCaptured,
            engineNotRewound: parsed.data.engineNotRewound,
          },
        ],
      };
    }
    case "turn.started": {
      const parsed = PayloadSchemas["turn.started"].safeParse(event.payload);
      return parsed.success
        ? { ...without(without(next, "error"), "stopReason"), activeTurnId: parsed.data.turnId, turnStartedAt: event.ts }
        : next;
    }
    case "turn.completed": {
      const parsed = PayloadSchemas["turn.completed"].safeParse(event.payload);
      if (!parsed.success) return without(next, "activeTurnId");
      return {
        ...without(without(next, "activeTurnId"), "turnStartedAt"),
        lastTurn: { status: parsed.data.status, ms: event.ts - (next.turnStartedAt ?? event.ts) },
      };
    }
    case "turn.failed": {
      const parsed = PayloadSchemas["turn.failed"].safeParse(event.payload);
      if (!parsed.success) return without(next, "activeTurnId");
      return {
        ...without(without(next, "activeTurnId"), "turnStartedAt"),
        error: parsed.data.message,
        lastTurn: { status: "failed", ms: event.ts - (next.turnStartedAt ?? event.ts) },
      };
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
      if (block.type !== "text" && block.type !== "reasoning") {
        if (block.type !== "file_ref" && block.type !== "diff_ref") return next;
        // A `diff_ref` previews the working-tree file, which is the same `path` field.
        const path = block.path;
        const index = next.messages.findIndex((message) => message.id === messageId);
        if (role === "user" && index !== -1) return next;
        if (index === -1) {
          return {
            ...next,
            messages: [
              ...next.messages,
              {
                id: messageId,
                role,
                blocks: [{ kind: "file", path }],
                status: "streaming",
                seq: event.seq,
                ...(event.turnId === null || event.turnId === undefined ? {} : { turnId: event.turnId }),
              },
            ],
          };
        }
        const message = next.messages[index]!;
        // A repeated reference in one message is not a second link.
        if (message.blocks.some((existing) => existing.kind === "file" && existing.path === path)) return next;
        const messages = [...next.messages];
        messages[index] = { ...message, blocks: [...message.blocks, { kind: "file", path }] };
        return { ...next, messages };
      }
      const kind: "text" | "reasoning" = block.type === "text" ? "text" : "reasoning";
      const index = next.messages.findIndex((message) => message.id === messageId);
      // The sender renders its own prompt before the kernel's echo arrives; the echo must not
      // append a second bubble for a message the transcript already holds.
      if (role === "user" && index !== -1) {
        // The echo is what names the optimistic bubble's turn and seq; it was created before this
        // event arrived, so dropping the event here would leave the prompt unaddressable.
        const existing = next.messages[index]!;
        if (existing.seq !== undefined) return next;
        const named = [...next.messages];
        named[index] = {
          ...existing,
          seq: event.seq,
          ...(event.turnId === null || event.turnId === undefined ? {} : { turnId: event.turnId }),
        };
        return { ...next, messages: named };
      }
      const messages = [...next.messages];
      if (index === -1) {
        messages.push({
          id: messageId,
          role,
          blocks: [{ kind, text: block.text }],
          status: "streaming",
          seq: event.seq,
          ...(event.turnId === null || event.turnId === undefined ? {} : { turnId: event.turnId }),
        });
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
      if (!parsed.success) return next;
      const { inputTokens, outputTokens, contextUsed, contextWindow, costUsd } = parsed.data;
      return { ...next, usage: { used: contextUsed, size: contextWindow, inputTokens, outputTokens, costUsd } };
    }
    case "file.changed": {
      const parsed = PayloadSchemas["file.changed"].safeParse(event.payload);
      if (!parsed.success) return next;
      const { path, change, add, del } = parsed.data;
      const index = next.files.findIndex((file) => file.path === path);
      const files = index === -1 ? [...next.files, { path, change, add, del }] : [...next.files];
      if (index !== -1) files[index] = { path, change, add, del };
      return { ...next, files };
    }
    case "plan.updated": {
      const parsed = PayloadSchemas["plan.updated"].safeParse(event.payload);
      return parsed.success ? { ...next, plan: parsed.data.items } : next;
    }
    case "skill.loaded": {
      const parsed = PayloadSchemas["skill.loaded"].safeParse(event.payload);
      if (!parsed.success) return next;
      const { name, scope, hash } = parsed.data;
      if (next.skillsLoaded.some((skill) => skill.name === name)) return next;
      return { ...next, skillsLoaded: [...next.skillsLoaded, { name, scope, hash }] };
    }
    case "engine.raw": {
      // Only the broker's warnings carry a message worth showing; every other engine's raw
      // payload is diagnostic noise the transcript must not grow a bubble for.
      const parsed = PayloadSchemas["engine.raw"].safeParse(event.payload);
      if (!parsed.success || parsed.data.engine !== "mcp") return next;
      const payload = parsed.data.payload;
      const warning =
        typeof payload === "object" && payload !== null && "warning" in payload && typeof payload.warning === "string"
          ? payload.warning
          : undefined;
      if (warning === undefined || next.notices.includes(warning)) return next;
      return { ...next, notices: [...next.notices, warning] };
    }
    default:
      return next;
  }
}

/**
 * The newest tool still running in this session, which is the chat's own description of the turn —
 * "Run `pnpm test`", not "shell". The sidebar shows it while the chat is open; the roster carries
 * the same call's kind, so the office can still say what the agent is doing with no title at all.
 */
export function runningToolTitle(state: ChatState): string | undefined {
  for (let index = state.tools.length - 1; index >= 0; index -= 1) {
    const tool = state.tools[index];
    if (tool !== undefined && tool.status === "running" && tool.title.trim() !== "") return tool.title;
  }
  return undefined;
}

/** One line of the transcript. A rewind and a message share one ordering, by seq. */
export interface TranscriptRow {
  seq: number;
  message?: ChatMessage;
  rewind?: ChatRewind;
  turnId?: string;
}

export function transcriptRows(state: ChatState): TranscriptRow[] {
  return [
    ...state.messages.map((message) => ({
      seq: message.seq ?? Number.MAX_SAFE_INTEGER,
      message,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    })),
    ...state.rewinds.map((rewind) => ({ seq: rewind.seq, rewind })),
  ].sort((left, right) => left.seq - right.seq);
}

export function appendUserMessage(state: ChatState, text: string, id: string): ChatState {
  if (text.trim().length === 0) return state;
  // The event log may have rendered this prompt first (it reaches the reducer before the RPC
  // resolves); the id is the request id either way, so one prompt stays one bubble.
  if (state.messages.some((message) => message.id === id)) return state;
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
  // A rewind invalidates every projection of the old log; bumping this replays from zero.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (sessionId === "") {
      setState(emptyChatState());
      return;
    }
    let active = true;
    let replaying = true;
    const buffered: AgentEvent[] = [];
    setState(emptyChatState(sessionId));

    const listener = (event: AgentEvent): void => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "session.rewound") {
        // The kernel answers a replay without the abandoned range, so the transcript is rebuilt
        // rather than truncated here: one way to build a transcript, not two.
        setGeneration((value) => value + 1);
        return;
      }
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
        // Snapshot the merged, ordered batch before scheduling state; the buffer is emptied
        // immediately afterwards so no deferred updater can miss a live frame.
        const merged = ordered([...replay, ...buffered]);
        buffered.length = 0;
        replaying = false;
        setState((prev) => merged.reduce(reduceChat, prev));
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
  }, [sessionId, requestFn, generation]);

  const appendUser = useCallback((text: string, id: string) => {
    setState((prev) => appendUserMessage(prev, text, id));
  }, []);

  return { state, appendUser };
}
