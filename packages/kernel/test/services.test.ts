import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcFault, reduceSession, type SessionState } from "@noir/protocol";
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

function setup() {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);
  return { db, events, projects, workspaces, sessions, providers, models };
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
    sessions.setStatus(s.id, "idle");
    expect(sessions.list()[0]!.status).toBe("idle");
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
    expect(sessions.list()[0]).toMatchObject({ lastEventSeq: 2, pendingApproval: false });

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
    expect(sessions.list()[0]).toMatchObject({ lastEventSeq: 3, lastEventAt: newestTs, pendingApproval: true });
    expect(sessions.view(s.id)).toMatchObject({ lastEventSeq: 3, pendingApproval: true });

    events.append({ sessionId: s.id, agentId: s.agentId, type: "permission.resolved", payload: { approvalId: "a1", decision: "allow_once" }, provenance });
    expect(sessions.list()[0]!.pendingApproval).toBe(false);
  });

  it("switches the model and rejects unknown or disabled models", () => {
    const { db, projects, workspaces, sessions, providers, models } = setup();
    const provider = providers.create({ name: "P", baseUrl: "http://localhost:1/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    const m1 = models.create({ providerId: provider.id, modelId: "m1", contextWindow: 1000, enabled: true });
    const m2 = models.create({ providerId: provider.id, modelId: "m2", contextWindow: 1000, enabled: true });
    const s = sessions.create(workspaces.createLocal(projects.add(tempDir()).id).id, m1.id);

    expect(sessions.setModel(s.id, m2.id).modelId).toBe(m2.id);
    expect(sessions.view(s.id).modelId).toBe(m2.id);
    expect(() => sessions.setModel(s.id, "missing")).toThrow(/Model not found/);

    db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(m2.id);
    expect(() => sessions.setModel(s.id, m2.id)).toThrow(/disabled/);

    sessions.setStatus(s.id, "closed");
    expect(() => sessions.setModel(s.id, m1.id)).toThrow(/closed/);
  });
});
