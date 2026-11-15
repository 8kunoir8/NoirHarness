import type Database from "better-sqlite3";

/**
 * The profile a chat that names no agent runs as. The id is fixed rather than looked up by name, so a
 * user who renames it keeps it: the default follows the row, not the word "Noir" reappearing later as
 * a second profile.
 */
export const DEFAULT_AGENT_ID = "default";
export const DEFAULT_AGENT_NAME = "Noir";
/** The catalog entry that is always present, so a fresh default profile names a role the user can pick. */
const DEFAULT_AGENT_ROLE = "Generalist";

/**
 * Creates the default profile once, at startup. Every chat that does not pick an agent then reuses one
 * row instead of minting a profile per chat, and `agent.list` can always name the id the picker
 * preselects. Ids are not derived from the name, so a "Noir" a user already created does not collide:
 * the name is only checked when this row is new.
 */
export function ensureDefaultAgent(db: Database.Database): void {
  const row = db.prepare("SELECT id FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID);
  if (row !== undefined) return;
  const taken = db
    .prepare("SELECT id FROM agents WHERE lower(name) = lower(?) AND archived_at IS NULL")
    .get(DEFAULT_AGENT_NAME);
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run(
    DEFAULT_AGENT_ID,
    taken === undefined ? DEFAULT_AGENT_NAME : `${DEFAULT_AGENT_NAME} (default)`,
    DEFAULT_AGENT_ROLE,
    "acp",
  );
}
