import { execFile } from "node:child_process";
import { mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type CheckpointView } from "@noir/protocol";
import type { EventStore } from "./eventStore.js";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const MAX_NOT_CAPTURED = 5_000;
const IDENTITY = ["-c", "user.name=NoirHarness", "-c", "user.email=checkpoints@noir.local"];

/**
 * Directories no restore should ever move. `.gitignore` cannot be trusted for this: a project that
 * keeps `node_modules` tracked would put hundreds of megabytes in the store on its first turn.
 */
const FORCED_EXCLUDES = [
  ".git/", "node_modules/", "dist/", "build/", "out/", "release/", "target/",
  ".next/", ".cache/", "vendor/", "coverage/",
];

export interface CaptureInput {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  turnId: string | null;
  seq: number;
  label?: "turn" | "pre-restore";
}

export interface CheckpointRow extends CheckpointView {
  workspaceId: string;
  workspaceRoot: string;
  treeSha: string | null;
  commitSha: string | null;
}

interface Row {
  id: string; workspace_id: string; session_id: string; turn_id: string | null; seq: number;
  tree_sha: string | null; commit_sha: string | null; label: string; created_at: number;
  not_captured: number; error: string | null; path: string;
}

export class CheckpointService {
  private readonly gitCommand: string;
  private healthCache: { checkpoints: "ok" | "unavailable"; checkpointReason?: string } | undefined;
  /** A store's config is written once per process: seven `git config` spawns per turn start is not free. */
  private readonly configured = new Map<string, string>();

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventStore,
    private readonly opts: { dataDir: string; gitCommand?: string },
  ) {
    this.gitCommand = opts.gitCommand ?? process.env.NOIR_GIT_COMMAND ?? "git";
  }

  entries(sessionId: string): CheckpointView[] {
    const ranges = this.events.rewoundRanges(sessionId);
    return this.rows(sessionId)
      // A checkpoint at the cut belongs to the turn the rewind abandoned. A pre-restore checkpoint
      // sits at the marker's own seq, which is `to`, and stays listed.
      .filter((row) => !ranges.some((range) => row.seq >= range.from && row.seq < range.to))
      .map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        seq: row.seq,
        createdAt: row.created_at,
        notCaptured: row.not_captured,
        label: row.label === "pre-restore" ? "pre-restore" : "turn",
        error: row.error,
      }));
  }

  async availability(workspaceId: string): Promise<{ available: boolean; reason?: string }> {
    const health = await this.health();
    if (health.checkpoints === "unavailable") {
      return { available: false, reason: health.checkpointReason ?? "not available" };
    }
    const row = this.db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as { path: string } | undefined;
    if (row === undefined) return { available: false, reason: "workspace missing" };
    try {
      await stat(row.path);
    } catch {
      return { available: false, reason: "workspace missing" };
    }
    const refusal = await this.refusal(row.path);
    return refusal === undefined ? { available: true } : { available: false, reason: refusal };
  }

  /** Cached: `system.health` is polled, and a missing binary does not appear mid-run. */
  async health(): Promise<{ checkpoints: "ok" | "unavailable"; checkpointReason?: string }> {
    if (this.healthCache !== undefined) return this.healthCache;
    try {
      await run(this.gitCommand, ["--version"], { timeout: 10_000, windowsHide: true });
      this.healthCache = { checkpoints: "ok" };
    } catch {
      this.healthCache = { checkpoints: "unavailable", checkpointReason: "git is not available" };
    }
    return this.healthCache;
  }

  async capture(input: CaptureInput): Promise<CheckpointRow> {
    const id = uuidv7();
    const label = input.label ?? "turn";
    const createdAt = Date.now();
    const failed = (error: string): CheckpointRow => {
      this.insert({ id, input, label, createdAt, treeSha: null, commitSha: null, notCaptured: 0, error });
      return this.row(input.sessionId, id);
    };
    const refusal = await this.refusal(input.workspaceRoot);
    if (refusal !== undefined) return failed(refusal);
    try {
      await this.ensureStore(input.workspaceId, input.workspaceRoot);
      await this.git(input.workspaceId, ["add", "-A", "--", "."]);
      const tree = (await this.git(input.workspaceId, ["write-tree"])).trim();
      const commit = (await this.git(input.workspaceId, ["commit-tree", tree, "-m", `checkpoint ${id}`])).trim();
      await this.git(input.workspaceId, ["update-ref", `refs/noir/${input.sessionId}/${id}`, commit]);
      const notCaptured = await this.countIgnored(input.workspaceId);
      this.insert({ id, input, label, createdAt, treeSha: tree, commitSha: commit, notCaptured, error: null });
      return this.row(input.sessionId, id);
    } catch (error) {
      return failed(error instanceof Error ? error.message : "checkpoint failed");
    }
  }

  row(sessionId: string, checkpointId: string): CheckpointRow {
    const row = this.db
      .prepare(
        `SELECT c.*, w.path FROM checkpoints c LEFT JOIN workspaces w ON w.id = c.workspace_id
           WHERE c.id = ? AND c.session_id = ?`,
      )
      .get(checkpointId, sessionId) as Row | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Checkpoint not found");
    return {
      id: row.id, turnId: row.turn_id, seq: row.seq, createdAt: row.created_at,
      notCaptured: row.not_captured, label: row.label === "pre-restore" ? "pre-restore" : "turn",
      error: row.error, workspaceId: row.workspace_id, workspaceRoot: row.path,
      treeSha: row.tree_sha, commitSha: row.commit_sha,
    };
  }

  /** Re-reads the work tree into the store's index. The stat cache makes this a delta, not a walk. */
  async refresh(row: CheckpointRow): Promise<void> {
    await this.ensureStore(row.workspaceId, row.workspaceRoot);
    await this.git(row.workspaceId, ["add", "-A", "--", "."]);
  }

  private rows(sessionId: string): Row[] {
    return this.db
      .prepare("SELECT c.*, w.path FROM checkpoints c LEFT JOIN workspaces w ON w.id = c.workspace_id WHERE c.session_id = ? ORDER BY c.created_at ASC, c.id ASC")
      .all(sessionId) as Row[];
  }

  private storeDir(workspaceId: string): string {
    return join(this.opts.dataDir, "checkpoints", workspaceId);
  }

  private async git(workspaceId: string, args: string[]): Promise<string> {
    const result = await run(this.gitCommand, [...IDENTITY, "-C", this.storeDir(workspaceId), ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  }

  /** One exclusion list per store: the forced excludes plus this workspace's data dir, if nested. */
  private async ensureStore(workspaceId: string, root: string): Promise<void> {
    const store = this.storeDir(workspaceId);
    const nested = relative(root, this.opts.dataDir);
    const ignore = join(store, "ignore");
    const fingerprint = `${root}\u0000${nested}\u0000${this.gitCommand}`;
    if (this.configured.get(workspaceId) === fingerprint) return;
    await mkdir(store, { recursive: true });
    try {
      await stat(join(store, ".git"));
    } catch {
      await run(this.gitCommand, ["init", "--quiet", store], { timeout: GIT_TIMEOUT_MS, windowsHide: true });
    }
    const hooks = join(store, "hooks-disabled");
    await mkdir(hooks, { recursive: true });
    // The store must never capture its own database or objects. `dataDir` is normally outside every
    // workspace, but a portable install can put it inside one, and then the first snapshot would
    // index the snapshot. `nested` is work-tree-relative, so `..` and `../x` are outside; `""` means
    // the data dir *is* the root, which no exclude can express and which `refusal` refuses.
    const self = nested === "" || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)
      ? []
      : [`/${nested.split(sep).join("/")}/`];
    await writeFile(ignore, `${[...FORCED_EXCLUDES, ...self].join("\n")}\n`, "utf8");
    const settings: Array<[string, string]> = [
      ["core.worktree", root],
      ["core.bare", "false"],
      // A restore must write the bytes it read; this machine has autocrlf=true globally.
      ["core.autocrlf", "false"],
      ["core.safecrlf", "false"],
      ["core.hooksPath", hooks],
      ["core.fsmonitor", "false"],
      ["core.excludesFile", ignore],
    ];
    for (const [key, value] of settings) await this.git(workspaceId, ["config", key, value]);
    this.configured.set(workspaceId, fingerprint);
  }

  /** Reasons a workspace is never snapshotted. Everything else is a per-turn error row. */
  private async refusal(root: string): Promise<string | undefined> {
    if (relative(root, this.opts.dataDir) === "") return "The workspace root is the checkpoint data directory";
    try {
      const attributes = await readFile(join(root, ".gitattributes"), "utf8");
      if (/filter\s*=\s*lfs/.test(attributes)) return "LFS worktrees are not supported";
    } catch {
      // No attributes file: nothing to refuse.
    }
    try {
      const stats = await statfs(this.opts.dataDir);
      if (Number(stats.bavail) * Number(stats.bsize) < MIN_FREE_BYTES) return "Not enough free space for a checkpoint";
    } catch {
      // No `statfs` on this platform: a snapshot is worth more than the space check.
    }
    return undefined;
  }

  private async countIgnored(workspaceId: string): Promise<number> {
    const out = await this.git(workspaceId, ["status", "--porcelain", "-z", "--ignored=traditional", "--untracked-files=all"]);
    let count = 0;
    for (const entry of out.split("\u0000")) if (entry.startsWith("!! ")) count += 1;
    return Math.min(count, MAX_NOT_CAPTURED);
  }

  private insert(args: {
    id: string;
    input: CaptureInput;
    label: "turn" | "pre-restore";
    createdAt: number;
    treeSha: string | null;
    commitSha: string | null;
    notCaptured: number;
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, workspace_id, session_id, turn_id, seq, tree_sha, commit_sha, label, created_at, not_captured, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        args.id, args.input.workspaceId, args.input.sessionId, args.input.turnId, args.input.seq,
        args.treeSha, args.commitSha, args.label, args.createdAt, args.notCaptured, args.error,
      );
  }
}
