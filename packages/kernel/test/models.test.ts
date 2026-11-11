import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, RpcFault, type ModelCreateParams } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ModelService } from "../src/models.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
import { SessionService } from "../src/sessions.js";
import { WorkspaceService } from "../src/workspaces.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
let dbSeq = 0;
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir models ü ")); dirs.push(d); return d; }
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memorySecrets(): Secrets & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: (id, v) => void store.set(id, v),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

function setup() {
  // The database lives under a path with a space and a non-ASCII segment.
  const db = openDb(join(tempDir(), `noir ${dbSeq++}.db`));
  dbs.push(db);
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);
  return { db, events, projects, workspaces, sessions, providers, models };
}

function addProvider(providers: ProviderService, overrides: { name?: string; enabled?: boolean } = {}) {
  return providers.create({
    name: overrides.name ?? "Local",
    baseUrl: "http://localhost:11434/v1",
    apiKind: "openai-completions",
    apiKey: "sk-test",
    enabled: overrides.enabled ?? true,
  });
}

function modelParams(providerId: string, overrides: Partial<ModelCreateParams> = {}): ModelCreateParams {
  return { providerId, modelId: "gpt-test", contextWindow: 200_000, enabled: true, engine: "acp", ...overrides };
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

describe("ModelService", () => {
  it("creates a model with a persisted createdAt and lists it by provider", () => {
    const { db, providers, models } = setup();
    const provider = addProvider(providers);
    const created = models.create(modelParams(provider.id, { displayName: "GPT Test", maxTokens: 4096 }));

    expect(created.providerId).toBe(provider.id);
    expect(created.displayName).toBe("GPT Test");
    expect(created.maxTokens).toBe(4096);
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toBeGreaterThan(0);

    const persisted = db.prepare("SELECT created_at, display_name FROM models WHERE id = ?").get(created.id) as { created_at: number; display_name: string };
    expect(persisted.created_at).toBe(created.createdAt);
    expect(persisted.display_name).toBe("GPT Test");

    const byProvider = models.list(provider.id);
    expect(byProvider).toEqual([created]);
    expect(models.list()).toEqual([created]);
  });

  it("defaults the display name to the model id", () => {
    const { providers, models } = setup();
    const provider = addProvider(providers);
    expect(models.create(modelParams(provider.id)).displayName).toBe("gpt-test");
  });

  it("rejects a duplicate model for the same provider", () => {
    const { providers, models } = setup();
    const provider = addProvider(providers);
    models.create(modelParams(provider.id));
    expectFault(() => models.create(modelParams(provider.id)), ErrorCodes.conflict, /already exists/);
  });

  it("allows the same model id on different providers", () => {
    const { providers, models } = setup();
    const a = addProvider(providers, { name: "A" });
    const b = addProvider(providers, { name: "B" });
    const modelA = models.create(modelParams(a.id));
    const modelB = models.create(modelParams(b.id));
    expect(models.list()).toHaveLength(2);
    expect(models.list(a.id)).toEqual([modelA]);
    expect(models.list(b.id)).toEqual([modelB]);
  });

  it("rejects a model for a missing provider", () => {
    const { models } = setup();
    expectFault(() => models.create(modelParams("missing")), ErrorCodes.notFound, /Provider not found/);
  });

  it("rejects deleting a missing model", () => {
    const { models } = setup();
    expectFault(() => models.remove("missing"), ErrorCodes.notFound, /Model not found/);
  });

  it("deletes a model", () => {
    const { providers, models } = setup();
    const provider = addProvider(providers);
    const created = models.create(modelParams(provider.id));
    models.remove(created.id);
    expect(models.list()).toEqual([]);
  });

  it("cascades models when their provider is deleted", () => {
    const { db, providers, models } = setup();
    const provider = addProvider(providers);
    models.create(modelParams(provider.id));
    providers.remove(provider.id);
    expect(models.list()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM models").pluck().get()).toBe(0);
  });

  it("stores an engine and rejects native for a non-openai provider", () => {
    const { providers, models } = setup();
    const provider = providers.create({ name: "anthropic", baseUrl: "https://example.test", apiKind: "anthropic-messages", apiKey: "k", enabled: true });
    expect(() => models.create({ providerId: provider.id, modelId: "m", contextWindow: 1000, enabled: true, engine: "native" }))
      .toThrow(/openai-completions/);
  });

  it("defaults the engine to acp and switches it only for openai-completions providers", () => {
    const { providers, models } = setup();
    const provider = addProvider(providers);
    const model = models.create(modelParams(provider.id));
    expect(model.engine).toBe("acp");

    expect(models.setEngine(model.id, "native").engine).toBe("native");
    expect(models.list(provider.id)[0]!.engine).toBe("native");

    expectFault(() => models.setEngine("missing", "native"), ErrorCodes.notFound, /Model not found/);
  });
});

describe("SessionService model selection", () => {
  function workspace(projects: ProjectService, workspaces: WorkspaceService): string {
    const root = join(tempDir(), "project ü");
    mkdirSync(root, { recursive: true });
    const project = projects.add(root);
    return workspaces.createLocal(project.id).id;
  }

  it("stores the model on the session and returns it in views", () => {
    const { providers, models, projects, workspaces, sessions } = setup();
    const provider = addProvider(providers);
    const model = models.create(modelParams(provider.id));
    const workspaceId = workspace(projects, workspaces);

    const created = sessions.create(workspaceId, model.id);
    expect(created.modelId).toBe(model.id);
    expect(created.workspaceId).toBe(workspaceId);

    expect(sessions.view(created.id).modelId).toBe(model.id);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]!.modelId).toBe(model.id);
  });

  it("creates a session without a model", () => {
    const { projects, workspaces, sessions } = setup();
    const created = sessions.create(workspace(projects, workspaces));
    expect(created.modelId).toBeNull();
    expect(sessions.view(created.id).modelId).toBeNull();
    expect(sessions.list()[0]!.modelId).toBeNull();
  });

  it("rejects a disabled model", () => {
    const { providers, models, projects, workspaces, sessions } = setup();
    const provider = addProvider(providers);
    const model = models.create(modelParams(provider.id, { enabled: false }));
    const workspaceId = workspace(projects, workspaces);
    expectFault(() => sessions.create(workspaceId, model.id), ErrorCodes.conflict, /Model is disabled/);
  });

  it("rejects a model whose provider is disabled", () => {
    const { providers, models, projects, workspaces, sessions } = setup();
    const provider = addProvider(providers, { enabled: false });
    const model = models.create(modelParams(provider.id));
    const workspaceId = workspace(projects, workspaces);
    expectFault(() => sessions.create(workspaceId, model.id), ErrorCodes.conflict, /provider is disabled/i);
  });

  it("rejects an unknown model", () => {
    const { projects, workspaces, sessions } = setup();
    const workspaceId = workspace(projects, workspaces);
    expectFault(() => sessions.create(workspaceId, "missing"), ErrorCodes.notFound, /Model not found/);
  });

  it("reports a missing session from view", () => {
    const { sessions } = setup();
    expectFault(() => sessions.view("missing"), ErrorCodes.notFound, /Session not found/);
  });
});
