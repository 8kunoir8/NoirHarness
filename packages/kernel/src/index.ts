import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
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
  RemoteRevokeParams,
  RpcFault,
  ScheduleCreateParams,
  ScheduleDeleteParams,
  ScheduleListParams,
  ScheduleRunNowParams,
  ScheduleRunsParams,
  ScheduleUpdateParams,
  SessionCloseParams,
  SessionDeleteParams,
  SessionForkParams,
  SessionListParams,
  SessionCreateParams,
  SessionCancelQueuedParams,
  SessionInterruptParams,
  SessionPromptParams,
  SessionSetModelParams,
  SessionSubscribeParams,
  SkillCheckUpdateParams,
  SkillInstallParams,
  SkillListParams,
  SkillReadParams,
  SkillRemoveParams,
  SkillSetEnabledParams,
  SkillUpdateParams,
  type SkillListResult,
  WorkspaceCreateParams,
  type AgentEvent,
} from "@noir/protocol";
import { dataDir as defaultDataDir } from "./appdata.js";
import { AgentService } from "./agents.js";
import { addAnnotation, deleteAnnotation, listAnnotations } from "./annotations.js";
import { buildIdOf } from "./buildId.js";
import { CheckpointService } from "./checkpoints.js";
import { openDb } from "./db.js";
import { EngineManager } from "./engineManager.js";
import { EventStore } from "./eventStore.js";
import { findFiles, listDirectory, readArtifact, readFileText, writeFileText } from "./fsService.js";
import { gitDiff, gitStatus } from "./gitService.js";
import { liveCount } from "./liveness.js";
import { McpClient } from "./mcp/client.js";
import { McpService } from "./mcp/service.js";
import { ModelService } from "./models.js";
import { clearProfileModels, profileAgentDir, syncProfile } from "./profile.js";
import { ProjectService } from "./projects.js";
import { ProviderService } from "./providers.js";
import { parseRedactionPatterns, Redactor } from "./redact.js";
import { createHub, startRpcServer, type Handler, type RpcServer } from "./rpcServer.js";
import { DeviceService } from "./devices.js";
import { RemoteAccess } from "./remoteAccess.js";
import { SkillService } from "./skills.js";
import { SkillSourceService } from "./skillSources.js";
import { ScheduleService } from "./schedules.js";
import { Scheduler } from "./scheduler.js";
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

/** `agent.roster` takes no fields; strict so a typo is `invalidParams` rather than silently ignored. */
const AgentRosterParams = z.object({}).strict();

const PROBE_TIMEOUT_MS = 750;
const STARTUP_GRACE_MS = 30_000;
const CLAIM_ATTEMPTS = 2;

/**
 * True only when the endpoint answers `/health` as the pid the caller expects. The runtime file's
 * token is deliberately not sent: the reply carries no secret, and a process able to bind this port
 * on this machine can already read the file.
 */
async function probeHealth(info: RuntimeInfo, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && "status" in body && body.status === "ok" && "pid" in body && body.pid === info.pid;
  } catch {
    return false;
  }
}

type ClaimState = "running" | "starting" | "stale";

/**
 * Classifies a lock holder. A pid that is alive but whose endpoint disowns it (pid reuse) or never
 * answers within the startup grace is reclaimable, so a stale file cannot wedge the data directory;
 * a holder that answers as its own pid is running.
 */
async function inspectClaim(owner: LockInfo, runtimeFile: string): Promise<ClaimState> {
  if (!isProcessAlive(owner.pid)) return "stale";
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  for (;;) {
    const info = readRuntimeFile(runtimeFile);
    if (info && info.pid === owner.pid && info.token === owner.token) {
      if (await probeHealth(info, Math.max(50, deadline - Date.now()))) return "running";
      break;
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
export async function startKernel(opts: { dataDir?: string; secrets?: Secrets; onShutdown?: () => void } = {}): Promise<Kernel> {
  const dir = opts.dataDir ?? defaultDataDir();
  const file = runtimeFilePath(dir);
  const lockFile = lockFilePath(dir);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });

  const token = randomBytes(32).toString("hex");

  // The file the desktop app hashes before it spawns this build: identity is bytes, not a version.
  const buildId = buildIdOf(process.argv[1] ?? "");
  const claim: LockInfo = { pid: process.pid, token, startedAt: Date.now() };
  await acquireOwnership(lockFile, file, claim);

  try {
    // A runtime file without a matching live lock is only trusted when it still serves as its own pid.
    const prior = readRuntimeFile(file);
    if (prior && isProcessAlive(prior.pid) && (await probeHealth(prior, PROBE_TIMEOUT_MS))) {
      throw new Error(`Kernel already running (pid ${prior.pid})`);
    }

    let db: Database.Database | undefined;
    let server: RpcServer | undefined;
    let remoteAccess: RemoteAccess | undefined;
    let engines: EngineManager | undefined;
    let scheduler: Scheduler | undefined;
    // Assigned once the kernel exists; a stop cannot arrive before the server is listening.
    let stop: (() => Promise<void>) | undefined;
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
      const checkpoints = new CheckpointService(db, events, { dataDir: dir });
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
      const skillSources = new SkillSourceService(database, skills, dir);
      const mcp = new McpService(database);
      /** Both `skill.list` and `skill.remove` answer with the listing, provenance attached. */
      const withSources = (listed: SkillListResult, workspaceId: string): SkillListResult => {
        const sources = skillSources.sourcesFor(workspaceId);
        return {
          ...listed,
          skills: listed.skills.map((row) => ({ ...row, source: sources.get(`${row.scope}|${row.name}`) ?? null })),
        };
      };
      const engineManager = new EngineManager({
        db,
        events,
        sessions,
        agents,
        models,
        providers,
        skills,
        mcp,
        dataDir: dir,
      });
      engines = engineManager;
      const devices = new DeviceService(db);
      const schedules = new ScheduleService(db);
      const schedulerInstance = new Scheduler({
        schedules,
        // A scheduled run is an ordinary session; `scheduleId` is the only tag that marks it.
        createSession: (schedule) =>
          sessions.create(schedule.workspaceId, { agentId: schedule.agentId, scheduleId: schedule.id }).id,
        prompt: (sessionId, runId, text) =>
          engineManager.prompt({ sessionId, requestId: runId, content: [{ type: "text", text }] }),
      });
      scheduler = schedulerInstance;
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

      // The hub is the whole of "one kernel": both listeners read this map and share this client set.
      const hub = createHub({});
      let listeningPort = 0;
      const writeRuntime = (remotePort?: number): void => {
        writeRuntimeFile(file, {
          pid: process.pid,
          port: listeningPort,
          token,
          ...(remotePort === undefined ? {} : { remotePort }),
        });
      };
      const remote = new RemoteAccess({
        hub,
        devices,
        dataDir: dir,
        ...(process.env.NOIR_WEB_ROOT === undefined ? {} : { webRoot: process.env.NOIR_WEB_ROOT }),
      });
      remoteAccess = remote;
      /** The admin verbs: a paired browser may drive sessions, but not the door it came in by. */
      const localOnly = (fn: Handler): Handler => async (params, ctx) => {
        if (ctx?.local !== true) {
          throw new RpcFault(ErrorCodes.forbidden, "Remote access is managed from this machine");
        }
        return fn(params, ctx);
      };

      const handlers: Record<string, Handler> = {
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
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          const listed = workspaceId === undefined ? await skills.list("", undefined) : await skills.list(workspaceId, root);
          return withSources(listed, workspaceId ?? "");
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
        [Methods.skillInstall]: async (params) => {
          const { workspaceId, scope, kind, source, ref } = SkillInstallParams.parse(params);
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          const installed = await skillSources.install(workspaceId ?? "", root, scope, kind, source, ref);
          return { ok: true, ...installed };
        },
        [Methods.skillCheckUpdate]: async (params) => {
          const { workspaceId, scope, name } = SkillCheckUpdateParams.parse(params);
          return skillSources.checkUpdate(workspaceId ?? "", scope, name);
        },
        [Methods.skillUpdate]: async (params) => {
          const { workspaceId, scope, name, expectHash } = SkillUpdateParams.parse(params);
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          return skillSources.update(workspaceId ?? "", root, scope, name, expectHash);
        },
        [Methods.skillRemove]: async (params) => {
          const { workspaceId, scope, name } = SkillRemoveParams.parse(params);
          const root = workspaceId === undefined ? undefined : workspaceRoot(workspaceId);
          await skillSources.remove(workspaceId ?? "", root, scope, name);
          const listed = workspaceId === undefined ? await skills.list("", undefined) : await skills.list(workspaceId, root);
          // The whole listing, not just `skills`: removing a project copy unshadows a global of the
          // same name, so `shadowed` is stale in any answer that omits it.
          return { ok: true as const, ...withSources(listed, workspaceId ?? "") };
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
        [Methods.sessionList]: async (params) => sessions.list(SessionListParams.parse(params ?? {})),
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
        [Methods.sessionDelete]: async (params) => {
          const { sessionId } = SessionDeleteParams.parse(params);
          // Close first: closing reaps the engine and every MCP child it started, so nothing is
          // left emitting events into rows this call is about to remove.
          await engineManager.closeSession(sessionId);
          sessions.remove(sessionId);
          return { deleted: true };
        },
        [Methods.sessionFork]: async (params) => {
          const { sessionId, upToSeq } = SessionForkParams.parse(params);
          return sessions.fork(sessionId, upToSeq);
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
        [Methods.scheduleList]: async (params) => ({
          schedules: schedules.list(ScheduleListParams.parse(params ?? {}).workspaceId),
        }),
        [Methods.scheduleCreate]: async (params) => {
          const created = schedules.create(ScheduleCreateParams.parse(params), Date.now());
          // A timer armed before this row existed is aimed past it, or absent when nothing was armed.
          schedulerInstance.reschedule();
          return created;
        },
        [Methods.scheduleUpdate]: async (params) => {
          const updated = schedules.update(ScheduleUpdateParams.parse(params), Date.now());
          // Resuming or re-timing can move the instant earlier than the armed one.
          schedulerInstance.reschedule();
          return updated;
        },
        [Methods.scheduleDelete]: async (params) => {
          schedules.remove(ScheduleDeleteParams.parse(params).id);
          schedulerInstance.reschedule();
          return { ok: true };
        },
        [Methods.scheduleRunNow]: async (params) => ({
          run: schedulerInstance.runNow(ScheduleRunNowParams.parse(params).id),
        }),
        [Methods.scheduleRuns]: async (params) => {
          const { id, limit, before } = ScheduleRunsParams.parse(params);
          return schedules.runs(id, limit, before);
        },
        [Methods.remoteStatus]: localOnly(async () => remote.status()),
        [Methods.remoteEnable]: localOnly(async () => {
          const status = await remote.enable();
          writeRuntime(status.port ?? undefined);
          return status;
        }),
        [Methods.remoteDisable]: localOnly(async () => {
          await remote.disable();
          writeRuntime();
          return remote.status();
        }),
        [Methods.remotePair]: localOnly(async () => remote.pair()),
        [Methods.remoteDevices]: localOnly(async () => ({
          devices: devices.list().map((device) => ({
            ...device,
            connected: [...hub.clients.values()].some((client) => client.deviceId === device.id),
          })),
        })),
        [Methods.remoteRevoke]: localOnly(async (params) => {
          const { id } = RemoteRevokeParams.parse(params);
          const revoked = devices.revoke(id);
          // A revoked device loses the sockets it already holds, not just the next handshake.
          for (const [socket, client] of hub.clients) {
            if (client.deviceId === id) socket.close();
          }
          return { ok: revoked };
        }),
        [Methods.sessionSubscribe]: async (params) => {
          const { sessionId, sinceSeq } = SessionSubscribeParams.parse(params);
          engineManager.reconcileSession(sessionId);
          // A rewind rebuilds the transcript by replaying from 0, so this is the filter that makes
          // the abandoned range disappear from the screen.
          const replay = events.visible(sessionId, sinceSeq);
          return { events: replay, lastSeq: replay.at(-1)?.seq ?? sinceSeq };
        },
      };

      hub.handlers = handlers;
      const started = await startRpcServer({
        token,
        handlers,
        hub,
        buildId,
        requestShutdown: (force) => {
          const live = liveCount(sessions.all());
          return { stop: force || live === 0, live };
        },
        onStopped: () => {
          void stop?.().finally(() => opts.onShutdown?.());
        },
      });
      server = started;
      broadcast = (event) => started.broadcast(event);
      engineManager.reconcileAll();
      // After the socket is listening, so a fire can broadcast; before the first tick's catch-up.
      scheduler.start();
      listeningPort = started.port;
      writeRuntime();
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
    const runningRemote = remoteAccess;
    const runningDb = db;
    const runningServer = server;
    const runningEngines = engines;

    let closed = false;
    const kernel: Kernel = {
      port: runningServer.port,
      token,
      async close() {
        if (closed) return;
        closed = true;
        try {
          scheduler.stop();
          await runningRemote?.close();
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
    stop = () => kernel.close();
    return kernel;
  } catch (error) {
    removeLockIfOwned(lockFile, claim);
    throw error;
  }
}
