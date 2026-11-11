import { z } from "zod";
import type { EngineHistoryMessage } from "@noir/engine-core";

/**
 * The event fields reconstruction reads. `AgentEvent` from `@noir/protocol` satisfies it; the
 * engine deliberately stays free of a protocol dependency and consumes only the log the kernel
 * hands it.
 */
export interface HistoryEvent {
  seq: number;
  type: string;
  /** `AgentEvent` spells an absent turn as `undefined` through its schema; both mean "no turn". */
  turnId?: string | null | undefined;
  /** Zod's `unknown()` infers an optional property, so an event may carry no payload at all. */
  payload?: unknown;
}

export interface HistoryLimits {
  contextWindow: number;
  /** The completion reservation the request leaves out of the window; `null` reserves nothing. */
  maxTokens: number | null;
}

const CHARS_PER_TOKEN = 4;
/** Room for the system prompt and the next reply: never fill the window to its brim. */
const RESERVE_TOKENS = 2_000;

const DeltaSchema = z.object({
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  block: z.object({ type: z.string(), text: z.string().optional() }),
});
const ToolStartedSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  /** Absent on events written before the kernel persisted the provider's call. */
  toolName: z.string().optional(),
  argumentsJson: z.string().optional(),
});
const ToolOutputSchema = z.object({ toolCallId: z.string(), chunk: z.string() });
const ToolCompletedSchema = z.object({ toolCallId: z.string() });
const ToolFailedSchema = z.object({ toolCallId: z.string(), message: z.string() });

type HistoryToolCall = NonNullable<Extract<EngineHistoryMessage, { role: "assistant" }>["toolCalls"]>[number];

interface AssistantDraft {
  text: string;
  toolCalls: HistoryToolCall[];
}

interface TurnDraft {
  userParts: string[];
  drafts: AssistantDraft[];
  /** Tool results by call id; the tool output stream and the failure message both land here. */
  results: Map<string, string>;
}

interface TurnHistory {
  messages: EngineHistoryMessage[];
  chars: number;
}

function emptyTurn(): TurnDraft {
  return { userParts: [], drafts: [], results: new Map() };
}

function appendResult(turn: TurnDraft, toolCallId: string, text: string): void {
  const existing = turn.results.get(toolCallId) ?? "";
  const joined = existing === "" || text === "" ? existing + text : `${existing}\n${text}`;
  turn.results.set(toolCallId, joined);
}

function applyEvent(turn: TurnDraft, event: HistoryEvent): void {
  switch (event.type) {
    case "message.delta": {
      const parsed = DeltaSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.block.type !== "text" || parsed.data.block.text === undefined) return;
      const text = parsed.data.block.text;
      if (parsed.data.role === "user") {
        turn.userParts.push(text);
        return;
      }
      // Text after a round's tool calls opens the next round's assistant message.
      let draft = turn.drafts.at(-1);
      if (draft === undefined || draft.toolCalls.length > 0) {
        draft = { text: "", toolCalls: [] };
        turn.drafts.push(draft);
      }
      draft.text += text;
      return;
    }
    case "tool.started": {
      const parsed = ToolStartedSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const name = parsed.data.toolName;
      // Without the provider's own name there is no valid call to replay. Keep the text and drop
      // the call rather than inventing a function name the provider never saw.
      if (name === undefined || name === "") return;
      let draft = turn.drafts.at(-1);
      // A new round of tool calls after every earlier call settled is a new assistant message.
      if (
        draft !== undefined &&
        draft.toolCalls.length > 0 &&
        draft.toolCalls.every((call) => turn.results.has(call.id))
      ) {
        draft = undefined;
      }
      if (draft === undefined) {
        draft = { text: "", toolCalls: [] };
        turn.drafts.push(draft);
      }
      const argumentsJson = parsed.data.argumentsJson;
      draft.toolCalls.push({
        id: parsed.data.toolCallId,
        name,
        arguments: argumentsJson === undefined || argumentsJson === "" ? "{}" : argumentsJson,
      });
      return;
    }
    case "tool.output": {
      const parsed = ToolOutputSchema.safeParse(event.payload);
      if (parsed.success) appendResult(turn, parsed.data.toolCallId, parsed.data.chunk);
      return;
    }
    case "tool.completed": {
      // A finished call with no output is still settled; that settles its round for the draft split.
      const parsed = ToolCompletedSchema.safeParse(event.payload);
      if (parsed.success && !turn.results.has(parsed.data.toolCallId)) {
        turn.results.set(parsed.data.toolCallId, "");
      }
      return;
    }
    case "tool.failed": {
      const parsed = ToolFailedSchema.safeParse(event.payload);
      if (parsed.success) appendResult(turn, parsed.data.toolCallId, parsed.data.message);
      return;
    }
    default:
      return;
  }
}

/** One turn's messages in wire order: the prompt, then each round's assistant message and results. */
function messagesFor(turn: TurnDraft): EngineHistoryMessage[] {
  const messages: EngineHistoryMessage[] = [];
  if (turn.userParts.length > 0) messages.push({ role: "user", text: turn.userParts.join("\n") });
  for (const draft of turn.drafts) {
    if (draft.text === "" && draft.toolCalls.length === 0) continue;
    messages.push(
      draft.toolCalls.length === 0
        ? { role: "assistant", text: draft.text }
        : { role: "assistant", text: draft.text, toolCalls: draft.toolCalls },
    );
    for (const call of draft.toolCalls) {
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, text: turn.results.get(call.id) ?? "" });
    }
  }
  return messages;
}

function charsOf(messages: EngineHistoryMessage[]): number {
  return messages.reduce((total, message) => total + message.text.length, 0);
}

export interface ReconstructedHistory {
  messages: EngineHistoryMessage[];
  /** Whole turns dropped, oldest first, to fit the model window. */
  trimmedTurns: number;
}

/**
 * Rebuilds the conversation from the persisted event log, newest last.
 *
 * Turns are dropped whole, oldest first, until the estimated request (characters / 4) fits the
 * model's window minus its completion reservation. The newest turn is always kept: sending a
 * partial or empty newest turn would lose the reply the user is waiting for. The caller logs the
 * dropped count; nothing in the event stream records a trim on its own.
 */
export function reconstructHistory(events: HistoryEvent[], limits: HistoryLimits): ReconstructedHistory {
  const turns = new Map<string, TurnDraft>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    // Only a turn's own stream can be attributed; session-level events reconstruct nothing.
    if (event.turnId === null || event.turnId === undefined) continue;
    let turn = turns.get(event.turnId);
    if (turn === undefined) {
      turn = emptyTurn();
      turns.set(event.turnId, turn);
    }
    applyEvent(turn, event);
  }

  const history: TurnHistory[] = [];
  for (const turn of turns.values()) {
    const messages = messagesFor(turn);
    if (messages.length > 0) history.push({ messages, chars: charsOf(messages) });
  }

  const budget = limits.contextWindow - (limits.maxTokens ?? 0) - RESERVE_TOKENS;
  let start = 0;
  let chars = history.reduce((total, turn) => total + turn.chars, 0);
  while (start < history.length - 1 && chars / CHARS_PER_TOKEN > budget) {
    chars -= history[start]!.chars;
    start += 1;
  }
  return { messages: history.slice(start).flatMap((turn) => turn.messages), trimmedTurns: start };
}
