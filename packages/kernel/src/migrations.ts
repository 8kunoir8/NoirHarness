import type Database from "better-sqlite3";

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, branch TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine_id TEXT NOT NULL,
        model_ref TEXT, skill_ids TEXT NOT NULL DEFAULT '[]', permission_policy TEXT NOT NULL DEFAULT '{}',
        parent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id), engine TEXT NOT NULL, engine_session_ref TEXT,
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, config_snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, closed_at INTEGER
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, usage_json TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, agent_id TEXT NOT NULL,
        parent_agent_id TEXT, turn_id TEXT, payload_json TEXT NOT NULL, blob_ref TEXT,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (session_id, seq)
      );
      CREATE TABLE file_changes (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT, path TEXT NOT NULL, change TEXT NOT NULL, "add" INTEGER NOT NULL, del INTEGER NOT NULL,
        diff_blob TEXT, applied_at INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, decision TEXT, decided_at INTEGER
      );
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (scope, name)
      );
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_kind TEXT NOT NULL,
        api_key_ref TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL, display_name TEXT NOT NULL, context_window INTEGER, max_tokens INTEGER,
        caps_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (provider_id, model_id)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `,
  },
  {
    id: 2,
    sql: `
      ALTER TABLE sessions ADD COLUMN model_id TEXT REFERENCES models(id) ON DELETE SET NULL;
      ALTER TABLE turns ADD COLUMN client_request_id TEXT;
      CREATE UNIQUE INDEX idx_turns_request
        ON turns(session_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      ALTER TABLE approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE models ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        note TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX annotations_lookup ON annotations (workspace_id, path);
    `,
  },
  {
    id: 4,
    sql: `
      DROP TABLE skills;
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        dir TEXT NOT NULL,
        hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE (workspace_id, scope, name)
      );
    `,
  },
  {
    id: 5,
    sql: `
      ALTER TABLE models ADD COLUMN engine TEXT NOT NULL DEFAULT 'acp';
      CREATE INDEX idx_models_engine ON models(engine);
    `,
  },
];

export function migrate(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").pluck().all() as number[]);
  const run = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    }
  });
  run();
}
