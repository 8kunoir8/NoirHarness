import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import WebSocket from "ws";
import { z } from "zod";
import {
  AgentArchiveParams,
  AgentCreateParams,
  AgentListParams,
  AgentUpdateParams,
  AnnotationAddParams,
  AnnotationDeleteParams,
  AnnotationListParams,
  ApprovalRespondParams,
  ArtifactReadParams,
  ErrorCodes,
  FsFilesParams,
  FsListParams,
  FsReadParams,
  FsWriteParams,
  GitDiffParams,
  GitStatusParams,
  McpServerCreateParams,
  McpServerDeleteParams,
  McpServerUpdateParams,
  McpTestParams,
  Methods,
  ModelCreateParams,
  ModelDeleteParams,
  ModelListParams,
  ModelSetEngineParams,
  ProjectAddParams,
  ProviderCreateParams,
  ProviderDeleteParams,
  RpcFault,
  SessionCloseParams,
  SessionCreateParams,
  SessionCancelQueuedParams,
  SessionInterruptParams,
  SessionPromptParams,
  SessionSetModelParams,
  SessionSubscribeParams,
  SkillListParams,
  SkillReadParams,
  SkillSetEnabledParams,
  WorkspaceCreateParams,
  type AgentEvent,
} from "@noir/protocol";
import { dataDir as defaultDataDir } from "./appdata.js";
import { AgentService } from "./agents.js";
import { addAnnotation, deleteAnnotation, listAnnotations } from "./annotations.js";
import { openDb } from "./db.js";
import { EngineManager } from "./engineManager.js";
import { EventStore } from "./eventStore.js";
import { findFiles, listDirectory, readArtifact, readFileText, writeFileText } from "./fsService.js";
import { gitDiff, gitStatus } from "./gitService.js";
import { McpClient } from "./mcp/client.js";
import { McpService } from "./mcp/service.js";
import { ModelService } from "./models.js";
import { clearProfileModels, profileAgentDir, syncProfile } from "./profile.js";
import { ProjectService } from "./projects.js";
import { ProviderService } from "./providers.js";
import { parseRedactionPatterns, Redactor } from "./redact.js";
import { startRpcServer, type RpcServer } from "./rpcServer.js";
import { SkillService } from "./skills.js";
import {
  lockFilePath,
  isProcessAlive,
  readLockFile,
  readRuntimeFile,
  removeLockIfOwned,
  removeMalformedLock,
  removeRuntimeFileIfOwned,
  runtimeFilePath,
  tryCreateLock,
  writeRuntimeFile,
  type LockInfo,
  type RuntimeInfo,
} from "./runtimeFile.js";
import { KeyringSecrets, type Secrets } from "./secrets.js";
import { SessionService } from "./sessions.js";
import { WorkspaceService } from "./workspaces.js";

export interface Kernel {
  port: number;
  token: string;
  close(): Promise<void>;
}

const ProbeFrame = z.object({
  id: z.number().int(),
  result: z.object({ status: z.literal("ok"), pid: z.number().int() }).optional(),
});

/** `agent.roster` takes no fields; strict so a typo is `invalidParams` rather than silently ignored. */
const AgentRosterParams = z.object({}).strict();

const PROBE_REQUEST_ID = 1;
const PROBE_TIMEOUT_MS = 750;
const STARTUP_GRACE_MS = 30_000;
const CLAIM_ATTEMPTS = 2;

/**
 * Answers true only when the recorded endpoint identifies the same pid and accepts our token.
 * Every inbound frame is inspected: notifications (no id) and unrelated replies are ignored so
 * a broadcast that arrives before the health reply cannot make a serving kernel look stale.
 */
function probeKernel(info: RuntimeInfo, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.once("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: PROBE_REQUEST_ID, method: Methods.systemHealth }));
    });
    ws.on("message", (data) => {
      try {
        const parsed = ProbeFrame.safeParse(JSON.parse(String(data)));
        if (!parsed.success || parsed.data.id !== PROBE_REQUEST_ID) return;
        finish(parsed.data.result?.status === "ok" && parsed.data.result.pid === info.pid);
      } catch {
        // Undecodable frames are ignored; the timeout decides.
      }
    });
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

type ClaimState = "running" | "starting" | "stale";

/**
 * Classifies a lock holder. Fail closed: a live pid whose claim is still within the startup
 * grace is "starting" (refused), and a matching runtime file counts as "running" even when
 * the health probe times out. Only a dead pid, or a live pid with no handshake and an old
 * claim, is reclaimable.
 */
async function inspectClaim(owner: LockInfo, runtimeFile: string): Promise<ClaimState> {
  if (!isProcessAlive(owner.pid)) return "stale";
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  for (;;) {
    const info = readRuntimeFile(runtimeFile);
    if (info && info.pid === owner.pid && info.token === owner.token) {
      await probeKernel(info, Math.max(50, deadline - Date.now()));
      return "running";
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return Date.now() - owner.startedAt < STARTUP_GRACE_MS ? "starting" : "stale";
}

/**
 * Claims exclusive ownership of a data dir. A lock held by a dead or unresponsive
 * process (pid reuse, crash, reboot) is reclaimed; a serving or starting kernel fails loudly.
 */
async function acquireOwnership(lockFile: string, runtimeFile: string, claim: LockInfo): Promise<void> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    if (tryCreateLock(lockFile, claim)) return;

    let owner = readLockFile(lockFile);
    if (!owner) {
      // A concurrent writer may not have flushed the lock yet; give it a moment before reclaiming.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      owner = readLockFile(lockFile);
    }
    if (owner) {
      const state = await inspectClaim(owner, runtimeFile);
      if (state === "running") throw new Error(`Kernel already running (pid ${owner.pid})`);
      if (state === "starting") throw new Error(`Kernel is starting (pid ${owner.pid})`);
      removeLockIfOwned(lockFile, owner);
    } else {
      removeMalformedLock(lockFile);
    }
  }
  throw new Error("Kernel startup conflict: runtime lock is held by another instance");
}

/**
 * `secrets` lets a test own the key store. Production callers omit it and get the OS keyring, the
 * only place a provider key may live.
 */
export async function startKernel(opts: { dataDir?: string; secrets?: Secrets } = {}): Promise<Kernel> {
  const dir = opts.dataDir ?? defaultDataDir();
  const file = runtimeFilePath(dir);
  const lockFile = lockFilePath(dir);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });

  const token = randomBytes(32).toString("hex");
  const claim: LockInfo = { pid: process.pid, token, startedAt: Date.now() };
  await acquireOwnership(lockFile, file, claim);

  try {
    // A runtime file without a matching live lock is only trusted when it still serves as its own pid.
    const prior = readRuntimeFile(file);
    if (prior && isProcessAlive(prior.pid) && (await probeKernel(prior, PROBE_TIMEOUT_MS))) {
      throw new Error(`Kernel already running (pid ${prior.pid})`);
    }

    let db: Database.Database | undefined;
    let server: RpcServer | undefined;
    let engines: EngineManager | undefined;
    try {
      const database = openDb(join(dir, "noir.db"));
      db = database;
      // Bound after the server starts so events raised earlier are not lost silently.
      let broadcast: (event: AgentEvent) => void = () => {};
      const redactor = new Redactor({
        env: process.env,
        patterns: parseRedactionPatterns(process.env.NOIR_REDACT_PATTERNS),
      });
      const events = new EventStore(db, (event) => broadcast(event), redactor);
      const projects = new ProjectService(db);
      const workspaces = new WorkspaceService(db, projects);
      const workspaceRoot = (workspaceId: string): string => {
        const workspace = workspaces.list().find((candidate) => candidate.id === workspaceId);
        if (workspace === undefined) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
        return workspace.path;
      };
      const models = new ModelService(db);
      const sessions = new SessionService(db, events, models);
      const providers = new ProviderService(db, opts.secrets ?? new KeyringSecrets());
      for (const key of providers.secretValues()) redactor.addSecret(key);
      const agents = new AgentService(db, models, sessions);
      // Task 5 shares this instance with EngineManager so enabled flags match what is materialized.
      const skills = new SkillService(database, dir);
      const mcp = new McpService(database);
      const engineManager = new EngineManager({
        db,
        events,
        sessions,
        agents,
        models,
        providers,
        skills,
        dataDir: dir,
      });
      engines = engineManager;
      const sync = () => syncProfile({ providers, models, dataDir: dir });
      const rollbackProfileRow = async (remove: () => void, cause: unknown): Promise<never> => {
        remove();
        try {
          await sync();
        } catch {
          // A partial materialize may have written the rejected key before failing; drop the file.
          await clearProfileModels(dir);
        }
        throw cause;
      };

      const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
        [Methods.systemHealth]: async () => ({ status: "ok", pid: process.pid, engineDir: profileAgentDir(dir) }),
        [Methods.projectAdd]: async (params) => projects.add(ProjectAddParams.parse(params).path),
        [Methods.projectList]: async () => ({ projects: projects.list() }),
        [Methods.workspaceCreate]: async (params) => workspaces.createLocal(WorkspaceCreateParams.parse(params).projectId),
        [Methods.workspaceList]: async () => ({ workspaces: workspaces.list() }),
        [Methods.fsList]: async (params) => {
          const { workspaceId, path } = FsListParams.parse(params);
          return listDirectory(workspaceRoot(workspaceId), path);
        },
        [Methods.fsRead]: async (params) => {
          const { workspaceId, path } = FsReadParams.parse(params);
          return readFileText(workspaceRoot(workspaceId), path);
        },
        [Methods.fsWrite]: async (params) => {
          const { workspaceId, path, content, expectedMtimeMs } = FsWriteParams.parse(params);
          return writeFileText(workspaceRoot(workspaceId), path, content, expectedMtimeMs);
        },
        [Methods.artifactRead]: async (params) => {
          const { workspaceId, path } = ArtifactReadParams.parse(params);
          return readArtifact(workspaceRoot(workspaceId), path);
        },
        [Methods.fsFiles]: async (params) => findFiles(workspaceRoot(FsFilesParams.parse(params).workspaceId)),
        [Methods.gitStatus]: async (params) => gitStatus(workspaceRoot(GitStatusParams.parse(params).workspaceId)),
        [Methods.gitDiff]: async (params) => {
          const { workspaceId, path } = GitDiffParams.parse(params);
          return { diff: await gitDiff(workspaceRoot(workspaceId), path) };
        },
        [Methods.skillList]: async (params) => {
          const { workspaceId } = SkillListParams.parse(params ?? {});
          if (workspaceId === undefined) return skills.list("", undefined);
          return skills.list(workspaceId, workspaceRoot(workspaceId));
        },
        [Methods.skillSetEnabled]: async (params) => {
          const { workspaceId, scope, name, enabled } = SkillSetEnabledParams.parse(params);
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          await skills.setEnabled(workspaceId ?? "", root, scope, name, enabled);
          return { ok: true };
        },
        [Methods.skillRead]: async (params) => {
          const { workspaceId, scope, name } = SkillReadParams.parse(params);
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          return skills.read(workspaceId ?? "", root, scope, name);
        },
        [Methods.mcpList]: async () => ({ servers: mcp.list() }),
        [Methods.mcpCreate]: async (params) => mcp.create(McpServerCreateParams.parse(params)),
        [Methods.mcpUpdate]: async (params) => mcp.update(McpServerUpdateParams.parse(params)),
        [Methods.mcpDelete]: async (params) => ({ deleted: mcp.delete(McpServerDeleteParams.parse(params).id) }),
        [Methods.mcpTest]: async (params) => {
          const probe = McpTestParams.parse(params);
          const client = new McpClient({ command: probe.command, args: probe.args, env: probe.env });
          try {
            await client.start();
            return { ok: true, tools: (await client.listTools()).map((tool) => ({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
            })) };
          } catch (error) {
            return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error) };
          } finally {
            await client.stop();
          }
        },
        [Methods.annotationList]: async (params) => {
          const { workspaceId, path } = AnnotationListParams.parse(params);
          return listAnnotations(database, workspaceRoot(workspaceId), workspaceId, path);
        },
        [Methods.annotationAdd]: async (params) => {
          const parsed = AnnotationAddParams.parse(params);
          return addAnnotation(database, workspaceRoot(parsed.workspaceId), parsed);
        },
        [Methods.annotationDelete]: async (params) => {
          deleteAnnotation(database, AnnotationDeleteParams.parse(params).id);
          return { ok: true };
        },
        [Methods.sessionCreate]: async (params) => {
          const { workspaceId, modelId, agentId } = SessionCreateParams.parse(params);
          await sync();
          const row = sessions.create(workspaceId, { modelId, agentId });
          return sessions.view(row.id);
        },
        [Methods.sessionList]: async () => ({ sessions: sessions.list() }),
        [Methods.agentList]: async (params) => ({
          agents: agents.list(AgentListParams.parse(params ?? {}).includeArchived ?? false),
        }),
        [Methods.agentCreate]: async (params) => agents.create(AgentCreateParams.parse(params)),
        [Methods.agentUpdate]: async (params) => agents.update(AgentUpdateParams.parse(params)),
        [Methods.agentArchive]: async (params) => {
          const { id, archived } = AgentArchiveParams.parse(params);
          agents.archive(id, archived);
          return { ok: true };
        },
        [Methods.agentRoster]: async (params) => {
          AgentRosterParams.parse(params ?? {});
          return { agents: agents.roster(), generatedAt: Date.now() };
        },
        [Methods.sessionPrompt]: async (params) => engineManager.prompt(SessionPromptParams.parse(params)),
        [Methods.sessionInterrupt]: async (params) => engineManager.interrupt(SessionInterruptParams.parse(params).sessionId),
        [Methods.sessionCancelQueued]: async (params) =>
          engineManager.cancelQueued(SessionCancelQueuedParams.parse(params)),
        [Methods.sessionClose]: async (params) => {
          await engineManager.closeSession(SessionCloseParams.parse(params).sessionId);
          return { ok: true };
        },
        [Methods.sessionSetModel]: async (params) => {
          const { sessionId, modelId } = SessionSetModelParams.parse(params);
          return sessions.setModel(sessionId, modelId);
        },
        [Methods.approvalRespond]: async (params) => {
          const { approvalId, decision } = ApprovalRespondParams.parse(params);
          await engineManager.respond(approvalId, decision);
          return { ok: true };
        },
        [Methods.modelCreate]: async (params) => {
          const created = models.create(ModelCreateParams.parse(params));
          try {
            await sync();
          } catch (error) {
            // A profile the renderer rejects must not leave a row that poisons every later sync.
            return await rollbackProfileRow(() => models.remove(created.id), error);
          }
          return created;
        },
        [Methods.modelList]: async (params) => ({ models: models.list(ModelListParams.parse(params ?? {}).providerId) }),
        [Methods.modelSetEngine]: async (params) => {
          const { id, engine } = ModelSetEngineParams.parse(params);
          return models.setEngine(id, engine);
        },
        [Methods.modelDelete]: async (params) => {
          models.remove(ModelDeleteParams.parse(params).id);
          await sync();
          return { ok: true };
        },
        [Methods.providerCreate]: async (params) => {
          const parsed = ProviderCreateParams.parse(params);
          redactor.addSecret(parsed.apiKey);
          const created = providers.create(parsed);
          try {
            await sync();
          } catch (error) {
            return await rollbackProfileRow(() => providers.remove(created.id), error);
          }
          return created;
        },
        [Methods.providerList]: async () => ({ providers: providers.list() }),
        [Methods.providerDelete]: async (params) => {
          providers.remove(ProviderDeleteParams.parse(params).id);
          await sync();
          return { ok: true };
        },
        [Methods.sessionSubscribe]: async (params) => {
          const { sessionId, sinceSeq } = SessionSubscribeParams.parse(params);
          engineManager.reconcileSession(sessionId);
          const replay = events.list(sessionId, sinceSeq);
          return { events: replay, lastSeq: replay.at(-1)?.seq ?? sinceSeq };
        },
      };

      const started = await startRpcServer({ token, handlers });
      server = started;
      broadcast = (event) => started.broadcast(event);
      engineManager.reconcileAll();
      writeRuntimeFile(file, { pid: process.pid, port: started.port, token });
    } catch (error) {
      if (engines) {
        try {
          await engines.shutdown();
        } catch {
          // Best effort: the startup error is what matters.
        }
      }
      if (server) {
        try {
          await server.close();
        } catch {
          // Already closing; the startup error is what matters.
        }
      }
      try {
        db?.close();
      } catch {
        // Already closed.
      }
      throw error;
    }

    if (!db || !server || !engines) throw new Error("Kernel failed to start");
    const runningDb = db;
    const runningServer = server;
    const runningEngines = engines;

    let closed = false;
    return {
      port: runningServer.port,
      token,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await runningEngines.shutdown();
        } finally {
          try {
            await runningServer.close();
          } finally {
            try {
              runningDb.close();
            } finally {
              removeRuntimeFileIfOwned(file, { pid: process.pid, token });
              removeLockIfOwned(lockFile, claim);
            }
          }
        }
      },
    };
  } catch (error) {
    removeLockIfOwned(lockFile, claim);
    throw error;
  }
}
