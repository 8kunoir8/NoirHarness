import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { ZodError } from "zod";
import { ErrorCodes, JsonRpcRequest, RpcFault, toRpcFailure, type AgentEvent } from "@noir/protocol";

/** What the kernel knows about the peer behind a socket: this machine, or a paired device. */
export interface ClientContext {
  /** The peer is on this machine and proved it with the runtime token. */
  local: boolean;
  deviceId?: string;
}

export type Handler = (params: unknown, ctx?: ClientContext) => Promise<unknown>;

/**
 * Shared by every listener a kernel runs: one handler map, one client set, so a browser and the
 * desktop window see the same session list and the same event stream.
 */
export interface Hub {
  handlers: Record<string, Handler>;
  clients: Map<WebSocket, ClientContext>;
  broadcast(event: AgentEvent): void;
}

export function createHub(handlers: Record<string, Handler>): Hub {
  const clients = new Map<WebSocket, ClientContext>();
  return {
    handlers,
    clients,
    broadcast(event) {
      const message = { jsonrpc: "2.0", method: "event", params: { event } };
      for (const client of clients.keys()) sendJson(client, message);
    },
  };
}

export interface ListenerOptions {
  host: string;
  hub: Hub;
  /** Decide a socket's identity; `undefined` refuses the upgrade. */
  authorize(req: IncomingMessage, local: boolean): ClientContext | undefined;
  /** Answer a plain HTTP request. `false` leaves it to the caller's 404. */
  handleHttp(req: IncomingMessage, res: ServerResponse, local: boolean): Promise<boolean>;
}

export interface RpcListener {
  port: number;
  close(): Promise<void>;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `::1` and `::ffff:127.0.0.1` are the same machine as `127.0.0.1`. */
export function isLoopback(remote: string | undefined): boolean {
  if (remote === undefined) return false;
  return remote === "::1" || remote === "127.0.0.1" || remote === "::ffff:127.0.0.1";
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // The socket closed between the readyState check and the write.
  }
}

/**
 * One listening socket. The loopback listener and the optional LAN listener are the same thing with
 * a different `authorize` and a different `handleHttp`, so a rule cannot drift between them.
 */
export async function createRpcListener(opts: ListenerOptions): Promise<RpcListener> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const open = (ws: WebSocket, ctx: ClientContext): void => {
    sockets.add(ws);
    opts.hub.clients.set(ws, ctx);
    const forget = (): void => {
      sockets.delete(ws);
      opts.hub.clients.delete(ws);
    };
    ws.on("close", forget);
    ws.on("error", forget);
    ws.on("message", async (raw) => {
      let id: string | number = 0;
      try {
        const parsed = JsonRpcRequest.parse(JSON.parse(String(raw)));
        id = parsed.id;
        const handler = opts.hub.handlers[parsed.method];
        if (!handler) throw new RpcFault(ErrorCodes.methodNotFound, `Unknown method: ${parsed.method}`);
        const result = await handler(parsed.params, ctx);
        sendJson(ws, { jsonrpc: "2.0", id, result });
      } catch (error) {
        const fault = error instanceof ZodError
          ? new RpcFault(ErrorCodes.invalidParams, error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; "))
          : error;
        sendJson(ws, toRpcFailure(id, fault));
      }
    });
  };

  http.on("upgrade", (req, socket, head) => {
    const ctx = opts.authorize(req, isLoopback((socket as Socket).remoteAddress));
    if (ctx === undefined) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => open(ws, ctx));
  });
  http.on("request", (req, res) => {
    void opts.handleHttp(req, res, isLoopback(req.socket.remoteAddress))
      .then((handled) => {
        if (!handled) sendHttp(res, 404, { error: "not found" });
      })
      .catch(() => {
        // A route that threw still owes the client an answer, unless it already gave one.
        if (!res.headersSent) sendHttp(res, 500, { error: "internal" });
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, opts.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");

  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.close();
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

export interface RpcServer extends RpcListener {
  broadcast(event: AgentEvent): void;
  hub: Hub;
}

/** What the control plane needs to know about a stop request; the kernel owns the policy. */
export interface ShutdownDecision {
  stop: boolean;
  live: number;
}

export interface RpcOptions {
  token: string;
  handlers: Record<string, Handler>;
  /** Share an existing hub when another listener is going to join it. */
  hub?: Hub;
  buildId?: string | null;
  requestShutdown?: (force: boolean) => ShutdownDecision;
  onStopped?: () => void;
}

/** The loopback listener: runtime token on the upgrade, Bearer token on the one route that stops us. */
export async function startRpcServer(opts: RpcOptions): Promise<RpcServer> {
  const hub = opts.hub ?? createHub(opts.handlers);
  const listener = await createRpcListener({
    host: "127.0.0.1",
    hub,
    authorize: (req) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const provided = url.searchParams.get("token") ?? "";
      return tokenMatches(provided, opts.token) ? { local: true } : undefined;
    },
    handleHttp: (req, res) => handleHttp(req, res, opts, "127.0.0.1"),
  });
  return {
    port: listener.port,
    hub,
    broadcast: (event) => hub.broadcast(event),
    close: () => listener.close(),
  };
}

/** The control plane: two routes, one of which can end this process. */
async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: RpcOptions, base: string): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${base}`);
  if (req.method === "GET" && url.pathname === "/health") {
    sendHttp(res, 200, { status: "ok", pid: process.pid, buildId: opts.buildId ?? null });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!tokenMatches(provided, opts.token)) {
      sendHttp(res, 401, { stopped: false });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendHttp(res, 400, { stopped: false });
      return true;
    }
    const force = typeof body === "object" && body !== null && "force" in body && body.force === true;
    const decision = opts.requestShutdown?.(force) ?? { stop: false, live: 0 };
    if (!decision.stop) {
      sendHttp(res, 409, { stopped: false, live: decision.live });
      return true;
    }
    // Attach before the reply flushes: `finish` can fire on the next tick.
    res.once("finish", () => opts.onStopped?.());
    sendHttp(res, 200, { stopped: true });
    return true;
  }
  return false;
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
export function sendHttp(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
}
