import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIdOf } from "../src/buildId.js";

describe("buildIdOf", () => {
  it("hashes the file's bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "noir buildid "));
    try {
      const file = join(dir, "entry.cjs");
      writeFileSync(file, "console.log(1)\n");
      expect(buildIdOf(file)).toMatch(/^[0-9a-f]{64}$/);
      const copy = join(dir, "copy.cjs");
      writeFileSync(copy, "console.log(1)\n");
      expect(buildIdOf(copy)).toBe(buildIdOf(file));
      writeFileSync(copy, "console.log(2)\n");
      expect(buildIdOf(copy)).not.toBe(buildIdOf(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null when the file cannot be read", () => {
    expect(buildIdOf(join(tmpdir(), "noir-does-not-exist.cjs"))).toBeNull();
  });
});
