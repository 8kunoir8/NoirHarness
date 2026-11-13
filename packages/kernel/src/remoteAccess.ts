import { networkInterfaces } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RpcFault, ErrorCodes, type RemotePairResult, type RemoteStatusResult } from "@noir/protocol";
import { createRpcListener, sendHttp, type ClientContext, type Hub, type RpcListener } from "./rpcServer.js";
import { deviceCookieHeader, type DeviceService } from "./devices.js";
import { serveAsset } from "./webAssets.js";
import { ensureCertificate, type StoredCertificate } from "./tls.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 5;
const REDEEM_BODY_BYTES = 1_024;

interface PendingCode {
  code: string;
  expiresAt: number;
  attempts: number;
}

interface RateWindow {
  count: number;
  until: number;
}

function firstLanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

/** Every name a page could legitimately use to reach us. Anything else is DNS rebinding. */
function allowedHosts(): Record<string, true> {
  const hosts: Record<string, true> = {
    localhost: true,
    "127.0.0.1": true,
    "[::1]": true,
  };
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      hosts[entry.family === "IPv6" ? `[${entry.address}]` : entry.address] = true;
    }
  }
  return hosts;
}

function hostnameOf(hostHeader: string): string {
  return hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1).toLowerCase()
    : (hostHeader.split(":")[0] ?? "").toLowerCase();
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A short label a person can recognise in the device list without reading a full UA string. */
function labelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined) return "Browser";
  if (userAgent.includes("iPhone")) return "iPhone";
  if (userAgent.includes("iPad")) return "iPad";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("Macintosh")) return "Mac";
  if (userAgent.includes("Windows")) return "Windows PC";
  if (userAgent.includes("Linux")) return "Linux";
  return "Browser";
}

export interface RemoteAccessOptions {
  hub: Hub;
  devices: DeviceService;
  /** Where the TLS pair lives; the listener cannot start without one. */
  dataDir: string;
  /** The built renderer, when there is one to serve. Without it the listener still pairs. */
  webRoot?: string;
  /** Injected so a test can expire a code without waiting ten minutes. */
  now?: () => number;
}

/**
 * The LAN listener. It does not exist until someone asks for it, and it never sees the runtime
 * token: a browser proves itself with the cookie a pairing code bought it.
 */
export class RemoteAccess {
  private listener: RpcListener | undefined;
  private certificate: StoredCertificate | undefined;
  private pending: PendingCode | undefined;
  private readonly attempts = new Map<string, RateWindow>();
  private hosts: Record<string, true> = allowedHosts();

  constructor(private readonly opts: RemoteAccessOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  status(): RemoteStatusResult {
    const port = this.listener?.port ?? null;
    const address = firstLanAddress();
    return {
      enabled: this.listener !== undefined,
      port,
      url: port !== null && address !== undefined ? `https://${address}:${port}/` : null,
      canServe: this.opts.webRoot !== undefined,
      fingerprint: this.certificate?.fingerprint ?? null,
    };
  }

  async enable(): Promise<RemoteStatusResult> {
    if (this.listener !== undefined) return this.status();
    let certificate: StoredCertificate;
    try {
      certificate = ensureCertificate(this.opts.dataDir);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      throw new RpcFault(ErrorCodes.internal, `cannot write the TLS certificate (${code})`);
    }
    this.hosts = allowedHosts();
    try {
      this.listener = await createRpcListener({
        host: "0.0.0.0",
        hub: this.opts.hub,
        tls: { key: certificate.keyPem, cert: certificate.certPem },
        authorize: (req) => this.authorizeSocket(req),
        handleHttp: (req, res) => this.handleHttp(req, res),
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      throw new RpcFault(ErrorCodes.internal, `cannot listen on the local network (${code})`);
    }
    this.certificate = certificate;
    return this.status();
  }

  async disable(): Promise<void> {
    this.pending = undefined;
    const listener = this.listener;
    this.listener = undefined;
    this.certificate = undefined;
    await listener?.close();
  }

  async close(): Promise<void> {
    await this.disable();
  }

  /** A one-time code, shown once and never logged; a new call replaces the previous code. */
  pair(): RemotePairResult {
    if (this.listener === undefined) throw new RpcFault(ErrorCodes.conflict, "remote access is off");
    const address = firstLanAddress();
    if (address === undefined) throw new RpcFault(ErrorCodes.conflict, "no network address to pair on");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + CODE_TTL_MS;
    this.pending = { code, expiresAt, attempts: 0 };
    return { url: `https://${address}:${this.listener.port}/pair#${code}`, code, expiresAt };
  }

  /** Exposed for the e2e and the pane's countdown; a code neither of them can see is not paired. */
  pendingExpiry(): number | undefined {
    return this.pending?.expiresAt;
  }

  private authorizeSocket(req: IncomingMessage): ClientContext | undefined {
    if (this.guard(req) !== undefined) return undefined;
    const device = this.opts.devices.authenticate(req.headers.cookie);
    if (device === undefined) return undefined;
    // A device is never "local", even from a loopback address: locality is the runtime token.
    return { local: false, deviceId: device.id };
  }

  /** `undefined` when the request may proceed, otherwise the status to answer with. */
  private guard(req: IncomingMessage): number | undefined {
    const host = req.headers.host;
    if (host === undefined || this.hosts[hostnameOf(host)] !== true) return 421;
    const origin = req.headers.origin;
    // Absent Origin means a non-browser client; a present one has to be this very page.
    if (origin !== undefined && origin !== `https://${host}`) return 403;
    return undefined;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const refusal = this.guard(req);
    if (refusal !== undefined) {
      sendHttp(res, refusal, { error: refusal === 421 ? "wrong host" : "wrong origin" });
      return true;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && path === "/pair/redeem") {
      await this.redeem(req, res);
      return true;
    }
    if (this.opts.webRoot !== undefined && serveAsset(req, res, this.opts.webRoot)) return true;
    if (path === "/" || (this.opts.webRoot === undefined && !path.startsWith("/pair"))) {
      sendHttp(res, 404, { error: this.opts.webRoot === undefined ? "no web root configured" : "not found" });
      return true;
    }
    return false;
  }

  private async redeem(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? "unknown";
    if (!this.allowedByRate(remote)) {
      sendHttp(res, 429, { ok: false, error: "too many attempts" });
      return;
    }
    let body: unknown;
    try {
      body = await readSmallBody(req, REDEEM_BODY_BYTES);
    } catch {
      sendHttp(res, 400, { ok: false });
      return;
    }
    const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    if (typeof code !== "string" || code.length === 0) {
      sendHttp(res, 400, { ok: false });
      return;
    }
    const pending = this.pending;
    if (pending === undefined || pending.expiresAt <= this.now()) {
      this.pending = undefined;
      sendHttp(res, 401, { ok: false, error: "no pairing code" });
      return;
    }
    if (!sameSecret(code, pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_MAX_ATTEMPTS) this.pending = undefined;
      sendHttp(res, 401, { ok: false, error: "wrong code" });
      return;
    }
    this.pending = undefined;
    const { device, cookie } = this.opts.devices.create(labelFromUserAgent(req.headers["user-agent"]));
    const payload = JSON.stringify({ ok: true, deviceId: device.id });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "set-cookie": deviceCookieHeader(cookie, { secure: true }),
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(payload);
  }

  private allowedByRate(remote: string): boolean {
    const now = this.now();
    const window = this.attempts.get(remote);
    if (window === undefined || window.until <= now) {
      this.attempts.set(remote, { count: 1, until: now + IP_WINDOW_MS });
      return true;
    }
    if (window.count >= IP_MAX_ATTEMPTS) return false;
    window.count += 1;
    return true;
  }
}

async function readSmallBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  return JSON.parse(text);
}
