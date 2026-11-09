import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ProjectService } from "../src/projects.js";
import { WorkspaceService } from "../src/workspaces.js";
import { SessionService } from "../src/sessions.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir svc ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  return { db, events, projects, workspaces, sessions };
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
});
