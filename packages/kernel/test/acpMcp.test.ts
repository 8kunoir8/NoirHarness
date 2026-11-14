import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionPolicy } from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { CheckpointService } from "../src/checkpoints.js";
import { openDb } from "../src/db.js";
import { EngineManager } from "../src/engineManager.js";
import { EventStore } from "../src/eventStore.js";
import { McpService } from "../src/mcp/service.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
import { SessionService } from "../src/sessions.js";
import { SkillService } from "../src/skills.js";
import { WorkspaceService } from "../src/workspaces.js";

const FAKE_ACP = fileURLToPath(new URL("../../engines/acp/test/fakeAcpServer.ts", import.meta.url));

const dirs: string[] = [];
const managers: EngineManager[] = [];

afterEach(async () => {
  delete process.env.NOIR_OMP_ARGS_JSON;
  delete process.env.FAKE_ACP_LOG;
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir acp mcp "));
  dirs.push(dir);
  return dir;
}

function memorySecrets(): Secrets {
  const store = new Map<string, string>();
  return {
    set: (id, value) => void store.set(id, value),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

/**
 * An ACP agent bound to one server whose only observable effect is a file: if the kernel spawns it,
 * the marker exists. The wire log is what the fake ACP server received.
 */
async function harness(policy: PermissionPolicy) {
  const workspaceDir = tempDir();
  const dataDir = tempDir();
  const marker = join(dataDir, "spawned-marker.txt");
  const wireLog = join(dataDir, "wire.log");
  process.env.NOIR_OMP_ARGS_JSON = JSON.stringify([FAKE_ACP]);
  process.env.FAKE_ACP_LOG = wireLog;

  const db = openDb(join(dataDir, "noir.db"));
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const models = new ModelService(db);
  const sessions = new SessionService(db, events, models);
  const agents = new AgentService(db, models, sessions, events);
  const providers = new ProviderService(db, memorySecrets());
  const skills = new SkillService(db, dataDir);
  const mcp = new McpService(db);

  const server = mcp.create({
    name: "calc",
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
    env: {},
    enabled: true,
  });
  const project = projects.add(workspaceDir);
  const workspace = workspaces.createLocal(project.id);
  const provider = providers.create({
    name: "Fake",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKind: "openai-completions",
    apiKey: "sk-fake",
    enabled: true,
  });
  const model = models.create({
    providerId: provider.id,
    modelId: "fake-1",
    contextWindow: 200_000,
    enabled: true,
    engine: "acp",
  });
  const agent = agents.create({
    name: "Broker",
    role: "Coder",
    engineId: "acp",
    modelRef: model.id,
    defaultWorkspaceId: workspace.id,
    mcpServerIds: [server.id],
    permissionPolicy: policy,
  });
  const session = sessions.create(workspace.id, { modelId: model.id, agentId: agent.id });
  const manager = new EngineManager({
    db,
    events,
    sessions,
    agents,
    models,
    providers,
    skills,
    mcp,
    checkpoints: new CheckpointService(db, events, { dataDir }),
    dataDir,
    ompCommand: process.execPath,
  });
  managers.push(manager);
  return { db, events, manager, session, marker, wireLog };
}

function sessionNew(wireLog: string): { params: { mcpServers?: unknown } } {
  const line = readFileSync(wireLog, "utf8")
    .split("\n")
    .find((entry) => entry.includes('"method":"session/new"'));
  expect(line).toBeDefined();
  return JSON.parse((line as string).slice((line as string).indexOf("{"))) as {
    params: { mcpServers?: unknown };
  };
}

async function turn(manager: EngineManager, events: EventStore, sessionId: string): Promise<void> {
  await manager.prompt({ sessionId, requestId: "acp-mcp", content: [{ type: "text", text: "hello" }] });
  const deadline = Date.now() + 20_000;
  while (!events.list(sessionId).some((event) => event.type === "turn.completed")) {
    if (Date.now() > deadline) throw new Error("timed out waiting for turn.completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("EngineManager over an ACP engine with MCP servers", () => {
  it("forwards the bound servers to session/new and never spawns them itself", async () => {
    const { db, events, manager, session, marker, wireLog } = await harness({ mcp: "ask" });
    await turn(manager, events, session.id);

    expect(existsSync(marker)).toBe(false);
    expect(sessionNew(wireLog).params.mcpServers).toEqual([
      { name: "calc", command: process.execPath, args: expect.any(Array), env: [] },
    ]);
    db.close();
  }, 60_000);

  it("withholds the servers from an mcp: reject agent, which has no kernel-side gate", async () => {
    const { db, events, manager, session, marker, wireLog } = await harness({ mcp: "reject" });
    await turn(manager, events, session.id);

    expect(existsSync(marker)).toBe(false);
    expect(sessionNew(wireLog).params.mcpServers).toEqual([]);
    db.close();
  }, 60_000);
});
