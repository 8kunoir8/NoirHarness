import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One model response: streamed text, one tool call (arguments split into fragments), and a finish reason. */
export type ScriptStep = {
  text?: string;
  toolCall?: { id: string; name: string; args: string };
  finish?: string;
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

/**
 * A minimal OpenAI-compatible chat-completions server: every request consumes the next script
 * step and is answered with SSE frames. Tool-call arguments arrive in two fragments so the
 * engine's index-keyed assembly is exercised rather than bypassed.
 */
export async function startFakeOpenAiServer(script: ScriptStep[]): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiServer["requests"] = [];
  let next = 0;

  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    requests.push({
      path: req.url ?? "",
      body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
    });
    const step = script[next++] ?? { finish: "stop" };

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

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
    send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } });
    res.write("data: [DONE]\n\n");
    res.end();
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
