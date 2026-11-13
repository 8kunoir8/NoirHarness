import { timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ZodError } from "zod";
import { ErrorCodes, JsonRpcRequest, RpcFault, toRpcFailure, type AgentEvent } from "@noir/protocol";

export type Handler = (params: unknown) => Promise<unknown>;

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // The socket closed between the readyState check and the write.
  }
}

export interface RpcServer {
  port: number;
  close(): Promise<void>;
  broadcast(event: AgentEvent): void;
}

export async function startRpcServer(opts: { token: string; handlers: Record<string, Handler>; buildId?: string | null }): Promise<RpcServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!tokenMatches(url.searchParams.get("token") ?? "", opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      let id: string | number = 0;
      try {
        const parsed = JsonRpcRequest.parse(JSON.parse(String(raw)));
        id = parsed.id;
        const handler = opts.handlers[parsed.method];
        if (!handler) throw new RpcFault(ErrorCodes.methodNotFound, `Unknown method: ${parsed.method}`);
        const result = await handler(parsed.params);
        sendJson(ws, { jsonrpc: "2.0", id, result });
      } catch (error) {
        const fault = error instanceof ZodError
          ? new RpcFault(ErrorCodes.invalidParams, error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; "))
          : error;
        sendJson(ws, toRpcFailure(id, fault));
      }
    });
  });
  http.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendHttp(res, 200, { status: "ok", pid: process.pid, buildId: opts.buildId ?? null });
      return;
    }
    sendHttp(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;

  return {
    port,
    broadcast(event) {
      const message = { jsonrpc: "2.0", method: "event", params: { event } };
      for (const client of clients) sendJson(client, message);
    },
    async close() {
      for (const client of clients) client.close();
      const wssClosed = Promise.withResolvers<void>();
      wss.close(() => wssClosed.resolve());
      await wssClosed.promise;
      const httpClosed = Promise.withResolvers<void>();
      http.close(() => httpClosed.resolve());
      // An idle keep-alive socket a client left open would otherwise hold the close callback.
      http.closeAllConnections();
      await httpClosed.promise;
    },
  };
}

/**
 * `connection: close` is not decoration: keep-alives make `http.close()` wait for the client, and a
 * health check that hangs shutdown is worse than no health check.
 */
function sendHttp(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
}
