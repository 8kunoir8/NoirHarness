import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import type { ProjectService } from "./projects.js";

export interface WorkspaceRow { id: string; projectId: string; path: string; branch: string | null; kind: "local"; status: "ready"; }

export class WorkspaceService {
  constructor(private readonly db: Database.Database, private readonly projects: ProjectService) {}

  createLocal(projectId: string): WorkspaceRow {
    const project = this.projects.list().find((p) => p.id === projectId);
    if (!project) throw new RpcFault(ErrorCodes.notFound, "Project not found");
    // Two workspaces on one path would overwrite each other's flags and materialized artifacts.
    const existing = this.db.prepare("SELECT id FROM workspaces WHERE path = ?").get(project.rootPath) as
      | { id: string }
      | undefined;
    if (existing !== undefined) throw new RpcFault(ErrorCodes.conflict, "A workspace already exists for this path");
    const row: WorkspaceRow = { id: uuidv7(), projectId, path: project.rootPath, branch: null, kind: "local", status: "ready" };
    this.db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
      row.id, row.projectId, row.path, row.branch, row.kind, row.status, Date.now(),
    );
    return row;
  }

  list(): WorkspaceRow[] {
    return (this.db.prepare("SELECT id, project_id, path, branch, kind, status FROM workspaces ORDER BY created_at DESC").all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id as string, projectId: r.project_id as string, path: r.path as string, branch: (r.branch as string) ?? null, kind: r.kind as "local", status: r.status as "ready" }));
  }
}
