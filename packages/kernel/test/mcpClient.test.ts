import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
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
const cleanups: (() => Promise<void>)[] = [];

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
  for (const cleanup of cleanups.splice(0)) await cleanup();
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
    const argvFile = join(dir, "server.argv");
    writeFileSync(
      join(dir, "server.js"),
      `${ECHO_SERVER}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
`,
    );
    // `npx` ships as this kind of shim, and it forwards its arguments to the real server.
    const shim = join(dir, "server.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0server.js" %*\r\n`);
    // `%FOO%` must reach the server literally, not expanded by cmd, and a trailing backslash must
    // not eat the closing quote — both were broken when the arguments rode on the cmd line.
    const args = ["C:\\Program Files\\x", "%FOO%", "100%", "a b\\", 'x"y'];
    const client = new McpClient({ command: shim, args, env: { FOO: "bar" } });
    clients.push(client);

    await client.start();
    await expect(client.callTool("echo", { text: "a b" })).resolves.toBe("Echo: a b");
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(args);

    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const serverPid = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(serverPid)).toBe(true);
    // Stopping the wrapper must take the server itself down, not orphan it.
    await client.stop();
    expect(isAlive(serverPid)).toBe(false);
  });

  it("speaks Streamable HTTP, answering as JSON", async () => {
    const requests: { method: string; session: string | undefined }[] = [];
    const server = createHttpServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        requests.push({ method: message.method, session: request.headers["mcp-session-id"] as string | undefined });
        if (message.id === undefined) {
          // A notification: the spec's answer is 202 with no body.
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } }
            : message.method === "tools/list"
              ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "over http" }] };
        // The session id the client must echo on every later request arrives with this reply.
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const client = new McpClient({ url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {} });
    clients.push(client);
    await client.start();
    expect(await client.listTools()).toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ]);
    expect(await client.callTool("echo", { text: "hi" })).toBe("over http");
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    // The first request has no session yet; every one after the reply carries it.
    expect(requests.map((entry) => entry.session)).toEqual([undefined, "sess-1", "sess-1", "sess-1"]);
    // No process was ever spawned, so stopping is only bookkeeping.
    expect(client.pid).toBeUndefined();
  });

  it("reads an SSE reply and ignores the frames that are not the answer", async () => {
    const server = createHttpServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse", version: "1" } }
            : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        // A progress notification first, then the answer: the reader must skip the one without
        // this id rather than treat the first frame as the reply.
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n\n`);
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const client = new McpClient({ url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {} });
    clients.push(client);
    await client.start();
    expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
  });

  it("reports an HTTP status as the server's failure, not a hung request", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" }).end("no token");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    const client = new McpClient({ url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {} });
    clients.push(client);
    await expect(client.start()).rejects.toThrow(/401 no token/);
  });
});
