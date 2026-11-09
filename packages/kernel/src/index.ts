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
const ProbeFrame = z.object({
  id: z.number().int(),
  result: z.object({ status: z.literal("ok"), pid: z.number().int() }).optional(),
});

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
