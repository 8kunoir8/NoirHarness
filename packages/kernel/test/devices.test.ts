import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DeviceService, deviceCookieHeader, parseDeviceCookie } from "../src/devices.js";

const dirs: string[] = [];
const opened: Database.Database[] = [];
function open(file: string): Database.Database {
  const db = openDb(file);
  opened.push(db);
  return db;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir devices "));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withDb(): { devices: DeviceService; dbFile: string } {
  const dbFile = join(tempDir(), "noir.db");
  return { devices: new DeviceService(open(dbFile)), dbFile };
}

describe("device service", () => {
  it("authenticates the cookie it minted and nothing else", () => {
    const { devices } = withDb();
    const { device, cookie } = devices.create("Laptop");
    expect(devices.authenticate(`noir_device=${cookie}`)?.id).toBe(device.id);
    expect(devices.authenticate(`noir_device=${device.id}.${"A".repeat(43)}`)).toBeUndefined();
    expect(devices.authenticate(undefined)).toBeUndefined();
    expect(devices.authenticate("garbage")).toBeUndefined();
  });

  it("stores a hash, not the secret", () => {
    const { devices, dbFile } = withDb();
    const secret = parseDeviceCookie(`noir_device=${devices.create("Laptop").cookie}`)?.secret ?? "";
    const rows = open(dbFile).prepare("SELECT token_hash FROM devices").all();
    expect(secret.length).toBeGreaterThan(32);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("refuses a revoked device from that moment on", () => {
    const { devices } = withDb();
    const { device, cookie } = devices.create("Laptop");
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.authenticate(`noir_device=${cookie}`)).toBeUndefined();
    expect(devices.list()[0]?.revokedAt).not.toBeNull();
    // Revoking twice changes nothing and says so.
    expect(devices.revoke(device.id)).toBe(false);
  });

  it("writes last_seen_at at most once a minute", () => {
    const { devices } = withDb();
    const { device, cookie } = devices.create("Laptop", 1_000);
    devices.authenticate(`noir_device=${cookie}`, 2_000);
    expect(devices.list()[0]?.lastSeenAt).toBe(1_000);
    devices.authenticate(`noir_device=${cookie}`, 61_000);
    expect(devices.list()[0]?.lastSeenAt).toBe(61_000);
    expect(device.id).toBe(devices.list()[0]?.id);
  });

  it("lists newest first and renames in place", () => {
    const { devices } = withDb();
    const first = devices.create("Phone", 1_000).device;
    const second = devices.create("Tablet", 2_000).device;
    expect(devices.list().map((d) => d.id)).toEqual([second.id, first.id]);
    expect(devices.rename(first.id, "Old phone")?.label).toBe("Old phone");
    expect(devices.rename("missing", "x")).toBeUndefined();
  });
});

describe("device cookie", () => {
  it("round-trips through a header with other cookies present", () => {
    const value = `${"a".repeat(36)}.${"b".repeat(43)}`;
    const parsed = parseDeviceCookie(`theme=dark; noir_device=${value}; other=1`);
    expect(parsed).toEqual({ id: "a".repeat(36), secret: "b".repeat(43) });
  });

  it("rejects a truncated value rather than half-parsing it", () => {
    expect(parseDeviceCookie("noir_device=nodot")).toBeUndefined();
    expect(parseDeviceCookie(`noir_device=${"a".repeat(36)}.short`)).toBeUndefined();
  });

  it("sets HttpOnly, SameSite=Strict, a root path and thirty days", () => {
    const header = deviceCookieHeader("value");
    expect(header).toContain("noir_device=value");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=2592000");
  });
});
