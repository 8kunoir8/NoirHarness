import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ErrorCodes, JsonRpcRequest, RpcFault, toRpcFailure, type AgentEvent } from "@noir/protocol";

export type Handler = (params: unknown) => Promise<unknown>;

export interface RpcServer {
  port: number;
  close(): Promise<void>;
  broadcast(event: AgentEvent): void;
}

export async function startRpcServer(opts: { token: string; handlers: Record<string, Handler> }): Promise<RpcServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== opts.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      let id: string | number = 0;
      try {
        const parsed = JsonRpcRequest.parse(JSON.parse(String(raw)));
        id = parsed.id;
        const handler = opts.handlers[parsed.method];
        if (!handler) throw new RpcFault(ErrorCodes.methodNotFound, `Unknown method: ${parsed.method}`);
        const result = await handler(parsed.params);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (error) {
        ws.send(JSON.stringify(toRpcFailure(id, error)));
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;

  return {
    port,
    broadcast(event) {
      const message = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event } });
      for (const client of clients) if (client.readyState === client.OPEN) client.send(message);
    },
    async close() {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
