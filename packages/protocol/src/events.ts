import { z } from "zod";

export const EVENT_VERSION = 1 as const;

export const SessionStatus = z.enum(["idle", "starting", "running", "waiting", "error", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), toolCallId: z.string(), title: z.string(), status: z.string() }),
  z.object({ type: z.literal("tool_result"), toolCallId: z.string(), status: z.string(), output: z.string().optional() }),
  z.object({ type: z.literal("image"), mimeType: z.string(), blobRef: z.string() }),
  z.object({ type: z.literal("file_ref"), path: z.string() }),
  z.object({ type: z.literal("diff_ref"), path: z.string(), blobRef: z.string() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const PermissionDecision = z.enum(["allow_once", "allow_always", "reject", "reject_always"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionOption = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: PermissionDecision,
});
export type PermissionOption = z.infer<typeof PermissionOption>;

export const EventType = z.enum([
  "session.created", "session.updated", "session.status", "session.closed",
  "turn.started", "turn.completed", "turn.failed",
  "message.delta", "message.completed",
  "tool.started", "tool.output", "tool.completed", "tool.failed",
  "permission.requested", "permission.resolved",
  "file.changed", "command.started", "command.output", "command.completed",
  "usage.updated", "plan.updated", "todo.updated", "skill.loaded",
  "engine.raw",
]);
export type EventType = z.infer<typeof EventType>;

export const PayloadSchemas = {
  "session.created": z.object({ title: z.string() }),
  "session.updated": z.object({ title: z.string() }),
  "session.status": z.object({ status: SessionStatus }),
  "session.closed": z.object({ reason: z.string().optional() }),
  "turn.started": z.object({ turnId: z.string(), index: z.number().int().nonnegative() }),
  "turn.completed": z.object({
    turnId: z.string(),
    status: z.enum(["completed", "interrupted"]).default("completed"),
    stopReason: z.string().optional(),
  }),
  "turn.failed": z.object({ turnId: z.string(), message: z.string() }),
  "message.delta": z.object({ messageId: z.string(), role: z.enum(["user", "assistant"]), block: ContentBlock }),
  "message.completed": z.object({ messageId: z.string(), status: z.enum(["done", "interrupted", "failed"]) }),
  "tool.started": z.object({ toolCallId: z.string(), title: z.string() }),
  "tool.output": z.object({ toolCallId: z.string(), chunk: z.string() }),
  "tool.completed": z.object({ toolCallId: z.string(), status: z.string() }),
  "tool.failed": z.object({ toolCallId: z.string(), message: z.string() }),
  "permission.requested": z.object({
    approvalId: z.string(),
    category: z.enum(["shell", "delete", "rename", "write-outside-workspace", "network"]),
    title: z.string(),
    options: z.array(PermissionOption).min(1),
  }),
  "permission.resolved": z.object({ approvalId: z.string(), decision: PermissionDecision }),
  "file.changed": z.object({ path: z.string(), change: z.enum(["created", "modified", "deleted"]), add: z.number().int().nonnegative(), del: z.number().int().nonnegative() }),
  "command.started": z.object({ commandId: z.string(), command: z.string() }),
  "command.output": z.object({ commandId: z.string(), chunk: z.string() }),
  "command.completed": z.object({ commandId: z.string(), exitCode: z.number().int() }),
  "usage.updated": z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), contextUsed: z.number().int().nonnegative(), contextWindow: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
  "plan.updated": z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(["pending", "active", "done"]) })) }),
  "todo.updated": z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(["pending", "active", "done"]) })) }),
  "skill.loaded": z.object({ name: z.string(), scope: z.enum(["global", "project"]), hash: z.string() }),
  "engine.raw": z.object({ engine: z.string(), payload: z.unknown() }),
} satisfies Record<EventType, z.ZodType>;

export const AgentEvent = z.object({
  v: z.literal(EVENT_VERSION),
  id: z.string().min(1),
  seq: z.number().int().positive(),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  parentAgentId: z.string().nullish(),
  turnId: z.string().nullish(),
  type: EventType,
  payload: z.unknown(),
  provenance: z.object({
    engine: z.enum(["native", "acp"]),
    engineName: z.string(),
    adapterVersion: z.string(),
  }),
});
export type AgentEvent = z.infer<typeof AgentEvent>;
