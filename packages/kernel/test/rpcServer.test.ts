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
