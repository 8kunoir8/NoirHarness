import type { infer as ZodInfer } from "zod";
import type { AgentEvent, ContentBlock, EventType, SessionStatus } from "./events.js";
import { PayloadSchemas } from "./events.js";

export interface MessageState { id: string; role: "user" | "assistant"; blocks: ContentBlock[]; status: "streaming" | "done" | "interrupted" | "failed"; }
export interface ChangedFileState { path: string; change: "created" | "modified" | "deleted"; add: number; del: number; }
export interface UsageState { inputTokens: number; outputTokens: number; contextUsed: number; contextWindow: number; costUsd: number; }
export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  title: string;
  messages: MessageState[];
  usage: UsageState;
  changedFiles: ChangedFileState[];
}

function payload<T extends EventType>(e: AgentEvent, type: T): ZodInfer<(typeof PayloadSchemas)[T]> {
  if (e.type !== type) throw new Error(`expected ${type}, got ${e.type}`);
  return PayloadSchemas[type].parse(e.payload) as ZodInfer<(typeof PayloadSchemas)[T]>;
}

const EMPTY: Omit<SessionState, "sessionId"> = {
  status: "idle",
  title: "",
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0, contextUsed: 0, contextWindow: 0, costUsd: 0 },
  changedFiles: [],
};

export function reduceSession(state: SessionState | undefined, e: AgentEvent): SessionState {
  const s: SessionState = state ?? { sessionId: e.sessionId, ...structuredClone(EMPTY) };

  switch (e.type) {
    case "session.created":
      return { ...s, title: payload(e, "session.created").title };
    case "session.updated":
      return { ...s, title: payload(e, "session.updated").title };
    case "session.status":
      return { ...s, status: payload(e, "session.status").status };
    case "session.closed":
      return { ...s, status: "closed" };
    case "message.delta": {
      const p = payload(e, "message.delta");
      const idx = s.messages.findIndex((m) => m.id === p.messageId);
      if (idx === -1) {
        return { ...s, messages: [...s.messages, { id: p.messageId, role: p.role, blocks: [p.block], status: "streaming" }] };
      }
      const messages = s.messages.slice();
      const current = messages[idx]!;
      messages[idx] = { ...current, blocks: [...current.blocks, p.block] };
      return { ...s, messages };
    }
    case "message.completed": {
      const p = payload(e, "message.completed");
      return { ...s, messages: s.messages.map((m) => (m.id === p.messageId ? { ...m, status: p.status } : m)) };
    }
    case "usage.updated":
      return { ...s, usage: payload(e, "usage.updated") };
    case "file.changed": {
      const p = payload(e, "file.changed");
      return { ...s, changedFiles: [...s.changedFiles.filter((f) => f.path !== p.path), { path: p.path, change: p.change, add: p.add, del: p.del }] };
    }
    default:
      return s;
  }
}
