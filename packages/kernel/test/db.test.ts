import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MIGRATIONS } from "../src/migrations.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir db "));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("openDb", () => {
  it("creates the schema and is idempotent", () => {
    const file = join(tempDir(), "noir.db");
    const db = openDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
    expect(tables).toEqual(expect.arrayContaining(["events", "sessions", "providers", "models", "projects", "workspaces", "schema_migrations"]));
    db.close();

    const again = openDb(file);
    const applied = again.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get() as number;
    expect(applied).toBe(MIGRATIONS.length);
    again.close();
  });

  it("upgrades a migration-1 database in place and keeps its rows", () => {
    const file = join(tempDir(), "noir.db");
    const legacy = new Database(file);
    legacy.pragma("journal_mode = WAL");
    legacy.pragma("foreign_keys = ON");
    legacy.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    legacy.exec(MIGRATIONS[0]!.sql);
    legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (1, ?)").run(Date.now());
    legacy.exec(`
      INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'P', '/tmp/p1', 1);
      INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES ('w1', 'p1', '/tmp/p1', NULL, 'local', 'ready', 1);
      INSERT INTO agents (id, name, role, engine_id) VALUES ('a1', 'A', 'default', 'acp');
      INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('s1', 'w1', 'a1', 'acp', 'idle', 1);
      INSERT INTO providers (id, name, base_url, api_kind, api_key_ref, enabled, created_at) VALUES ('pr1', 'Local', 'http://x/v1', 'openai-completions', 'pr1', 1, 1);
    `);
    legacy.close();

    const db = openDb(file);
    const applied = db.prepare("SELECT id FROM schema_migrations ORDER BY id").pluck().all() as number[];
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(db.prepare("SELECT status FROM sessions WHERE id = 's1'").pluck().get()).toBe("idle");
    expect(db.prepare("SELECT name FROM providers WHERE id = 'pr1'").pluck().get()).toBe("Local");

    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns("sessions")).toContain("model_id");
    expect(columns("turns")).toContain("client_request_id");
    expect(columns("approvals")).toContain("options_json");
    expect(columns("models")).toContain("created_at");
    expect(columns("models")).toContain("engine");
    expect(columns("agents")).toContain("default_workspace_id");
    expect(columns("agents")).toContain("archived_at");
    expect(columns("agents")).toContain("created_at");
    expect(columns("agents")).toContain("mcp_server_ids");
    expect(columns("mcp_servers")).toContain("args_json");
    db.close();
  });
});
