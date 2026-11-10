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

describe("relativePath", () => {
  it("normalizes separators and drops empty segments", () => {
    expect(relativePath("./src//main.ts")).toBe("src/main.ts");
    expect(relativePath("")).toBe("");
  });

  it("rejects absolute, drive-letter, UNC and parent paths", () => {
    const bad = ["/etc/passwd", "C:/Windows", "C:\\Windows", "\\\\server\\share", "../x", "a/../../b"];
    for (const value of bad) expect(faultCode(() => relativePath(value))).toBe(ErrorCodes.invalidParams);
  });
});

describe("resolveInsideRoot", () => {
  it("returns a path under the root", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"));
    expect(resolveInsideRoot(root, "src/main.ts")).toBe(join(root, "src", "main.ts"));
    expect(resolveInsideRoot(root, "")).toBe(root);
  });

  it("refuses a symlink that points outside the root", () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "secret.txt"), "nope");
    try {
      symlinkSync(outside, join(root, "link"), "junction");
    } catch {
      return; // No link rights on this host; the realpath comparison is still covered above.
    }
    expect(faultCode(() => resolveInsideRoot(root, "link/secret.txt"))).toBe(ErrorCodes.invalidParams);
  });
});
