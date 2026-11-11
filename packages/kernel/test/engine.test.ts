import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
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
  type EngineKind,
  type EventType,
  type PermissionPolicy,
  type SessionState,
} from "@noir/protocol";
import { AgentService } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { EngineManager } from "../src/engineManager.js";
import { EventStore } from "../src/eventStore.js";
import { REDACTED, Redactor } from "../src/redact.js";
import { startKernel, type Kernel } from "../src/index.js";
import { ModelService } from "../src/models.js";
import { profileAgentDir } from "../src/profile.js";
import { ProjectService } from "../src/projects.js";
import { ProviderService, type Secrets } from "../src/providers.js";
import { SessionService } from "../src/sessions.js";
import { SkillService } from "../src/skills.js";
import { WorkspaceService } from "../src/workspaces.js";
import { startFakeOpenAiServer } from "../../engines/native/test/fakeOpenAiServer.js";

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

function setup(
  opts: {
    turnTimeoutMs?: number;
    acpArgs?: string[];
    acpSkill?: string;
    acpPermissionTitle?: string;
    acpPermissionKind?: string;
    acpPermissionRawInput?: Record<string, unknown>;
    agentPermissionPolicy?: PermissionPolicy;
    redactor?: Redactor;
    baseUrl?: string;
    engine?: EngineKind;
    contextWindow?: number;
  } = {},
) {
  const root = tempDir();
  const dataDir = tempDir();
  const db = openDb(join(dataDir, "noir.db"));
  dbs.push(db);
  const events = new EventStore(db, undefined, opts.redactor);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const models = new ModelService(db);
  const sessions = new SessionService(db, events, models);
  const providers = new ProviderService(db, memorySecrets());

  const project = projects.add(root);
  const workspace = workspaces.createLocal(project.id);
  const provider = providers.create({
    name: "Fake",
    baseUrl: opts.baseUrl ?? "http://127.0.0.1:9/v1",
    apiKind: "openai-completions",
    apiKey: SECRET,
    enabled: true,
  });
  const model = models.create({
    providerId: provider.id,
    modelId: "fake-1",
    contextWindow: opts.contextWindow ?? 200_000,
    enabled: true,
    engine: opts.engine ?? "acp",
  });
  const skills = new SkillService(db, dataDir);
  const agents = new AgentService(db, models);
  const session =
    opts.agentPermissionPolicy === undefined
      ? sessions.create(workspace.id, { modelId: model.id })
      : sessions.create(workspace.id, {
          modelId: model.id,
          agentId: agents.create({
            name: "Policy Agent",
            role: "Coder",
            engineId: "acp",
            modelRef: model.id,
            permissionPolicy: opts.agentPermissionPolicy,
            defaultWorkspaceId: workspace.id,
          }).id,
        });

  // The manager parses its launch argv at construction time.
  process.env.NOIR_OMP_ARGS_JSON = JSON.stringify(opts.acpArgs ?? [FAKE_SERVER]);
  // The adapter merges opts.env over process.env, so the fake server inherits this switch.
  if (opts.acpSkill === undefined) delete process.env.FAKE_ACP_SKILL;
  else process.env.FAKE_ACP_SKILL = opts.acpSkill;
  if (opts.acpPermissionTitle === undefined) delete process.env.FAKE_ACP_PERMISSION_TITLE;
  else process.env.FAKE_ACP_PERMISSION_TITLE = opts.acpPermissionTitle;
  if (opts.acpPermissionKind === undefined) delete process.env.FAKE_ACP_PERMISSION_KIND;
  else process.env.FAKE_ACP_PERMISSION_KIND = opts.acpPermissionKind;
  if (opts.acpPermissionRawInput === undefined) delete process.env.FAKE_ACP_PERMISSION_RAW_INPUT;
  else process.env.FAKE_ACP_PERMISSION_RAW_INPUT = JSON.stringify(opts.acpPermissionRawInput);
  const manager = new EngineManager({
    db,
    events,
    sessions,
    agents,
    models,
    providers,
    skills,
    dataDir,
    ompCommand: process.execPath,
    ...(opts.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.turnTimeoutMs }),
  });
  return { db, events, sessions, agents, providers, models, skills, manager, session, workspaceId: workspace.id, dataDir, root };
}

/**
 * A second manager over the same database: its first prompt is a kernel restart from the
 * engine's point of view, so it rebuilds history from the event log alone.
 */
function restartedManager(deps: {
  db: Database.Database;
  events: EventStore;
  sessions: SessionService;
  agents: AgentService;
  models: ModelService;
  providers: ProviderService;
  skills: SkillService;
  dataDir: string;
}): EngineManager {
  const manager = new EngineManager({
    db: deps.db,
    events: deps.events,
    sessions: deps.sessions,
    agents: deps.agents,
    models: deps.models,
    providers: deps.providers,
    skills: deps.skills,
    dataDir: deps.dataDir,
    ompCommand: process.execPath,
  });
  managers.push(manager);
  return manager;
}

function writeProjectSkill(root: string, name = "demo"): void {
  mkdirSync(join(root, ".noir", "skills", name), { recursive: true });
  writeFileSync(
    join(root, ".noir", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n\nBODY\n`,
  );
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

function approvalRows(db: Database.Database, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE session_id = ?").get(sessionId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

const IdResult = z.object({ id: z.string() });
const SubscribeResult = z.object({ events: z.array(AgentEvent), lastSeq: z.number().int() });

beforeAll(() => {
  for (const key of [
    "NOIR_OMP_COMMAND",
    "NOIR_OMP_ARGS_JSON",
    "NOIR_TURN_TIMEOUT_MS",
    "FAKE_ACP_SKILL",
    "FAKE_ACP_PERMISSION_TITLE",
    "FAKE_ACP_PERMISSION_KIND",
    "FAKE_ACP_PERMISSION_RAW_INPUT",
  ]) {
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
        "message.delta",
        "message.completed",
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

      // The prompt is persisted before the turn: one user block, then the assistant's stream.
      const promptEvents = stream.filter(
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "user",
      );
      expect(promptEvents).toHaveLength(1);
      expect(eventPayload(promptEvents[0]!, "message.delta")).toEqual({
        messageId: "stream-1",
        role: "user",
        block: { type: "text", text: "stream" },
      });

      const deltas = stream.filter(
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "assistant",
      );
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
      expect(state?.messages.map((message) => [message.id, message.role])).toEqual([
        ["stream-1", "user"],
        ["msg-fake-1", "assistant"],
      ]);
      expect(state?.messages[1]).toMatchObject({ id: "msg-fake-1", role: "assistant", status: "done" });
      expect(state?.status).toBe("idle");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attributes a skill:// read to the materialized skill's scope and hash",
    async () => {
      const { events, manager, session, root } = setup({ acpSkill: "demo" });
      writeProjectSkill(root);
      await manager.prompt({ sessionId: session.id, requestId: "skill-1", content: [{ type: "text", text: "stream" }] });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      const loaded = events.list(session.id).filter((event) => event.type === "skill.loaded");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.payload).toMatchObject({ name: "demo", scope: "project" });
      expect(eventPayload(loaded[0]!, "skill.loaded").hash).toMatch(/^[0-9a-f]{64}$/);
      expect(loaded[0]?.turnId).toBe(events.list(session.id).find((event) => event.type === "turn.started")?.turnId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not attribute a skill:// read for a disabled skill",
    async () => {
      const { events, manager, skills, session, workspaceId, root } = setup({ acpSkill: "demo" });
      writeProjectSkill(root);
      await skills.setEnabled(workspaceId, root, "project", "demo", false);

      const result = await manager.prompt({
        sessionId: session.id,
        requestId: "skill-disabled-1",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === result.turnId);
      expect(events.list(session.id).filter((event) => event.type === "skill.loaded")).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops attributing a skill disabled between turns on one live engine",
    async () => {
      const { events, manager, skills, session, workspaceId, root } = setup({ acpSkill: "demo" });
      writeProjectSkill(root);

      const first = await manager.prompt({
        sessionId: session.id,
        requestId: "skill-toggle-1",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === first.turnId);
      expect(events.list(session.id).filter((event) => event.type === "skill.loaded")).toHaveLength(1);

      await skills.setEnabled(workspaceId, root, "project", "demo", false);

      const second = await manager.prompt({
        sessionId: session.id,
        requestId: "skill-toggle-2",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === second.turnId);

      const loaded = events.list(session.id).filter((event) => event.type === "skill.loaded");
      expect(loaded).toHaveLength(1);
      expect(loaded.filter((event) => event.turnId === second.turnId)).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attributes one skill.loaded per turn so the dedupe set resets between turns",
    async () => {
      const { events, manager, session, root } = setup({ acpSkill: "demo" });
      writeProjectSkill(root);

      const first = await manager.prompt({
        sessionId: session.id,
        requestId: "skill-turn-1",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === first.turnId);
      const second = await manager.prompt({
        sessionId: session.id,
        requestId: "skill-turn-2",
        content: [{ type: "text", text: "stream" }],
      });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed" && event.turnId === second.turnId);

      const loaded = events.list(session.id).filter((event) => event.type === "skill.loaded");
      expect(loaded).toHaveLength(2);
      expect(loaded.map((event) => event.turnId)).toEqual([first.turnId, second.turnId]);
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
    "allows shell without an approval row when the policy says allow",
    async () => {
      const { events, sessions, db, manager, session } = setup({
        agentPermissionPolicy: { shell: "allow" },
        acpPermissionKind: "execute",
      });
      await manager.prompt({ sessionId: session.id, requestId: "auto-allow", content: [{ type: "text", text: "permission" }] });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const stream = events.list(session.id);
      expect(stream.filter((event) => event.type === "permission.requested")).toHaveLength(0);
      const auto = stream.filter((event) => event.type === "permission.auto");
      expect(auto).toHaveLength(1);
      expect(eventPayload(auto[0]!, "permission.auto")).toMatchObject({
        category: "shell",
        decision: "allow_once",
      });
      expect(approvalRows(db, session.id)).toBe(0);
      expect(sessions.view(session.id).status).not.toBe("waiting");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a delete without an approval row when the policy says reject",
    async () => {
      const { events, manager, session, db } = setup({
        agentPermissionPolicy: { delete: "reject" },
        acpPermissionKind: "delete",
        acpPermissionRawInput: { path: "notes.txt" },
      });
      await manager.prompt({ sessionId: session.id, requestId: "auto-reject", content: [{ type: "text", text: "permission" }] });
      const auto = await waitForEvent(events, session.id, (event) => event.type === "permission.auto");
      expect(eventPayload(auto, "permission.auto")).toMatchObject({ category: "delete", decision: "reject" });
      expect(approvalRows(db, session.id)).toBe(0);
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "asks for a write that escapes the workspace even when the policy allows it",
    async () => {
      const { events, db, manager, session } = setup({
        agentPermissionPolicy: { "write-outside-workspace": "allow" },
        acpPermissionKind: "edit",
        acpPermissionRawInput: { path: "../escape.txt" },
      });
      await manager.prompt({ sessionId: session.id, requestId: "outside-write", content: [{ type: "text", text: "permission" }] });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      expect(eventPayload(requested, "permission.requested").category).toBe("write-outside-workspace");
      expect(events.list(session.id).filter((event) => event.type === "permission.auto")).toHaveLength(0);
      expect(approvalRows(db, session.id)).toBe(1);

      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "asks for a write inside the workspace when the policy does not cover it",
    async () => {
      const { events, db, manager, session } = setup({
        agentPermissionPolicy: { shell: "allow" },
        acpPermissionKind: "edit",
        acpPermissionRawInput: { path: "notes.txt" },
      });
      await manager.prompt({ sessionId: session.id, requestId: "inside-write-ask", content: [{ type: "text", text: "permission" }] });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      expect(eventPayload(requested, "permission.requested").category).toBe("write-outside-workspace");
      expect(events.list(session.id).filter((event) => event.type === "permission.auto")).toHaveLength(0);
      expect(approvalRows(db, session.id)).toBe(1);

      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "auto-allows an inside write when the write-outside-workspace policy allows it",
    async () => {
      const { events, db, manager, session } = setup({
        agentPermissionPolicy: { "write-outside-workspace": "allow" },
        acpPermissionKind: "edit",
        acpPermissionRawInput: { path: "notes.txt" },
      });
      await manager.prompt({ sessionId: session.id, requestId: "inside-write-auto", content: [{ type: "text", text: "permission" }] });
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

      const stream = events.list(session.id);
      expect(stream.filter((event) => event.type === "permission.requested")).toHaveLength(0);
      const auto = stream.filter((event) => event.type === "permission.auto");
      expect(auto).toHaveLength(1);
      expect(eventPayload(auto[0]!, "permission.auto")).toMatchObject({
        category: "write-outside-workspace",
        decision: "allow_once",
      });
      expect(approvalRows(db, session.id)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "asks instead of auto-approving when a workspace link reaches outside",
    async (context) => {
      const { events, db, manager, session, root } = setup({
        agentPermissionPolicy: { "write-outside-workspace": "allow" },
        acpPermissionKind: "edit",
        acpPermissionRawInput: { path: "linked/notes.txt" },
      });
      try {
        await symlink(tempDir(), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip();
          return;
        }
        throw error;
      }

      await manager.prompt({ sessionId: session.id, requestId: "linked-write", content: [{ type: "text", text: "permission" }] });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      expect(eventPayload(requested, "permission.requested").category).toBe("write-outside-workspace");
      expect(events.list(session.id).filter((event) => event.type === "permission.auto")).toHaveLength(0);
      expect(approvalRows(db, session.id)).toBe(1);

      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads a policy value outside the vocabulary as ask",
    async () => {
      const { events, db, manager, session } = setup({
        agentPermissionPolicy: { shell: "allow" },
        acpPermissionKind: "execute",
      });
      // A hand-edited snapshot can hold any string; the enum schema never saw it.
      db.prepare("UPDATE sessions SET config_snapshot_json = ? WHERE id = ?").run(
        JSON.stringify({ permissionPolicy: { shell: "Allow" } }),
        session.id,
      );

      await manager.prompt({ sessionId: session.id, requestId: "unreadable-policy", content: [{ type: "text", text: "permission" }] });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      expect(events.list(session.id).filter((event) => event.type === "permission.auto")).toHaveLength(0);
      expect(approvalRows(db, session.id)).toBe(1);

      await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "projects the redacted approval title into the approvals table",
    async () => {
      const secret = "noir-approval-secret-9d2c";
      const { db, events, manager, session } = setup({
        acpPermissionTitle: `echo ${secret}`,
        redactor: new Redactor({ secrets: [secret] }),
      });
      const prompt = manager.prompt({
        sessionId: session.id,
        requestId: "permission-redact",
        content: [{ type: "text", text: "permission" }],
      });
      const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
      const approval = eventPayload(requested, "permission.requested");
      expect(approval.title).toBe(`echo ${REDACTED}`);

      const rows = JSON.stringify(db.prepare("SELECT payload_json, options_json FROM approvals").all());
      expect(rows).toContain(`echo ${REDACTED}`);
      expect(rows).not.toContain(secret);

      await manager.respond(approval.approvalId, "allow_once");
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      expect((await prompt).queued).toBe(false);
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
      await waitForEvent(
        events,
        session.id,
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "assistant",
      );
      const interrupted = await manager.interrupt(session.id);
      expect(interrupted.interrupted).toBe(true);

      const completed = await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
      expect(eventPayload(completed, "turn.completed").status).toBe("interrupted");
      const message = events
        .list(session.id)
        .find(
          (event) =>
            event.type === "message.completed" &&
            eventPayload(event, "message.completed").messageId === "msg-fake-slow",
        )!;
      expect(eventPayload(message, "message.completed")).toEqual({ messageId: "msg-fake-slow", status: "interrupted" });
      expect(await manager.interrupt(session.id)).toEqual({ interrupted: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the queued turn after interrupting the turn ahead of it",
    async () => {
      const { events, manager, session } = setup();
      const first = await manager.prompt({
        sessionId: session.id,
        requestId: "interrupt-queue-1",
        content: [{ type: "text", text: "slow" }],
      });
      await waitForEvent(
        events,
        session.id,
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "assistant",
      );
      const second = await manager.prompt({
        sessionId: session.id,
        requestId: "interrupt-queue-2",
        content: [{ type: "text", text: "stream" }],
      });
      expect(second.queued).toBe(true);

      expect((await manager.interrupt(session.id)).interrupted).toBe(true);

      const completedFirst = await waitForEvent(
        events,
        session.id,
        (event) => event.type === "turn.completed" && event.turnId === first.turnId,
      );
      expect(eventPayload(completedFirst, "turn.completed").status).toBe("interrupted");
      const startedSecond = await waitForEvent(
        events,
        session.id,
        (event) => event.type === "turn.started" && event.turnId === second.turnId,
      );
      expect(startedSecond.seq).toBeGreaterThan(completedFirst.seq);
      const completedSecond = await waitForEvent(
        events,
        session.id,
        (event) => event.type === "turn.completed" && event.turnId === second.turnId,
      );
      expect(eventPayload(completedSecond, "turn.completed").status).toBe("completed");
      expect(events.list(session.id).some((event) => event.type === "turn.failed")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops a queued turn without inventing events for it",
    async () => {
      const { db, events, manager, session } = setup();
      await manager.prompt({
        sessionId: session.id,
        requestId: "cancel-queued-running",
        content: [{ type: "text", text: "slow" }],
      });
      await waitForEvent(
        events,
        session.id,
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "assistant",
      );
      const queued = await manager.prompt({
        sessionId: session.id,
        requestId: "cancel-queued-waiting",
        content: [{ type: "text", text: "later" }],
      });
      expect(queued.queued).toBe(true);

      expect(await manager.cancelQueued({ sessionId: session.id, turnId: queued.turnId })).toEqual({ cancelled: true });
      expect(await manager.cancelQueued({ sessionId: session.id, turnId: queued.turnId })).toEqual({ cancelled: false });
      // The sender's own prompt is persisted at enqueue time; cancelling invents no turn lifecycle.
      expect(events.list(session.id).filter((event) => event.turnId === queued.turnId).map((event) => event.type)).toEqual([
        "message.delta",
        "message.completed",
      ]);
      expect(db.prepare("SELECT id FROM turns WHERE id = ?").get(queued.turnId)).toBeUndefined();

      // Cancelling the queued turn leaves the running turn alone.
      expect((await manager.interrupt(session.id)).interrupted).toBe(true);
      await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
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
      await waitForEvent(
        events,
        session.id,
        (event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "assistant",
      );
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
      expect(row.status).toBe("error");
      const stopped = events.list(session.id).filter((event) => event.type === "session.status").at(-1)!;
      expect(stopped.payload).toEqual({ status: "error", reason: "kernel_restart" });
    },
    TEST_TIMEOUT_MS,
  );

  it("sweeps sessions a crashed kernel left active in one boot pass", () => {
    const db = openDb(":memory:");
    dbs.push(db);
    db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p','p','/tmp/p',1)").run();
    db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES ('w','p','/tmp/p','main','local','ready',1)").run();
    db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES ('a','A','default','acp')").run();
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('run','w','a','acp','running',1)").run();
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('wait','w','a','acp','waiting',2)").run();
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('done','w','a','acp','closed',3)").run();
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('start','w','a','acp','starting',4)").run();
    db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('fresh','w','a','acp','starting',5)").run();
    db.prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES ('t1','run',1,'running',1)").run();
    db.prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES ('t2','start',2,'running',4)").run();

    const events = new EventStore(db);
    const models = new ModelService(db);
    const manager = new EngineManager({
      db,
      events,
      sessions: new SessionService(db, events, models),
      agents: new AgentService(db, models),
      models,
      providers: new ProviderService(db, memorySecrets()),
      skills: new SkillService(db, tempDir()),
      dataDir: tempDir(),
    });
    managers.push(manager);
    manager.reconcileAll();
    const statuses = db.prepare("SELECT id, status FROM sessions ORDER BY id").all();
    expect(statuses).toEqual([
      { id: "done", status: "closed" },
      { id: "fresh", status: "starting" },
      { id: "run", status: "error" },
      { id: "start", status: "error" },
      { id: "wait", status: "error" },
    ]);
    const turn = db.prepare("SELECT id, status FROM turns ORDER BY id").all();
    expect(turn).toEqual([
      { id: "t1", status: "failed" },
      { id: "t2", status: "failed" },
    ]);
    expect(events.list("run").some((event) => event.type === "session.status" && PayloadSchemas["session.status"].safeParse(event.payload).data?.reason === "kernel_restart")).toBe(true);
    expect(events.list("done")).toHaveLength(0);
    // A session that never accepted a turn is still starting, not a failed crash victim.
    expect(events.list("fresh")).toHaveLength(0);
  });

  it(
    "fails the turn but leaves a resumable error session untouched when its model is gone",
    async () => {
      const { db, events, sessions, manager, session } = setup();
      sessions.setStatus(session.id, "error");
      if (session.modelId === null) throw new Error("fixture session has no model");
      db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(session.modelId);
      const before = events.list(session.id).length;

      const result = await manager.prompt({
        sessionId: session.id,
        requestId: "resume-gone-1",
        content: [{ type: "text", text: "resume" }],
      });
      expect(result.queued).toBe(false);

      const failed = await waitForEvent(events, session.id, (event) => event.type === "turn.failed");
      const failedPayload = eventPayload(failed, "turn.failed");
      expect(failedPayload.turnId).toBe(result.turnId);
      expect(failedPayload.message).toBe("The session model is disabled or missing");

      const turn = db.prepare("SELECT status FROM turns WHERE id = ?").get(result.turnId) as { status: string };
      expect(turn.status).toBe("failed");
      const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
      expect(row.status).toBe("error");
      // The prompt is persisted; beyond it the only new event is the failure itself.
      expect(events.list(session.id).slice(before).map((event) => event.type)).toEqual([
        "message.delta",
        "message.completed",
        "turn.failed",
      ]);
      expect(events.list(session.id).some((event) => event.type === "turn.started")).toBe(false);
      expect(manager.enginePid(session.id)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe("EngineManager with the native engine", () => {
  it(
    "runs a tool call end to end and stamps native provenance",
    async () => {
      const server = await startFakeOpenAiServer([
        { toolCall: { id: "call_1", name: "fs.read", args: JSON.stringify({ path: "note.txt" }) } },
        { toolCall: { id: "call_2", name: "shell.exec", args: JSON.stringify({ command: "echo hi" }) } },
        { text: "done" },
      ]);
      try {
        const { events, manager, session, root } = setup({ baseUrl: server.baseUrl, engine: "native" });
        writeFileSync(join(root, "note.txt"), "native file body");

        const result = await manager.prompt({
          sessionId: session.id,
          requestId: "native-1",
          content: [{ type: "text", text: "read it" }],
        });
        expect(result.queued).toBe(false);

        const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
        expect(eventPayload(requested, "permission.requested")).toMatchObject({ category: "shell", title: "echo hi" });
        await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");

        const completed = await waitForEvent(events, session.id, (event) => event.type === "turn.completed");
        expect(eventPayload(completed, "turn.completed")).toMatchObject({ status: "completed", stopReason: "stop" });

        const stream = events.list(session.id);
        const turnStart = stream.findIndex((event) => event.type === "turn.started");
        expect(turnStart).toBeGreaterThanOrEqual(0);
        expect(stream.slice(turnStart).every((event) => event.provenance.engine === "native")).toBe(true);
        // Status rows are written by `SessionService` (engineName "none"); everything the manager
        // appends for the native session names the native engine.
        expect(
          stream
            .slice(turnStart)
            .filter((event) => event.type !== "session.status")
            .every((event) => event.provenance.engineName === "native"),
        ).toBe(true);

        const started = stream.filter((event) => event.type === "tool.started");
        expect(started).toHaveLength(2);
        expect(eventPayload(started[0]!, "tool.started")).toMatchObject({
          toolCallId: "call_1",
          title: "Read note.txt",
          kind: "read",
        });
        const output = stream.find(
          (event) => event.type === "tool.output" && eventPayload(event, "tool.output").toolCallId === "call_1",
        );
        expect(eventPayload(output!, "tool.output").chunk).toContain("native file body");

        // `shell` is native's spelling of ACP's `execute`; both drive the command projection.
        const commandStarted = stream.find((event) => event.type === "command.started");
        expect(eventPayload(commandStarted!, "command.started")).toEqual({ commandId: "call_2", command: "echo hi" });
        const commandOutput = stream.find((event) => event.type === "command.output");
        expect(eventPayload(commandOutput!, "command.output").chunk).toContain("hi");
        const commandCompleted = stream.find((event) => event.type === "command.completed");
        expect(eventPayload(commandCompleted!, "command.completed")).toMatchObject({ commandId: "call_2", exitCode: 0 });

        const completedTools = stream
          .filter((event) => event.type === "tool.completed")
          .map((event) => eventPayload(event, "tool.completed"));
        expect(completedTools.map((payload) => payload.toolCallId)).toEqual(["call_1", "call_2"]);

        // The provider reported 12/4 tokens; the context meter takes the prompt count it measured.
        const usage = eventPayload(stream.find((event) => event.type === "usage.updated")!, "usage.updated");
        expect(usage).toEqual({ inputTokens: 12, outputTokens: 4, contextUsed: 12, contextWindow: 200_000, costUsd: 0 });

        // The in-process engine has no child, so there is no pid to report.
        expect(manager.enginePid(session.id)).toBeUndefined();
        expect(server.requests).toHaveLength(3);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports the exit code native appends, not one the command printed",
    async () => {
      const server = await startFakeOpenAiServer([
        { toolCall: { id: "call_1", name: "shell.exec", args: JSON.stringify({ command: "echo exit code: 7" }) } },
        { text: "done" },
      ]);
      try {
        const { events, manager, session } = setup({ baseUrl: server.baseUrl, engine: "native" });
        await manager.prompt({
          sessionId: session.id,
          requestId: "native-exit",
          content: [{ type: "text", text: "run it" }],
        });

        const requested = await waitForEvent(events, session.id, (event) => event.type === "permission.requested");
        await manager.respond(eventPayload(requested, "permission.requested").approvalId, "allow_once");
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        // stdout contains a line that looks like the trailer; the real trailer is appended last, so 0 wins.
        const completed = events.list(session.id).find((event) => event.type === "command.completed");
        expect(eventPayload(completed!, "command.completed")).toEqual({ commandId: "call_1", exitCode: 0 });
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "persists the user prompt once, ahead of the turn it belongs to",
    async () => {
      const server = await startFakeOpenAiServer([{ text: "ok" }]);
      try {
        const { events, manager, session } = setup({ baseUrl: server.baseUrl, engine: "native" });
        const result = await manager.prompt({
          sessionId: session.id,
          requestId: "native-user-1",
          content: [{ type: "text", text: "hello there" }],
        });
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        const userEvents = () =>
          events
            .list(session.id)
            .filter((event) => event.type === "message.delta" && eventPayload(event, "message.delta").role === "user");
        expect(userEvents()).toHaveLength(1);
        expect(eventPayload(userEvents()[0]!, "message.delta")).toEqual({
          messageId: "native-user-1",
          role: "user",
          block: { type: "text", text: "hello there" },
        });
        expect(userEvents()[0]!.turnId).toBe(result.turnId);

        const stream = events.list(session.id);
        const completed = stream.find(
          (event) =>
            event.type === "message.completed" &&
            eventPayload(event, "message.completed").messageId === "native-user-1",
        );
        expect(eventPayload(completed!, "message.completed")).toEqual({ messageId: "native-user-1", status: "done" });
        expect(userEvents()[0]!.seq).toBeLessThan(stream.find((event) => event.type === "turn.started")!.seq);

        // A retried prompt returns the same turn and must not persist the text twice.
        await manager.prompt({
          sessionId: session.id,
          requestId: "native-user-1",
          content: [{ type: "text", text: "hello there" }],
        });
        expect(userEvents()).toHaveLength(1);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attributes a skill.read through onSkillRead exactly once",
    async () => {
      const server = await startFakeOpenAiServer([
        { toolCall: { id: "call_1", name: "skill.read", args: JSON.stringify({ name: "demo" }) } },
        { text: "done" },
      ]);
      try {
        const { events, manager, session, root } = setup({ baseUrl: server.baseUrl, engine: "native" });
        writeProjectSkill(root, "demo");
        await manager.prompt({
          sessionId: session.id,
          requestId: "native-skill-1",
          content: [{ type: "text", text: "load the skill" }],
        });
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        const stream = events.list(session.id);
        const loaded = stream.filter((event) => event.type === "skill.loaded");
        expect(loaded).toHaveLength(1);
        expect(eventPayload(loaded[0]!, "skill.loaded")).toMatchObject({ name: "demo", scope: "project" });

        const started = stream.find((event) => event.type === "tool.started");
        expect(eventPayload(started!, "tool.started")).toMatchObject({ toolCallId: "call_1", kind: "skill" });
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends the cold-start prompt to the provider exactly once",
    async () => {
      const server = await startFakeOpenAiServer([{ text: "ok" }]);
      try {
        const { events, manager, session } = setup({ baseUrl: server.baseUrl, engine: "native" });
        await manager.prompt({
          sessionId: session.id,
          requestId: "cold-start-1",
          content: [{ type: "text", text: "hello there" }],
        });
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        // Assert the request body: the persisted prompt must not reach the provider twice.
        const messages = server.requests[0]?.body.messages as Array<{ role: string; content: string }>;
        expect(messages.filter((message) => message.role === "user")).toEqual([
          { role: "user", content: "hello there" },
        ]);
        // The prompt precedes the assistant reply and nothing else follows the system message.
        expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["system", "user"]);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "estimates usage when the provider omits it",
    async () => {
      const server = await startFakeOpenAiServer([{ text: "hello", omitUsage: true }]);
      try {
        const { events, manager, session } = setup({ baseUrl: server.baseUrl, engine: "native" });
        await manager.prompt({
          sessionId: session.id,
          requestId: "no-usage-1",
          content: [{ type: "text", text: "hi" }],
        });
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        const usage = eventPayload(
          events.list(session.id).find((event) => event.type === "usage.updated")!,
          "usage.updated",
        );
        // ceil(5 / 4) generated characters; the request estimate feeds both counters.
        expect(usage.outputTokens).toBe(2);
        expect(usage.inputTokens).toBeGreaterThan(0);
        expect(usage.contextUsed).toBe(usage.inputTokens);
        expect(usage.contextWindow).toBe(200_000);
        expect(usage.costUsd).toBe(0);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replays a native tool call with its real name and arguments after a restart",
    async () => {
      const server = await startFakeOpenAiServer([
        { toolCall: { id: "call_1", name: "fs.read", args: JSON.stringify({ path: "note.txt" }) } },
        { text: "done" },
        { text: "again" },
      ]);
      try {
        const deps = setup({ baseUrl: server.baseUrl, engine: "native" });
        const { events, manager, session, root } = deps;
        writeFileSync(join(root, "note.txt"), "file body");
        await manager.prompt({
          sessionId: session.id,
          requestId: "restart-1",
          content: [{ type: "text", text: "read it" }],
        });
        await waitForEvent(events, session.id, (event) => event.type === "turn.completed");

        const started = events.list(session.id).find((event) => event.type === "tool.started");
        expect(eventPayload(started!, "tool.started")).toMatchObject({
          toolName: "fs.read",
          argumentsJson: JSON.stringify({ path: "note.txt" }),
        });

        const restarted = restartedManager(deps);
        const second = await restarted.prompt({
          sessionId: session.id,
          requestId: "restart-2",
          content: [{ type: "text", text: "again" }],
        });
        await waitForEvent(
          events,
          session.id,
          (event) => event.type === "turn.completed" && eventPayload(event, "turn.completed").turnId === second.turnId,
        );

        type WireAssistant = {
          role: string;
          content: string;
          tool_call_id?: string;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        const messages = server.requests.at(-1)?.body.messages as WireAssistant[];
        const assistant = messages.find((message) => message.tool_calls !== undefined);
        expect(assistant?.tool_calls).toEqual([
          {
            id: "call_1",
            type: "function",
            function: { name: "fs.read", arguments: JSON.stringify({ path: "note.txt" }) },
          },
        ]);
        expect(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_1")).toBe(true);
        // Each user turn is replayed once: reconstruction must not re-send the current prompt.
        expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
          "read it",
          "again",
        ]);
        await restarted.closeSession(session.id);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replays a prompt whose turn failed before the engine started",
    async () => {
      const server = await startFakeOpenAiServer([{ text: "fine" }]);
      try {
        const { db, events, manager, session } = setup({ baseUrl: server.baseUrl, engine: "native" });
        if (session.modelId === null) throw new Error("fixture session has no model");
        db.prepare("UPDATE models SET enabled = 0 WHERE id = ?").run(session.modelId);

        await manager.prompt({
          sessionId: session.id,
          requestId: "spawn-fail-1",
          content: [{ type: "text", text: "lost prompt" }],
        });
        const failed = await waitForEvent(events, session.id, (event) => event.type === "turn.failed");
        expect(eventPayload(failed, "turn.failed").message).toBe("The session model is disabled or missing");
        // The prompt is persisted and the turn is terminal, even though `turn.started` never landed.
        expect(events.list(session.id).some((event) => event.type === "turn.started")).toBe(false);

        db.prepare("UPDATE models SET enabled = 1 WHERE id = ?").run(session.modelId);
        const second = await manager.prompt({
          sessionId: session.id,
          requestId: "spawn-fail-2",
          content: [{ type: "text", text: "second" }],
        });
        await waitForEvent(
          events,
          session.id,
          (event) => event.type === "turn.completed" && eventPayload(event, "turn.completed").turnId === second.turnId,
        );

        const messages = server.requests[0]?.body.messages as Array<{ role: string; content: string }>;
        expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
          "lost prompt",
          "second",
        ]);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "logs the trimmed replay of a native history at engine start",
    async () => {
      const long = "x".repeat(4_000);
      const server = await startFakeOpenAiServer([{ text: "first" }, { text: "second" }, { text: "again" }]);
      try {
        const deps = setup({ baseUrl: server.baseUrl, engine: "native", contextWindow: 2_400 });
        const { events, manager, session } = deps;
        // Two long turns exceed 2,400 - 2,000 tokens ≈ 1,600 chars, so the oldest one is dropped.
        const firstTurn = await manager.prompt({
          sessionId: session.id,
          requestId: "trim-1",
          content: [{ type: "text", text: long }],
        });
        await waitForEvent(
          events,
          session.id,
          (event) => event.type === "turn.completed" && eventPayload(event, "turn.completed").turnId === firstTurn.turnId,
        );
        const secondTurn = await manager.prompt({
          sessionId: session.id,
          requestId: "trim-2",
          content: [{ type: "text", text: long }],
        });
        await waitForEvent(
          events,
          session.id,
          (event) => event.type === "turn.completed" && eventPayload(event, "turn.completed").turnId === secondTurn.turnId,
        );

        const restarted = restartedManager(deps);
        const third = await restarted.prompt({
          sessionId: session.id,
          requestId: "trim-3",
          content: [{ type: "text", text: "again" }],
        });
        await waitForEvent(
          events,
          session.id,
          (event) => event.type === "turn.completed" && eventPayload(event, "turn.completed").turnId === third.turnId,
        );

        const raw = events.list(session.id).filter((event) => event.type === "engine.raw");
        expect(raw).toHaveLength(1);
        expect(eventPayload(raw[0]!, "engine.raw")).toEqual({ engine: "native", payload: { trimmedTurns: 1 } });

        const messages = server.requests.at(-1)?.body.messages as Array<{ role: string; content: string }>;
        expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
        // The oldest long turn is gone; the newest is kept whole even though it overflows alone.
        expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
          long,
          "again",
        ]);
        await restarted.closeSession(session.id);
        await manager.closeSession(session.id);
      } finally {
        await server.close();
      }
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

  it(
    "seeds the ingest redactor from a provider key created at runtime",
    async () => {
      const KEY = "plain-provider-secret-9d2c";
      const dataDir = tempDir();
      const root = tempDir();
      process.env.NOIR_OMP_COMMAND = process.execPath;
      process.env.NOIR_OMP_ARGS_JSON = JSON.stringify([FAKE_SERVER]);
      process.env.NOIR_TURN_TIMEOUT_MS = "20000";

      const previousTitle = process.env.FAKE_ACP_PERMISSION_TITLE;
      process.env.FAKE_ACP_PERMISSION_TITLE = KEY;

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

        const providerId = IdResult.parse((await call("provider.create", {
          name: "Plain",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKind: "openai-completions",
          apiKey: KEY,
        })).result).id;
        const modelId = IdResult.parse((await call("model.create", { providerId, modelId: "fake-1" })).result).id;
        const projectId = IdResult.parse((await call("project.add", { path: root })).result).id;
        const workspaceId = IdResult.parse((await call("workspace.create", { projectId })).result).id;
        const sessionId = IdResult.parse((await call("session.create", { workspaceId, modelId })).result).id;

        const prompt = await call("session.prompt", {
          sessionId,
          requestId: "redact-rpc-1",
          content: [{ type: "text", text: "tool" }],
        });
        expect(SessionPromptResult.parse(prompt.result).queued).toBe(false);

        const replayAll = async (): Promise<AgentEvent[]> =>
          SubscribeResult.parse((await call("session.subscribe", { sessionId, sinceSeq: 0 })).result).events;
        const waitForReplay = async (predicate: (events: AgentEvent[]) => boolean): Promise<AgentEvent[]> => {
          const deadline = Date.now() + TEST_TIMEOUT_MS;
          for (;;) {
            const events = await replayAll();
            if (predicate(events)) return events;
            if (Date.now() >= deadline) throw new Error("timed out waiting for session events");
            await tick();
          }
        };

        const requestedEvents = await waitForReplay((events) => events.some((event) => event.type === "permission.requested"));
        const requested = requestedEvents.find((event) => event.type === "permission.requested")!;
        const approval = eventPayload(requested, "permission.requested");
        expect(approval.title).toBe(REDACTED);
        expect(JSON.stringify(requestedEvents)).not.toContain(KEY);

        const respond = await call("approval.respond", { approvalId: approval.approvalId, decision: "allow_once" });
        expect(respond.result).toEqual({ ok: true });
        await waitForReplay((events) => events.some((event) => event.type === "turn.completed"));

        const finalEvents = await replayAll();
        expect(JSON.stringify(finalEvents)).toContain(REDACTED);
        expect(JSON.stringify(finalEvents)).not.toContain(KEY);

        socket.close();
        socket = undefined;
        await kernel.close();
        kernel = undefined;

        const verify = openDb(join(dataDir, "noir.db"));
        try {
          const rows = JSON.stringify(verify.prepare("SELECT payload_json, options_json FROM approvals").all());
          expect(rows).toContain(REDACTED);
          expect(rows).not.toContain(KEY);
        } finally {
          verify.close();
        }
      } finally {
        socket?.close();
        if (kernel !== undefined) await kernel.close();
        if (previousTitle === undefined) delete process.env.FAKE_ACP_PERMISSION_TITLE;
        else process.env.FAKE_ACP_PERMISSION_TITLE = previousTitle;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
