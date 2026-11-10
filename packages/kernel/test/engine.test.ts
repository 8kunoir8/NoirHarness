import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  AgentEvent,
  EventNotificationParams,
  PayloadSchemas,
  reduceSession,
  SessionPromptResult,
  type EventType,
  type SessionState,
} from "@noir/protocol";
import { openDb } from "../src/db.js";
import { EngineManager } from "../src/engineManager.js";
import { EventStore } from "../src/eventStore.js";
import { startKernel, type Kernel } from "../src/index.js";
import { ModelService } from "../src/models.js";
import { profileAgentDir } from "../src/profile.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
import { SessionService } from "../src/sessions.js";
import { WorkspaceService } from "../src/workspaces.js";

const FAKE_SERVER = fileURLToPath(new URL("../../engines/acp/test/fakeAcpServer.ts", import.meta.url));
const SECRET = "sk-noir-secret-4e1f";
const TEST_TIMEOUT_MS = 30_000;

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const managers: EngineManager[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir engine ünïcode "));
  dirs.push(dir);
  return dir;
}

function memorySecrets(): Secrets {
  const store = new Map<string, string>();
  return {
    set: (id, value) => void store.set(id, value),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

// Integration tests drive real child processes; polling their persisted state is the only
// completion signal the engine manager exposes outside the event stream.
async function tick(ms = 20): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  setTimeout(deferred.resolve, ms);
  await deferred.promise;
}

async function waitForEvent(
  events: EventStore,
  sessionId: string,
  predicate: (event: AgentEvent) => boolean,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<AgentEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.list(sessionId).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a session event");
    await tick();
  }
}

function setup(opts: { turnTimeoutMs?: number; acpArgs?: string[] } = {}) {
  const root = tempDir();
  const dataDir = tempDir();
  const db = openDb(join(dataDir, "noir.db"));
  dbs.push(db);
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  const providers = new ProviderService(db, memorySecrets());
  const models = new ModelService(db);

  const project = projects.add(root);
  const workspace = workspaces.createLocal(project.id);
  const provider = providers.create({
    name: "Fake",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKind: "openai-completions",
    apiKey: SECRET,
    enabled: true,
  });
  const model = models.create({ providerId: provider.id, modelId: "fake-1", contextWindow: 200_000, enabled: true });
  const session = sessions.create(workspace.id, model.id);

  // The manager parses its launch argv at construction time.
  process.env.NOIR_OMP_ARGS_JSON = JSON.stringify(opts.acpArgs ?? [FAKE_SERVER]);
  const manager = new EngineManager({
    db,
    events,
    sessions,
    models,
    providers,
    dataDir,
    ompCommand: process.execPath,
    ...(opts.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.turnTimeoutMs }),
  });
  return { db, events, sessions, providers, models, manager, session, dataDir, root };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Payload<T extends EventType> = z.infer<(typeof PayloadSchemas)[T]>;

function eventPayload<T extends EventType>(event: AgentEvent, type: T): Payload<T> {
  return PayloadSchemas[type].parse(event.payload) as Payload<T>;
}

const IdResult = z.object({ id: z.string() });
const SubscribeResult = z.object({ events: z.array(AgentEvent), lastSeq: z.number().int() });

beforeAll(() => {
  for (const key of ["NOIR_OMP_COMMAND", "NOIR_OMP_ARGS_JSON", "NOIR_TURN_TIMEOUT_MS"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.NOIR_OMP_COMMAND = process.execPath;
  process.env.NOIR_OMP_ARGS_JSON = JSON.stringify([FAKE_SERVER]);
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.shutdown();
    } catch {
      // The test may already have closed every session.
    }
  }
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a directory handle.
    }
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = TEST_TIMEOUT_MS, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

describe("EngineManager over the fake ACP server", () => {
  it(
    "streams text as gap-free events that replay to the same projection",
    async () => {
      const { events, manager, session } = setup();
      const result = await manager.prompt({
        sessionId: session.id,
        requestId: "stream-1",
        content: [{ type: "text", text: "stream" }],
      });
      expect(result.queued).toBe(false);

      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      const stream = events.list(session.id);
      stream.forEach((event, index) => expect(event.seq).toBe(index + 1));

      const types = stream.map((event) => event.type);
      expect(types.slice(2)).toEqual([
        "session.status",
        "turn.started",
        "message.delta",
        "message.delta",
        "message.delta",
        "message.completed",
        "usage.updated",
        "turn.completed",
        "session.status",
      ]);

      const deltas = stream.filter((event) => event.type === "message.delta");
      const text = deltas
        .map((event) => eventPayload(event, "message.delta"))
        .map((payload) => (payload.block.type === "text" ? payload.block.text : ""))
        .join("");
      expect(text).toBe("Hello from mock.");
      expect(deltas.every((event) => eventPayload(event, "message.delta").messageId === "msg-fake-1")).toBe(true);
      expect(deltas.every((event) => event.provenance.engineName === "omp")).toBe(true);

      const completed = eventPayload(stream.find((event) => event.type === "turn.completed")!, "turn.completed");
      expect(completed).toMatchObject({ turnId: result.turnId, status: "completed", stopReason: "end_turn" });

      const usage = eventPayload(stream.find((event) => event.type === "usage.updated")!, "usage.updated");
      expect(usage).toEqual({ inputTokens: 11, outputTokens: 7, contextUsed: 11, contextWindow: 200_000, costUsd: 0 });

      const state = stream.reduce<SessionState | undefined>(reduceSession, undefined);
      expect(state?.messages).toHaveLength(1);
      expect(state?.messages[0]).toMatchObject({ id: "msg-fake-1", role: "assistant", status: "done" });
      expect(state?.status).toBe("idle");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns the same turn for a duplicate requestId and appends no second turn",
    async () => {
      const { db, events, manager, session } = setup();
      const first = await manager.prompt({
        sessionId: session.id,
        requestId: "dup-1",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      const second = await manager.prompt({
        sessionId: session.id,
        requestId: "dup-1",
        content: [{ type: "text", text: "stream" }],
      });
      expect(second.turnId).toBe(first.turnId);
      expect(second.queued).toBe(false);

      const turns = db.prepare("SELECT id, status FROM turns WHERE session_id = ?").all(session.id) as Array<{
        id: string;
        status: string;
      }>;
      expect(turns).toEqual([{ id: first.turnId, status: "completed" }]);
      expect(events.list(session.id).filter((event) => event.type === "turn.started")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "queues a second prompt while running and drains it in order at idle",
    async () => {
      const { events, manager, session } = setup();
      const first = await manager.prompt({
        sessionId: session.id,
        requestId: "queue-1",
        content: [{ type: "text", text: "permission" }],
      });
      const requested = await waitForEvent(
        events,
        session.id,
        (event) => event.type === "permission.requested" && event.turnId === first.turnId,
      );
      const approvalId = eventPayload(requested, "permission.requested").approvalId;

      const second = await manager.prompt({
        sessionId: session.id,
        requestId: "queue-2",
        content: [{ type: "text", text: "stream" }],
      });
      expect(second.queued).toBe(true);
      expect(second.turnId).not.toBe(first.turnId);

      await manager.respond(approvalId, "allow_once");

      const started = await waitForEvent(events, session.id, (event) => event.type === "turn.started" && event.turnId === second.turnId);
      expect(eventPayload(started, "turn.started").index).toBe(2);
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === second.turnId);

      const stream = events.list(session.id);
      const order = stream.filter((event) => event.type === "turn.started" || event.type === "turn.completed");
      expect(order.map((event) => event.type)).toEqual([
        "turn.started",
        "turn.completed",
        "turn.started",
        "turn.completed",
      ]);
      expect(order.at(-1)!.turnId).toBe(second.turnId);
      expect(order.at(-1)!.seq).toBeGreaterThan(stream.find((event) => event.turnId === first.turnId && event.type === "turn.completed")!.seq);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "requests permission, resolves it, and reports the completed tool",
    async () => {
      const { events, manager, session } = setup();
      const result = await manager.prompt({
        sessionId: session.id,
        requestId: "permission-allow",
        content: [{ type: "text", text: "permission" }],
      });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      const approval = eventPayload(requested, "permission.requested");
      expect(approval).toMatchObject({ category: "shell", title: "echo hi" });
      expect(approval.options.map((option) => option.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject",
        "reject_always",
      ]);

      await manager.respond(approval.approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const stream = events.list(session.id);
      const index = (type: EventType) => stream.findIndex((event) => event.type === type);
      expect(index("permission.requested")).toBeLessThan(index("permission.resolved"));
      expect(index("permission.resolved")).toBeLessThan(index("tool.completed"));
      expect(
        stream.some(
          (event) => event.type === "session.status" && PayloadSchemas["session.status"].safeParse(event.payload).data?.status === "waiting",
        ),
      ).toBe(true);
      expect(eventPayload(stream[index("permission.resolved")]!, "permission.resolved").decision).toBe("allow_once");
      expect(eventPayload(stream[index("tool.completed")]!, "tool.completed").toolCallId).toBe("call_fake_1");

      const command = eventPayload(stream.find((event) => event.type === "command.started")!, "command.started");
      expect(command).toEqual({ commandId: "call_fake_1", command: "echo hi" });
      expect(eventPayload(stream.find((event) => event.type === "turn.completed")!, "turn.completed")).toMatchObject({
        turnId: result.turnId,
        status: "completed",
      });

      const row = manager.enginePid(session.id);
      expect(row).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the tool closed when the user rejects the permission",
    async () => {
      const { events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "permission-reject",
        content: [{ type: "text", text: "permission" }],
      });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "reject");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const failed = await waitForEvent(events, session.id, (event) => event.type === "tool.failed");
      expect(eventPayload(failed, "tool.failed").message).toContain("rejected");
      expect(events.list(session.id).some((event) => event.type === "tool.completed")).toBe(false);
      expect(
        eventPayload(events.list(session.id).find((event) => event.type === "turn.completed")!, "turn.completed").status,
      ).toBe("completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "marks the open message and the turn interrupted on session.interrupt",
    async () => {
      const { events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "interrupt-1",
        content: [{ type: "text", text: "slow" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "message.delta");
      const interrupted = await manager.interrupt(session.id);
      expect(interrupted.interrupted).toBe(true);

      const completed = await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      expect(eventPayload(completed, "turn.completed").status).toBe("interrupted");
      const message = events.list(session.id).find((event) => event.type === "message.completed")!;
      expect(eventPayload(message, "message.completed")).toEqual({ messageId: "msg-fake-slow", status: "interrupted" });
      expect(await manager.interrupt(session.id)).toEqual({ interrupted: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the turn and the session when the engine dies mid-turn",
    async () => {
      const { db, events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "crash-1",
        content: [{ type: "text", text: "crash" }],
      });
      const failed = await waitForEvent(events, session.id, (event) => event.type === "turn.failed");
      expect(eventPayload(failed, "turn.failed").message.length).toBeGreaterThan(0);
      await waitForEvent(
        events,
        session.id,
        (event) => event.type === "session.status" && PayloadSchemas["session.status"].safeParse(event.payload).data?.status === "error",
      );
      const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
      expect(row.status).toBe("error");
      expect(db.prepare("SELECT status FROM turns WHERE id = ?").get(failed.turnId) as { status: string }).toEqual({
        status: "failed",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes the session and reaps the engine child",
    async () => {
      const { events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "reap-1",
        content: [{ type: "text", text: "hang" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.started");
      const pid = manager.enginePid(session.id);
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid!)).toBe(true);

      await manager.closeSession(session.id);
      const deadline = Date.now() + 10_000;
      while (isAlive(pid!) && Date.now() < deadline) await tick(50);
      expect(isAlive(pid!)).toBe(false);
      expect(manager.enginePid(session.id)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "turns a hung prompt into an interrupted timeout",
    async () => {
      const { events, manager, session } = setup({ turnTimeoutMs: 400 });
      await manager.prompt({
        sessionId: session.id,
        requestId: "timeout-1",
        content: [{ type: "text", text: "hang" }],
      });
      const completed = await waitForEvent(events, session.id, (event) => event.type === "turn.completed", 15_000);
      expect(eventPayload(completed, "turn.completed")).toMatchObject({ status: "interrupted", stopReason: "cancelled" });
    },
    20_000,
  );

  it(
    "never puts an API key in a database row or an event",
    async () => {
      const { db, events, manager, session, dataDir } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "secret-1",
        content: [{ type: "text", text: "permission" }],
      });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const profile = readFileSync(join(profileAgentDir(dataDir), "models.yml"), "utf8");
      expect(profile).toContain(SECRET);
      expect(JSON.stringify(events.list(session.id))).not.toContain(SECRET);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all() as string[];
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        expect(JSON.stringify(rows), `table ${table}`).not.toContain(SECRET);
      }
    },
    TEST_TIMEOUT_MS,
  );
  it(
    "does not leak the engine or emit events when the session closes during startup",
    async () => {
      const pidFile = join(tempDir(), "acp.pid");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(async () => { await import(${JSON.stringify(pathToFileURL(FAKE_SERVER).href)}); }, 700);`;
      const { db, events, manager, session } = setup({ acpArgs: ["-e", script, "--"] });
      await manager.prompt({
        sessionId: session.id,
        requestId: "close-startup",
        content: [{ type: "text", text: "stream" }],
      });
      await waitFor(() => existsSync(pidFile), TEST_TIMEOUT_MS, "the spawned engine pid file");
      const pid = Number(readFileSync(pidFile, "utf8"));

      await manager.closeSession(session.id);
      const closedAt = events.list(session.id).at(-1)!.seq;
      await waitFor(() => !isAlive(pid), 10_000, "the engine child to exit");
      await tick(1_200);

      const late = events.list(session.id).filter((event) => event.seq > closedAt);
      expect(late).toEqual([]);
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string }).status).toBe("closed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settles a pending approval when interrupted and never revives the finished turn",
    async () => {
      const { db, events, manager, session } = setup({ turnTimeoutMs: 400 });
      await manager.prompt({
        sessionId: session.id,
        requestId: "interrupt-approval",
        content: [{ type: "text", text: "permission" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      expect((await manager.interrupt(session.id)).interrupted).toBe(true);
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const resolvedCount = () => events.list(session.id).filter((event) => event.type === "permission.resolved").length;
      expect(resolvedCount()).toBe(1);
      await tick(1_200);
      expect(resolvedCount()).toBe(1);
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string }).status).toBe("idle");

      const next = await manager.prompt({
        sessionId: session.id,
        requestId: "after-interrupt",
        content: [{ type: "text", text: "stream" }],
      });
      expect(next.queued).toBe(false);
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === next.turnId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a prompt that races session.close and leaves one engine",
    async () => {
      const { events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "close-race-1",
        content: [{ type: "text", text: "slow" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "message.delta");
      const pid = manager.enginePid(session.id);
      expect(pid).toBeGreaterThan(0);

      const closing = manager.closeSession(session.id);
      await expect(
        manager.prompt({
          sessionId: session.id,
          requestId: "close-race-2",
          content: [{ type: "text", text: "stream" }],
        }),
      ).rejects.toThrow(/closing/i);
      await Promise.all([closing, manager.closeSession(session.id)]);
      await expect(manager.closeSession(session.id)).resolves.toBeUndefined();

      await waitFor(() => !isAlive(pid!), 10_000, "the engine child to exit");
      const closed = events.list(session.id).find((event) => event.type === "session.closed")!;
      const closedStatus = events.list(session.id).filter((event) => event.type === "session.status").at(-1);
      await tick(500);
      const late = events.list(session.id).filter((event) => event.seq > closed.seq);
      expect(late).toEqual([]);
      expect(closedStatus === undefined || closedStatus.seq < closed.seq).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves orphaned approvals when a session is reconciled before replay",
    async () => {
      const { db, events, manager, session } = setup();
      const turnId = "stale-turn-1";
      db.prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES (?,?,?,?,?)").run(
        turnId,
        session.id,
        1,
        "running",
        Date.now(),
      );
      db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
      const approvalId = "stale-approval-1";
      const requested = events.append({
        sessionId: session.id,
        agentId: session.agentId,
        type: "permission.requested",
        payload: {
          approvalId,
          category: "shell",
          title: "Run?",
          options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
        },
        provenance: { engine: "acp", engineName: "omp", adapterVersion: "0.0.0" },
      });
      db.prepare(
        "INSERT INTO approvals (id, session_id, event_id, kind, payload_json, options_json) VALUES (?,?,?,?,?,?)",
      ).run(approvalId, session.id, requested.id, "shell", JSON.stringify(requested.payload), "[]");

      // Same sequence as the session.subscribe handler: reconcile, then replay.
      manager.reconcileSession(session.id);
      const replay = events.list(session.id);
      const resolved = replay.find((event) => event.type === "permission.resolved")!;
      expect(eventPayload(resolved, "permission.resolved")).toEqual({ approvalId, decision: "reject" });
      expect(resolved.seq).toBeGreaterThan(requested.seq);
      expect(replay.some((event) => event.type === "turn.failed" && event.turnId === turnId)).toBe(true);

      const undecided = db
        .prepare("SELECT COUNT(*) AS count FROM approvals WHERE session_id = ? AND decision IS NULL")
        .get(session.id) as { count: number };
      expect(undecided.count).toBe(0);
      const approval = db.prepare("SELECT decision FROM approvals WHERE id = ?").get(approvalId) as { decision: string };
      expect(approval.decision).toBe("reject");
      const turn = db.prepare("SELECT status FROM turns WHERE id = ?").get(turnId) as { status: string };
      expect(turn.status).toBe("failed");
      const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
      expect(row.status).toBe("idle");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("kernel RPC over the fake ACP server", () => {
  it(
    "replays before a prompt and broadcasts the live turn",
    async () => {
      const dataDir = tempDir();
      const root = tempDir();
      process.env.NOIR_OMP_COMMAND = process.execPath;
      process.env.NOIR_OMP_ARGS_JSON = JSON.stringify([FAKE_SERVER]);
      process.env.NOIR_TURN_TIMEOUT_MS = "20000";

      let kernel: Kernel | undefined;
      let socket: WebSocket | undefined;
      try {
        kernel = await startKernel({ dataDir });
        socket = new WebSocket(`ws://127.0.0.1:${kernel.port}/?token=${kernel.token}`);
        await once(socket, "open");
        interface Frame { id?: number; method?: string; result?: unknown; params?: unknown }
        const frames: Frame[] = [];
        socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));

        let nextId = 1;
        const call = async (method: string, params: unknown): Promise<Frame> => {
          const id = nextId++;
          socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          const deadline = Date.now() + TEST_TIMEOUT_MS;
          for (;;) {
            const frame = frames.find((candidate) => candidate.id === id);
            if (frame !== undefined) return frame;
            if (Date.now() >= deadline) throw new Error(`timed out waiting for ${method}`);
            await tick();
          }
        };

        const provider = await call("provider.create", {
          name: "Fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKind: "openai-completions",
          apiKey: SECRET,
        });
        const providerId = IdResult.parse(provider.result).id;
        const model = await call("model.create", { providerId, modelId: "fake-1" });
        const modelId = IdResult.parse(model.result).id;
        const project = await call("project.add", { path: root });
        const projectId = IdResult.parse(project.result).id;
        const workspace = await call("workspace.create", { projectId });
        const workspaceId = IdResult.parse(workspace.result).id;
        const created = await call("session.create", { workspaceId, modelId });
        const sessionId = IdResult.parse(created.result).id;

        const replay = await call("session.subscribe", { sessionId, sinceSeq: 0 });
        const replayResult = SubscribeResult.parse(replay.result);
        expect(replayResult.events.map((event) => event.type)).toEqual(["session.created", "session.status"]);
        expect(replayResult.lastSeq).toBe(2);

        const prompt = await call("session.prompt", {
          sessionId,
          requestId: "rpc-1",
          content: [{ type: "text", text: "stream" }],
        });
        expect(SessionPromptResult.parse(prompt.result).queued).toBe(false);

        const deadline = Date.now() + TEST_TIMEOUT_MS;
        let live: AgentEvent[] = [];
        for (;;) {
          live = frames
            .filter((frame) => frame.method === "event")
            .map((frame) => EventNotificationParams.parse(frame.params).event)
            .filter((event) => event.sessionId === sessionId && event.seq > replayResult.lastSeq);
          if (live.some((event) => event.type === "turn.completed")) break;
          if (Date.now() >= deadline) throw new Error("timed out waiting for the live turn.completed broadcast");
          await tick();
        }
        live.forEach((event, index) => expect(event.seq).toBe(replayResult.lastSeq + index + 1));
        expect(live.map((event) => event.type)).toContain("turn.started");
        expect(live.map((event) => event.type)).toContain("message.delta");

        const tail = await call("session.subscribe", { sessionId, sinceSeq: replayResult.lastSeq });
        const tailResult = SubscribeResult.parse(tail.result);
        expect(tailResult.events[0]!.seq).toBe(replayResult.lastSeq + 1);
        const tailIds = new Set(tailResult.events.map((event) => event.id));
        expect(live.every((event) => tailIds.has(event.id))).toBe(true);
        expect(tailResult.lastSeq).toBeGreaterThanOrEqual(live.at(-1)!.seq);
      } finally {
        socket?.close();
        if (kernel !== undefined) await kernel.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
