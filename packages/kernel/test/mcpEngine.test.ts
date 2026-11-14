import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PermissionPolicy } from "@noir/protocol";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "../../engines/native/test/fakeOpenAiServer.js";
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

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const servers: FakeOpenAiServer[] = [];
const managers: EngineManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  for (const server of servers.splice(0)) await server.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir mcp engine "));
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
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


/** A real MCP server process: one `add` tool over stdio JSON-RPC. */
const CALC_SERVER = `
process.stdin.setEncoding("utf8");
if (process.env.NOIR_MCP_PID_FILE) require("node:fs").writeFileSync(process.env.NOIR_MCP_PID_FILE, String(process.pid));
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "calc", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
      ] } });
    } else if (message.method === "tools/call") {
      const { a, b } = message.params.arguments;
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(a + b) }] } });
    }
  }
});
`;

function payload<T extends AgentEvent["type"]>(event: AgentEvent, type: T): Record<string, unknown> {
  expect(event.type).toBe(type);
  return event.payload as Record<string, unknown>;
}

async function waitForEvent(
  events: EventStore,
  sessionId: string,
  predicate: (event: AgentEvent) => boolean,
  timeoutMs = 10_000,
): Promise<AgentEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.list(sessionId).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a session event");
    const deferred = Promise.withResolvers<void>();
    setTimeout(deferred.resolve, 20);
    await deferred.promise;
  }
}

async function harness(server: FakeOpenAiServer, policy: PermissionPolicy, pidFile?: string) {
  const root = tempDir();
  const dataDir = tempDir();
  const db = openDb(join(dataDir, "noir.db"));
  dbs.push(db);
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const models = new ModelService(db);
  const sessions = new SessionService(db, events, models);
  const providers = new ProviderService(db, memorySecrets());
  const agents = new AgentService(db, models, sessions);
  const skills = new SkillService(db, dataDir);
  const mcp = new McpService(db);
  const mcpServer = mcp.create({
    name: "calc",
    command: process.execPath,
    args: ["-e", CALC_SERVER],
    env: pidFile === undefined ? {} : { NOIR_MCP_PID_FILE: pidFile },
    enabled: true,
  });

  const project = projects.add(root);
  const workspace = workspaces.createLocal(project.id);
  const provider = providers.create({
    name: "Fake",
    baseUrl: server.baseUrl,
    apiKind: "openai-completions",
    apiKey: "sk-fake",
    enabled: true,
  });
  const model = models.create({ providerId: provider.id, modelId: "fake-1", contextWindow: 200_000, enabled: true, engine: "native" });
  const agent = agents.create({
    name: "Broker",
    role: "Coder",
    engineId: "native",
    modelRef: model.id,
    permissionPolicy: policy,
    defaultWorkspaceId: workspace.id,
    mcpServerIds: [mcpServer.id],
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
  });
  managers.push(manager);
  return { events, manager, session, agents, mcp, mcpServer };
}

describe("EngineManager MCP broker", () => {
  it("offers the session's namespaced MCP tools to the provider", async () => {
    const server = await startFakeOpenAiServer([{ text: "ok" }]);
    servers.push(server);
    const { events, manager, session } = await harness(server, {});

    await manager.prompt({ sessionId: session.id, requestId: "mcp-tools", content: [{ type: "text", text: "hi" }] });
    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

    const tools = server.requests[0]?.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("mcp__calc__add");
  });

  it("asks for approval under the mcp category and runs the tool once allowed", async () => {
    const server = await startFakeOpenAiServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 4, b: 5 }) } },
      { text: "summed" },
    ]);
    servers.push(server);
    const { events, manager, session } = await harness(server, { mcp: "ask" });

    await manager.prompt({ sessionId: session.id, requestId: "mcp-ask", content: [{ type: "text", text: "add" }] });
    const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
    expect(payload(requested, "permission.requested")).toMatchObject({
      category: "mcp",
      title: "mcp__calc__add",
    });
    await manager.respond(payload(requested, "permission.requested").approvalId as string, "allow_once");

    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    const stream = events.list(session.id);
    const output = stream.find((event) => event.type === "tool.output");
    expect(payload(output as AgentEvent, "tool.output").chunk).toBe("9");
    const completed = stream.find((event) => event.type === "tool.completed");
    expect(payload(completed as AgentEvent, "tool.completed")).toMatchObject({ toolCallId: "call_1", status: "completed" });
  });

  it("auto-allows under an allow policy without a card", async () => {
    const server = await startFakeOpenAiServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 1, b: 2 }) } },
      { text: "summed" },
    ]);
    servers.push(server);
    const { events, manager, session } = await harness(server, { mcp: "allow" });

    await manager.prompt({ sessionId: session.id, requestId: "mcp-allow", content: [{ type: "text", text: "add" }] });
    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

    const stream = events.list(session.id);
    expect(stream.some((event) => event.type === "permission.requested")).toBe(false);
    const auto = stream.find((event) => event.type === "permission.auto");
    expect(payload(auto as AgentEvent, "permission.auto")).toMatchObject({ category: "mcp", decision: "allow_once" });
    const output = stream.find((event) => event.type === "tool.output");
    expect(payload(output as AgentEvent, "tool.output").chunk).toBe("3");
  });

  it("auto-rejects under a reject policy and never touches the server", async () => {
    const server = await startFakeOpenAiServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 1, b: 2 }) } },
      { text: "blocked" },
    ]);
    servers.push(server);
    const { events, manager, session } = await harness(server, { mcp: "reject" });

    await manager.prompt({ sessionId: session.id, requestId: "mcp-reject", content: [{ type: "text", text: "add" }] });
    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

    const stream = events.list(session.id);
    expect(stream.some((event) => event.type === "permission.requested")).toBe(false);
    expect(payload(stream.find((event) => event.type === "permission.auto") as AgentEvent, "permission.auto")).toMatchObject({
      category: "mcp",
      decision: "reject",
    });
    const failed = stream.find((event) => event.type === "tool.failed");
    expect(payload(failed as AgentEvent, "tool.failed").message).toMatch(/permission denied/i);
  });

  it("gives an agent with no bound servers no MCP tools", async () => {
    const server = await startFakeOpenAiServer([{ text: "ok" }]);
    servers.push(server);
    const { events, manager, session, agents, mcp } = await harness(server, { mcp: "allow" });
    expect(mcp.list()).toHaveLength(1);
    // The profile is read when the session engine starts, so clearing bindings before the first
    // prompt is what a restart would do.
    agents.update({ id: session.agentId, mcpServerIds: [] });

    await manager.prompt({ sessionId: session.id, requestId: "mcp-unbound", content: [{ type: "text", text: "hi" }] });
    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

    const tools = server.requests[0]?.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("reaps the session's MCP children when the session closes", async () => {
    const server = await startFakeOpenAiServer([{ text: "ok" }]);
    servers.push(server);
    const pidFile = join(tempDir(), "mcp.pid");
    const { events, manager, session } = await harness(server, { mcp: "allow" }, pidFile);

    await manager.prompt({ sessionId: session.id, requestId: "mcp-close", content: [{ type: "text", text: "hi" }] });
    await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(pid)).toBe(true);

    await manager.closeSession(session.id);
    expect(isAlive(pid)).toBe(false);
  });
});
