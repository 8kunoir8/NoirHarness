import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/**
 * A self-signed certificate, encoded by hand: `node:crypto` mints keys and signs bytes, but nothing
 * in Node emits X.509, and `openssl` is not something to require on a Windows desktop. This is the
 * smallest v3 certificate a browser accepts for `https://<ip>:<port>/`.
 */

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const DAYS = 5 * 365;
const VALIDITY_SKEW_MS = 24 * 60 * 60 * 1000;

function lengthOf(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  let rest = size;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function setOf(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function octets(body: Buffer): Buffer {
  return tlv(0x04, body);
}

function bitString(body: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
}

function explicit(tag: number, body: Buffer): Buffer {
  return tlv(0xa0 + tag, body);
}

function boolean(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

/** Minimal, positive: leading zero bytes dropped, one added when the top bit would read as negative. */
function integer(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  let body = raw.subarray(start);
  if ((body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((arc) => Number.parseInt(arc, 10));
  const first = arcs.shift();
  const second = arcs.shift();
  if (first === undefined || second === undefined) throw new Error("bad oid");
  const bytes: number[] = [first * 40 + second];
  for (const arc of arcs) {
    const chunk: number[] = [];
    let rest = arc;
    do {
      chunk.unshift(rest & 0x7f);
      rest = Math.floor(rest / 128);
    } while (rest > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(when: Date): Buffer {
  const iso = when.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${iso}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return sequence(setOf(sequence(oid(OID_CN), utf8(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(oid(id), boolean(true), octets(value))
    : sequence(oid(id), octets(value));
}

function ipBytes(address: string): Buffer | undefined {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    return Buffer.from(address.split(".").map((part) => Number.parseInt(part, 10)));
  }
  return undefined;
}

/** Every address this machine can be reached at on a LAN, minus the ones nobody browses to. */
export function localHosts(): { hostnames: string[]; addresses: string[] } {
  const addresses: string[] = ["127.0.0.1"];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      addresses.push(entry.address);
    }
  }
  return { hostnames: ["localhost"], addresses };
}

export interface GeneratedCertificate {
  certPem: string;
  keyPem: string;
  /** Exposed so a test can verify the signature against the public half. */
  tbs: Buffer;
  signature: Buffer;
  publicKey: KeyObject;
}

export function generateCertificate(opts: { commonName: string; hostnames: string[]; addresses: string[] }): GeneratedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algo = sequence(oid(OID_ECDSA_SHA256));
  const subject = name(opts.commonName);
  const notBefore = new Date(Date.now() - VALIDITY_SKEW_MS);
  const notAfter = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000);

  const names: Buffer[] = [];
  for (const hostname of opts.hostnames) names.push(tlv(0x82, Buffer.from(hostname, "ascii")));
  for (const address of opts.addresses) {
    const bytes = ipBytes(address);
    if (bytes !== undefined) names.push(tlv(0x87, bytes));
    else names.push(tlv(0x82, Buffer.from(address, "ascii")));
  }

  const extensions = sequence(
    extension(OID_BASIC_CONSTRAINTS, true, sequence()),
    extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]))),
    extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH))),
    extension(OID_SUBJECT_ALT_NAME, false, sequence(...names)),
  );

  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    algo,
    subject,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    explicit(3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);

  const certPem = pem("CERTIFICATE", sequence(tbs, algo, bitString(signature)));
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  const keyPem = typeof exported === "string" ? exported : exported.toString("utf8");
  return { certPem, keyPem, tbs, signature, publicKey };
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Colon-separated uppercase hex, the form every browser shows next to a certificate warning. */
export function certificateFingerprint(certPem: string): string {
  const der = new X509Certificate(certPem).raw;
  return createHash("sha256")
    .update(der)
    .digest("hex")
    .toUpperCase()
    .replace(/(..)(?=.)/g, "$1:");
}

/** True while the certificate is valid and names every address the pane might advertise. */
export function certificateCovers(certPem: string, hosts: { hostnames: string[]; addresses: string[] }): boolean {
  try {
    const cert = new X509Certificate(certPem);
    if (Date.parse(cert.validTo) - Date.now() < VALIDITY_SKEW_MS) return false;
    if (!hosts.hostnames.every((host) => cert.checkHost(host) !== undefined)) return false;
    return hosts.addresses.every((address) => cert.checkIP(address) !== undefined);
  } catch {
    return false;
  }
}

export interface StoredCertificate {
  keyPath: string;
  certPath: string;
  keyPem: string;
  certPem: string;
  fingerprint: string;
  /** False when the pair on disk was still good and nothing was written. */
  issued: boolean;
}

export function tlsDir(dataDir: string): string {
  return join(dataDir, "tls");
}

/**
 * Reuse the pair on disk while it still names this machine; otherwise issue a new one. A laptop that
 * changes networks gets a new fingerprint, which is why the pane prints it.
 */
export function ensureCertificate(dataDir: string, hosts = localHosts()): StoredCertificate {
  const dir = tlsDir(dataDir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  mkdirSync(dir, { recursive: true });

  try {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    if (certificateCovers(certPem, hosts)) {
      return { keyPath, certPath, keyPem, certPem, fingerprint: certificateFingerprint(certPem), issued: false };
    }
  } catch {
    // Missing or unreadable: issue a new one rather than fail the enable.
  }

  const generated = generateCertificate({
    commonName: `NoirHarness (${hosts.hostnames[0] ?? "localhost"})`,
    hostnames: hosts.hostnames,
    addresses: hosts.addresses,
  });
  writeFileSync(keyPath, generated.keyPem, { mode: 0o600 });
  writeFileSync(certPath, generated.certPem, { mode: 0o644 });
  return {
    keyPath,
    certPath,
    keyPem: generated.keyPem,
    certPem: generated.certPem,
    fingerprint: certificateFingerprint(generated.certPem),
    issued: true,
  };
}
