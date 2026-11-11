import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function startOptions(server: FakeOpenAiServer, cwd: string): EngineStartOptions {
  return {
    sessionId: "session-1",
    cwd,
    model: { providerName: "fake", modelId: "fake-1", contextWindow: 100_000, maxTokens: null },
    baseUrl: server.baseUrl,
    apiKey: "sk-fake",
    history: [],
    skills: [],
    turnTimeoutMs: 10_000,
  };
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
    expect(started).toMatchObject({ toolCallId: "call_1", title: "Read note.txt", toolKind: "read" });
    const completed = updates.find(isToolUpdate);
    expect(completed).toMatchObject({ toolCallId: "call_1", status: "completed" });
    expect(completed?.text).toContain("file body");

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
});
