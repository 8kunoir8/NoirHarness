import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault } from "@noir/protocol";

export interface ProjectRow { id: string; name: string; rootPath: string; createdAt: number; }

export class ProjectService {
  constructor(private readonly db: Database.Database) {}

  add(rootPath: string): ProjectRow {
    const abs = resolve(rootPath);
    let stat;
    try { stat = statSync(abs); } catch { throw new RpcFault(ErrorCodes.invalidParams, `Path does not exist: ${abs}`); }
    if (!stat.isDirectory()) throw new RpcFault(ErrorCodes.invalidParams, `Not a directory: ${abs}`);
    const existing = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(abs);
    if (existing) throw new RpcFault(ErrorCodes.conflict, "Project already added");

    const row: ProjectRow = { id: uuidv7(), name: basename(abs) || abs, rootPath: abs, createdAt: Date.now() };
    this.db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)").run(row.id, row.name, row.rootPath, row.createdAt);
    return row;
  }

  list(): ProjectRow[] {
    return (this.db.prepare("SELECT id, name, root_path, created_at FROM projects ORDER BY created_at DESC").all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id as string, name: r.name as string, rootPath: r.root_path as string, createdAt: r.created_at as number }));
  }
}
