import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineStartOptions, EngineUpdate } from "@noir/engine-core";
import { createNativeEngine } from "../src/index.js";
import { PERMISSION_DENIED, toolKind, toolTitle } from "../src/tools.js";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fakeOpenAiServer.js";

const dirs: string[] = [];
const servers: FakeOpenAiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startServer(script: Parameters<typeof startFakeOpenAiServer>[0]): Promise<FakeOpenAiServer> {
  const server = await startFakeOpenAiServer(script);
  servers.push(server);
  return server;
}

function startOptions(server: FakeOpenAiServer, extra: Partial<EngineStartOptions> = {}): EngineStartOptions {
  const dir = mkdtempSync(join(tmpdir(), "noir-native-mcp-"));
  dirs.push(dir);
  return {
    sessionId: "session-mcp",
    cwd: dir,
    model: { providerName: "fake", modelId: "fake-1", contextWindow: 100_000, maxTokens: null },
    baseUrl: server.baseUrl,
    apiKey: "sk-fake",
    history: [],
    skills: [],
    turnTimeoutMs: 10_000,
    ...extra,
  };
}

type ToolUpdate = Extract<EngineUpdate, { kind: "tool.updated" }>;

function toolUpdate(updates: EngineUpdate[], toolCallId: string): ToolUpdate | undefined {
  return updates.find(
    (update): update is ToolUpdate => update.kind === "tool.updated" && update.toolCallId === toolCallId,
  );
}

const ADD_TOOL = {
  name: "mcp__calc__add",
  description: "[calc] Add two numbers",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
};

describe("native engine MCP tools", () => {
  it("describes mcp tools to the provider alongside its own", async () => {
    const server = await startServer([{ text: "ok" }]);
    const session = await createNativeEngine().start(
      startOptions(server, { mcpTools: [ADD_TOOL], callMcpTool: async () => "0" }),
    );
    await session.prompt([{ type: "text", text: "hi" }], {
      onUpdate: () => undefined,
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    const tools = server.requests[0]?.body.tools as Array<{ function: { name: string; parameters: unknown } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("mcp__calc__add");
    expect(tools.map((tool) => tool.function.name)).toContain("fs.read");
    expect(tools.find((tool) => tool.function.name === "mcp__calc__add")?.function.parameters).toEqual(
      ADD_TOOL.parameters,
    );
  });

  it("asks for approval, then runs the call through the kernel bridge", async () => {
    const server = await startServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 2, b: 3 }) } },
      { text: "summed" },
    ]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const session = await createNativeEngine().start(
      startOptions(server, {
        mcpTools: [ADD_TOOL],
        callMcpTool: async (name, args) => {
          calls.push({ name, args });
          return String((args.a as number) + (args.b as number));
        },
      }),
    );

    const updates: EngineUpdate[] = [];
    const permissions: Array<{ kind: string | undefined; title: string }> = [];
    await session.prompt([{ type: "text", text: "add" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async (request) => {
        permissions.push({ kind: request.toolCall.kind, title: request.toolCall.title });
        return "allow_once";
      },
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(permissions).toEqual([{ kind: "mcp", title: "mcp__calc__add" }]);
    expect(calls).toEqual([{ name: "mcp__calc__add", args: { a: 2, b: 3 } }]);
    expect(toolUpdate(updates, "call_1")).toMatchObject({ status: "completed", text: "5" });
  });

  it("returns the denial text and never calls the server when approval is refused", async () => {
    const server = await startServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 2, b: 3 }) } },
      { text: "blocked" },
    ]);
    let called = false;
    const session = await createNativeEngine().start(
      startOptions(server, {
        mcpTools: [ADD_TOOL],
        callMcpTool: async () => {
          called = true;
          return "5";
        },
      }),
    );

    const updates: EngineUpdate[] = [];
    await session.prompt([{ type: "text", text: "add" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "reject",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    expect(called).toBe(false);
    expect(toolUpdate(updates, "call_1")).toMatchObject({ status: "failed", text: PERMISSION_DENIED });
  });

  it("fails an mcp call the kernel did not wire instead of pretending it ran", async () => {
    const server = await startServer([
      { toolCall: { id: "call_1", name: "mcp__calc__add", args: JSON.stringify({ a: 1, b: 1 }) } },
      { text: "done" },
    ]);
    const session = await createNativeEngine().start(startOptions(server));

    const updates: EngineUpdate[] = [];
    await session.prompt([{ type: "text", text: "add" }], {
      onUpdate: (update) => updates.push(update),
      onPermission: async () => "allow_once",
      onSkillRead: () => undefined,
    });
    await session.dispose();

    const failed = toolUpdate(updates, "call_1");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.text).toMatch(/unknown tool/i);
  });

  it("keeps mcp tools in the generic tool kind with the namespaced title", () => {
    expect(toolKind("mcp__calc__add")).toBe("other");
    expect(toolTitle("mcp__calc__add", { a: 1 })).toBe("mcp__calc__add");
  });
});
