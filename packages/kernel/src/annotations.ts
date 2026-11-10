import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { relativePath } from "./fsPaths.js";
import { gitDiff } from "./gitService.js";

export interface AnnotationRow {
  id: string;
  line: number;
  note: string;
  createdAt: number;
  stale: boolean;
}

/** Lists notes for a path, deriving each one's `stale` flag from its stored hash vs the current diff. */
export async function listAnnotations(
  db: Database.Database,
  root: string,
  workspaceId: string,
  path: string,
): Promise<{ diffHash: string; annotations: AnnotationRow[] }> {
  // An unchanged, clean or non-repo workspace has an empty diff; hashing it is what makes every
  // stored note report `stale` instead of the call failing.
  const rel = relativePath(path);
  const diffHash = createHash("sha256").update(await gitDiff(root, rel)).digest("hex");
  const rows = db
    .prepare(
      "SELECT id, line, note, diff_hash, created_at FROM annotations WHERE workspace_id = ? AND path = ? ORDER BY line, created_at",
    )
    .all(workspaceId, rel) as Array<Record<string, unknown>>;
  return {
    diffHash,
    annotations: rows.map((row) => ({
      id: row.id as string,
      line: row.line as number,
      note: row.note as string,
      createdAt: row.created_at as number,
      stale: (row.diff_hash as string) !== diffHash,
    })),
  };
}

export async function addAnnotation(
  db: Database.Database,
  root: string,
  params: { workspaceId: string; path: string; line: number; note: string },
): Promise<AnnotationRow> {
  const rel = relativePath(params.path);
  const diff = await gitDiff(root, rel);
  if (diff === "") throw new RpcFault(ErrorCodes.invalidParams, `${rel} has no diff to annotate`);
  const note = params.note.trim();
  if (note === "") throw new RpcFault(ErrorCodes.invalidParams, "Annotation note cannot be empty");
  const row: AnnotationRow = {
    id: uuidv7(),
    line: params.line,
    note,
    createdAt: Date.now(),
    stale: false,
  };
  db.prepare(
    "INSERT INTO annotations (id, workspace_id, path, line, note, diff_hash, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(row.id, params.workspaceId, rel, row.line, row.note, createHash("sha256").update(diff).digest("hex"), row.createdAt);
  return row;
}

export function deleteAnnotation(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
}
