import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ErrorCodes } from "@noir/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { parseGitTarget, parseLocalTarget } from "../src/skillSources.js";

const root = mkdtempSync(join(tmpdir(), "noir src "));
const realDir = join(root, "real");
mkdirSync(realDir);
const link = join(root, "link");
if (process.platform === "win32") symlinkSync(realDir, link, "junction");
else symlinkSync(realDir, link, "dir");
const file = join(root, "afile");
writeFileSync(file, "plain");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fetch target validation", () => {
  it("accepts https anywhere", () => {
    expect(parseGitTarget("https://example.test/r.git", undefined)).toEqual({
      kind: "git", url: "https://example.test/r.git", ref: undefined,
    });
  });

  it("accepts http only on loopback, comparing the whole hostname", () => {
    for (const url of ["http://127.0.0.1:8080/r.git", "http://localhost/r.git", "http://[::1]/r.git"]) {
      expect(parseGitTarget(url, undefined).kind).toBe("git");
    }
    // A prefix is not a loopback address, and 127.0.0.2 is not on the allowlist.
    for (const url of ["http://127.0.0.1.evil/r.git", "http://localhost.evil/r.git", "http://127.0.0.2/r.git"]) {
      expect(() => parseGitTarget(url, undefined)).toThrow(/not an accepted transport/);
    }
  });

  it("refuses every transport that could execute or prompt", () => {
    for (const url of ["ext::sh -c id", "ssh://git@h/r.git", "git://h/r.git", "file:///c/r.git"]) {
      expect(() => parseGitTarget(url, undefined)).toThrow(/not an accepted transport/);
    }
    // A Windows path parses as protocol "c:", so it must fail as a URL or as a transport.
    expect(() => parseGitTarget(String.raw`C:\tmp\r`, undefined)).toThrow(/not a URL|not an accepted transport/);
  });

  it("refuses credentials in the URL", () => {
    expect(() => parseGitTarget("https://user:tok@h/r.git", undefined)).toThrow(/credentials/);
    expect(() => parseGitTarget("https://user@h/r.git", undefined)).toThrow(/credentials/);
  });

  it("validates ref as an argv-safe token", () => {
    const pinned = parseGitTarget("https://h/r.git", "release/1.2");
    expect(pinned.kind === "git" ? pinned.ref : undefined).toBe("release/1.2");
    for (const ref of ["--upload-pack=id", "a b", "../x", "", "a".repeat(129)]) {
      expect(() => parseGitTarget("https://h/r.git", ref)).toThrow(/invalid ref/i);
    }
  });

  it("accepts an absolute local directory and refuses a link", async () => {
    expect(await parseLocalTarget(realDir)).toEqual({ kind: "local", path: resolve(realDir) });
    await expect(parseLocalTarget(link)).rejects.toThrow(/symlink/);
    await expect(parseLocalTarget(join(root, "missing"))).rejects.toThrow(/not a directory/);
    await expect(parseLocalTarget("relative/path")).rejects.toThrow(/absolute/);
  });

  it("normalizes the path before stat, so a trailing separator cannot smuggle a link", async () => {
    await expect(parseLocalTarget(link + sep)).rejects.toThrow(/symlink/);
    expect(await parseLocalTarget(root + sep)).toEqual({ kind: "local", path: resolve(root) });
  });

  it("reports a path that traverses a file as an invalid parameter, not an internal error", async () => {
    await expect(parseLocalTarget(join(file, "x"))).rejects.toMatchObject({ code: ErrorCodes.invalidParams });
  });
});
