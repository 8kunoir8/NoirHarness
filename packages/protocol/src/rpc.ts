import { z } from "zod";
import {
  AgentEvent,
  ContentBlock,
  EngineKind,
  PermissionCategory,
  PermissionDecision,
  SessionStatus,
} from "./events.js";

export const Methods = {
  systemHealth: "system.health",
  projectAdd: "project.add",
  projectList: "project.list",
  workspaceCreate: "workspace.create",
  workspaceList: "workspace.list",
  sessionCreate: "session.create",
  sessionList: "session.list",
  agentList: "agent.list",
  agentCreate: "agent.create",
  agentUpdate: "agent.update",
  agentArchive: "agent.archive",
  agentRoster: "agent.roster",
  sessionSubscribe: "session.subscribe",
  modelCreate: "model.create",
  modelList: "model.list",
  modelDelete: "model.delete",
  modelSetEngine: "model.setEngine",
  sessionPrompt: "session.prompt",
  sessionInterrupt: "session.interrupt",
  sessionCancelQueued: "session.cancelQueued",
  sessionClose: "session.close",
  sessionFork: "session.fork",
  sessionSetModel: "session.setModel",
  approvalRespond: "approval.respond",
  providerCreate: "provider.create",
  providerList: "provider.list",
  providerDelete: "provider.delete",
  fsList: "fs.list",
  fsRead: "fs.read",
  fsWrite: "fs.write",
  fsFiles: "fs.files",
  artifactRead: "artifact.read",
  gitStatus: "git.status",
  gitDiff: "git.diff",
  annotationList: "annotation.list",
  annotationAdd: "annotation.add",
  annotationDelete: "annotation.delete",
  skillList: "skill.list",
  skillSetEnabled: "skill.setEnabled",
  skillRead: "skill.read",
  skillInstall: "skill.install",
  skillCheckUpdate: "skill.checkUpdate",
  skillUpdate: "skill.update",
  skillRemove: "skill.remove",
  mcpList: "mcp.list",
  mcpCreate: "mcp.create",
  mcpUpdate: "mcp.update",
  mcpDelete: "mcp.delete",
  mcpTest: "mcp.test",
  scheduleList: "schedule.list",
  scheduleCreate: "schedule.create",
  scheduleUpdate: "schedule.update",
  scheduleDelete: "schedule.delete",
  scheduleRunNow: "schedule.runNow",
  scheduleRuns: "schedule.runs",
  remoteStatus: "remote.status",
  remoteEnable: "remote.enable",
  remoteDisable: "remote.disable",
  remotePair: "remote.pair",
  remoteDevices: "remote.devices",
  remoteRevoke: "remote.revoke",
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
export const SessionCreateParams = z.object({
  workspaceId: z.string().min(1),
  modelId: z.string().optional(),
  agentId: z.string().min(1).optional(),
});
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

/** The three filters the kernel can answer itself; `unread` needs the window's read marks. */
export const SessionFilter = z.enum(["all", "needs_you", "working", "done"]);
export type SessionFilter = z.infer<typeof SessionFilter>;

export const SessionListParams = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  /** Opaque: the `createdAt:id` of the last row of the previous page. */
  cursor: z.string().regex(/^\d+:/).optional(),
  filter: SessionFilter.optional(),
  /** Matches the title, which is what the search box promised; the transcript stays out of SQL. */
  search: z.string().trim().max(200).optional(),
  /** The window lists one workspace; filtering it here keeps a page from being mostly other ones. */
  workspaceId: z.string().min(1).optional(),
});
export type SessionListParams = z.infer<typeof SessionListParams>;
export const SessionView = z.object({
  id: z.string(), workspaceId: z.string(), agentId: z.string(), engine: z.string(),
  title: z.string(), status: SessionStatus, modelId: z.string().nullable(),
  /** The schedule that fired this session, or null for a session a person started. */
  scheduleId: z.string().nullable(),
  createdAt: z.number().int(),
  /** Seq of the newest event; 0 when the session has none. Lets the shell sort and de-duplicate. */
  lastEventSeq: z.number().int().nonnegative(),
  /** Timestamp of the newest event, or the row's creation time when the session has none. */
  lastEventAt: z.number().int(),
  /** True when the newest permission event for the session is an unanswered request. */
  pendingApproval: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

export const SessionListResult = z.object({
  sessions: z.array(SessionView),
  /** How many sessions match the filter and search, not how many fit on this page. */
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type SessionListResult = z.infer<typeof SessionListResult>;

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

/** `upToSeq` forks the conversation as it stood at an event, not as it stands now. */
export const SessionForkParams = z.object({
  sessionId: z.string().min(1),
  upToSeq: z.number().int().positive().optional(),
});
export type SessionForkParams = z.infer<typeof SessionForkParams>;
export const SessionForkResult = z.object({
  session: SessionView,
  /** How many events came along, so the UI can say "empty fork" instead of implying one. */
  copiedEvents: z.number().int().nonnegative(),
});
export type SessionForkResult = z.infer<typeof SessionForkResult>;

export const SessionSetModelParams = z.object({ sessionId: z.string().min(1), modelId: z.string().min(1) });
export type SessionSetModelParams = z.infer<typeof SessionSetModelParams>;
export const ApprovalRespondParams = z.object({ approvalId: z.string().min(1), decision: PermissionDecision });
export type ApprovalRespondParams = z.infer<typeof ApprovalRespondParams>;

/** Missing key means `ask`. Unknown keys are rejected, not silently ignored. */
export const PermissionPolicySchema = z
  .object({
    shell: z.enum(["ask", "allow", "reject"]),
    delete: z.enum(["ask", "allow", "reject"]),
    rename: z.enum(["ask", "allow", "reject"]),
    "write-outside-workspace": z.enum(["ask", "allow", "reject"]),
    network: z.enum(["ask", "allow", "reject"]),
    mcp: z.enum(["ask", "allow", "reject"]),
  })
  .partial()
  .strict();
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  engineId: z.enum(["acp", "native"]),
  modelRef: z.string().nullable(),
  permissionPolicy: PermissionPolicySchema,
  defaultWorkspaceId: z.string().nullable(),
  /** MCP servers this agent may use; empty means none, never "all". */
  mcpServerIds: z.array(z.string()).default([]),
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type AgentView = z.infer<typeof AgentView>;

export const AgentCreateParams = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(40).default("Coder"),
  engineId: z.enum(["acp", "native"]).default("acp"),
  modelRef: z.string().min(1).nullable().default(null),
  permissionPolicy: PermissionPolicySchema.default({}),
  defaultWorkspaceId: z.string().min(1).nullable().default(null),
  mcpServerIds: z.array(z.string()).default([]),
});
export type AgentCreateParams = z.infer<typeof AgentCreateParams>;
export const AgentUpdateParams = AgentCreateParams.partial().extend({ id: z.string().min(1) });
export type AgentUpdateParams = z.infer<typeof AgentUpdateParams>;
export const AgentArchiveParams = z.object({ id: z.string().min(1), archived: z.boolean() });
export type AgentArchiveParams = z.infer<typeof AgentArchiveParams>;
export const AgentArchiveResult = z.object({ ok: z.literal(true) });
export type AgentArchiveResult = z.infer<typeof AgentArchiveResult>;
export const AgentListParams = z.object({ includeArchived: z.boolean().optional() });
export type AgentListParams = z.infer<typeof AgentListParams>;
export const AgentListResult = z.object({ agents: z.array(AgentView) });
export type AgentListResult = z.infer<typeof AgentListResult>;

export const AgentRosterEntry = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.enum(["idle", "working", "needs_you", "error"]),
  activeSessionId: z.string().nullable(),
  activeSessionStatus: SessionStatus.nullable(),
  activeToolKind: z.enum(["read", "write", "shell", "search", "skill", "other"]).nullable(),
  sessionCount: z.number().int().nonnegative(),
  lastActivityAt: z.number().int(),
  usage: z.object({ used: z.number().int(), size: z.number().int() }).nullable(),
  /**
   * The active session's newest unanswered `permission.requested`. `title` is empty when the stored
   * payload could not be read; the office bubble then falls back to `category`.
   */
  pendingApproval: z
    .object({
      approvalId: z.string(),
      title: z.string(),
      category: PermissionCategory,
    })
    .nullable(),
});
export type AgentRosterEntry = z.infer<typeof AgentRosterEntry>;
export const AgentRosterResult = z.object({ agents: z.array(AgentRosterEntry), generatedAt: z.number().int() });
export type AgentRosterResult = z.infer<typeof AgentRosterResult>;

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

export const ArtifactReadParams = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) });
export type ArtifactReadParams = z.infer<typeof ArtifactReadParams>;
export const ArtifactReadResult = z.object({
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int(),
  truncated: z.boolean(),
});
export type ArtifactReadResult = z.infer<typeof ArtifactReadResult>;

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

export const SkillSourceKindSchema = z.enum(["git", "local"]);
export type SkillSourceKindSchema = z.infer<typeof SkillSourceKindSchema>;

/**
 * Where an installed skill came from. `null` on a skill placed on disk by hand. There is no
 * "update available" field: a listing must not touch the network, so the verdict belongs to the
 * `skill.checkUpdate` response and to whoever holds it, never to the row.
 */
export const SkillSourceView = z.object({
  kind: SkillSourceKindSchema,
  url: z.string(),
  ref: z.string().nullable(),
  commit: z.string().nullable(),
  hash: z.string(),
});
export type SkillSourceView = z.infer<typeof SkillSourceView>;

export const SkillView = z.object({
  scope: SkillScopeSchema,
  name: z.string(),
  description: z.string(),
  hash: z.string(),
  enabled: z.boolean(),
  source: SkillSourceView.nullable().optional(),
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

export const SkillInstallParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  kind: SkillSourceKindSchema,
  /** An `https:`/loopback-`http:` git URL, or an absolute directory path for `local`. */
  source: z.string().min(1),
  ref: z.string().min(1).optional(),
});
export type SkillInstallParams = z.infer<typeof SkillInstallParams>;

export const SkillInstallResult = z.object({ ok: z.literal(true), name: z.string(), hash: z.string() });
export type SkillInstallResult = z.infer<typeof SkillInstallResult>;

export const SkillCheckUpdateParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  name: z.string().min(1),
});
export type SkillCheckUpdateParams = z.infer<typeof SkillCheckUpdateParams>;

export const SkillCheckUpdateResult = z.object({
  commit: z.string().nullable(),
  hash: z.string(),
  changed: z.boolean(),
});
export type SkillCheckUpdateResult = z.infer<typeof SkillCheckUpdateResult>;

export const SkillUpdateParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  name: z.string().min(1),
  /** The hash the user was shown; a fetch that no longer matches is refused. */
  expectHash: z.string().min(1),
});
export type SkillUpdateParams = z.infer<typeof SkillUpdateParams>;

export const SkillRemoveParams = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: SkillScopeSchema,
  name: z.string().min(1),
});
export type SkillRemoveParams = z.infer<typeof SkillRemoveParams>;

/**
 * Removal answers with the workspace's whole listing — the same shape `skill.list` returns, plus
 * `ok` — so the panel can render the result without a second round trip. The skill list alone
 * would leave a stale `shadowed`: removing the project copy of a name unshadows the global one.
 */
export const SkillRemoveResult = SkillListResult.extend({ ok: z.literal(true) });
export type SkillRemoveResult = z.infer<typeof SkillRemoveResult>;
/** A configured MCP server. `args` and `env` are decoded from the row's JSON columns. */
export const McpServerView = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type McpServerView = z.infer<typeof McpServerView>;

/**
 * Server names become tool-name segments (`mcp__<name>__<tool>`). `__` is reserved as the
 * separator, so a name that contains it would make the split ambiguous.
 */
export const McpServerName = z.string().regex(/^(?!.*__)[a-z0-9_-]{1,40}$/);

export const McpServerCreateParams = z.object({
  name: McpServerName,
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type McpServerCreateParams = z.infer<typeof McpServerCreateParams>;
export const McpServerUpdateParams = McpServerCreateParams.partial().extend({ id: z.string().min(1) });
export type McpServerUpdateParams = z.infer<typeof McpServerUpdateParams>;
export const McpServerDeleteParams = z.object({ id: z.string().min(1) });
export type McpServerDeleteParams = z.infer<typeof McpServerDeleteParams>;
export const McpServerListResult = z.object({ servers: z.array(McpServerView) });
export type McpServerListResult = z.infer<typeof McpServerListResult>;
export const McpServerDeleteResult = z.object({ deleted: z.boolean() });
export type McpServerDeleteResult = z.infer<typeof McpServerDeleteResult>;

/** A probe runs one server with these settings without saving it. */
export const McpTestParams = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});
export type McpTestParams = z.infer<typeof McpTestParams>;
export const McpDiscoveredTool = z.object({ name: z.string(), description: z.string().optional() });
export type McpDiscoveredTool = z.infer<typeof McpDiscoveredTool>;
export const McpTestResult = z.object({
  ok: z.boolean(),
  tools: z.array(McpDiscoveredTool),
  error: z.string().optional(),
});
export type McpTestResult = z.infer<typeof McpTestResult>;

/** Paired browsers. `url` is null until the LAN listener exists and the machine has an address. */
export const RemoteStatusResult = z.object({
  enabled: z.boolean(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  /** False when the kernel was started without assets to serve; pairing would have nothing to show. */
  canServe: z.boolean(),
  /** SHA-256 of the LAN certificate, colon-separated; null while the listener is off. */
  fingerprint: z.string().nullable(),
});
export type RemoteStatusResult = z.infer<typeof RemoteStatusResult>;

export const RemotePairResult = z.object({
  url: z.string(),
  code: z.string(),
  expiresAt: z.number().int(),
});
export type RemotePairResult = z.infer<typeof RemotePairResult>;

export const DeviceView = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  connected: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceView>;
export const RemoteDevicesResult = z.object({ devices: z.array(DeviceView) });
export type RemoteDevicesResult = z.infer<typeof RemoteDevicesResult>;

export const RemoteRevokeParams = z.object({ id: z.string().min(1) });
export type RemoteRevokeParams = z.infer<typeof RemoteRevokeParams>;

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
  forbidden: -32003,
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

