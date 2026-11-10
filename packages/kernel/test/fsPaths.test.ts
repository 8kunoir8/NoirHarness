import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import { relativePath, resolveInsideRoot } from "../src/fsPaths.js";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir fs paths "));
  dirs.push(dir);
  return realpathSync(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function faultCode(run: () => unknown): number | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcFault);
    return (error as RpcFault).code;
  }
}

// Probe once so a host without link rights skips the symlink cases visibly instead of passing vacuously.
function linkRights(): boolean {
  const base = mkdtempSync(join(tmpdir(), "noir fs probe "));
  try {
    mkdirSync(join(base, "target"));
    symlinkSync(join(base, "target"), join(base, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
const canLink = linkRights();

describe("relativePath", () => {
  it("normalizes separators and drops empty segments", () => {
    expect(relativePath("./src//main.ts")).toBe("src/main.ts");
    expect(relativePath("")).toBe("");
  });

  it("rejects absolute, drive-letter, UNC and parent paths", () => {
    const bad = ["/etc/passwd", "C:/Windows", "C:\\Windows", "\\\\server\\share", "//server/share", "C:foo", "../x", "a/../../b"];
    for (const value of bad) expect(faultCode(() => relativePath(value))).toBe(ErrorCodes.invalidParams);
  });

  it("rejects backslash separators in wire paths", () => {
    expect(faultCode(() => relativePath("src\\main.ts"))).toBe(ErrorCodes.invalidParams);
  });

  it("accepts names that merely begin with dots", () => {
    expect(relativePath("..foo/bar")).toBe("..foo/bar");
  });
});

describe("resolveInsideRoot", () => {
  it("returns a path under the root", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"));
    expect(resolveInsideRoot(root, "src/main.ts")).toBe(join(root, "src", "main.ts"));
    expect(resolveInsideRoot(root, "")).toBe(root);
  });

  it("accepts names that merely begin with dots", () => {
    const root = tempRoot();
    expect(resolveInsideRoot(root, "..foo/bar")).toBe(join(root, "..foo", "bar"));
  });

  it("rejects backslash parent payloads", () => {
    const root = tempRoot();
    expect(faultCode(() => resolveInsideRoot(root, "..\\..\\x"))).toBe(ErrorCodes.invalidParams);
  });

  it.runIf(canLink)("refuses a symlink that points outside the root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(outside, join(root, "link"), "junction");
    expect(faultCode(() => resolveInsideRoot(root, "link/secret.txt"))).toBe(ErrorCodes.invalidParams);
  });

  it.runIf(canLink)("refuses a dangling symlink inside the root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, "link"), "junction");
    rmSync(outside, { recursive: true, force: true });
    expect(faultCode(() => resolveInsideRoot(root, "link/x"))).toBe(ErrorCodes.invalidParams);
  });

  it.runIf(canLink)("returns the canonical path through a symlink that stays inside the root", () => {
    const root = tempRoot();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"), "junction");
    expect(resolveInsideRoot(root, "link/file.txt")).toBe(join(root, "real", "file.txt"));
  });
});
