import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packagedKernelEntry, packagedNodeBinary } from "../src/packagedPaths.js";

describe("packaged paths", () => {
  it("resolves inside resources, not app.asar", () => {
    const resources = join("C:", "Program Files", "NoirHarness", "resources");
    expect(packagedKernelEntry(resources)).toBe(join(resources, "kernel", "dist", "index.cjs"));
    expect(packagedNodeBinary(resources, "win32")).toBe(join(resources, "runtime", "node.exe"));
    expect(packagedKernelEntry(resources)).not.toContain("app.asar");
    expect(packagedNodeBinary(resources, "win32")).not.toContain("app.asar");
  });

  it("picks the runtime name for the target platform", () => {
    const resources = join("/opt", "NoirHarness", "resources");
    expect(packagedNodeBinary(resources, "linux")).toBe(join(resources, "runtime", "node"));
    expect(packagedNodeBinary(resources, "darwin")).toBe(join(resources, "runtime", "node"));
  });
});
