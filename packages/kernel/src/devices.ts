import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const DEVICE_COOKIE = "noir_device";
/** Thirty days; the pane says so, and revocation does not wait for it. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TOUCH_INTERVAL_MS = 60_000;

export interface Device {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

interface DeviceRow {
  id: string;
  label: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function hashMatches(secret: string, expected: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** The cookie value is `<id>.<secret>`; the secret never lands in the database. */
export function parseDeviceCookie(header: string | undefined): { id: string; secret: string } | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== DEVICE_COOKIE) continue;
    const value = trimmed.slice(eq + 1);
    const dot = value.indexOf(".");
    if (dot !== 36) return undefined;
    const id = value.slice(0, dot);
    const secret = value.slice(dot + 1);
    if (secret.length < 32) return undefined;
    return { id, secret };
  }
  return undefined;
}

export function deviceCookieHeader(value: string): string {
  return `${DEVICE_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

/**
 * Paired browsers. The row is the authority: a revoked device fails authentication on the next
 * request and has its open sockets closed by the caller.
 */
export class DeviceService {
  constructor(private readonly db: Database.Database) {}

  create(label: string, now = Date.now()): { device: Device; cookie: string } {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO devices (id, label, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, label, hashSecret(secret), now, now);
    return { device: { id, label, createdAt: now, lastSeenAt: now, revokedAt: null }, cookie: `${id}.${secret}` };
  }

  /** An unknown, revoked, or wrong-secret cookie is the same answer: not a device. */
  authenticate(cookie: string | undefined, now = Date.now()): Device | undefined {
    const parsed = parseDeviceCookie(cookie);
    if (parsed === undefined) return undefined;
    const row = this.db
      .prepare("SELECT id, label, token_hash, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?")
      .get(parsed.id) as DeviceRow | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    if (!hashMatches(parsed.secret, row.token_hash)) return undefined;
    // One write a minute per device keeps a polling browser off the write path.
    if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
      row.last_seen_at = now;
    }
    return toDevice(row);
  }

  list(): Device[] {
    const rows = this.db
      .prepare("SELECT id, label, token_hash, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at DESC")
      .all() as DeviceRow[];
    return rows.map(toDevice);
  }

  revoke(id: string, now = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, id);
    return result.changes > 0;
  }
}
