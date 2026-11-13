import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AgentEvent } from "@noir/protocol";
import { startRpcServer, type RpcServer } from "../src/rpcServer.js";

let server: RpcServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function call(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
  });
}

function waitClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once("close", () => resolve());
  });
}

describe("rpc server", () => {
  it("rejects a bad token", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    await expect(connect(server.port, "bad")).rejects.toThrow();
  });

  it("answers a health call", async () => {
    server = await startRpcServer({ token: "good", handlers: { "system.health": async () => ({ ok: true }) } });
    const ws = await connect(server.port, "good");
    const res = await call(ws, "system.health");
    expect(res.result).toEqual({ ok: true });
    ws.close();
  });

  it("returns method not found", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    const ws = await connect(server.port, "good");
    const res = await call(ws, "nope");
    expect(res.error.code).toBe(-32601);
    ws.close();
  });

  it("never echoes the token in an error", async () => {
    server = await startRpcServer({ token: "super-secret-token", handlers: { "boom": async () => { throw new Error("x"); } } });
    const ws = await connect(server.port, "super-secret-token");
    const res = await call(ws, "boom");
    expect(JSON.stringify(res)).not.toContain("super-secret-token");
    ws.close();
  });

  it("broadcasts events to every open client", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    const first = await connect(server.port, "good");
    const second = await connect(server.port, "good");
    const event: AgentEvent = {
      v: 1, id: "evt-1", seq: 1, ts: 0, sessionId: "s1", agentId: "a1",
      type: "session.created", payload: { title: "t" },
      provenance: { engine: "native", engineName: "test", adapterVersion: "0" },
    };
    const frame = { jsonrpc: "2.0", method: "event", params: { event } };

    const firstGot = nextMessage(first);
    const secondGot = nextMessage(second);
    server.broadcast(event);
    expect(await firstGot).toEqual(frame);
    expect(await secondGot).toEqual(frame);

    const closed = waitClose(first);
    first.close();
    await closed;

    const remainingGot = nextMessage(second);
    server.broadcast(event);
    expect(await remainingGot).toEqual(frame);
    second.close();
  });
});
async function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: "close" } });
  return { status: res.status, body: await res.json() };
}

describe("http control plane", () => {
  it("answers /health with the pid and build id", async () => {
    server = await startRpcServer({ token: "good", handlers: {}, buildId: "abc123" });
    const res = await httpGet(server.port, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", pid: process.pid, buildId: "abc123" });
  });

  it("never leaks the token on /health", async () => {
    server = await startRpcServer({ token: "super-secret-token", handlers: {}, buildId: "abc123" });
    const res = await httpGet(server.port, "/health");
    expect(JSON.stringify(res.body)).not.toContain("super-secret-token");
  });

  it("is 404 for any other request, even with a good token", async () => {
    server = await startRpcServer({ token: "good", handlers: {}, buildId: "abc123" });
    expect((await httpGet(server.port, "/?token=good")).status).toBe(404);
    expect((await httpGet(server.port, "/nope")).status).toBe(404);
  });

  it("reports a null build id when the caller has none", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    const res = await httpGet(server.port, "/health");
    expect(res.body).toEqual({ status: "ok", pid: process.pid, buildId: null });
  });
});
async function shutdown(port: number, token: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json", connection: "close" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("POST /shutdown", () => {
  it("rejects a missing or wrong token", async () => {
    server = await startRpcServer({ token: "good", handlers: {}, requestShutdown: () => ({ stop: true, live: 0 }) });
    expect((await shutdown(server.port, undefined, { force: false })).status).toBe(401);
    expect((await shutdown(server.port, "bad", { force: false })).status).toBe(401);
  });

  it("refuses while a session is live and says how many", async () => {
    let called = 0;
    server = await startRpcServer({
      token: "good",
      handlers: {},
      requestShutdown: (force) => {
        called += 1;
        expect(force).toBe(false);
        return { stop: false, live: 2 };
      },
      onStopped: () => { throw new Error("must not stop"); },
    });
    const res = await shutdown(server.port, "good", { force: false });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ stopped: false, live: 2 });
    expect(called).toBe(1);
  });

  it("stops when forced and fires onStopped after the reply", async () => {
    const order: string[] = [];
    server = await startRpcServer({
      token: "good",
      handlers: {},
      requestShutdown: (force) => {
        order.push(`request:${String(force)}`);
        return { stop: true, live: 2 };
      },
      onStopped: () => order.push("stopped"),
    });
    const res = await shutdown(server.port, "good", { force: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stopped: true });
    expect(order).toEqual(["request:true", "stopped"]);
  });

  it("rejects a body that is not JSON", async () => {
    server = await startRpcServer({ token: "good", handlers: {}, requestShutdown: () => ({ stop: true, live: 0 }) });
    const res = await fetch(`http://127.0.0.1:${server.port}/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json", connection: "close" },
      body: "nonsense",
    });
    expect(res.status).toBe(400);
  });
});
