import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import {
  ADAPTER_VERSION,
  createAcpEngine,
  type CreateAcpClientOptions,
} from "@noir/engine-acp";
import { ADAPTER_VERSION as NATIVE_ADAPTER_VERSION, createNativeEngine, reconstructHistory } from "@noir/engine-native";
import type {
  Engine,
  EngineHistoryMessage,
  EnginePermissionRequest,
  EnginePromptResult,
  EngineSession,
  EngineUpdate,
  PermissionDecision,
} from "@noir/engine-core";
import {
  ErrorCodes,
  PayloadSchemas,
  RpcFault,
  type EngineKind,
  type AgentEvent,
  type McpServerView,
  type PermissionOption,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionStatus,
  type ToolKind,
} from "@noir/protocol";
import type { AgentService } from "./agents.js";
import type { EventStore } from "./eventStore.js";
import { resolveModelFor, type EngineRegistryDeps } from "./engineRegistry.js";
import type { McpService } from "./mcp/service.js";
import { SessionMcpManager } from "./mcp/sessionMcp.js";
import type { ModelService } from "./models.js";
import { profileAgentDir, syncProfile } from "./profile.js";
import type { ProviderService } from "./providers.js";
import type { SessionService } from "./sessions.js";
import type { SkillScope, SkillService } from "./skills.js";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

const ENGINE_PROVENANCE: Record<EngineKind, { engineName: string; adapterVersion: string }> = {
  acp: { engineName: "omp", adapterVersion: ADAPTER_VERSION },
  native: { engineName: "native", adapterVersion: NATIVE_ADAPTER_VERSION },
};

/** What the session's engine stamps on the events the kernel appends for it. */
function provenanceFor(engine: EngineKind): { engine: EngineKind; engineName: string; adapterVersion: string } {
  switch (engine) {
    case "native":
      return { engine, ...ENGINE_PROVENANCE.native };
    default:
      return { engine: "acp", ...ENGINE_PROVENANCE.acp };
  }
}

const ENGINE_FACTORIES: Record<string, (options: CreateAcpClientOptions) => Engine> = {
  acp: (options) => createAcpEngine(options),
  native: () => createNativeEngine(),
};

/** Unknown values are possible: `sessions.engine` is persisted text, not a closed set at the DB layer. */
function engineFactory(engine: string): ((options: CreateAcpClientOptions) => Engine) | undefined {
  return ENGINE_FACTORIES[engine];
}

const sessionQuery = `
  SELECT s.id AS id, s.agent_id AS agent_id, s.status AS status, s.model_id AS model_id,
         s.engine AS engine, s.workspace_id AS workspace_id, w.path AS workspace_path
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  WHERE s.id = ?`;

const enabledModelQuery = `
  SELECT m.id AS id, p.name AS provider_name, m.model_id AS model_id
  FROM models m
  JOIN providers p ON p.id = m.provider_id
  WHERE m.enabled = 1 AND p.enabled = 1 AND m.id = ?`;

type PromptContent = Array<{ type: "text"; text: string }>;

interface SessionRow {
  id: string;
  agent_id: string;
  status: SessionStatus;
  model_id: string | null;
  engine: EngineKind;
  workspace_id: string;
  workspace_path: string;
}

interface QueuedTurn {
  turnId: string;
  idx: number;
  content: PromptContent;
}

interface TurnContext extends QueuedTurn {
  openMessages: Map<string, true>;
  nextMessageSeq: number;
  cancelRequested: boolean;
  /** Skills already attributed this turn, so a repeated read does not duplicate the event. */
  loadedSkills: Set<string>;
  /** Tool-call ids whose `tool.started` was a command, so the command projection can settle them. */
  commands: Set<string>;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  request: EnginePermissionRequest;
  timer: NodeJS.Timeout;
  resolve(decision: PermissionDecision): void;
}

interface SessionState {
  sessionId: string;
  agentId: string;
  /** The engine fixed at session creation; every event this manager appends for it is stamped with it. */
  engineKind: EngineKind;
  workspaceId: string;
  workspaceRoot: string;
  /** What `materialize` wrote for this workspace; empty when materialization failed. */
  skillIndex: Map<string, { scope: SkillScope; hash: string }>;
  engine: Engine | undefined;
  engineSession: EngineSession | undefined;
  /** The session's MCP servers; created with the engine and disposed with it. */
  mcp: SessionMcpManager | undefined;
  selector: string | undefined;
  turn: TurnContext | undefined;
  queue: QueuedTurn[];
  approvals: Map<string, PendingApproval>;
  usage: { size: number; used: number; costAmount?: number } | undefined;
  closing: boolean;
}

function parseArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NOIR_OMP_ARGS_JSON must be a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("NOIR_OMP_ARGS_JSON must be a JSON array of strings");
  }
  return parsed as string[];
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function promptText(content: SessionPromptParams["content"]): PromptContent {
  const blocks: PromptContent = [];
  for (const block of content) {
    if (block.type === "text") blocks.push({ type: "text", text: block.text });
  }
  if (blocks.length === 0) throw new RpcFault(ErrorCodes.invalidParams, "Prompt must contain at least one text block");
  return blocks;
}

function permissionCategory(
  kind: string | undefined,
): "shell" | "delete" | "rename" | "write-outside-workspace" | "network" | "mcp" {
  switch (kind) {
    case "mcp":
      return "mcp";
    case "execute":
      return "shell";
    case "delete":
      return "delete";
    case "move":
    case "rename":
      return "rename";
    case "fetch":
      return "network";
    default:
      return "write-outside-workspace";
  }
}

/** The real path of the deepest existing ancestor. Errors other than "nothing here" fail closed. */
async function existingRealPath(target: string): Promise<string | undefined> {
  let probe = target;
  for (;;) {
    try {
      return await realpath(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

/**
 * Whether a write target resolves inside the workspace. A link inside the workspace must not make
 * an outside target look inside, so the real path of the deepest existing ancestor is compared
 * too. Everything else fails closed: no path, a relative escape, an absolute path elsewhere, the
 * workspace root itself, a dangling or looping link, or a filesystem error.
 */
async function isInsideWorkspace(root: string, rawInput: unknown): Promise<boolean> {
  if (typeof rawInput !== "object" || rawInput === null) return false;
  const path = "path" in rawInput ? rawInput.path : undefined;
  if (typeof path !== "string" || path === "") return false;
  try {
    const realRoot = await realpath(root);
    const target = resolve(realRoot, path);
    const lexical = relative(realRoot, target);
    if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) return false;
    const real = await existingRealPath(target);
    if (real === undefined) return false;
    const realRelative = relative(realRoot, real);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) return false;
    // The workspace root as the deepest existing ancestor is only enough for a target that does
    // not exist yet; an existing target the realpath walk cannot resolve is a link, not a file.
    if (real !== realRoot) return true;
    try {
      await lstat(target);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch {
    return false;
  }
}

function protocolDecision(kind: EnginePermissionRequest["options"][number]["kind"]): PermissionDecision {
  switch (kind) {
    case "allow_once":
      return "allow_once";
    case "allow_always":
      return "allow_always";
    case "reject_always":
      return "reject_always";
    default:
      return "reject";
  }
}

function planStatus(status: string): "pending" | "active" | "done" {
  switch (status) {
    case "completed":
    case "done":
      return "done";
    case "in_progress":
    case "active":
      return "active";
    default:
      return "pending";
  }
}

/** Native's shell result appends the real exit code last; ACP's content does not, so a finished call is 0. */
function exitCodeFrom(text: string | undefined): number {
  const match = /(?:^|\n)exit code: (-?\d+)\s*$/.exec(text ?? "");
  const parsed = match?.[1] === undefined ? 0 : Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Filesystem failures a workspace normally produces when it cannot be written to. */
const WORKSPACE_WRITE_FAILURES: Record<string, true> = {
  EACCES: true,
  EPERM: true,
  EROFS: true,
  ENOSPC: true,
  ENOTDIR: true,
};

function isWorkspaceWriteFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && WORKSPACE_WRITE_FAILURES[error.code] === true;
}

/** `skill://<name>` and `skill://<name>/<subpath>` both name the skill. */
function skillNameFromRawInput(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("path" in raw) || typeof raw.path !== "string" || !raw.path.startsWith("skill://")) return undefined;
  // Skill names are URI-unreserved (`[A-Za-z0-9._-]`), so `%` never encodes and no percent-decoding
  // may be applied — a literal name is the name the manifest carries.
  const name = raw.path.slice("skill://".length).split(/[/?#]/, 1)[0] ?? "";
  return name === "" ? undefined : name;
}

/**
 * Native emits the kernel vocabulary directly; ACP emits its own (`execute`, `edit`, `fetch`, …).
 * The event schema carries the closed kernel set, never an engine's spelling.
 */
function officeToolKind(kind: string | undefined): ToolKind {
  switch (kind) {
    case "read":
    case "search":
    case "skill":
    case "write":
    case "shell":
      return kind;
    case "execute":
      return "shell";
    case "edit":
    case "delete":
    case "move":
      return "write";
    default:
      return "other";
  }
}

export class EngineManager {
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly dataDir: string;
  private readonly turnTimeoutMs: number;
  private readonly states = new Map<string, SessionState>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly closing = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly deps: {
      db: Database.Database;
      events: EventStore;
      sessions: SessionService;
      agents: AgentService;
      models: ModelService;
      providers: ProviderService;
      skills: SkillService;
      mcp: McpService;
      dataDir: string;
      ompCommand?: string;
      turnTimeoutMs?: number;
    },
  ) {
    this.command = deps.ompCommand ?? process.env.NOIR_OMP_COMMAND ?? "omp";
    this.baseArgs = parseArgs(process.env.NOIR_OMP_ARGS_JSON);
    this.dataDir = deps.dataDir;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? parseTimeout(process.env.NOIR_TURN_TIMEOUT_MS) ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  /** Child pid for a session, when an engine is live. Used by tests and diagnostics. */
  enginePid(sessionId: string): number | undefined {
    return this.states.get(sessionId)?.engineSession?.pid;
  }

  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (this.shuttingDown) throw new RpcFault(ErrorCodes.conflict, "Kernel is shutting down");
    if (this.closing.has(params.sessionId)) throw new RpcFault(ErrorCodes.conflict, "Session is closing");
    const row = this.loadSession(params.sessionId);
    if (row.status === "closed") throw new RpcFault(ErrorCodes.conflict, "Session is closed");

    const fresh = !this.states.has(params.sessionId);
    const state = this.stateFor(row);
    if (fresh) this.reconcile(state);

    const existing = this.deps.db
      .prepare("SELECT id, status FROM turns WHERE session_id = ? AND client_request_id = ?")
      .get(params.sessionId, params.requestId) as { id: string; status: string } | undefined;
    if (existing !== undefined) return { turnId: existing.id, queued: existing.status === "queued" };

    const content = promptText(params.content);
    const queued = this.deps.db
      .prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id = ?")
      .get(params.sessionId) as { count: number };
    const idx = queued.count + 1;
    const turnId = uuidv7();
    // Delivery is decided by the live turn, never by a persisted status a crashed kernel may have left behind.
    const immediate = state.turn === undefined;

    this.deps.db
      .prepare("INSERT INTO turns (id, session_id, idx, status, started_at, client_request_id) VALUES (?,?,?,?,?,?)")
      .run(turnId, params.sessionId, idx, immediate ? "running" : "queued", Date.now(), params.requestId);

    // The request id is unique per send and a retried prompt returned above, so this lands once.
    // Emitting before the turn starts keeps the prompt ahead of `turn.started` in seq order.
    this.emit(
      state,
      "message.delta",
      { messageId: params.requestId, role: "user", block: { type: "text", text: content.map((block) => block.text).join("\n") } },
      turnId,
    );
    this.emit(state, "message.completed", { messageId: params.requestId, status: "done" }, turnId);

    const turn: QueuedTurn = { turnId, idx, content };
    if (!immediate) {
      state.queue.push(turn);
      return { turnId, queued: true };
    }

    void this.startTurn(state, turn);
    return { turnId, queued: false };
  }

  async interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    const state = this.states.get(sessionId);
    if (state === undefined) return { interrupted: false };
    const turn = state.turn;
    if (turn !== undefined) {
      turn.cancelRequested = true;
      for (const approval of [...state.approvals.values()]) this.settleApproval(approval, "reject");
      try {
        await state.engineSession?.interrupt();
      } catch {
        // The engine may already be gone; the turn settles as failed in that case.
      }
    }
    // The queue survives an interrupt: a prompt the user queued while this turn ran still runs
    // once the engine settles. `cancelQueued` is the way to drop one.
    return { interrupted: turn !== undefined };
  }

  /**
   * Drops one turn that is still waiting in the queue. No event is emitted: the turn never
   * started, so a replay must not invent a failed or completed turn for it.
   */
  async cancelQueued(params: { sessionId: string; turnId: string }): Promise<{ cancelled: boolean }> {
    const state = this.states.get(params.sessionId);
    if (state === undefined) return { cancelled: false };
    const index = state.queue.findIndex((turn) => turn.turnId === params.turnId);
    if (index === -1) return { cancelled: false };
    state.queue.splice(index, 1);
    this.deps.db.prepare("DELETE FROM turns WHERE id = ?").run(params.turnId);
    return { cancelled: true };
  }

  async respond(approvalId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) {
      const row = this.deps.db.prepare("SELECT decision FROM approvals WHERE id = ?").get(approvalId) as
        | { decision: string | null }
        | undefined;
      if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Approval not found");
      throw new RpcFault(ErrorCodes.conflict, "Approval already decided");
    }
    this.settleApproval(pending, decision);
  }

  /**
   * Ends a session. `markClosed` is false for a shutdown: stopping the daemon must leave every
   * session where it was, so the next kernel reconciles it to `error` and the user resumes it —
   * only an explicit `session.close` makes a chat permanently closed.
   */
  async closeSession(sessionId: string, markClosed = true): Promise<void> {
    const exists = this.deps.db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
    if (exists === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");

    // Block concurrent prompts for the whole close, not just after the row is updated.
    this.closing.add(sessionId);
    try {
      const state = this.states.get(sessionId);
      if (state !== undefined) {
        state.closing = true;
        this.states.delete(sessionId);
        this.dropQueue(state, "interrupted");
        const turn = state.turn;
        state.turn = undefined;
        if (turn !== undefined) {
          for (const messageId of turn.openMessages.keys()) {
            this.emit(state, "message.completed", { messageId, status: "interrupted" }, turn.turnId);
          }
          this.emit(state, "turn.completed", { turnId: turn.turnId, status: "interrupted", stopReason: "closed" }, turn.turnId);
        }
        for (const approval of [...state.approvals.values()]) this.settleApproval(approval, "reject");
        if (state.engineSession !== undefined) {
          try {
            await state.engineSession.interrupt();
          } catch {
            // The engine may already be gone.
          }
        }
        // The engine and the MCP children it was started with go together: a closed session must
        // not leave a server process behind until the app quits.
        await this.disposeEngine(state);
      }

      // Re-read with no await in between: a concurrent close may have won the race.
      const current = this.deps.db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as
        | { status: SessionStatus }
        | undefined;
      if (markClosed && current !== undefined && current.status !== "closed") {
        this.deps.sessions.setStatus(sessionId, "closed");
      }
    } finally {
      this.closing.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const sessionIds = [...this.states.keys()];
    for (const sessionId of sessionIds) {
      try {
        await this.closeSession(sessionId, false);
      } catch {
        // Shutdown is best effort; every child is still disposed below.
      }
    }
    this.states.clear();
  }

  private loadSession(sessionId: string): SessionRow {
    const row = this.deps.db.prepare(sessionQuery).get(sessionId) as SessionRow | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    return row;
  }

  /** Fail turns/approvals a crashed kernel left behind; safe to call before replaying a session. */
  reconcileSession(sessionId: string): void {
    if (this.states.has(sessionId) || this.closing.has(sessionId)) return;
    const row = this.deps.db.prepare("SELECT id, agent_id, status, engine FROM sessions WHERE id = ?").get(sessionId) as
      | { id: string; agent_id: string; status: SessionStatus; engine: EngineKind }
      | undefined;
    if (row === undefined || row.status === "closed") return;
    this.reconcile({ sessionId: row.id, agentId: row.agent_id, engineKind: row.engine });
  }

  /** Fails sessions a previous kernel left active; the next prompt resumes them from `error`. */
  reconcileAll(): void {
    const rows = this.deps.db
      .prepare(
        `SELECT s.id, s.agent_id, s.engine FROM sessions s
         WHERE s.status IN ('starting','running','waiting')
           AND (s.status <> 'starting' OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id))
         ORDER BY s.created_at ASC`,
      )
      .all() as Array<{ id: string; agent_id: string; engine: EngineKind }>;
    for (const row of rows) {
      this.reconcile({ sessionId: row.id, agentId: row.agent_id, engineKind: row.engine });
      // A crashed mid-turn session stays `starting` until it accepted a turn; only then is the
      // stale `starting` a lie worth resolving. A session with no turn was never live.
      this.setStatus(row.id, "error", "kernel_restart");
    }
  }

  /**
   * First touch after a kernel restart: turns persisted as queued/running have no live engine
   * behind them, so fail them, resolve orphaned approvals, and release a stale status.
   */
  private reconcile(target: { sessionId: string; agentId: string; engineKind: EngineKind }): void {
    const approvals = this.deps.db
      .prepare("SELECT id FROM approvals WHERE session_id = ? AND decision IS NULL")
      .all(target.sessionId) as Array<{ id: string }>;
    for (const approval of approvals) {
      this.deps.db
        .prepare("UPDATE approvals SET decision = 'reject', decided_at = ? WHERE id = ? AND decision IS NULL")
        .run(Date.now(), approval.id);
      this.emit(target, "permission.resolved", { approvalId: approval.id, decision: "reject" });
    }

    const stale = this.deps.db
      .prepare("SELECT id FROM turns WHERE session_id = ? AND status IN ('queued','running') ORDER BY idx ASC")
      .all(target.sessionId) as Array<{ id: string }>;
    for (const turn of stale) {
      this.emit(target, "turn.failed", { turnId: turn.id, message: "Engine restarted" }, turn.id);
    }

    const row = this.deps.db.prepare("SELECT status FROM sessions WHERE id = ?").get(target.sessionId) as
      | { status: SessionStatus }
      | undefined;
    if (row !== undefined && (row.status === "running" || row.status === "waiting")) {
      this.setStatus(target.sessionId, "error", "kernel_restart");
    }
  }

  private stateFor(row: SessionRow): SessionState {
    const existing = this.states.get(row.id);
    if (existing !== undefined) return existing;
    const state: SessionState = {
      sessionId: row.id,
      agentId: row.agent_id,
      engineKind: row.engine,
      workspaceId: row.workspace_id,
      workspaceRoot: row.workspace_path,
      skillIndex: new Map(),
      engine: undefined,
      engineSession: undefined,
      mcp: undefined,
      selector: undefined,
      turn: undefined,
      queue: [],
      approvals: new Map(),
      usage: undefined,
      closing: false,
    };
    this.states.set(row.id, state);
    return state;
  }

  private selectorFor(sessionId: string): string {
    const row = this.deps.db.prepare("SELECT model_id FROM sessions WHERE id = ?").get(sessionId) as
      | { model_id: string | null }
      | undefined;
    if (row === undefined) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    if (row.model_id !== null) {
      const model = this.deps.db.prepare(enabledModelQuery).get(row.model_id) as
        | { id: string; provider_name: string; model_id: string }
        | undefined;
      if (model === undefined) throw new RpcFault(ErrorCodes.conflict, "The session model is disabled or missing");
      return `${model.provider_name}/${model.model_id}`;
    }
    const fallback = this.deps.models.defaultModel();
    if (fallback === undefined) throw new RpcFault(ErrorCodes.conflict, "No enabled model is available for this session");
    return `${fallback.providerName}/${fallback.modelId}`;
  }

  private get registryDeps(): EngineRegistryDeps {
    return { db: this.deps.db, providers: this.deps.providers, models: this.deps.models };
  }

  private async ensureEngine(state: SessionState, currentTurnId: string): Promise<EngineSession> {
    if (state.engineSession !== undefined) return state.engineSession;
    const selector = this.selectorFor(state.sessionId);
    await syncProfile({
      providers: this.deps.providers,
      models: this.deps.models,
      dataDir: this.dataDir,
    });

    // Materialization is a filesystem write, so an unwritable workspace must not gate the engine:
    // a read-only workspace still has to answer chat. Any other failure is a real fault and
    // surfaces from the turn rather than being hidden.
    try {
      await this.deps.skills.materialize(state.workspaceId, state.workspaceRoot);
    } catch (error) {
      if (!isWorkspaceWriteFailure(error)) throw error;
      // Keep whatever the last turn read; a fresh state simply has nothing yet.
    }

    const args = [
      ...this.baseArgs,
      "--session-dir",
      join(state.workspaceRoot, ".noir", "sessions"),
      "--model",
      selector,
      "acp",
    ];
    const factory = engineFactory(state.engineKind);
    if (factory === undefined) throw new RpcFault(ErrorCodes.conflict, `Unknown engine: ${state.engineKind}`);
    const engine = factory({
      command: this.command,
      args,
      cwd: state.workspaceRoot,
      // PI_CODING_AGENT_DIR makes omp read and write only NoirHarness's own agent directory.
      env: { PI_CODING_AGENT_DIR: profileAgentDir(this.dataDir) },
      turnTimeoutMs: this.turnTimeoutMs,
    });
    state.engine = engine;
    try {
      const resolved = resolveModelFor(state.sessionId, this.registryDeps);
      const { baseUrl, apiKey, ...model } = resolved;
      // The enabled set materialization just wrote; the engine names these in its prompt.
      const listed = await this.deps.skills.list(state.workspaceId, state.workspaceRoot);
      const skills = listed.skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({ name: skill.name, scope: skill.scope, description: skill.description }));
      // Replay only turns with a lifecycle: the prompt of the in-flight turn (persisted before
      // this spawn) and of queued turns is not history. A turn that reached a terminal event
      // still is, even when its spawn failed before `turn.started` — the UI shows its prompt.
      let history: EngineHistoryMessage[] = [];
      if (state.engineKind === "native") {
        const log = this.deps.events.list(state.sessionId, 0);
        const replayedTurns = new Set<string>();
        for (const event of log) {
          if (event.turnId === null || event.turnId === undefined) continue;
          if (
            event.type === "turn.started" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed"
          ) {
            replayedTurns.add(event.turnId);
          }
        }
        const { messages, trimmedTurns } = reconstructHistory(
          log.filter(
            (event) =>
              event.turnId !== null &&
              event.turnId !== undefined &&
              event.turnId !== currentTurnId &&
              replayedTurns.has(event.turnId),
          ),
          model,
        );
        history = messages;
        // Spec §8: a trimmed replay is visible in the log, never in the UI.
        if (trimmedTurns > 0) this.emit(state, "engine.raw", { engine: "native", payload: { trimmedTurns } });
      }
      // The profile's bindings are read once per engine start: enabling a server mid-session
      // would change the tool list the provider was already told about.
      const bound = this.boundMcpServers(state);
      // Only the native engine gets the kernel's own clients; an ACP agent spawns the servers from
      // `session/new`, so spawning them here too would run every server twice.
      const sessionMcp =
        state.engineKind === "native" && bound.length > 0
          ? new SessionMcpManager(bound, state.workspaceRoot)
          : undefined;
      if (sessionMcp !== undefined) {
        await sessionMcp.initialize();
        state.mcp = sessionMcp;
        for (const warning of sessionMcp.warnings) {
          this.emit(state, "engine.raw", { engine: "mcp", payload: { warning } }, currentTurnId);
        }
      }
      // `selector` is deliberately left unset: `start()` does not apply `EngineStartOptions.model`
      // for ACP, so the first turn's model branch applies it through `setModel`.
      state.engineSession = await engine.start({
        sessionId: state.sessionId,
        cwd: state.workspaceRoot,
        model,
        baseUrl,
        apiKey,
        // ACP reconstructs nothing from the log; only the native engine replays the conversation.
        history,
        skills,
        turnTimeoutMs: this.turnTimeoutMs,
        // ACP needs the server list; the native engine needs the aggregate plus the call bridge.
        ...(bound.length === 0
          ? {}
          : {
              mcpServers: bound.map((server) => ({
                name: server.name,
                command: server.command,
                args: server.args,
                env: server.env,
              })),
            }),
        ...(sessionMcp === undefined
          ? {}
          : {
              mcpTools: sessionMcp.tools,
              callMcpTool: (name: string, args: Record<string, unknown>) => sessionMcp.executeTool(name, args),
            }),
      });
    } catch (error) {
      state.engine = undefined;
      throw error;
    }
    return state.engineSession;
  }

  private async startTurn(state: SessionState, turn: QueuedTurn): Promise<void> {
    const context: TurnContext = {
      ...turn,
      openMessages: new Map(),
      nextMessageSeq: 0,
      cancelRequested: false,
      loadedSkills: new Set(),
      commands: new Set(),
    };
    state.turn = context;
    state.usage = undefined;
    try {
      const engineSession = await this.ensureEngine(state, context.turnId);
      if (state.closing) {
        // The session closed while the engine was spawning: reap it and stay silent.
        state.turn = undefined;
        await this.disposeEngine(state);
        return;
      }
      if (context.cancelRequested) {
        this.emit(state, "turn.failed", { turnId: context.turnId, message: "interrupted" }, context.turnId);
        state.turn = undefined;
        state.usage = undefined;
        this.setStatus(state.sessionId, "idle");
        this.drain(state);
        return;
      }
      const selector = this.selectorFor(state.sessionId);
      if (state.selector !== selector) {
        const { providerName, modelId, contextWindow, maxTokens } = resolveModelFor(state.sessionId, this.registryDeps);
        await engineSession.setModel?.({ providerName, modelId, contextWindow, maxTokens });
        state.selector = selector;
      }
      // Materialization only writes at spawn, but the index must follow toggles and sibling
      // materializations: read it right before the turn so this tool call set is attributed
      // against the manifest the engine can actually see now, not the one from spawn time.
      state.skillIndex = await this.deps.skills.manifestFor(state.workspaceRoot);
      this.setStatus(state.sessionId, "running");
      this.emit(state, "turn.started", { turnId: turn.turnId, index: turn.idx }, turn.turnId);
      const result = await engineSession.prompt(turn.content, {
        onUpdate: (update) => this.handleUpdate(state, context, update),
        onPermission: (request) => this.handlePermission(state, context, request),
        onSkillRead: (name) => this.attributeSkill(state, context, name),
      });
      this.finishTurn(state, context, result);
    } catch (error) {
      this.failTurn(state, context, error);
    }
  }

  private finishTurn(state: SessionState, turn: TurnContext, result: EnginePromptResult): void {
    if (state.closing) return;
    // Clear the turn first: settling a straggling approval must not flip a finished turn back to running.
    state.turn = undefined;
    for (const approval of [...state.approvals.values()]) this.settleApproval(approval, "reject");
    const interrupted = result.stopReason === "cancelled" || result.timedOut;
    const messageStatus = interrupted ? "interrupted" : "done";
    for (const messageId of turn.openMessages.keys()) {
      this.emit(state, "message.completed", { messageId, status: messageStatus }, turn.turnId);
    }
    if (result.usage !== undefined || state.usage !== undefined) {
      // An engine that reports usage only on its result still gets a real meter: prefer its
      // prompt count and the model's window instead of publishing a zero-sized context.
      let contextWindow = state.usage?.size ?? 0;
      if (contextWindow === 0) {
        try {
          contextWindow = resolveModelFor(state.sessionId, this.registryDeps).contextWindow;
        } catch {
          // The model may have been disabled mid-turn; the tokens the engine reported still stand.
        }
      }
      this.emit(
        state,
        "usage.updated",
        {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          contextUsed: state.usage?.used ?? result.usage?.inputTokens ?? 0,
          contextWindow,
          costUsd: state.usage?.costAmount ?? 0,
        },
        turn.turnId,
      );
    }
    this.emit(
      state,
      "turn.completed",
      { turnId: turn.turnId, status: interrupted ? "interrupted" : "completed", stopReason: result.stopReason },
      turn.turnId,
    );
    this.setStatus(state.sessionId, "idle");
    this.drain(state);
  }

  private failTurn(state: SessionState, turn: TurnContext, error: unknown): void {
    if (state.closing) return;
    this.emit(state, "turn.failed", { turnId: turn.turnId, message: error instanceof Error ? error.message : "Engine failed" }, turn.turnId);
    state.turn = undefined;
    for (const approval of [...state.approvals.values()]) this.settleApproval(approval, "reject");
    this.setStatus(state.sessionId, "error");
    this.dropQueue(state, "Engine failed");
    void this.disposeEngine(state);
  }

  private drain(state: SessionState): void {
    if (state.closing || state.turn !== undefined) return;
    const next = state.queue.shift();
    if (next === undefined) return;
    void this.startTurn(state, next);
  }

  private dropQueue(state: SessionState, message: string): void {
    const dropped = state.queue.splice(0);
    for (const turn of dropped) {
      this.emit(state, "turn.failed", { turnId: turn.turnId, message }, turn.turnId);
      this.deps.db.prepare("DELETE FROM turns WHERE id = ?").run(turn.turnId);
    }
  }

  private async disposeEngine(state: SessionState): Promise<void> {
    const session = state.engineSession;
    const mcp = state.mcp;
    state.engine = undefined;
    state.engineSession = undefined;
    state.mcp = undefined;
    state.selector = undefined;
    // The session's MCP processes die with its engine, whichever of the two is still running.
    if (mcp !== undefined) {
      try {
        await mcp.dispose();
      } catch {
        // Already gone.
      }
    }
    if (session === undefined) return;
    try {
      await session.dispose();
    } catch {
      // Already gone.
    }
  }

  private setStatus(sessionId: string, status: SessionStatus, reason?: string): void {
    const row = this.deps.db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as
      | { status: SessionStatus }
      | undefined;
    if (row === undefined || row.status === status) return;
    if (row.status === "closed") return;
    this.deps.sessions.setStatus(sessionId, status, reason === undefined ? undefined : { reason });
  }

  private emit(
    target: { sessionId: string; agentId: string; engineKind: EngineKind },
    type: Parameters<EventStore["append"]>[0]["type"],
    payload: unknown,
    turnId?: string,
  ): AgentEvent {
    return this.deps.events.append({
      sessionId: target.sessionId,
      agentId: target.agentId,
      type,
      payload,
      turnId: turnId ?? null,
      provenance: provenanceFor(target.engineKind),
    });
  }

  /**
   * One `skill.loaded` per skill per turn, and only for a skill the manifest still lists: a
   * disabled or unreadable skill is never attributed.
   */
  private attributeSkill(state: SessionState, turn: TurnContext, name: string): void {
    if (state.closing) return;
    const meta = state.skillIndex.get(name);
    if (meta === undefined || turn.loadedSkills.has(name)) return;
    turn.loadedSkills.add(name);
    this.emit(state, "skill.loaded", { name, scope: meta.scope, hash: meta.hash }, turn.turnId);
  }

  private handleUpdate(state: SessionState, turn: TurnContext, update: EngineUpdate): void {
    if (state.closing) return;
    switch (update.kind) {
      case "message": {
        const messageId = update.messageId !== "" ? update.messageId : `${turn.turnId}-m${turn.nextMessageSeq++}`;
        turn.openMessages.set(messageId, true);
        this.emit(
          state,
          "message.delta",
          {
            messageId,
            role: "assistant",
            block: update.reasoning ? { type: "reasoning", text: update.text } : { type: "text", text: update.text },
          },
          turn.turnId,
        );
        return;
      }
      case "tool.started": {
        this.emit(
          state,
          "tool.started",
          {
            toolCallId: update.toolCallId,
            title: update.title,
            ...(update.toolKind === undefined ? {} : { kind: officeToolKind(update.toolKind) }),
            ...(update.toolName === undefined ? {} : { toolName: update.toolName }),
            ...(update.argumentsJson === undefined ? {} : { argumentsJson: update.argumentsJson }),
          },
          turn.turnId,
        );
        // ACP reads skills through a `skill://` path; an engine that reads by name reports it via
        // `onSkillRead`. Both land in the same per-turn dedupe set.
        const skillName = skillNameFromRawInput(update.rawInput);
        if (skillName !== undefined) this.attributeSkill(state, turn, skillName);
        // Native names this kind `shell`; ACP names it `execute`. Both are the command projection.
        if (update.toolKind === "execute" || update.toolKind === "shell") {
          turn.commands.add(update.toolCallId);
          const raw = update.rawInput;
          const command =
            typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).command === "string"
              ? ((raw as Record<string, unknown>).command as string)
              : update.title;
          this.emit(state, "command.started", { commandId: update.toolCallId, command }, turn.turnId);
        }
        return;
      }
      case "tool.updated": {
        if (update.status === "completed") {
          // The final tool_call_update carries the whole content snapshot; the UI appends it to the card.
          if (update.text !== undefined && update.text !== "") {
            this.emit(state, "tool.output", { toolCallId: update.toolCallId, chunk: update.text }, turn.turnId);
            if (turn.commands.has(update.toolCallId)) {
              this.emit(state, "command.output", { commandId: update.toolCallId, chunk: update.text }, turn.turnId);
            }
          }
          this.emit(state, "tool.completed", { toolCallId: update.toolCallId, status: update.status }, turn.turnId);
          if (turn.commands.has(update.toolCallId)) {
            this.emit(
              state,
              "command.completed",
              { commandId: update.toolCallId, exitCode: exitCodeFrom(update.text) },
              turn.turnId,
            );
          }
        } else if (update.status === "failed") {
          this.emit(state, "tool.failed", { toolCallId: update.toolCallId, message: update.text ?? update.status }, turn.turnId);
        }
        return;
      }
      case "usage": {
        state.usage = {
          size: update.size,
          used: update.used,
          ...(update.costAmount === undefined ? {} : { costAmount: update.costAmount }),
        };
        return;
      }
      case "plan": {
        this.emit(
          state,
          "plan.updated",
          { items: update.entries.map((entry) => ({ text: entry.content, status: planStatus(entry.status) })) },
          turn.turnId,
        );
        return;
      }
      case "title": {
        this.emit(state, "session.updated", { title: update.title }, turn.turnId);
        return;
      }
      case "raw": {
        this.emit(
          state,
          "engine.raw",
          { engine: provenanceFor(state.engineKind).engineName, payload: update.update },
          turn.turnId,
        );
        return;
      }
    }
  }

  private async handlePermission(
    state: SessionState,
    turn: TurnContext,
    request: EnginePermissionRequest,
  ): Promise<PermissionDecision> {
    if (state.closing) return "reject";

    const category = permissionCategory(request.toolCall.kind);
    // The policy lives in the session snapshot, so editing an agent profile cannot change a
    // running session. Anything outside the vocabulary reads as `ask`, never as a silent decision.
    const stored = this.deps.sessions.snapshot(state.sessionId).permissionPolicy?.[category];
    const configured = stored === "allow" || stored === "reject" ? stored : "ask";
    // A write the kernel cannot prove inside the workspace always asks, even if it is allowed.
    const forcedAsk = category === "write-outside-workspace" && !(await isInsideWorkspace(state.workspaceRoot, request.toolCall.rawInput));
    // Containment awaits the filesystem, so the session may have closed while it ran; the sync
    // check above is stale now and a late event or approval row would outlive the close.
    if (state.closing) return "reject";
    const effective = forcedAsk ? "ask" : configured;
    const title = request.toolCall.title !== "" ? request.toolCall.title : "Permission required";
    if (effective !== "ask") {
      const decision: PermissionDecision = effective === "allow" ? "allow_once" : "reject";
      this.emit(state, "permission.auto", { category, title, decision }, turn.turnId);
      return decision;
    }

    const approvalId = uuidv7();
    const options: PermissionOption[] = request.options
      .filter((option) => option.optionId !== "")
      .map((option) => ({
        optionId: option.optionId,
        name: option.name !== "" ? option.name : option.optionId,
        kind: protocolDecision(option.kind),
      }));
    const effectiveOptions: PermissionOption[] =
      options.length > 0 ? options : [{ optionId: "reject", name: "Reject", kind: "reject" }];

    const payload = {
      approvalId,
      category,
      title,
      options: effectiveOptions,
    };
    const event = this.emit(state, "permission.requested", payload, turn.turnId);
    // The store validated and redacted the payload; project what it persisted so the approvals
    // row cannot keep a secret the event stream dropped.
    const persisted = PayloadSchemas["permission.requested"].parse(event.payload);
    this.deps.db
      .prepare("INSERT INTO approvals (id, session_id, event_id, kind, payload_json, options_json) VALUES (?,?,?,?,?,?)")
      .run(approvalId, state.sessionId, event.id, persisted.category, JSON.stringify(persisted), JSON.stringify(persisted.options));

    this.setStatus(state.sessionId, "waiting");

    let resolveDecision: (decision: PermissionDecision) => void = () => undefined;
    const promise = new Promise<PermissionDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const pending: PendingApproval = {
      approvalId,
      sessionId: state.sessionId,
      request,
      timer: setTimeout(() => {
        this.settleApproval(pending, "reject");
      }, this.turnTimeoutMs),
      resolve: resolveDecision,
    };
    state.approvals.set(approvalId, pending);
    this.approvals.set(approvalId, pending);
    return promise;
  }

  /** Resolve a pending approval exactly once: engine promise, DB row, event, session status. */
  private settleApproval(pending: PendingApproval, decision: PermissionDecision): void {
    if (this.approvals.get(pending.approvalId) !== pending) return;
    this.approvals.delete(pending.approvalId);
    clearTimeout(pending.timer);

    const state = this.states.get(pending.sessionId);
    state?.approvals.delete(pending.approvalId);

    this.deps.db
      .prepare("UPDATE approvals SET decision = ?, decided_at = ? WHERE id = ?")
      .run(decision, Date.now(), pending.approvalId);
    const session = this.deps.db.prepare("SELECT agent_id, engine FROM sessions WHERE id = ?").get(pending.sessionId) as
      | { agent_id: string; engine: EngineKind }
      | undefined;
    if (session !== undefined) {
      this.deps.events.append({
        sessionId: pending.sessionId,
        agentId: session.agent_id,
        type: "permission.resolved",
        payload: { approvalId: pending.approvalId, decision },
        provenance: provenanceFor(session.engine),
      });
    }
    if (state !== undefined && state.turn !== undefined) this.setStatus(state.sessionId, "running");
    pending.resolve(decision);
  }

  /**
   * The servers this session may run. The native broker keeps them under `mcp: reject` because its
   * own approval gate answers every call with a denial (spec §4.1). An ACP agent has no such gate
   * here — it spawns whatever it is given and answers its own approvals — so the list itself is
   * withheld, otherwise the policy would only be a label.
   */
  private boundMcpServers(state: SessionState): McpServerView[] {
    const policy = this.deps.sessions.snapshot(state.sessionId).permissionPolicy?.mcp;
    if (state.engineKind !== "native" && policy === "reject") return [];
    return this.deps.mcp.forAgent(this.deps.agents.view(state.agentId).mcpServerIds);
  }
}
