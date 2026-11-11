import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCreateParams, McpServerCreateParams } from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { McpService } from "../src/mcp/service.js";
import { ModelService } from "../src/models.js";
import { SessionService } from "../src/sessions.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  db: Database.Database;
  mcp: McpService;
  agents: AgentService;
  clock: { now: number };
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "noir mcp "));
  dirs.push(dir);
  const db = openDb(join(dir, "noir.db"));
  dbs.push(db);
  const models = new ModelService(db);
  const sessions = new SessionService(db, new EventStore(db), models);
  const clock = { now: 1_000 };
  return {
    db,
    mcp: new McpService(db, () => clock.now),
    agents: new AgentService(db, models, sessions),
    clock,
  };
}

const sqliteServer = {
  name: "sqlite",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-sqlite"],
  env: { DB_PATH: "test.db" },
};

/** The RPC boundary parses these; the service receives the defaults already applied. */
function serverInput(overrides: Record<string, unknown> = {}) {
  return McpServerCreateParams.parse({ ...sqliteServer, ...overrides });
}

describe("McpService", () => {
  it("creates a server with a generated id and decodes its JSON columns", () => {
    const { mcp } = setup();
    const created = mcp.create(serverInput());
    expect(created.id).toMatch(/^mcp-/);
    expect(created.name).toBe("sqlite");
    expect(created.args).toEqual(["-y", "@modelcontextprotocol/server-sqlite"]);
    expect(created.env).toEqual({ DB_PATH: "test.db" });
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toBe(1_000);
    expect(created.updatedAt).toBe(1_000);
  });

  it("lists servers by name and reads one back by id", () => {
    const { mcp } = setup();
    const first = mcp.create(serverInput({ name: "zeta" }));
    mcp.create(serverInput({ name: "alpha" }));
    expect(mcp.list().map((server) => server.name)).toEqual(["alpha", "zeta"]);
    expect(mcp.get(first.id)?.name).toBe("zeta");
    expect(mcp.get("mcp-missing")).toBeNull();
    expect(mcp.getByName("zeta")?.id).toBe(first.id);
  });

  it("applies only the supplied fields on update and bumps updatedAt", () => {
    const { mcp, clock } = setup();
    const created = mcp.create(serverInput());
    clock.now = 2_000;
    const updated = mcp.update({ id: created.id, enabled: false, args: ["server.js", "--verbose"] });
    expect(updated.enabled).toBe(false);
    expect(updated.args).toEqual(["server.js", "--verbose"]);
    expect(updated.command).toBe("npx");
    expect(updated.env).toEqual({ DB_PATH: "test.db" });
    expect(updated.updatedAt).toBe(2_000);
  });

  it("rejects a duplicate server name", () => {
    const { mcp } = setup();
    mcp.create(serverInput());
    expect(() => mcp.create(serverInput({ command: "other" }))).toThrow(/already exists/i);
  });

  it("reports a missing id on update instead of silently creating", () => {
    const { mcp } = setup();
    expect(() => mcp.update({ id: "mcp-missing", enabled: false })).toThrow(/not found/i);
  });

  it("deletes once and reports every later delete as false", () => {
    const { mcp } = setup();
    const created = mcp.create(serverInput());
    expect(mcp.delete(created.id)).toBe(true);
    expect(mcp.list()).toHaveLength(0);
    expect(mcp.delete(created.id)).toBe(false);
  });

  it("disables every server in one call", () => {
    const { mcp } = setup();
    mcp.create(serverInput());
    mcp.create(serverInput({ name: "git" }));
    mcp.setAllEnabled(false);
    expect(mcp.list().every((server) => !server.enabled)).toBe(true);
  });

  it("resolves the enabled servers bound to an agent", () => {
    const { mcp, agents } = setup();
    const sqlite = mcp.create(serverInput());
    const git = mcp.create(serverInput({ name: "git" }));
    mcp.create(serverInput({ name: "unbound" }));
    const agent = agents.create(AgentCreateParams.parse({ name: "Worker", mcpServerIds: [sqlite.id, git.id] }));
    expect(mcp.forAgent(agent.mcpServerIds).map((server) => server.name)).toEqual(["git", "sqlite"]);

    mcp.update({ id: git.id, enabled: false });
    expect(mcp.forAgent(agent.mcpServerIds).map((server) => server.name)).toEqual(["sqlite"]);
  });
});

describe("agent MCP bindings", () => {
  it("defaults a new agent to no MCP servers", () => {
    const { agents } = setup();
    const agent = agents.create(AgentCreateParams.parse({ name: "Worker" }));
    expect(agent.mcpServerIds).toEqual([]);
  });

  it("persists explicit bindings through create and update", () => {
    const { agents } = setup();
    const agent = agents.create(AgentCreateParams.parse({ name: "Worker", mcpServerIds: ["mcp-1"] }));
    expect(agent.mcpServerIds).toEqual(["mcp-1"]);

    const updated = agents.update({ id: agent.id, mcpServerIds: ["mcp-2", "mcp-3"] });
    expect(updated.mcpServerIds).toEqual(["mcp-2", "mcp-3"]);

    const cleared = agents.update({ id: agent.id, mcpServerIds: [] });
    expect(cleared.mcpServerIds).toEqual([]);
  });
});
