import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
