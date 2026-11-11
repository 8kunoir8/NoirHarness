import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCreateParams,
  AgentView,
  ErrorCodes,
  PermissionPolicySchema,
  RpcFault,
  type ApiKind,
} from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
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
  projects: ProjectService;
  workspaces: WorkspaceService;
  providers: ProviderService;
  models: ModelService;
  agents: AgentService;
}

function setup(): TestServices {
  const db = openDb(join(tempDir(), "noir.db"));
  dbs.push(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);
  const agents = new AgentService(db, models);
  return { db, projects, workspaces, providers, models, agents };
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
