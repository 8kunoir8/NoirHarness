import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCreateParams,
  AgentRosterEntry,
  AgentView,
  ErrorCodes,
  PermissionPolicySchema,
  RpcFault,
  type ApiKind,
} from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
import { SessionService } from "../src/sessions.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir agents "));
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

interface TestServices {
  db: Database.Database;
  events: EventStore;
  projects: ProjectService;
  workspaces: WorkspaceService;
  providers: ProviderService;
  models: ModelService;
  sessions: SessionService;
  agents: AgentService;
}

function setup(): TestServices {
  const db = openDb(join(tempDir(), "noir.db"));
  dbs.push(db);
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);
  const sessions = new SessionService(db, events, models);
  const agents = new AgentService(db, models, sessions, events);
  return { db, events, projects, workspaces, providers, models, sessions, agents };
}

function agentInput(overrides: Record<string, unknown> = {}): AgentCreateParams {
  return AgentCreateParams.parse({ name: "Reviewer", role: "Review", engineId: "acp", ...overrides });
}

function addProvider(providers: ProviderService, apiKind: ApiKind = "openai-completions", enabled = true) {
  return providers.create({
    name: `Provider ${apiKind} ${enabled}`,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKind,
    apiKey: "sk-test",
    enabled,
  });
}

function addModel(services: TestServices, apiKind: ApiKind = "openai-completions", enabled = true) {
  const provider = addProvider(services.providers, apiKind, enabled);
  return services.models.create({
    providerId: provider.id,
    modelId: `model-${apiKind}`,
    contextWindow: 200_000,
    enabled: true,
    engine: "acp",
  });
}

/**
 * The row the engine writes when it accepts a prompt. The roster reads work from these and not from
 * the status, so a test that wants an agent to look busy has to give it something to run.
 */
function executing(services: TestServices, sessionId: string, status: "queued" | "running" = "running"): void {
  services.db
    .prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES (?,?,?,?,?)")
    .run(`turn-${sessionId}`, sessionId, 0, status, Date.now());
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

describe("AgentService", () => {
  it("creates an agent with defaults and a valid view", () => {
    const { agents } = setup();
    const agent = agents.create(agentInput({ name: "  Reviewer  ", role: "  Review  " }));

    expect(agent.name).toBe("Reviewer");
    expect(agent.role).toBe("Review");
    expect(agent.engineId).toBe("acp");
    expect(agent.modelRef).toBeNull();
    expect(agent.permissionPolicy).toEqual({});
    expect(agent.defaultWorkspaceId).toBeNull();
    expect(agent.archivedAt).toBeNull();
    expect(agent.createdAt).toBeGreaterThan(0);
    expect(AgentView.parse(agent)).toEqual(agent);
    expect(agents.list()).toEqual([agent]);
  });

  it("rejects a duplicate name case-insensitively and frees the name on archive", () => {
    const { agents } = setup();
    const first = agents.create(agentInput({ name: "Reviewer" }));

    expectFault(() => agents.create(agentInput({ name: "reviewer" })), ErrorCodes.conflict, /already exists/);

    agents.archive(first.id, true);
    const second = agents.create(agentInput({ name: "rEvIeWeR" }));
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe("rEvIeWeR");
  });

  it("archives idempotently in both directions and hides archived agents by default", () => {
    const { agents } = setup();
    const agent = agents.create(agentInput());

    agents.archive(agent.id, true);
    agents.archive(agent.id, true);
    expect(agents.list().map((a) => a.id)).not.toContain(agent.id);
    expect(agents.list(true).map((a) => a.id)).toContain(agent.id);

    agents.archive(agent.id, false);
    agents.archive(agent.id, false);
    expect(agents.list().map((a) => a.id)).toContain(agent.id);
    expect(agents.list(true).find((a) => a.id === agent.id)?.archivedAt).toBeNull();

    expectFault(() => agents.archive("missing", true), ErrorCodes.notFound, /Agent not found/);
  });

  it("refuses to unarchive a name that was taken while archived", () => {
    const { agents } = setup();
    const archived = agents.create(agentInput({ name: "Alpha" }));
    agents.archive(archived.id, true);
    agents.create(agentInput({ name: "alpha" }));

    expectFault(() => agents.archive(archived.id, false), ErrorCodes.conflict, /already exists/);
  });

  it("lists by case-insensitive name and honours includeArchived", () => {
    const { agents } = setup();
    const zeta = agents.create(agentInput({ name: "zeta" }));
    agents.create(agentInput({ name: "Alpha" }));
    agents.create(agentInput({ name: "beta" }));

    expect(agents.list().map((a) => a.name)).toEqual(["Alpha", "beta", "zeta"]);

    agents.archive(zeta.id, true);
    expect(agents.list().map((a) => a.name)).toEqual(["Alpha", "beta"]);
    expect(agents.list(true).map((a) => a.name)).toEqual(["Alpha", "beta", "zeta"]);
  });

  it("rejects a model that is disabled or missing", () => {
    const services = setup();
    const { agents, db } = services;
    const model = addModel(services);

    expectFault(() => agents.create(agentInput({ modelRef: "missing" })), ErrorCodes.notFound, /Model not found/);
    expect(agents.create(agentInput({ name: "With model", modelRef: model.id })).modelRef).toBe(model.id);

    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(model.id);
    expectFault(
      () => agents.create(agentInput({ name: "Disabled model", modelRef: model.id })),
      ErrorCodes.notFound,
      /Model not found/,
    );
  });

  it("rejects a model whose provider is disabled", () => {
    const services = setup();
    const { agents } = services;
    const model = addModel(services, "openai-completions", false);

    expectFault(
      () => agents.create(agentInput({ name: "Disabled provider", modelRef: model.id })),
      ErrorCodes.notFound,
      /Model not found/,
    );
  });

  it("requires an openai-completions provider for the native engine", () => {
    const services = setup();
    const { agents } = services;
    const okModel = addModel(services, "openai-completions");
    const badModel = addModel(services, "anthropic-messages");

    // ACP accepts any provider; native only the protocol its loop speaks.
    expect(agents.create(agentInput({ engineId: "acp", modelRef: badModel.id })).engineId).toBe("acp");
    expect(agents.create(agentInput({ name: "Native", engineId: "native", modelRef: okModel.id })).engineId).toBe("native");

    expectFault(
      () => agents.create(agentInput({ name: "Bad native", engineId: "native", modelRef: badModel.id })),
      ErrorCodes.conflict,
      /openai-completions/,
    );
    // Without a model the compatibility is re-checked when the session resolves its model.
    expect(agents.create(agentInput({ name: "Native default", engineId: "native" })).modelRef).toBeNull();
  });

  it("rejects an unknown default workspace", () => {
    const services = setup();
    const { db, agents, projects, workspaces } = services;
    expectFault(
      () => agents.create(agentInput({ defaultWorkspaceId: "missing" })),
      ErrorCodes.notFound,
      /Workspace not found/,
    );

    const project = projects.add(tempDir());
    const workspace = workspaces.createLocal(project.id);
    const agent = agents.create(agentInput({ name: "Bound", defaultWorkspaceId: workspace.id }));
    expect(agent.defaultWorkspaceId).toBe(workspace.id);

    // Deleting the workspace clears the reference rather than orphaning it.
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
    expect(agents.list().find((a) => a.id === agent.id)?.defaultWorkspaceId).toBeNull();
  });

  it("does not reapply create defaults on a partial update", () => {
    const services = setup();
    const { agents, projects, workspaces } = services;
    const model = addModel(services);
    const project = projects.add(tempDir());
    const workspace = workspaces.createLocal(project.id);
    const agent = agents.create(
      agentInput({ name: "Native", engineId: "native", modelRef: model.id, defaultWorkspaceId: workspace.id }),
    );

    const updated = agents.update({ id: agent.id, role: "Review" });
    expect(updated).toEqual({ ...agent, role: "Review" });

    expectFault(
      () => agents.update({ id: agent.id, defaultWorkspaceId: "missing" }),
      ErrorCodes.notFound,
      /Workspace not found/,
    );
  });

  it("round-trips the permission policy as JSON text", () => {
    const { db, agents } = setup();
    const agent = agents.create(agentInput({ permissionPolicy: { shell: "allow", network: "reject" } }));

    expect(agent.permissionPolicy).toEqual({ shell: "allow", network: "reject" });
    const stored = db.prepare("SELECT permission_policy FROM agents WHERE id = ?").get(agent.id) as {
      permission_policy: string;
    };
    expect(typeof stored.permission_policy).toBe("string");
    expect(JSON.parse(stored.permission_policy)).toEqual({ shell: "allow", network: "reject" });

    const updated = agents.update({ id: agent.id, permissionPolicy: { delete: "allow" } });
    expect(updated.permissionPolicy).toEqual({ delete: "allow" });
    expect(agents.list()[0]?.permissionPolicy).toEqual({ delete: "allow" });
  });

  it("rejects an unknown permission category instead of ignoring it", () => {
    expect(PermissionPolicySchema.safeParse({ shell: "ask", shells: "allow" }).success).toBe(false);
    expect(() => agentInput({ permissionPolicy: { shells: "allow" } })).toThrow();
  });

  it("updates only the provided fields and validates the effective model", () => {
    const services = setup();
    const { agents } = services;
    const model = addModel(services);
    const agent = agents.create(agentInput({ name: "Original", role: "Coder" }));

    const renamed = agents.update({ id: agent.id, name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.role).toBe("Coder");

    const withModel = agents.update({ id: agent.id, modelRef: model.id });
    expect(withModel.modelRef).toBe(model.id);

    const cleared = agents.update({ id: agent.id, modelRef: null });
    expect(cleared.modelRef).toBeNull();
    expect(cleared.name).toBe("Renamed");

    expectFault(() => agents.update({ id: "missing", name: "Nope" }), ErrorCodes.notFound, /Agent not found/);
    expectFault(() => agents.update({ id: agent.id, modelRef: "missing" }), ErrorCodes.notFound, /Model not found/);

    agents.create(agentInput({ name: "Taken" }));
    expectFault(() => agents.update({ id: agent.id, name: "taken" }), ErrorCodes.conflict, /already exists/);
  });

  it("validates native compatibility when an update adds or switches the model", () => {
    const services = setup();
    const { agents } = services;
    const badModel = addModel(services, "anthropic-messages");
    const agent = agents.create(agentInput({ name: "Native", engineId: "native" }));

    expectFault(
      () => agents.update({ id: agent.id, modelRef: badModel.id }),
      ErrorCodes.conflict,
      /openai-completions/,
    );

    const acpAgent = agents.create(agentInput({ name: "Acp" }));
    expectFault(
      () => agents.update({ id: acpAgent.id, engineId: "native", modelRef: badModel.id }),
      ErrorCodes.conflict,
      /openai-completions/,
    );
  });
});

const provenance = { engine: "acp" as const, engineName: "test", adapterVersion: "0" };

function workspaceFor(services: TestServices): string {
  return services.workspaces.createLocal(services.projects.add(tempDir()).id).id;
}

function entryFor(services: TestServices, agentId: string): AgentRosterEntry {
  const entry = services.agents.roster().find((candidate) => candidate.agentId === agentId);
  if (entry === undefined) throw new Error(`No roster entry for ${agentId}`);
  return AgentRosterEntry.parse(entry);
}

describe("AgentService.roster", () => {
  it("reports needs_you when any session has a pending approval", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Nyx" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: {
        approvalId: "a1",
        category: "shell",
        title: "Run ls",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      provenance,
    });

    expect(entryFor(services, agent.id)).toMatchObject({
      status: "needs_you",
      activeSessionId: session.id,
      activeSessionStatus: "running",
      sessionCount: 1,
      activeToolKind: null,
      usage: null,
    });
  });

  it("reports the active session's pending approval with its title and category", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Waiting" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: { approvalId: "a1", category: "shell", title: "Run rm -rf build", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      provenance,
    });

    expect(entryFor(services, agent.id)).toMatchObject({
      status: "needs_you",
      pendingApproval: { approvalId: "a1", title: "Run rm -rf build", category: "shell" },
    });
  });

  it("hides an approval and a tool a rewind abandoned", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Rewound" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");
    executing(services, session.id);
    const tool = services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "tool.started",
      payload: { toolCallId: "t1", kind: "write", title: "Edit main.ts" },
      provenance,
    });
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "usage.updated",
      payload: { inputTokens: 10, outputTokens: 20, contextUsed: 900, contextWindow: 1000, costUsd: 0.001 },
      provenance,
    });
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: { approvalId: "a1", category: "shell", title: "Run rm -rf build", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      provenance,
    });
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "session.rewound",
      payload: {
        cutSeq: tool.seq, checkpointId: "c-1", promptSeq: tool.seq, restored: 0, deleted: 0, removed: 0,
        failed: 0, notCaptured: 0, engine: "acp", engineNotRewound: true,
      },
      provenance,
    });

    expect(entryFor(services, agent.id)).toMatchObject({
      status: "working",
      activeToolKind: null,
      usage: null,
      pendingApproval: null,
    });

    // A request the rewind did not touch still counts: only the abandoned range is filtered.
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: { approvalId: "a2", category: "shell", title: "Run ls", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      provenance,
    });
    expect(entryFor(services, agent.id)).toMatchObject({
      status: "needs_you",
      pendingApproval: { approvalId: "a2", title: "Run ls" },
    });
  });

  it("clears the pending approval when a newer permission.resolved arrives", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Resolved" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: { approvalId: "a1", category: "shell", title: "Run ls", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      provenance,
    });
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.resolved",
      payload: { approvalId: "a1", decision: "allow_once" },
      provenance,
    });

    expect(entryFor(services, agent.id).pendingApproval).toBeNull();
  });

  it("reports no pending approval when the active session never asked", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Quiet" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");

    expect(entryFor(services, agent.id).pendingApproval).toBeNull();
  });

  it("keeps the approval row's category when the stored request payload is unreadable", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Corrupt" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "running");
    const event = services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "permission.requested",
      payload: { approvalId: "a1", category: "delete", title: "Delete build", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      provenance,
    });
    services.db
      .prepare("INSERT INTO approvals (id, session_id, event_id, kind, payload_json) VALUES (?,?,?,?,?)")
      .run("a1", session.id, event.id, "delete", "{}");
    services.db.prepare("UPDATE events SET payload_json = ? WHERE id = ?").run("{not json", event.id);

    // The marker survives a corrupt payload; the bubble falls back to the category (empty title).
    expect(entryFor(services, agent.id).pendingApproval).toEqual({
      approvalId: "a1",
      title: "",
      category: "delete",
    });
  });

  it("reports working for a turn in flight, not for a chat nobody has prompted", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const idle = services.agents.create(agentInput({ name: "Idle" }));
    const busy = services.agents.create(agentInput({ name: "Busy" }));
    const fresh = services.agents.create(agentInput({ name: "Fresh" }));
    const emptyChat = services.sessions.create(workspaceId, { agentId: idle.id });
    const prompted = services.sessions.create(workspaceId, { agentId: busy.id });
    const spawning = services.sessions.create(workspaceId, { agentId: fresh.id });
    services.sessions.setStatus(prompted.id, "running");
    // The engine writes the turn row when it accepts a prompt, before the engine is up: that row is
    // what "working" means, and a session with none of them is idle no matter its status.
    executing(services, prompted.id);
    executing(services, spawning.id, "queued");

    expect(entryFor(services, idle.id)).toMatchObject({ status: "idle", activeSessionId: emptyChat.id });
    expect(entryFor(services, busy.id).status).toBe("working");
    // A first turn the engine is still coming up for is already work.
    expect(entryFor(services, fresh.id).status).toBe("working");

    // An approval wait keeps its turn row and is not work: nothing runs until it is answered.
    services.sessions.setStatus(prompted.id, "waiting");
    expect(entryFor(services, busy.id).status).toBe("idle");

    // A finished turn leaves nothing in flight, so both agents go back to idle.
    const finish = services.db.prepare("UPDATE turns SET status = 'completed', ended_at = ? WHERE id = ?");
    finish.run(Date.now(), `turn-${prompted.id}`);
    finish.run(Date.now(), `turn-${spawning.id}`);
    services.sessions.setStatus(prompted.id, "idle");
    expect(entryFor(services, fresh.id).status).toBe("idle");
    expect(entryFor(services, busy.id).status).toBe("idle");
  });

  it("reports error for an agent whose only session errored", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Broken" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(session.id, "error");

    expect(entryFor(services, agent.id)).toMatchObject({ status: "error", activeSessionId: session.id, activeSessionStatus: "error" });
  });

  it("reports idle for idle or closed sessions and for an agent with no sessions", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const idle = services.agents.create(agentInput({ name: "Idle" }));
    const closed = services.agents.create(agentInput({ name: "Closed" }));
    const fresh = services.agents.create(agentInput({ name: "Fresh" }));

    const idleSession = services.sessions.create(workspaceId, { agentId: idle.id });
    services.sessions.setStatus(idleSession.id, "idle");
    const closedSession = services.sessions.create(workspaceId, { agentId: closed.id });
    services.sessions.setStatus(closedSession.id, "closed");

    expect(entryFor(services, idle.id)).toMatchObject({ status: "idle", activeSessionId: idleSession.id, activeSessionStatus: "idle" });
    // A closed session is not "active": there is nothing to open.
    expect(entryFor(services, closed.id)).toMatchObject({ status: "idle", activeSessionId: null, activeSessionStatus: null });
    expect(entryFor(services, fresh.id)).toMatchObject({ status: "idle", activeSessionId: null, sessionCount: 0, lastActivityAt: fresh.createdAt });
  });

  it("ranks working above error when the agent has both kinds of session", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Mixed" }));
    const errored = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(errored.id, "error");
    const running = services.sessions.create(workspaceId, { agentId: agent.id });
    services.sessions.setStatus(running.id, "running");
    executing(services, running.id);

    expect(entryFor(services, agent.id)).toMatchObject({ status: "working", sessionCount: 2 });
  });

  it("describes the newest open session, not the newest session overall", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Multi" }));
    const first = services.sessions.create(workspaceId, { agentId: agent.id });
    const second = services.sessions.create(workspaceId, { agentId: agent.id });
    services.db.prepare("UPDATE sessions SET created_at = 1 WHERE id = ?").run(first.id);
    services.db.prepare("UPDATE sessions SET created_at = 2 WHERE id = ?").run(second.id);
    services.db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(second.id);

    expect(entryFor(services, agent.id)).toMatchObject({
      activeSessionId: first.id,
      activeSessionStatus: "starting",
      sessionCount: 2,
    });
  });

  it("breaks a same-millisecond created_at tie by id", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Tied" }));
    const first = services.sessions.create(workspaceId, { agentId: agent.id });
    const second = services.sessions.create(workspaceId, { agentId: agent.id });
    services.db.prepare("UPDATE sessions SET created_at = 7 WHERE id IN (?, ?)").run(first.id, second.id);

    const expected = first.id > second.id ? first : second;
    services.events.append({
      sessionId: expected.id,
      agentId: agent.id,
      type: "tool.started",
      payload: { toolCallId: "t1", title: "Tied tool", kind: "search" },
      provenance,
    });

    expect(entryFor(services, agent.id)).toMatchObject({
      activeSessionId: expected.id,
      activeToolKind: "search",
    });
  });

  it("counts the same number of statements however many open sessions the roster has", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const first = services.agents.create(agentInput({ name: "One" }));
    const second = services.agents.create(agentInput({ name: "Two" }));
    services.sessions.create(workspaceId, { agentId: first.id });
    services.sessions.create(workspaceId, { agentId: second.id });

    const originalPrepare = services.db.prepare;
    let calls = 0;
    services.db.prepare = ((sql: string) => {
      calls += 1;
      return originalPrepare.call(services.db, sql);
    }) as typeof services.db.prepare;
    try {
      services.agents.roster();
      const baseline = calls;
      // Session list (4), agent list (1), batched event query (1), rewind marker scan (1), and the
      // batched turn lookup that decides who is working (1). Flat, whatever the roster's size.
      expect(baseline).toBe(8);

      for (let index = 0; index < 8; index += 1) {
        const extra = services.agents.create(agentInput({ name: `Extra ${index}` }));
        services.sessions.create(workspaceId, { agentId: extra.id });
      }
      calls = 0;
      services.agents.roster();
      expect(calls).toBe(baseline);
    } finally {
      services.db.prepare = originalPrepare;
    }
  });

  it("takes activeToolKind from the newest tool.started kind and rejects unknown or malformed payloads", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Tools" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });

    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "tool.started",
      payload: { toolCallId: "t1", title: "Read file", kind: "read" },
      provenance,
    });
    expect(entryFor(services, agent.id).activeToolKind).toBe("read");

    // A newer payload without `kind` supersedes the older one instead of falling back to it.
    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "tool.started",
      payload: { toolCallId: "t2", title: "Untyped" },
      provenance,
    });
    expect(entryFor(services, agent.id).activeToolKind).toBeNull();

    services.db
      .prepare(
        "UPDATE events SET payload_json = ? WHERE id = (SELECT id FROM events WHERE session_id = ? AND type = 'tool.started' ORDER BY seq DESC LIMIT 1)",
      )
      .run(JSON.stringify({ toolCallId: "t3", title: "Bad kind", kind: "telepathy" }), session.id);
    expect(entryFor(services, agent.id).activeToolKind).toBeNull();

    services.db
      .prepare(
        "UPDATE events SET payload_json = ? WHERE id = (SELECT id FROM events WHERE session_id = ? AND type = 'tool.started' ORDER BY seq DESC LIMIT 1)",
      )
      .run("{not json", session.id);
    expect(entryFor(services, agent.id).activeToolKind).toBeNull();
  });

  it("reports usage from the newest usage.updated payload", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Tokens" }));
    const session = services.sessions.create(workspaceId, { agentId: agent.id });
    expect(entryFor(services, agent.id).usage).toBeNull();

    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "usage.updated",
      payload: { inputTokens: 1, outputTokens: 2, contextUsed: 500, contextWindow: 2_000, costUsd: 0 },
      provenance,
    });
    expect(entryFor(services, agent.id).usage).toEqual({ used: 500, size: 2_000 });

    services.events.append({
      sessionId: session.id,
      agentId: agent.id,
      type: "usage.updated",
      payload: { inputTokens: 3, outputTokens: 4, contextUsed: 900, contextWindow: 2_000, costUsd: 0 },
      provenance,
    });
    expect(entryFor(services, agent.id).usage).toEqual({ used: 900, size: 2_000 });

    services.db
      .prepare(
        "UPDATE events SET payload_json = ? WHERE id = (SELECT id FROM events WHERE session_id = ? AND type = 'usage.updated' ORDER BY seq DESC LIMIT 1)",
      )
      .run(JSON.stringify({ contextUsed: "lots", contextWindow: 2_000 }), session.id);
    expect(entryFor(services, agent.id).usage).toBeNull();
  });

  it("uses the newest event time across all of the agent's sessions", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const agent = services.agents.create(agentInput({ name: "Busy" }));
    const older = services.sessions.create(workspaceId, { agentId: agent.id });
    const newer = services.sessions.create(workspaceId, { agentId: agent.id });
    services.db.prepare("UPDATE sessions SET created_at = 1 WHERE id = ?").run(older.id);
    services.db.prepare("UPDATE sessions SET created_at = 2 WHERE id = ?").run(newer.id);

    const later = Date.now() + 60_000;
    services.events.append({
      sessionId: older.id,
      agentId: agent.id,
      type: "message.delta",
      payload: { messageId: "m1", role: "assistant", block: { type: "text", text: "later" } },
      provenance,
      ts: later,
    });

    expect(entryFor(services, agent.id).lastActivityAt).toBe(later);
  });

  it("sorts by status urgency, then by name", () => {
    const services = setup();
    const workspaceId = workspaceFor(services);
    const beta = services.agents.create(agentInput({ name: "Beta" }));
    const alpha = services.agents.create(agentInput({ name: "Alpha" }));
    const zulu = services.agents.create(agentInput({ name: "Zulu" }));
    const aardvark = services.agents.create(agentInput({ name: "Aardvark" }));

    const betaSession = services.sessions.create(workspaceId, { agentId: beta.id });
    services.sessions.setStatus(betaSession.id, "error");
    const alphaSession = services.sessions.create(workspaceId, { agentId: alpha.id });
    services.sessions.setStatus(alphaSession.id, "idle");
    const zuluSession = services.sessions.create(workspaceId, { agentId: zulu.id });
    services.sessions.setStatus(zuluSession.id, "running");
    executing(services, zuluSession.id);
    const aardvarkSession = services.sessions.create(workspaceId, { agentId: aardvark.id });
    services.sessions.setStatus(aardvarkSession.id, "idle");

    expect(services.agents.roster().map((entry) => entry.name)).toEqual(["Zulu", "Beta", "Aardvark", "Alpha"]);
  });
});
