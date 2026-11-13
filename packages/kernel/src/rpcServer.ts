import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/** What the control plane needs to know about a stop request; the kernel owns the policy. */
export interface ShutdownDecision {
  stop: boolean;
  live: number;
}

export interface RpcOptions {
  token: string;
  handlers: Record<string, Handler>;
  buildId?: string | null;
  requestShutdown?: (force: boolean) => ShutdownDecision;
  /** Called once the `200` has flushed, so the caller learns the stop was accepted. */
  onStopped?: () => void;
}

export async function startRpcServer(opts: RpcOptions): Promise<RpcServer> {
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
    void handleHttp(req, res, opts);
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

/** The control plane: two routes, one of which can end this process. */
async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: RpcOptions): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    sendHttp(res, 200, { status: "ok", pid: process.pid, buildId: opts.buildId ?? null });
    return;
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!tokenMatches(provided, opts.token)) {
      sendHttp(res, 401, { stopped: false });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendHttp(res, 400, { stopped: false });
      return;
    }
    const force = typeof body === "object" && body !== null && "force" in body && body.force === true;
    const decision = opts.requestShutdown?.(force) ?? { stop: false, live: 0 };
    if (!decision.stop) {
      sendHttp(res, 409, { stopped: false, live: decision.live });
      return;
    }
    // Attach before the reply flushes: `finish` can fire on the next tick.
    res.once("finish", () => opts.onStopped?.());
    sendHttp(res, 200, { stopped: true });
    return;
  }
  sendHttp(res, 404, { error: "not found" });
}

/** Bodies here are `{force}`; anything larger is not this route's client. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > 4_096) throw new Error("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
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
