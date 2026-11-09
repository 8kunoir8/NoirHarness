import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Methods,
  ProjectAddParams,
  ProviderCreateParams,
  SessionCreateParams,
  SessionSubscribeParams,
  WorkspaceCreateParams,
  type AgentEvent,
} from "@noir/protocol";
import { z } from "zod";
import { dataDir as defaultDataDir } from "./appdata.js";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { ProjectService } from "./projects.js";
import { ProviderService } from "./providers.js";
import { startRpcServer } from "./rpcServer.js";
import { isProcessAlive, readRuntimeFile, removeRuntimeFile, runtimeFilePath, writeRuntimeFile } from "./runtimeFile.js";
import { KeyringSecrets } from "./secrets.js";
import { SessionService } from "./sessions.js";
import { WorkspaceService } from "./workspaces.js";

export interface Kernel {
  port: number;
  token: string;
  close(): Promise<void>;
}

const ProviderDeleteParams = z.object({ id: z.string().min(1) });

export async function startKernel(opts: { dataDir?: string } = {}): Promise<Kernel> {
  const dir = opts.dataDir ?? defaultDataDir();
  const file = runtimeFilePath(dir);
  mkdirSync(dir, { recursive: true });
  const existing = readRuntimeFile(file);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Kernel already running (pid ${existing.pid})`);
  }

  const db = openDb(join(dir, "noir.db"));
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

  const token = randomBytes(32).toString("hex");
  const server = await startRpcServer({ token, handlers });
  broadcast = (event) => server.broadcast(event);
  writeRuntimeFile(file, { pid: process.pid, port: server.port, token });

  let closed = false;
  return {
    port: server.port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      db.close();
      removeRuntimeFile(file);
    },
  };
}
