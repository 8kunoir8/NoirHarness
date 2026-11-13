import { verify, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certificateCovers, certificateFingerprint, ensureCertificate, generateCertificate, tlsDir } from "../src/tls.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir tls "));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOSTS = { hostnames: ["localhost"], addresses: ["127.0.0.1", "192.168.1.20"] };

describe("certificate encoding", () => {
  const generated = generateCertificate({ commonName: "NoirHarness (test)", ...HOSTS });

  it("parses as an X.509 certificate a browser would look at", () => {
    const cert = new X509Certificate(generated.certPem);
    expect(cert.subject).toContain("CN=NoirHarness (test)");
    expect(cert.subject).toBe(cert.issuer);
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toBeDefined();
  });

  it("names every host it advertised, as an IP where it is one", () => {
    const cert = new X509Certificate(generated.certPem);
    expect(cert.subjectAltName).toContain("IP Address:192.168.1.20");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.checkIP("192.168.1.20")).toBe("192.168.1.20");
    expect(cert.checkHost("localhost")).toBe("localhost");
    expect(cert.checkIP("10.0.0.1")).toBeUndefined();
  });

  it("carries a signature that verifies against its own public key", () => {
    // The bytes signed are the TBSCertificate the encoder built; verifying them proves the
    // signatureValue in the PEM is over those bytes and not over something adjacent.
    expect(verify("sha256", generated.tbs, generated.publicKey, generated.signature)).toBe(true);
    const publicKey = new X509Certificate(generated.certPem).publicKey;
    expect(publicKey.export({ type: "spki", format: "pem" })).toBe(
      generated.publicKey.export({ type: "spki", format: "pem" }),
    );
  });

  it("survives a year of wall clock without being expired", () => {
    const cert = new X509Certificate(generated.certPem);
    expect(Date.parse(cert.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now() + 360 * 24 * 60 * 60 * 1000);
  });

  it("loads in OpenSSL, which is the parser that actually decides", () => {
    // X509Certificate is Node's own reader; a secure context goes through the TLS stack a browser
    // handshake will use. Both have to accept the pair for the key file and the DER to be right.
    expect(() => createSecureContext({ key: generated.keyPem, cert: generated.certPem })).not.toThrow();
  });

  it("prints a fingerprint in the form a browser shows", () => {
    expect(certificateFingerprint(generated.certPem)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe("certificate storage", () => {
  it("writes a key and a certificate, and the key is not world-readable", () => {
    const dir = tempDir();
    const stored = ensureCertificate(dir, HOSTS);
    expect(stored.issued).toBe(true);
    expect(existsSync(stored.keyPath)).toBe(true);
    expect(existsSync(stored.certPath)).toBe(true);
    expect(readFileSync(stored.certPath, "utf8")).toContain("BEGIN CERTIFICATE");
    if (process.platform !== "win32") {
      expect(statSync(stored.keyPath).mode & 0o777).toBe(0o600);
    }
    expect(stored.keyPath.startsWith(tlsDir(dir))).toBe(true);
  });

  it("reuses the pair while it still names this machine", () => {
    const dir = tempDir();
    const first = ensureCertificate(dir, HOSTS);
    const second = ensureCertificate(dir, HOSTS);
    expect(first.issued).toBe(true);
    expect(second.issued).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("reissues when the machine gains an address, because the old cert cannot name it", () => {
    const dir = tempDir();
    const first = ensureCertificate(dir, HOSTS);
    const moved = { hostnames: ["localhost"], addresses: ["127.0.0.1", "10.1.2.3"] };
    expect(certificateCovers(first.certPem, moved)).toBe(false);
    const second = ensureCertificate(dir, moved);
    expect(second.issued).toBe(true);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(new X509Certificate(second.certPem).checkIP("10.1.2.3")).toBe("10.1.2.3");
  });

  it("replaces a cert that is not a cert instead of failing the enable", () => {
    const dir = tempDir();
    ensureCertificate(dir, HOSTS);
    const { certPath } = ensureCertificate(dir, HOSTS);
    writeFileSync(certPath, "not a certificate");
    const repaired = ensureCertificate(dir, HOSTS);
    expect(repaired.issued).toBe(true);
    expect(() => new X509Certificate(repaired.certPem)).not.toThrow();
  });
});
