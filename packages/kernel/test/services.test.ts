import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCreateParams, ErrorCodes, RpcFault, reduceSession, type SessionState } from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService } from "../src/providers.js";
import type { Secrets } from "../src/secrets.js";
import { SessionService } from "../src/sessions.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir svc ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memorySecrets(): Secrets {
  const store = new Map<string, string>();
  return {
    set: (id, value) => void store.set(id, value),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

function expectFault(fn: () => unknown, code: number, message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcFault);
    expect((error as RpcFault).code).toBe(code);
    expect((error as Error).message).toMatch(message);
    return;
  }
  expect.unreachable("expected RpcFault");
}

function setup() {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);
  const sessions = new SessionService(db, events, models);
  const agents = new AgentService(db, models, sessions);
  return { db, events, projects, workspaces, sessions, providers, models, agents };
}

describe("ProjectService", () => {
  it("adds a real directory and rejects a file", () => {
    const { projects } = setup();
    const root = tempDir();
    const project = projects.add(root);
    expect(project.rootPath).toBe(root);
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    expect(() => projects.add(file)).toThrow(RpcFault);
  });

  it("rejects a duplicate path", () => {
    const { projects } = setup();
    const root = tempDir();
    projects.add(root);
    expect(() => projects.add(root)).toThrow(/already/);
  });

  it("accepts a path with spaces and unicode", () => {
    const { projects } = setup();
    const root = join(tempDir(), "my project ü");
    mkdirSync(root, { recursive: true });
    expect(projects.add(root).rootPath).toBe(root);
  });
});

describe("WorkspaceService", () => {
  it("creates a local workspace for a project", () => {
    const { projects, workspaces } = setup();
    const project = projects.add(tempDir());
    const ws = workspaces.createLocal(project.id);
    expect(ws.kind).toBe("local");
    expect(ws.path).toBe(project.rootPath);
  });
});

describe("SessionService", () => {
  it("creates a session in starting state and allows starting -> idle", () => {
    const { projects, workspaces, sessions } = setup();
    const project = projects.add(tempDir());
    const ws = workspaces.createLocal(project.id);
    const s = sessions.create(ws.id);
    expect(s.status).toBe("starting");
    expect(s.engine).toBe("acp");
    sessions.setStatus(s.id, "idle");
    expect(sessions.all()[0]!.status).toBe("idle");
  });

  it("rejects an illegal transition", () => {
    const { projects, workspaces, sessions } = setup();
    const project = projects.add(tempDir());
    const s = sessions.create(workspaces.createLocal(project.id).id);
    expect(() => sessions.setStatus(s.id, "waiting")).toThrow();
  });

  it("emits the initial starting status so replay matches the row", () => {
    const { projects, workspaces, sessions, events } = setup();
    const project = projects.add(tempDir());
    const s = sessions.create(workspaces.createLocal(project.id).id);
    const stream = events.list(s.id);
    expect(stream.map((e) => e.type)).toEqual(["session.created", "session.status"]);
    expect(stream[1]!.payload).toEqual({ status: "starting" });
    const state = stream.reduce<SessionState | undefined>(reduceSession, undefined);
    expect(state!.status).toBe("starting");
  });

  it("names the schedule that fired a session, and only when one did", () => {
    const { db, projects, workspaces, sessions, events } = setup();
    const project = projects.add(tempDir());
    const workspaceId = workspaces.createLocal(project.id).id;
    db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES ('a-sched', 'Night shift', 'dev', 'acp')").run();
    const agentId = db.prepare("SELECT id FROM agents LIMIT 1").pluck().get() as string;
    db.prepare(
      "INSERT INTO schedules (id, workspace_id, agent_id, name, prompt, interval_minutes, next_run_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("sched-1", workspaceId, agentId, "Nightly", "tidy", 1_440, 1, 1);
    const fired = sessions.create(workspaceId, { scheduleId: "sched-1" });
    const manual = sessions.create(workspaceId);
    const created = (id: string) => events.list(id).find((event) => event.type === "session.created");
    expect(created(fired.id)?.payload).toEqual({ title: "", scheduleId: "sched-1" });
    expect(created(manual.id)?.payload).toEqual({ title: "" });
  });

  it("pages newest first, and says how many match in total", () => {
    const { db, projects, workspaces, sessions } = setup();
    const workspaceId = workspaces.createLocal(projects.add(tempDir()).id).id;
    for (let index = 0; index < 5; index += 1) {
      const created = sessions.create(workspaceId);
      db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(1_000 + index, created.id);
    }
    const first = sessions.list({ limit: 2 });
    expect(first.sessions.map((session) => session.createdAt)).toEqual([1_004, 1_003]);
    expect(first.total).toBe(5);
    const second = sessions.list({ limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.sessions.map((session) => session.createdAt)).toEqual([1_002, 1_001]);
    const third = sessions.list({ limit: 2, cursor: second.nextCursor ?? "" });
    expect(third.sessions.map((session) => session.createdAt)).toEqual([1_000]);
    expect(third.nextCursor).toBeNull();
  });

  it("filters by what the kernel can answer, and searches the title", () => {
    const { projects, workspaces, sessions, events } = setup();
    const workspaceId = workspaces.createLocal(projects.add(tempDir()).id).id;
    const named = sessions.create(workspaceId);
    events.append({
      sessionId: named.id,
      agentId: named.agentId,
      type: "session.updated",
      payload: { title: "Nightly tidy" },
      provenance: { engine: "acp", engineName: "test", adapterVersion: "0" },
    });
    const closed = sessions.create(workspaceId);
    sessions.setStatus(closed.id, "idle");
    sessions.setStatus(closed.id, "closed");

    expect(sessions.list({ filter: "done" }).total).toBe(1);
    expect(sessions.list({ filter: "needs_you" }).total).toBe(0);
    const found = sessions.list({ search: "nightly" });
    expect(found.sessions.map((session) => session.id)).toEqual([named.id]);
    expect(sessions.list({ search: "%" }).total).toBe(0);
  });

  it("forks the conversation without the parent's lifecycle", () => {
    const { projects, workspaces, sessions, events } = setup();
    const project = projects.add(tempDir());
    const parent = sessions.create(workspaces.createLocal(project.id).id);
    const provenance = { engine: "acp" as const, engineName: "test", adapterVersion: "0" };
    const say = (text: string, seq: number): void => {
      events.append({ sessionId: parent.id, agentId: parent.agentId, type: "message.delta", payload: { messageId: "m1", role: "assistant", block: { type: "text", text } }, provenance, ts: seq });
      events.append({ sessionId: parent.id, agentId: parent.agentId, type: "message.completed", payload: { messageId: "m1", status: "done" }, provenance, ts: seq + 1 });
    };
    say("first", 10);
    say("second", 20);
    events.append({ sessionId: parent.id, agentId: parent.agentId, type: "session.updated", payload: { title: "Nightly" }, provenance });
    sessions.setStatus(parent.id, "idle");

    const { session: fork, copiedEvents } = sessions.fork(parent.id);
    // Four messages plus the parent's retitle; the lifecycle events stay behind.
    expect(copiedEvents).toBe(5);
    expect(fork.status).toBe("idle");
    expect(fork.title).toBe("Fork of Nightly");
    expect(fork.id).not.toBe(parent.id);
    const stream = events.list(fork.id);
    expect(stream.filter((event) => event.type === "session.created")).toHaveLength(1);
    expect(stream.map((event) => event.seq)).toEqual([...stream.map((event) => event.seq)].sort((a, b) => a - b));
    const state = stream.reduce<SessionState | undefined>(reduceSession, undefined);
    expect(state?.messages).toHaveLength(1);
    expect(state?.messages[0]?.blocks).toHaveLength(2);
    expect(state?.status).toBe("idle");
    expect(state?.title).toBe("Fork of Nightly");
  });

  it("cuts the fork at a sequence when asked", () => {
    const { projects, workspaces, sessions, events } = setup();
    const project = projects.add(tempDir());
    const parent = sessions.create(workspaces.createLocal(project.id).id);
    const provenance = { engine: "acp" as const, engineName: "test", adapterVersion: "0" };
    events.append({ sessionId: parent.id, agentId: parent.agentId, type: "message.delta", payload: { messageId: "m1", role: "assistant", block: { type: "text", text: "early" } }, provenance });
    events.append({ sessionId: parent.id, agentId: parent.agentId, type: "message.delta", payload: { messageId: "m2", role: "assistant", block: { type: "text", text: "late" } }, provenance });
    const { session: fork, copiedEvents } = sessions.fork(parent.id, 3);
    expect(copiedEvents).toBe(1);
    expect(events.list(fork.id).some((event) => event.type === "message.delta" && JSON.stringify(event.payload).includes("late"))).toBe(false);
  });

  it("closes through session.closed and records closed_at", () => {
    const { db, projects, workspaces, sessions, events } = setup();
    const project = projects.add(tempDir());
    const s = sessions.create(workspaces.createLocal(project.id).id);
    sessions.setStatus(s.id, "closed");
    const row = db.prepare("SELECT status, closed_at FROM sessions WHERE id = ?").get(s.id) as { status: string; closed_at: number | null };
    expect(row.status).toBe("closed");
    expect(row.closed_at).not.toBeNull();
    expect(events.list(s.id).at(-1)!.type).toBe("session.closed");
  });

  it("reports the newest event and an unanswered approval in session views", () => {
    const { projects, workspaces, sessions, events } = setup();
    const s = sessions.create(workspaces.createLocal(projects.add(tempDir()).id).id);
    const newestTs = Date.now() + 5_000;
    const provenance = { engine: "acp", engineName: "fake", adapterVersion: "0" } as const;
    expect(sessions.all()[0]).toMatchObject({ lastEventSeq: 2, pendingApproval: false });

    events.append({
      sessionId: s.id,
      agentId: s.agentId,
      type: "permission.requested",
      payload: {
        approvalId: "a1",
        category: "shell",
        title: "Run ls",
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      },
      provenance,
      ts: newestTs,
    });
    expect(sessions.all()[0]).toMatchObject({ lastEventSeq: 3, lastEventAt: newestTs, pendingApproval: true });
    expect(sessions.view(s.id)).toMatchObject({ lastEventSeq: 3, pendingApproval: true });

    events.append({ sessionId: s.id, agentId: s.agentId, type: "permission.resolved", payload: { approvalId: "a1", decision: "allow_once" }, provenance });
    expect(sessions.all()[0]!.pendingApproval).toBe(false);
  });

  it("takes session meta from the visible log after a rewind", () => {
    const { projects, workspaces, sessions, events } = setup();
    const s = sessions.create(workspaces.createLocal(projects.add(tempDir()).id).id);
    const provenance = { engine: "acp", engineName: "fake", adapterVersion: "0" } as const;
    events.append({ sessionId: s.id, agentId: s.agentId, type: "permission.requested", payload: { approvalId: "a1", category: "shell", title: "Run ls", options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] }, provenance });
    const marker = events.append({
      sessionId: s.id, agentId: s.agentId, type: "session.rewound",
      payload: { cutSeq: 1, checkpointId: "c-1", promptSeq: 1, restored: 0, deleted: 0, removed: 0, failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true },
      provenance,
    });

    // The abandoned approval must not keep the session flagged, and the marker counts as activity.
    expect(sessions.view(s.id)).toMatchObject({ lastEventSeq: marker.seq, pendingApproval: false });
  });

  it("switches the model and rejects unknown or disabled models", () => {
    const { db, projects, workspaces, sessions, providers, models } = setup();
    const provider = providers.create({ name: "P", baseUrl: "http://localhost:1/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    const m1 = models.create({ providerId: provider.id, modelId: "m1", contextWindow: 1000, enabled: true, engine: "acp" });
    const m2 = models.create({ providerId: provider.id, modelId: "m2", contextWindow: 1000, enabled: true, engine: "acp" });
    const s = sessions.create(workspaces.createLocal(projects.add(tempDir()).id).id, { modelId: m1.id });

    expect(sessions.setModel(s.id, m2.id).modelId).toBe(m2.id);
    expect(sessions.view(s.id).modelId).toBe(m2.id);
    expect(() => sessions.setModel(s.id, "missing")).toThrow(/Model not found/);

    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(m2.id);
    expect(() => sessions.setModel(s.id, m2.id)).toThrow(/disabled/);

    sessions.setStatus(s.id, "closed");
    expect(() => sessions.setModel(s.id, m1.id)).toThrow(/closed/);
  });

  it("stores the model's engine on the session and rejects a different engine on setModel", () => {
    const { projects, workspaces, sessions, providers, models, events } = setup();
    const openai = providers.create({ name: "OpenAI", baseUrl: "http://localhost:1/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    const anthropic = providers.create({ name: "Anthropic", baseUrl: "http://localhost:1", apiKind: "anthropic-messages", apiKey: "k", enabled: true });
    const native = models.create({ providerId: openai.id, modelId: "native-1", contextWindow: 1000, enabled: true, engine: "native" });
    const acp = models.create({ providerId: anthropic.id, modelId: "acp-1", contextWindow: 1000, enabled: true, engine: "acp" });
    const session = sessions.create(workspaces.createLocal(projects.add(tempDir()).id).id, { modelId: native.id });

    expect(session.engine).toBe("native");
    expect(sessions.view(session.id).engine).toBe("native");
    expect(() => sessions.setModel(session.id, acp.id)).toThrow(expect.objectContaining({ code: ErrorCodes.conflict }));
    expect(sessions.view(session.id).modelId).toBe(native.id);

    sessions.setStatus(session.id, "idle");
    sessions.setStatus(session.id, "closed");
    expect(events.list(session.id).every((event) => event.provenance.engine === "native")).toBe(true);
  });
});

describe("SessionService agent start", () => {
  function fixture() {
    const services = setup();
    const provider = services.providers.create({
      name: "OpenAI",
      baseUrl: "http://localhost:1/v1",
      apiKind: "openai-completions",
      apiKey: "k",
      enabled: true,
    });
    const model = services.models.create({ providerId: provider.id, modelId: "m1", contextWindow: 1000, enabled: true, engine: "acp" });
    const other = services.models.create({ providerId: provider.id, modelId: "m2", contextWindow: 1000, enabled: true, engine: "acp" });
    const native = services.models.create({ providerId: provider.id, modelId: "native-1", contextWindow: 1000, enabled: true, engine: "native" });
    const ws = services.workspaces.createLocal(services.projects.add(tempDir()).id);
    // The RPC handler parses params first; the schema supplies role/engine/policy defaults.
    const newAgent = (params: Parameters<typeof AgentCreateParams.parse>[0]) => services.agents.create(AgentCreateParams.parse(params));
    return { ...services, model, other, native, ws, newAgent };
  }

  it("snapshots the agent and keeps it after the profile changes", () => {
    const { sessions, agents, newAgent, model, other, ws } = fixture();
    const agent = newAgent({ name: "Snap", role: "Coder", engineId: "acp", modelRef: model.id, permissionPolicy: { shell: "allow" } });
    const session = sessions.create(ws.id, { agentId: agent.id });
    agents.update({ id: agent.id, modelRef: other.id, permissionPolicy: { shell: "reject" } });
    expect(sessions.view(session.id).agentId).toBe(agent.id);
    expect(sessions.snapshot(session.id)).toMatchObject({ agentId: agent.id, modelId: model.id, permissionPolicy: { shell: "allow" } });
  });

  it("keeps the legacy profile row for a session created without an agent", () => {
    const { db, sessions, ws } = fixture();
    const session = sessions.create(ws.id);
    expect(db.prepare("SELECT name, role, engine_id FROM agents WHERE id = ?").get(session.agentId)).toEqual({
      name: "Agent",
      role: "default",
      engine_id: "acp",
    });
    expect(session.modelId).toBeNull();
  });

  it("rejects an archived agent", () => {
    const { sessions, agents, newAgent, ws } = fixture();
    const agent = newAgent({ name: "Old" });
    agents.archive(agent.id, true);
    expectFault(() => sessions.create(ws.id, { agentId: agent.id }), ErrorCodes.conflict, /archived/);
    expectFault(() => sessions.create(ws.id, { agentId: "missing" }), ErrorCodes.notFound, /Agent not found/);
  });

  it("prefers an explicit model over the agent's model", () => {
    const { sessions, newAgent, model, other, ws } = fixture();
    const agent = newAgent({ name: "Pick", modelRef: model.id });
    const session = sessions.create(ws.id, { agentId: agent.id, modelId: other.id });
    expect(session.modelId).toBe(other.id);
    expect(sessions.snapshot(session.id)).toMatchObject({ modelId: other.id });
  });

  it("takes the engine from the chosen model and rejects native on a non-openai-completions provider", () => {
    const { db, providers, models, sessions, newAgent, native, ws } = fixture();
    const agent = newAgent({ name: "Native", engineId: "native", modelRef: native.id });
    expect(sessions.create(ws.id, { agentId: agent.id }).engine).toBe("native");

    const acpAgent = newAgent({ name: "Acp" });
    expect(sessions.create(ws.id, { agentId: acpAgent.id, modelId: native.id }).engine).toBe("native");

    const anthropic = providers.create({
      name: "Anthropic",
      baseUrl: "http://localhost:1",
      apiKind: "anthropic-messages",
      apiKey: "k",
      enabled: true,
    });
    const stale = models.create({ providerId: anthropic.id, modelId: "stale", contextWindow: 1000, enabled: true, engine: "acp" });
    // Simulates a row that reached native before the provider rule existed; the session guard still catches it.
    db.prepare("UPDATE models SET engine = 'native' WHERE id = ?").run(stale.id);
    expectFault(() => sessions.create(ws.id, { agentId: acpAgent.id, modelId: stale.id }), ErrorCodes.conflict, /openai-completions/);
  });

  it("returns an empty snapshot for unreadable json", () => {
    const { db, sessions, ws } = fixture();
    const session = sessions.create(ws.id);
    db.prepare("UPDATE sessions SET config_snapshot_json = 'not json' WHERE id = ?").run(session.id);
    expect(sessions.snapshot(session.id)).toEqual({});
    expectFault(() => sessions.snapshot("missing"), ErrorCodes.notFound, /Session not found/);
  });

  it("rejects an agent model that is disabled or gone", () => {
    const { db, sessions, newAgent, model, ws } = fixture();
    const gone = newAgent({ name: "Gone", modelRef: model.id });
    db.prepare("UPDATE agents SET model_ref = 'gone' WHERE id = ?").run(gone.id);
    const agent = newAgent({ name: "Broken", modelRef: model.id });
    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(model.id);
    expectFault(() => sessions.create(ws.id, { agentId: agent.id }), ErrorCodes.conflict, /Model is disabled/);
    expectFault(() => sessions.create(ws.id, { agentId: gone.id }), ErrorCodes.notFound, /Model not found/);
  });

  it("rejects an agent model whose provider is disabled", () => {
    const { db, sessions, newAgent, model, ws } = fixture();
    const agent = newAgent({ name: "BrokenProvider", modelRef: model.id });
    db.prepare("UPDATE providers SET enabled = 0 WHERE id = ?").run(model.providerId);
    expectFault(() => sessions.create(ws.id, { agentId: agent.id }), ErrorCodes.conflict, /provider is disabled/i);
  });

  it("rejects a native agent when the kernel default cannot run native", () => {
    const { projects, workspaces, sessions, providers, models, agents } = setup();
    const ws = workspaces.createLocal(projects.add(tempDir()).id);
    const agent = agents.create(AgentCreateParams.parse({ name: "Native", engineId: "native" }));
    const anthropic = providers.create({
      name: "Anthropic",
      baseUrl: "http://localhost:1",
      apiKind: "anthropic-messages",
      apiKey: "k",
      enabled: true,
    });
    models.create({ providerId: anthropic.id, modelId: "claude", contextWindow: 1000, enabled: true, engine: "acp" });
    expectFault(() => sessions.create(ws.id, { agentId: agent.id }), ErrorCodes.conflict, /openai-completions/);
  });

  it("rejects a native agent when no default model exists", () => {
    const { projects, workspaces, sessions, agents } = setup();
    const ws = workspaces.createLocal(projects.add(tempDir()).id);
    const agent = agents.create(AgentCreateParams.parse({ name: "Native", engineId: "native" }));
    expectFault(() => sessions.create(ws.id, { agentId: agent.id }), ErrorCodes.conflict, /No model is configured/);
  });

  it("fails closed on an invalid stored policy", () => {
    const { db, sessions, newAgent, model, ws } = fixture();
    const agent = newAgent({ name: "BadPolicy", modelRef: model.id });
    db.prepare("UPDATE agents SET permission_policy = ? WHERE id = ?").run('{"shell":"allow","bogus":1}', agent.id);
    const session = sessions.create(ws.id, { agentId: agent.id });
    expect(sessions.snapshot(session.id)).toMatchObject({ permissionPolicy: {} });
  });

  it("starts a native agent on the kernel default without pinning it", () => {
    const { db, sessions, newAgent, ws } = fixture();
    const agent = newAgent({ name: "NativeDefault", engineId: "native" });
    const session = sessions.create(ws.id, { agentId: agent.id });
    expect(session.engine).toBe("native");
    expect(session.modelId).toBeNull();
    expect(db.prepare("SELECT model_id FROM sessions WHERE id = ?").get(session.id)).toEqual({ model_id: null });
    expect(sessions.snapshot(session.id)).toMatchObject({ engine: "native", modelId: null });
  });
});
