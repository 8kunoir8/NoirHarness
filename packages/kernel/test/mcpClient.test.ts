import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.js";

/** A minimal MCP server: initialize, tools/list, tools/call over newline-delimited JSON-RPC. */
const ECHO_SERVER = `
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
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } },
      ] } });
    } else if (message.method === "tools/call") {
      if (message.params.name === "boom") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "exploded" }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Echo: " + message.params.arguments.text }] } });
      }
    }
  }
});
`;

const clients: McpClient[] = [];

function clientFor(script: string, overrides: { callTimeoutMs?: number; startupTimeoutMs?: number } = {}): McpClient {
  const client = new McpClient({
    command: process.execPath,
    args: ["-e", script],
    env: {},
    ...overrides,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
});

describe("McpClient", () => {
  it("handshakes, lists tools with their schemas, and calls one", async () => {
    const client = clientFor(ECHO_SERVER);
    await client.start();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "boom"]);
    expect(tools[0]?.description).toBe("Echo the text back");
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });

    await expect(client.callTool("echo", { text: "hello world" })).resolves.toBe("Echo: hello world");
  });

  it("turns a server-reported tool error into a rejection carrying its text", async () => {
    const client = clientFor(ECHO_SERVER);
    await client.start();
    await expect(client.callTool("boom", {})).rejects.toThrow(/exploded/);
  });

  it("ignores non-JSON banner lines on stdout", async () => {
    const noisy = `
process.stdout.write("INFO: starting mock server\\n");
process.stdout.write("not json at all\\n");
${ECHO_SERVER}`;
    const client = clientFor(noisy);
    await client.start();
    expect(await client.listTools()).toHaveLength(2);
  });

  it("fails fast when the executable does not exist", async () => {
    const client = new McpClient({ command: "definitely-not-a-real-binary-xyz", args: [], env: {} });
    await expect(client.start()).rejects.toThrow(/definitely-not-a-real-binary-xyz/);
  });

  it("rejects a request when the server exits mid-call", async () => {
    const dying = `
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => process.exit(3));
`;
    const client = clientFor(dying);
    await expect(client.start()).rejects.toThrow(/exited/);
  });

  it("rejects a tool call once its timeout elapses", async () => {
    // Real elapsed time is the behavior under test here: the client must bound a silent server.
    const silent = `
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
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "silent", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "wait", inputSchema: { type: "object" } }] } });
    }
  }
});
`;
    const client = clientFor(silent, { callTimeoutMs: 150 });
    await client.start();
    await expect(client.callTool("wait", {})).rejects.toThrow(/timed out/);
  });

  it("stops the child process so the pid is gone", async () => {
    const client = clientFor(ECHO_SERVER);
    await client.start();
    expect(client.pid).toBeTypeOf("number");
    await client.stop();
    expect(client.pid).toBeUndefined();
  });
});
