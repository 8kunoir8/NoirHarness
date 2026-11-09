import { z } from "zod";

export const Methods = {
  systemHealth: "system.health",
  projectAdd: "project.add",
  projectList: "project.list",
  workspaceCreate: "workspace.create",
  workspaceList: "workspace.list",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionSubscribe: "session.subscribe",
  providerCreate: "provider.create",
  providerList: "provider.list",
  providerDelete: "provider.delete",
} as const;

export const ProjectAddParams = z.object({ path: z.string().min(1) });
export const WorkspaceCreateParams = z.object({ projectId: z.string().min(1) });
export const SessionCreateParams = z.object({ workspaceId: z.string().min(1) });
export const SessionSubscribeParams = z.object({ sessionId: z.string().min(1), sinceSeq: z.number().int().nonnegative().default(0) });

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

