import { z } from "zod";
import { AgentEvent, ContentBlock, EngineKind, PermissionDecision, SessionStatus } from "./events.js";

export const Methods = {
  systemHealth: "system.health",
  projectAdd: "project.add",
  projectList: "project.list",
  workspaceCreate: "workspace.create",
  workspaceList: "workspace.list",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionSubscribe: "session.subscribe",
  modelCreate: "model.create",
  modelList: "model.list",
  modelDelete: "model.delete",
  modelSetEngine: "model.setEngine",
  sessionPrompt: "session.prompt",
  sessionInterrupt: "session.interrupt",
  sessionCancelQueued: "session.cancelQueued",
  sessionClose: "session.close",
  sessionSetModel: "session.setModel",
  approvalRespond: "approval.respond",
  providerCreate: "provider.create",
  providerList: "provider.list",
  providerDelete: "provider.delete",
  fsList: "fs.list",
  fsRead: "fs.read",
  fsWrite: "fs.write",
  fsFiles: "fs.files",
  gitStatus: "git.status",
  gitDiff: "git.diff",
  annotationList: "annotation.list",
  annotationAdd: "annotation.add",
  annotationDelete: "annotation.delete",
  skillList: "skill.list",
  skillSetEnabled: "skill.setEnabled",
  skillRead: "skill.read",
} as const;

/** `system.health` result. `engineDir` is the agent directory the kernel materializes and omp reads. */
export const SystemHealthResult = z.object({
  status: z.literal("ok"),
  pid: z.number().int(),
  engineDir: z.string(),
});
export type SystemHealthResult = z.infer<typeof SystemHealthResult>;

export const ProjectAddParams = z.object({ path: z.string().min(1) });
export const WorkspaceCreateParams = z.object({ projectId: z.string().min(1) });
export const SessionCreateParams = z.object({ workspaceId: z.string().min(1), modelId: z.string().optional() });
export const SessionSubscribeParams = z.object({ sessionId: z.string().min(1), sinceSeq: z.number().int().nonnegative().default(0) });

export const ModelCreateParams = z.object({
  providerId: z.string().min(1),
  modelId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(120).optional(),
  contextWindow: z.number().int().positive().default(200_000),
  maxTokens: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  engine: EngineKind.default("acp"),
});
export type ModelCreateParams = z.infer<typeof ModelCreateParams>;

export const ModelView = z.object({
  id: z.string(), providerId: z.string(), modelId: z.string(), displayName: z.string(),
  contextWindow: z.number().int(), maxTokens: z.number().int().nullable(),
  enabled: z.boolean(), createdAt: z.number().int(), engine: EngineKind,
});
export type ModelView = z.infer<typeof ModelView>;
export const ModelListParams = z.object({ providerId: z.string().optional() });
export const ModelListResult = z.object({ models: z.array(ModelView) });
export type ModelListResult = z.infer<typeof ModelListResult>;
export const ModelDeleteParams = z.object({ id: z.string().min(1) });
export const ModelSetEngineParams = z.object({ id: z.string().min(1), engine: EngineKind });
export type ModelSetEngineParams = z.infer<typeof ModelSetEngineParams>;

export const SessionView = z.object({
  id: z.string(), workspaceId: z.string(), agentId: z.string(), engine: z.string(),
  title: z.string(), status: SessionStatus, modelId: z.string().nullable(), createdAt: z.number().int(),
  /** Seq of the newest event; 0 when the session has none. Lets the shell sort and de-duplicate. */
  lastEventSeq: z.number().int().nonnegative(),
  /** Timestamp of the newest event, or the row's creation time when the session has none. */
  lastEventAt: z.number().int(),
  /** True when the newest permission event for the session is an unanswered request. */
  pendingApproval: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

export const SessionPromptParams = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().trim().min(1).max(120),
  content: z.array(ContentBlock).min(1),
});
export type SessionPromptParams = z.infer<typeof SessionPromptParams>;
export const SessionPromptResult = z.object({ turnId: z.string(), queued: z.boolean() });
export type SessionPromptResult = z.infer<typeof SessionPromptResult>;
export const SessionInterruptParams = z.object({ sessionId: z.string().min(1) });
export type SessionInterruptParams = z.infer<typeof SessionInterruptParams>;
export const SessionInterruptResult = z.object({ interrupted: z.boolean() });
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;
export const SessionCancelQueuedParams = z.object({ sessionId: z.string().min(1), turnId: z.string().min(1) });
export type SessionCancelQueuedParams = z.infer<typeof SessionCancelQueuedParams>;
export const SessionCancelQueuedResult = z.object({ cancelled: z.boolean() });
export type SessionCancelQueuedResult = z.infer<typeof SessionCancelQueuedResult>;
export const SessionCloseParams = z.object({ sessionId: z.string().min(1) });

export const SessionSetModelParams = z.object({ sessionId: z.string().min(1), modelId: z.string().min(1) });
export type SessionSetModelParams = z.infer<typeof SessionSetModelParams>;
export const ApprovalRespondParams = z.object({ approvalId: z.string().min(1), decision: PermissionDecision });
export type ApprovalRespondParams = z.infer<typeof ApprovalRespondParams>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const FsListParams = z.object({
  workspaceId: z.string().min(1),
  path: z.string().default(""),
});
export type FsListParams = z.infer<typeof FsListParams>;
export const FsListResult = z.object({ entries: z.array(FsEntry), truncated: z.boolean() });
export type FsListResult = z.infer<typeof FsListResult>;

export const FsReadParams = z.object({ workspaceId: z.string().min(1), path: z.string() });
export type FsReadParams = z.infer<typeof FsReadParams>;
export const FsReadResult = z.object({
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int(),
  truncated: z.boolean(),
});
export type FsReadResult = z.infer<typeof FsReadResult>;

export const FsWriteParams = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  content: z.string().max(5_000_000),
  expectedMtimeMs: z.number().int().optional(),
});
export type FsWriteParams = z.infer<typeof FsWriteParams>;
export const FsWriteResult = z.object({ mtimeMs: z.number().int() });
export type FsWriteResult = z.infer<typeof FsWriteResult>;

export const FsFilesParams = z.object({ workspaceId: z.string().min(1) });
export type FsFilesParams = z.infer<typeof FsFilesParams>;
export const FsFilesResult = z.object({ files: z.array(z.string()), truncated: z.boolean() });
export type FsFilesResult = z.infer<typeof FsFilesResult>;

export const GitFileStatus = z.object({
  path: z.string(),
  change: z.enum(["created", "modified", "deleted"]),
  add: z.number().int().nonnegative(),
  del: z.number().int().nonnegative(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitStatusParams = z.object({ workspaceId: z.string().min(1) });
export type GitStatusParams = z.infer<typeof GitStatusParams>;
export const GitStatusResult = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  files: z.array(GitFileStatus),
});
export type GitStatusResult = z.infer<typeof GitStatusResult>;
export const GitDiffParams = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) });
export type GitDiffParams = z.infer<typeof GitDiffParams>;
export const GitDiffResult = z.object({ diff: z.string() });
export type GitDiffResult = z.infer<typeof GitDiffResult>;

export const AnnotationView = z.object({
  id: z.string(),
  line: z.number().int().positive(),
  note: z.string(),
  createdAt: z.number().int(),
  stale: z.boolean(),
});
export type AnnotationView = z.infer<typeof AnnotationView>;

export const AnnotationListParams = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) });
export type AnnotationListParams = z.infer<typeof AnnotationListParams>;
export const AnnotationListResult = z.object({ diffHash: z.string(), annotations: z.array(AnnotationView) });
export type AnnotationListResult = z.infer<typeof AnnotationListResult>;

export const AnnotationAddParams = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  note: z.string().trim().min(1).max(2_000),
  // The hash the note was written against, so a note cannot be stored against a newer diff.
  expectedDiffHash: z.string().optional(),
});
export type AnnotationAddParams = z.infer<typeof AnnotationAddParams>;

export const AnnotationDeleteParams = z.object({ id: z.string().min(1) });
export type AnnotationDeleteParams = z.infer<typeof AnnotationDeleteParams>;
export const AnnotationDeleteResult = z.object({ ok: z.literal(true) });
export type AnnotationDeleteResult = z.infer<typeof AnnotationDeleteResult>;

export const SkillScopeSchema = z.enum(["global", "project"]);
export type SkillScopeSchema = z.infer<typeof SkillScopeSchema>;

export const SkillView = z.object({
  scope: SkillScopeSchema,
  name: z.string(),
  description: z.string(),
  hash: z.string(),
  enabled: z.boolean(),
});
export type SkillView = z.infer<typeof SkillView>;

export const SkillListParams = z.object({ workspaceId: z.string().min(1).optional() });
export type SkillListParams = z.infer<typeof SkillListParams>;
export const SkillListResult = z.object({
  skills: z.array(SkillView),
  shadowed: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SkillListResult = z.infer<typeof SkillListResult>;

export const SkillSetEnabledParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
});
export type SkillSetEnabledParams = z.infer<typeof SkillSetEnabledParams>;
export const SkillSetEnabledResult = z.object({ ok: z.literal(true) });
export type SkillSetEnabledResult = z.infer<typeof SkillSetEnabledResult>;

export const SkillReadParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  name: z.string().min(1),
});
export type SkillReadParams = z.infer<typeof SkillReadParams>;
export const SkillReadResult = z.object({ content: z.string(), hash: z.string(), truncated: z.literal(false) });
export type SkillReadResult = z.infer<typeof SkillReadResult>;

export const EventNotificationParams = z.object({ event: AgentEvent });
export type EventNotificationParams = z.infer<typeof EventNotificationParams>;

export const ApiKind = z.enum(["openai-completions", "anthropic-messages", "google-generative-ai"]);
export type ApiKind = z.infer<typeof ApiKind>;

export const ProviderCreateParams = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  apiKind: ApiKind,
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ProviderCreateParams = z.infer<typeof ProviderCreateParams>;

export const ProviderView = z.object({
  id: z.string(), name: z.string(), baseUrl: z.string(), apiKind: ApiKind,
  enabled: z.boolean(), hasKey: z.boolean(), createdAt: z.number().int(),
});
export type ProviderView = z.infer<typeof ProviderView>;
export const ProviderListResult = z.object({ providers: z.array(ProviderView) });

export const ProviderDeleteParams = z.object({ id: z.string().min(1) });
export type ProviderDeleteParams = z.infer<typeof ProviderDeleteParams>;
export const ProjectView = z.object({ id: z.string(), name: z.string(), rootPath: z.string(), createdAt: z.number().int() });
export const ProjectListResult = z.object({ projects: z.array(ProjectView) });

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcSuccess = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown() });

export const JsonRpcFailure = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.object({ retryable: z.boolean(), details: z.unknown().optional() }).optional(),
  }),
});
export type JsonRpcFailure = z.infer<typeof JsonRpcFailure>;

export const ErrorCodes = {
  parse: -32700,
  invalidParams: -32602,
  methodNotFound: -32601,
  internal: -32603,
  unauthorized: -32001,
  notFound: -32004,
  conflict: -32009,
} as const;

export class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly retryable = false, readonly details?: unknown) {
    super(message);
    this.name = "RpcFault";
  }
}

export function toRpcFailure(id: string | number, error: unknown): JsonRpcFailure {
  if (error instanceof RpcFault) {
    return {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable || error.details !== undefined ? { data: { retryable: error.retryable, ...(error.details !== undefined ? { details: error.details } : {}) } } : {}),
      },
    };
  }
  return { jsonrpc: "2.0" as const, id, error: { code: ErrorCodes.internal, message: "Internal error" } };
}

