import { afterEach, describe, expect, it } from "vitest";
import type { McpServerView } from "@noir/protocol";
import { SessionMcpManager } from "../src/mcp/sessionMcp.js";

const CALC_SERVER = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "calc", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
      ] } });
    } else if (message.method === "tools/call") {
      const { a, b } = message.params.arguments;
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(a + b) }] } });
    }
  }
});
`;

const EMPTY_SERVER = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "empty", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    }
  }
});
`;

function server(name: string, script: string): McpServerView {
  return {
    id: `mcp-${name}`,
    name,
    command: process.execPath,
    args: ["-e", script],
    env: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const managers: SessionMcpManager[] = [];

function manager(servers: McpServerView[]): SessionMcpManager {
  const created = new SessionMcpManager(servers, process.cwd());
  managers.push(created);
  return created;
}

afterEach(async () => {
  for (const created of managers.splice(0)) await created.dispose();
});

describe("SessionMcpManager", () => {
  it("namespaces every tool as mcp__<server>__<tool> with the server in the description", async () => {
    const session = manager([server("calc", CALC_SERVER)]);
    await session.initialize();
    expect(session.tools.map((tool) => tool.name)).toEqual(["mcp__calc__add"]);
    expect(session.tools[0]?.description).toBe("[calc] Add two numbers");
    expect(session.tools[0]?.parameters).toMatchObject({ type: "object", required: ["a", "b"] });
  });

  it("routes a call to the server that owns the tool", async () => {
    const session = manager([server("calc", CALC_SERVER)]);
    await session.initialize();
    await expect(session.executeTool("mcp__calc__add", { a: 10, b: 25 })).resolves.toBe("35");
  });

  it("rejects an unknown or malformed tool name without touching a server", async () => {
    const session = manager([server("calc", CALC_SERVER)]);
    await session.initialize();
    await expect(session.executeTool("mcp__calc__missing", {})).rejects.toThrow(/unknown/i);
    await expect(session.executeTool("mcp__nosuch__add", {})).rejects.toThrow(/unknown/i);
    await expect(session.executeTool("add", {})).rejects.toThrow(/unknown/i);
  });

  it("keeps a server that advertises no tools without failing the session", async () => {
    const session = manager([server("empty", EMPTY_SERVER)]);
    await session.initialize();
    expect(session.tools).toEqual([]);
    expect(session.warnings).toEqual([]);
  });

  it("drops a tool whose namespaced name the provider would reject, keeping the rest", async () => {
    const longName = "t".repeat(60);
    const script = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "wide", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "ok", inputSchema: { type: "object" } },
        { name: "${longName}", inputSchema: { type: "object" } },
        { name: "has space", inputSchema: { type: "object" } },
      ] } });
    }
  }
});
`;
    const session = manager([server("wide", script)]);
    await session.initialize();
    expect(session.tools.map((tool) => tool.name)).toEqual(["mcp__wide__ok"]);
    expect(session.warnings).toHaveLength(2);
  });

  it("skips a server that cannot start and reports why", async () => {
    const broken: McpServerView = { ...server("broken", "x"), command: "definitely-not-a-real-binary-xyz" };
    const session = manager([broken, server("calc", CALC_SERVER)]);
    await session.initialize();
    expect(session.tools.map((tool) => tool.name)).toEqual(["mcp__calc__add"]);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toMatch(/broken/);
  });

  it("passes custom environment variables to the server process", async () => {
    const envEcho = `
process.stdin.setEncoding("utf8");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "env", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "read", inputSchema: { type: "object" } }] } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(process.env.NOIR_MCP_PROBE) }] } });
    }
  }
});
`;
    const session = manager([{ ...server("env", envEcho), env: { NOIR_MCP_PROBE: "sentinel-value" } }]);
    await session.initialize();
    await expect(session.executeTool("mcp__env__read", {})).resolves.toBe("sentinel-value");
  });

  it("stops every child process on dispose", async () => {
    const session = manager([server("calc", CALC_SERVER), server("other", CALC_SERVER)]);
    await session.initialize();
    const pids = session.pids;
    expect(pids).toHaveLength(2);
    await session.dispose();
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
  });
});
