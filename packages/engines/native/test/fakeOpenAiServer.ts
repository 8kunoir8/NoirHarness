import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One model response: streamed text, one tool call (arguments split into fragments), and a finish reason. */
export type ScriptStep = {
  text?: string;
  toolCall?: { id: string; name: string; args: string };
  finish?: string;
  /** Hold the stream open this long before answering, so a turn can be interrupted or timed out. */
  delayMs?: number;
  /** Omit the trailing usage chunk, so the engine has to estimate the token counts itself. */
  omitUsage?: boolean;
};

export interface FakeOpenAiServer {
  baseUrl: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** Answers one request with the next scripted step, as the SSE frames the engine parses. */
async function respond(step: ScriptStep, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // A client that gave up mid-stream closes the socket; a late write must not fault the server.
  res.on("error", () => undefined);
  const send = (payload: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (step.delayMs !== undefined) {
    const delayed = Promise.withResolvers<void>();
    setTimeout(delayed.resolve, step.delayMs);
    await delayed.promise;
  }
  if (step.text !== undefined && step.text !== "") {
    send({ choices: [{ delta: { content: step.text } }] });
  }
  if (step.toolCall !== undefined) {
    const { id, name, args } = step.toolCall;
    const half = Math.ceil(args.length / 2);
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, type: "function", function: { name, arguments: args.slice(0, half) } },
            ],
          },
        },
      ],
    });
    send({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }],
    });
  }
  send({
    choices: [
      {
        delta: {},
        finish_reason: step.finish ?? (step.toolCall === undefined ? "stop" : "tool_calls"),
      },
    ],
  });
  if (step.omitUsage !== true) {
    send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * A minimal OpenAI-compatible chat-completions server: every request consumes the next script
 * step and is answered with SSE frames. Tool-call arguments arrive in two fragments so the
 * engine's index-keyed assembly is exercised rather than bypassed.
 */
export async function startFakeOpenAiServer(script: ScriptStep[]): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiServer["requests"] = [];
  let next = 0;

  // `createServer` ignores the handler's promise, so the discard is explicit. A request the fake
  // cannot answer must fail in the test, not hang it: the body below owns its own failure and answers
  // 500, because a rejection nobody awaits would leave the client waiting on a response forever.
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const raw = await readBody(req);
        requests.push({
          path: req.url ?? "",
          body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
        await respond(script[next++] ?? { finish: "stop" }, res);
      } catch (error) {
        // The response is closed either way: a request the fake cannot answer fails where the test
        // can see it, instead of leaving the client waiting on a reply that never comes.
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
