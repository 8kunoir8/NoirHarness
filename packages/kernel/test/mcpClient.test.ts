import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const dirs: string[] = [];

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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle on a killed child's cwd.
    }
  }
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

  it.skipIf(process.platform !== "win32")("runs a .cmd shim, which Node cannot spawn itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noir mcp shim "));
    dirs.push(dir);
    const pidFile = join(dir, "server.pid");
    writeFileSync(
      join(dir, "server.js"),
      `${ECHO_SERVER}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
`,
    );
    // `npx` ships as this kind of shim, and it forwards its arguments to the real server.
    const shim = join(dir, "server.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`);
    const client = new McpClient({ command: shim, args: ["C:\\Program Files\\x"], env: {} });
    clients.push(client);

    await client.start();
    await expect(client.callTool("echo", { text: "a b" })).resolves.toBe("Echo: a b");

    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const serverPid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(serverPid)).toBe(true);
    // Stopping the wrapper must take the server itself down, not orphan it.
    await client.stop();
    expect(isAlive(serverPid)).toBe(false);
  });
});
