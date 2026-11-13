import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { DeviceService } from "../src/devices.js";
import { RemoteAccess } from "../src/remoteAccess.js";
import { createHub } from "../src/rpcServer.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The LAN listener is TLS-only; `plain` is the downgrade that must not work. */
function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string; plain?: boolean },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = opts.plain === true ? httpRequest : httpsRequest;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers ?? {},
        ...(opts.plain === true ? {} : { rejectUnauthorized: false }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function service(): { devices: DeviceService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "noir remote "));
  dirs.push(dir);
  const db = openDb(join(dir, "noir.db"));
  dbs.push(db);
  return { devices: new DeviceService(db), dir };
}

async function enabled(
  now?: () => number,
  webRoot?: string,
): Promise<{ remote: RemoteAccess; port: number; devices: DeviceService }> {
  const { devices, dir: dataDir } = service();
  const remote = new RemoteAccess({
    hub: createHub({}),
    devices,
    dataDir,
    ...(now === undefined ? {} : { now }),
    ...(webRoot === undefined ? {} : { webRoot }),
  });
  closes.push(() => remote.close());
  await remote.enable();
  const status = remote.status();
  if (status.port === null) throw new Error("listener did not start");
  return { remote, port: status.port, devices };
}

describe("remote access", () => {
  it("is off until it is asked for", async () => {
    const { devices, dir } = service();
    const remote = new RemoteAccess({ hub: createHub({}), devices, dataDir: dir });
    expect(remote.status()).toMatchObject({ enabled: false, port: null, url: null, canServe: false, fingerprint: null });
    await remote.enable();
    expect(remote.status().enabled).toBe(true);
    expect(remote.status().port).toBeGreaterThan(0);
    await remote.disable();
    expect(remote.status().enabled).toBe(false);
  });

  it("speaks TLS and nothing else", async () => {
    const { port } = await enabled();
    const page = await send(port, { path: "/" });
    expect(page.status).toBe(404);
    // The same request in plaintext never reaches the application at all.
    await expect(send(port, { path: "/", plain: true })).rejects.toThrow();
  });

  it("reports a fingerprint once the certificate exists", async () => {
    const { remote } = await enabled();
    expect(remote.status().fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(remote.status().url ?? "").toContain("https://");
  });

  it("does not answer the control plane on the network", async () => {
    const { port } = await enabled();
    expect((await send(port, { path: "/health" })).status).toBe(404);
    expect((await send(port, { method: "POST", path: "/shutdown", body: "{}" })).status).toBe(404);
  });

  it("refuses a host that is not this machine", async () => {
    const { port } = await enabled();
    const reply = await send(port, { path: "/pair/redeem", headers: { host: "evil.example" } });
    expect(reply.status).toBe(421);
  });

  it("refuses a foreign origin", async () => {
    const { port } = await enabled();
    const reply = await send(port, {
      method: "POST",
      path: "/pair/redeem",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ code: "x" }),
    });
    expect(reply.status).toBe(403);
  });

  it("mints a device from a code, once", async () => {
    const { remote, port, devices } = await enabled();
    const { code } = remote.pair();
    const host = `127.0.0.1:${port}`;
    const first = await send(port, {
      method: "POST",
      path: "/pair/redeem",
      headers: { "content-type": "application/json", host },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const cookie = first.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Issued over TLS, so the browser may only send it back over TLS.
    expect(cookie).toContain("Secure");
    expect(devices.list()).toHaveLength(1);

    const second = await send(port, {
      method: "POST",
      path: "/pair/redeem",
      headers: { "content-type": "application/json", host },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(401);
  });

  it("burns the code after five wrong attempts", async () => {
    let clock = 1_000_000;
    const { remote, port } = await enabled(() => clock);
    const { code } = remote.pair();
    const host = `127.0.0.1:${port}`;
    const attempt = async (guess: string): Promise<number> => {
      // Step past the per-IP window so the burn rule, not the rate limit, is what answers.
      clock += 61_000;
      const reply = await send(port, {
        method: "POST",
        path: "/pair/redeem",
        headers: { "content-type": "application/json", host },
        body: JSON.stringify({ code: guess }),
      });
      return reply.status;
    };
    for (let i = 0; i < 5; i += 1) expect(await attempt("wrong")).toBe(401);
    // The right code is worthless once the budget is gone.
    expect(await attempt(code)).toBe(401);
  });

  it("expires a code after ten minutes", async () => {
    let clock = 1_000_000;
    const { remote, port } = await enabled(() => clock);
    const { code } = remote.pair();
    clock += 10 * 60 * 1000 + 1;
    const reply = await send(port, {
      method: "POST",
      path: "/pair/redeem",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({ code }),
    });
    expect(reply.status).toBe(401);
  });

  it("rate-limits one address to five attempts a minute", async () => {
    const { port } = await enabled();
    const host = `127.0.0.1:${port}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (
          await send(port, {
            method: "POST",
            path: "/pair/redeem",
            headers: { "content-type": "application/json", host },
            body: JSON.stringify({ code: "wrong" }),
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("serves the shell to a stranger and the API to nobody", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noir remote shell "));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>harness</title>");
    const { port, remote } = await enabled(undefined, dir);
    expect(remote.status().canServe).toBe(true);

    const page = await send(port, { path: "/" });
    expect(page.status).toBe(200);
    expect(page.body).toContain("harness");
    expect(page.headers["cache-control"]).toBe("no-store");

    // The page itself is public; the socket it opens is not.
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("says so when there is no shell to serve", async () => {
    const { port } = await enabled();
    const reply = await send(port, { path: "/" });
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toEqual({ error: "no web root configured" });
  });

  it("only opens a socket for a paired cookie", async () => {
    const { remote, port, devices } = await enabled();
    const cookie = `noir_device=${devices.create("Laptop").cookie}`;
    const host = `127.0.0.1:${port}`;
    const open = (headers: Record<string, string>): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://${host}/`, { headers, rejectUnauthorized: false });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    await expect(open({})).rejects.toThrow();
    const ws = await open({ cookie, origin: `https://${host}` });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    expect(remote.status().enabled).toBe(true);
  });
});
