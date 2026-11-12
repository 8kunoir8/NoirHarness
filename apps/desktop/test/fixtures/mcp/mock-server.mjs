#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the end-to-end spec: newline-delimited JSON-RPC 2.0 with one `add`
 * tool. It prints nothing but protocol frames, so a stray banner cannot be blamed for a failure.
 */
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name !== "add") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
      return;
    }
    const sum = Number(args?.a) + Number(args?.b);
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(sum) }] } });
  }
  // Notifications (e.g. `notifications/initialized`) carry no id and expect no answer.
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A malformed frame is the client's bug; answering nothing is the honest reply.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
