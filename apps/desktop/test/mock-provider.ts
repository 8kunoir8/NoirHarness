import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Minimal OpenAI-compatible completions endpoint for the e2e specs.
 *
 * It exists so a real `omp acp` process can be driven through the whole app: the engine spawns,
 * reads its profile, posts here, and streams the result back over ACP. Only what the engine
 * actually sends is handled; anything else is a 404 so a wrong URL fails loudly.
 *
 * Prompt text selects the script: `tool` asks for a bash call, `ntool` asks for a `shell.exec`
 * call whose arguments arrive split across two frames (the native engine's reassembly path),
 * `slow` streams for ~6s so a spec can queue a second prompt and interrupt, and `queued`
 * answers with a distinct reply.
 */
export interface MockProvider {
  /** `http://127.0.0.1:<port>/v1` — the base URL the provider form expects. */
  url: string;
  /** Every request path seen, in arrival order (e.g. `/v1/chat/completions`). */
  requests: string[];
  /** True once a `role: "tool"` message reached the provider. */
  toolMessageSeen(): boolean;
  /** Every user prompt the engine sent, in arrival order. */
  prompts(): string[];
  /**
   * The `messages` array of every POSTed request body, in arrival order. `[0]` is the cold-start
   * request, which is where a duplicated or dropped user prompt would show up.
   */
  requestMessages(): MockMessage[][];
  close(): Promise<void>;
}

export interface MockMessage {
  role?: unknown;
  content?: unknown;
}

type WireMessage = MockMessage;

const MODELS_URL_PATH = "/v1/chat/completions";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function lastUserText(messages: WireMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "user") return messageText(message.content);
  }
  return "";
}

function chunk(delta: unknown, finishReason: string | null): string {
  const frame = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "mock-1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const parts: Buffer[] = [];
  req.on("data", (chunkData: Buffer) => parts.push(chunkData));
  req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  req.on("error", reject);
  return promise;
}

function parseMessages(raw: string): WireMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("messages" in parsed)) return [];
    const messages = parsed.messages;
    if (!Array.isArray(messages)) return [];
    return messages.filter((message): message is WireMessage => typeof message === "object" && message !== null);
  } catch {
    return [];
  }
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: string[] = [];
  const prompts: string[] = [];
  const bodies: MockMessage[][] = [];
  const sockets = new Set<Socket>();
  let toolMessageSeen = false;

  const server = createServer((req, res) => {
    requests.push(req.url ?? "");

    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== MODELS_URL_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    void readBody(req)
      .then(async (raw) => {
        const messages = parseMessages(raw);
        bodies.push(messages);
        const hasToolMessage = messages.some((message) => message.role === "tool");
        if (hasToolMessage) toolMessageSeen = true;
        const prompt = lastUserText(messages);
        prompts.push(prompt);

        startSse(res);
        res.on("error", () => undefined);

        // Before the `tool` branches: `ntool` contains `tool`, and the native engine answers
        // `shell.exec` where the ACP engine answers `bash`.
        if (prompt.includes("ntool")) {
          if (hasToolMessage) {
            res.write(chunk({ role: "assistant", content: "native tool finished" }, null));
            res.write(chunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          // One call whose arguments JSON is split across two frames: the native loop must
          // concatenate fragments by `index` before it can parse the shell command.
          res.write(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_native_1",
                    type: "function",
                    function: { name: "shell.exec", arguments: "{\"comm" },
                  },
                ],
              },
              null,
            ),
          );
          res.write(
            chunk({ tool_calls: [{ index: 0, function: { arguments: "and\":\"echo hi\"}" } }] }, null),
          );
          res.write(chunk({}, "tool_calls"));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // `mtool` owns the MCP round trip; it must precede the `tool` branches that it contains.
        if (prompt.includes("mtool")) {
          if (hasToolMessage) {
            res.write(chunk({ role: "assistant", content: "mcp tool finished" }, null));
            res.write(chunk({}, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mcp_1",
                    type: "function",
                    function: {
                      name: "mcp__calc__add",
                      arguments: JSON.stringify({ a: 4, b: 5 }),
                    },
                  },
                ],
              },
              "tool_calls",
            ),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (prompt.includes("slow")) {
          // Stream long enough for a spec to queue a second prompt and interrupt this turn.
          res.write(chunk({ role: "assistant", content: "slow " }, null));
          for (let step = 0; step < 40 && !res.destroyed; step += 1) {
            await delay(150);
            if (res.destroyed) return;
            res.write(chunk({ content: `${step} ` }, null));
          }
          if (res.destroyed) return;
          res.write(chunk({}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // The tool follow-up resends the whole transcript, so a tool result only explains this
        // request: a later prompt still gets its own scripted reply.
        if (hasToolMessage && prompt.includes("tool")) {
          res.write(chunk({ role: "assistant", content: "tool finished" }, null));
          res.write(chunk({}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        if (prompt.includes("tool")) {
          res.write(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
                  },
                ],
              },
              "tool_calls",
            ),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const reply = prompt.includes("queued") ? "queued reply." : "Hello from mock.";
        res.write(chunk({ role: "assistant", content: reply }, null));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock provider failed" } }));
      });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("mock provider did not bind a TCP port");
  }
  const { port } = address as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    toolMessageSeen: () => toolMessageSeen,
    prompts: () => [...prompts],
    requestMessages: () => bodies.map((messages) => [...messages]),
    close: () => {
      const closed = Promise.withResolvers<void>();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
