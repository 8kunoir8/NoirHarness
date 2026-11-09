import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import WebSocket from "ws";
import { z } from "zod";
import {
  Methods,
  ProjectAddParams,
  ProviderCreateParams,
  SessionCreateParams,
  SessionSubscribeParams,
  WorkspaceCreateParams,
  type AgentEvent,
} from "@noir/protocol";
import { dataDir as defaultDataDir } from "./appdata.js";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { ProjectService } from "./projects.js";
import { ProviderService } from "./providers.js";
import { startRpcServer, type RpcServer } from "./rpcServer.js";
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
import { KeyringSecrets } from "./secrets.js";
import { SessionService } from "./sessions.js";
import { WorkspaceService } from "./workspaces.js";

export interface Kernel {
  port: number;
  token: string;
  close(): Promise<void>;
}

const ProviderDeleteParams = z.object({ id: z.string().min(1) });
const HealthResponse = z.object({ result: z.object({ status: z.literal("ok"), pid: z.number().int() }) });

const PROBE_TIMEOUT_MS = 750;
const CLAIM_ATTEMPTS = 2;

/** Answers true only when the recorded endpoint identifies the same pid and accepts our token. */
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
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: Methods.systemHealth }));
    });
    ws.once("message", (data) => {
      try {
        const parsed = HealthResponse.safeParse(JSON.parse(String(data)));
        finish(parsed.success && parsed.data.result.pid === info.pid);
      } catch {
        finish(false);
      }
    });
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

/** A claim holder is live only when its pid is alive and its recorded endpoint answers as that pid. */
async function claimHolderIsServing(owner: LockInfo, runtimeFile: string): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return false;
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  for (;;) {
    const info = readRuntimeFile(runtimeFile);
    if (info && info.pid === owner.pid && info.token === owner.token) {
      return probeKernel(info, Math.max(50, deadline - Date.now()));
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Claims exclusive ownership of a data dir. A lock held by a dead or unresponsive
 * process (pid reuse, crash, reboot) is reclaimed; a serving kernel fails loudly.
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
      if (await claimHolderIsServing(owner, runtimeFile)) {
        throw new Error(`Kernel already running (pid ${owner.pid})`);
      }
      removeLockIfOwned(lockFile, owner);
    } else {
      removeMalformedLock(lockFile);
    }
  }
  throw new Error("Kernel startup conflict: runtime lock is held by another instance");
}

export async function startKernel(opts: { dataDir?: string } = {}): Promise<Kernel> {
  const dir = opts.dataDir ?? defaultDataDir();
  const file = runtimeFilePath(dir);
  const lockFile = lockFilePath(dir);
  mkdirSync(join(dir, "runtime"), { recursive: true });

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
    try {
      db = openDb(join(dir, "noir.db"));
      // Bound after the server starts so events raised earlier are not lost silently.
      let broadcast: (event: AgentEvent) => void = () => {};
      const events = new EventStore(db, (event) => broadcast(event));
      const projects = new ProjectService(db);
      const workspaces = new WorkspaceService(db, projects);
      const sessions = new SessionService(db, events);
      const providers = new ProviderService(db, new KeyringSecrets());

      const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
        [Methods.systemHealth]: async () => ({ status: "ok", pid: process.pid }),
        [Methods.projectAdd]: async (params) => projects.add(ProjectAddParams.parse(params).path),
        [Methods.projectList]: async () => ({ projects: projects.list() }),
        [Methods.workspaceCreate]: async (params) => workspaces.createLocal(WorkspaceCreateParams.parse(params).projectId),
        [Methods.workspaceList]: async () => ({ workspaces: workspaces.list() }),
        [Methods.sessionCreate]: async (params) => sessions.create(SessionCreateParams.parse(params).workspaceId),
        [Methods.sessionList]: async () => ({ sessions: sessions.list() }),
        [Methods.providerCreate]: async (params) => providers.create(ProviderCreateParams.parse(params)),
        [Methods.providerList]: async () => ({ providers: providers.list() }),
        [Methods.providerDelete]: async (params) => {
          providers.remove(ProviderDeleteParams.parse(params).id);
          return { ok: true };
        },
        [Methods.sessionSubscribe]: async (params) => {
          const { sessionId, sinceSeq } = SessionSubscribeParams.parse(params);
          return { events: events.list(sessionId, sinceSeq) };
        },
      };

      const started = await startRpcServer({ token, handlers });
      server = started;
      broadcast = (event) => started.broadcast(event);
      writeRuntimeFile(file, { pid: process.pid, port: started.port, token });
    } catch (error) {
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

    if (!db || !server) throw new Error("Kernel failed to start");
    const runningDb = db;
    const runningServer = server;

    let closed = false;
    return {
      port: runningServer.port,
      token,
      async close() {
        if (closed) return;
        closed = true;
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
      },
    };
  } catch (error) {
    removeLockIfOwned(lockFile, claim);
    throw error;
  }
}
