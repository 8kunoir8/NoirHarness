import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineStartOptions, EngineUpdate } from "@noir/engine-core";
import { createNativeEngine } from "../src/index.js";
import { PERMISSION_DENIED } from "../src/tools.js";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fakeOpenAiServer.js";

const dirs: string[] = [];
const servers: FakeOpenAiServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir-native-loop-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle.
    }
  }
});

async function startServer(script: Parameters<typeof startFakeOpenAiServer>[0]): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAiServer(script);
  servers.push(server);
  return server;
}

function startOptions(
  server: FakeOpenAiServer,
  cwd: string,
  extra: { turnTimeoutMs?: number; skills?: EngineStartOptions["skills"] } = {},
): EngineStartOptions {
  return {
    sessionId: "session-1",
    cwd,
    model: { providerName: "fake", modelId: "fake-1", contextWindow: 100_000, maxTokens: null },
    baseUrl: server.baseUrl,
    apiKey: "sk-fake",
    history: [],
    skills: extra.skills ?? [],
    turnTimeoutMs: extra.turnTimeoutMs ?? 10_000,
  };
}

async function tick(ms = 5): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  setTimeout(deferred.resolve, ms);
  await deferred.promise;
}

/** Blocks until the fake provider accepted the request, so the turn is provably streaming. */
async function waitForRequest(server: FakeOpenAiServer): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (server.requests.length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the provider request");
    await tick();
  }
}

function isMessage(update: EngineUpdate): update is Extract<EngineUpdate, { kind: "message" }> {
  return update.kind === "message";
}

function isToolUpdate(update: EngineUpdate): update is Extract<EngineUpdate, { kind: "tool.updated" }> {
  return update.kind === "tool.updated";
}

describe("native turn loop", () => {
  it("streams a tool call, runs the tool, and streams the follow-up", async () => {
    const root = tempDir();
    writeFileSync(join(root, "note.txt"), "file body");
    const server = await startServer([
      { toolCall: { id: "call_1", name: "fs.read", args: JSON.stringify({ path: "note.txt" }) } },
      { text: "done" },
    ]);
    const session = await createNativeEngine().start(startOptions(server, root));

    const updates: EngineUpdate[] = [];
    const result = await session.prompt([{ type: "text", text: "read it" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(result.stopReason).toBe("stop");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.body.model).toBe("fake-1");
    const tools = server.requests[0]?.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("fs.read");

    const messages = updates.filter(isMessage);
    expect(messages.map((update) => update.text)).toEqual(["done"]);

    const started = updates.find((update) => update.kind === "tool.started");
    expect(started).toMatchObject({
      toolCallId: "call_1",
      title: "Read note.txt",
      toolKind: "read",
      toolName: "fs.read",
      argumentsJson: JSON.stringify({ path: "note.txt" }),
    });
    const completed = updates.find(isToolUpdate);
    expect(completed).toMatchObject({ toolCallId: "call_1", status: "completed" });
    expect(completed?.text).toContain("file body");

    // The provider reported 12 prompt tokens; the kernel's context meter takes that count.
    expect(updates.filter((update) => update.kind === "usage").at(-1)).toEqual({
      kind: "usage",
      size: 100_000,
      used: 12,
    });

    const second = server.requests[1]?.body.messages as Array<{ role: string; tool_call_id?: string }>;
    expect(second).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call_1" }));
    const assistant = second.find((message) => message.role === "assistant") as {
      tool_calls?: Array<{ function: { arguments: string } }>;
    };
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({ path: "note.txt" }));
  });

  it("fails an invalid tool input without failing the turn", async () => {
    const root = tempDir();
    const server = await startServer([
      { toolCall: { id: "call_1", name: "fs.read", args: "{}" } },
      { text: "recovered" },
    ]);
    const session = await createNativeEngine().start(startOptions(server, root));

    const updates: EngineUpdate[] = [];
    const result = await session.prompt([{ type: "text", text: "bad call" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(result.stopReason).toBe("stop");
    const failed = updates.find(isToolUpdate);
    expect(failed).toMatchObject({ toolCallId: "call_1", status: "failed" });
    expect(failed?.text).toContain("Tool input invalid:");
    expect(updates.filter(isMessage).some((update) => update.text === "recovered")).toBe(true);
  });

  it("reports a denied permission as a failed tool call and keeps going", async () => {
    const root = tempDir();
    const server = await startServer([
      { toolCall: { id: "call_1", name: "shell.exec", args: JSON.stringify({ command: "echo hi" }) } },
      { text: "denied" },
    ]);
    const session = await createNativeEngine().start(startOptions(server, root));

    const updates: EngineUpdate[] = [];
    const result = await session.prompt([{ type: "text", text: "run it" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "reject",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(result.stopReason).toBe("stop");
    const failed = updates.find(isToolUpdate);
    expect(failed).toMatchObject({ status: "failed", text: PERMISSION_DENIED });
    expect(updates.filter(isMessage).some((update) => update.text === "denied")).toBe(true);
  });

  it("aborts the live stream on interrupt and settles the turn as cancelled", async () => {
    const root = tempDir();
    const server = await startServer([{ text: "late", delayMs: 2_000 }]);
    const session = await createNativeEngine().start(startOptions(server, root));

    const pending = session.prompt([{ type: "text", text: "stop me" }], {
      onUpdate: () => undefined,
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await waitForRequest(server);
    await session.interrupt();
    const result = await pending;
    await session.dispose();

    expect(result).toMatchObject({ stopReason: "cancelled", timedOut: false });
  });

  it("reports timedOut when a turn outlives turnTimeoutMs", async () => {
    const root = tempDir();
    const server = await startServer([{ text: "late", delayMs: 2_000 }]);
    const session = await createNativeEngine().start(startOptions(server, root, { turnTimeoutMs: 50 }));

    const updates: EngineUpdate[] = [];
    const result = await session.prompt([{ type: "text", text: "slow turn" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(result).toMatchObject({ stopReason: "timeout", timedOut: true });
    // The turn was cut short, so nothing the provider had not sent yet was replayed as content.
    expect(updates.filter(isMessage)).toEqual([]);
  });

  it("estimates usage when the provider omits it", async () => {
    const root = tempDir();
    const server = await startServer([{ text: "abcde", omitUsage: true }]);
    const session = await createNativeEngine().start(startOptions(server, root));

    const updates: EngineUpdate[] = [];
    const result = await session.prompt([{ type: "text", text: "hi" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    // ceil(5 / 4) characters of generated text; the request estimate is what the meter shows.
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(updates.filter((update) => update.kind === "usage").at(-1)).toEqual({
      kind: "usage",
      size: 100_000,
      used: result.usage?.inputTokens,
    });
  });

  it("reports a skill read once and labels the tool call as a skill", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".noir", "skills-engine", "demo"), { recursive: true });
    writeFileSync(join(root, ".noir", "skills-engine", "demo", "SKILL.md"), "# Demo\n");
    const server = await startServer([
      { toolCall: { id: "call_1", name: "skill.read", args: JSON.stringify({ name: "demo" }) } },
      { text: "done" },
    ]);
    const session = await createNativeEngine().start(
      startOptions(server, root, { skills: [{ name: "demo", scope: "project", description: "demo" }] }),
    );

    const updates: EngineUpdate[] = [];
    const reads: string[] = [];
    const result = await session.prompt([{ type: "text", text: "load it" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: (name) => reads.push(name),
    });
    await session.dispose();

    expect(result.stopReason).toBe("stop");
    expect(reads).toEqual(["demo"]);
    const started = updates.find((update) => update.kind === "tool.started");
    expect(started).toMatchObject({ toolCallId: "call_1", toolKind: "skill", rawInput: { name: "demo" } });
    const completed = updates.find(isToolUpdate);
    expect(completed?.text).toContain("# Demo");
  });
});
