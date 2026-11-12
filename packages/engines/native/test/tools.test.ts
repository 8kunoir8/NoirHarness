import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnginePermissionRequest, PermissionDecision } from "@noir/engine-core";
import { PERMISSION_DENIED, runTool, type ToolContext } from "../src/tools.js";

const dirs: string[] = [];

function tempDir(prefix = "noir native tools "): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a handle on a killed child's cwd.
    }
  }
});

function context(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "session-1",
    workspaceRoot: root,
    signal: new AbortController().signal,
    onPermission: async () => "allow_once",
    skills: [],
    readSkill: async (name) => {
      throw new Error(`no skill ${name}`);
    },
    ...overrides,
  };
}

function permissionMock(decision: PermissionDecision = "allow_once") {
  return vi.fn(async (_request: EnginePermissionRequest): Promise<PermissionDecision> => decision);
}

describe("fs.read", () => {
  it("returns the content of a file inside the workspace", async () => {
    const root = tempDir();
    writeFileSync(join(root, "note.txt"), "hello\nworld\n");
    await expect(runTool("fs.read", { path: "note.txt" }, context(root))).resolves.toContain("hello");
  });

  it("rejects a path that leaves the workspace", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    await expect(runTool("fs.read", { path: "../secret.txt" }, context(root))).rejects.toThrow(/outside the workspace/);
    await expect(runTool("fs.read", { path: join(outside, "secret.txt") }, context(root))).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("rejects a directory link that escapes the workspace", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Creating links may need privileges this machine does not grant.
      return;
    }
    await expect(runTool("fs.read", { path: "link/secret.txt" }, context(root))).rejects.toThrow(/outside the workspace/);
  });
});

describe("fs.replace", () => {
  it("rejects a find that occurs more than once", async () => {
    const root = tempDir();
    writeFileSync(join(root, "dup.txt"), "x x");
    await expect(
      runTool("fs.replace", { path: "dup.txt", find: "x", newText: "y" }, context(root)),
    ).rejects.toThrow("find must match exactly once");
    expect(readFileSync(join(root, "dup.txt"), "utf8")).toBe("x x");
  });

  it("replaces a single occurrence after approval", async () => {
    const root = tempDir();
    writeFileSync(join(root, "one.txt"), "before");
    const onPermission = permissionMock();
    const result = await runTool(
      "fs.replace",
      { path: "one.txt", find: "before", newText: "after" },
      context(root, { onPermission }),
    );
    expect(result).toContain('"replacements":1');
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("after");
    expect(onPermission).toHaveBeenCalledTimes(1);
    expect(onPermission.mock.calls[0]?.[0].toolCall.kind).toBe("edit");
  });

  it("writes replacement patterns in newText literally", async () => {
    const root = tempDir();
    writeFileSync(join(root, "script.sh"), "echo X\n");
    await runTool(
      "fs.replace",
      { path: "script.sh", find: "X", newText: "cost $& $' $$ $1" },
      context(root),
    );
    expect(readFileSync(join(root, "script.sh"), "utf8")).toBe("echo cost $& $' $$ $1\n");
  });

  it("asks before reading a target outside the workspace", async () => {
    const root = tempDir();
    const outside = tempDir();
    const target = join(outside, "outside.txt");
    writeFileSync(target, "a b");
    const denied = permissionMock("reject");
    await expect(
      runTool("fs.replace", { path: target, find: "a", newText: "c" }, context(root, { onPermission: denied })),
    ).resolves.toBe(PERMISSION_DENIED);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(readFileSync(target, "utf8")).toBe("a b");
  });
});

describe("fs.write", () => {
  it("asks before writing outside the workspace and writes only when allowed", async () => {
    const root = tempDir();
    const outside = tempDir();
    const target = join(outside, "outside.txt");

    const denied = permissionMock("reject");
    await expect(
      runTool("fs.write", { path: target, content: "nope" }, context(root, { onPermission: denied })),
    ).resolves.toBe(PERMISSION_DENIED);
    expect(existsSync(target)).toBe(false);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]?.[0].toolCall).toMatchObject({
      kind: "edit",
      rawInput: { path: target, content: "nope" },
    });

    const allowed = permissionMock();
    const result = await runTool(
      "fs.write",
      { path: target, content: "written" },
      context(root, { onPermission: allowed }),
    );
    expect(result).toContain('"bytes":7');
    expect(readFileSync(target, "utf8")).toBe("written");
  });

  it("asks before writing inside the workspace too", async () => {
    const root = tempDir();
    const onPermission = permissionMock();
    await runTool("fs.write", { path: "inside.txt", content: "ok" }, context(root, { onPermission }));
    expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("ok");
    expect(onPermission).toHaveBeenCalledTimes(1);
  });
});

describe("fs.delete", () => {
  it("labels the approval as a delete and removes a file only when allowed", async () => {
    const root = tempDir();
    writeFileSync(join(root, "gone.txt"), "x");
    const denied = permissionMock("reject");
    await expect(
      runTool("fs.delete", { path: "gone.txt" }, context(root, { onPermission: denied })),
    ).resolves.toBe(PERMISSION_DENIED);
    expect(existsSync(join(root, "gone.txt"))).toBe(true);
    expect(denied.mock.calls[0]?.[0].toolCall.kind).toBe("delete");

    const result = await runTool("fs.delete", { path: "gone.txt" }, context(root));
    expect(result).toContain('"deleted":true');
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
  });
});

describe("shell.exec", () => {
  it("returns stdout and the exit code", async () => {
    const root = tempDir();
    const onPermission = permissionMock();
    const result = await runTool("shell.exec", { command: "echo hi" }, context(root, { onPermission }));
    expect(result).toContain("hi");
    expect(result).toContain("exit code: 0");
    expect(onPermission.mock.calls[0]?.[0].toolCall.kind).toBe("execute");
  });

  it("kills the process tree and reports an abort", async () => {
    const root = tempDir();
    const controller = new AbortController();
    const marker = join(root, "started.txt");
    const running = runTool(
      "shell.exec",
      { command: `node -e "require('node:fs').writeFileSync('started.txt', 'x'); setInterval(() => {}, 1000)"` },
      context(root, { signal: controller.signal }),
    );
    // The child exists once it wrote the marker; polling it beats guessing at process startup time.
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
    controller.abort();
    const result = await running;
    expect(result.toLowerCase()).toContain("abort");
  }, 20_000);

  it("never runs a rejected command", async () => {
    const root = tempDir();
    const marker = join(root, "marker.txt");
    const result = await runTool(
      "shell.exec",
      { command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')"` },
      context(root, { onPermission: async () => "reject" }),
    );
    expect(result).toBe(PERMISSION_DENIED);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("mcp tools", () => {
  it("caps a server's output like every other tool", async () => {
    const root = tempDir();
    const huge = "x".repeat(200_000);
    const result = await runTool("mcp__calc__dump", {}, context(root, { callMcpTool: async () => huge }));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64 * 1024 + "\n[truncated]".length);
    expect(result.endsWith("[truncated]")).toBe(true);
  });

  it("settles an in-flight call when the turn is aborted", async () => {
    const root = tempDir();
    const controller = new AbortController();
    let started = false;
    // The broker call never settles: only the abort can end the wait, and the turn must not hang.
    const running = runTool(
      "mcp__calc__slow",
      {},
      context(root, {
        signal: controller.signal,
        callMcpTool: () => {
          started = true;
          return new Promise<string>(() => undefined);
        },
      }),
    );
    // Abort after the call is in flight, so the race — not the pre-check — is what settles it.
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort();
    await expect(running).rejects.toThrow(/aborted/i);
  });
});

describe("skill tools", () => {
  it("lists the enabled skills the engine was started with", async () => {
    const root = tempDir();
    const result = await runTool(
      "skill.list",
      {},
      context(root, {
        skills: [{ name: "demo", scope: "project", description: "Demo skill" }],
      }),
    );
    expect(result).toContain("demo");
    expect(result).toContain("project");
  });

  it("reads a skill through the injected reader", async () => {
    const root = tempDir();
    const readSkill = vi.fn(async () => "# Skill\nbody");
    const result = await runTool("skill.read", { name: "demo" }, context(root, { readSkill }));
    expect(readSkill).toHaveBeenCalledWith("demo");
    expect(result).toContain("body");
  });
});

describe("fs.list and fs.search", () => {
  it("lists entries relative to the root", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const listed = await runTool("fs.list", { path: "." }, context(root));
    expect(listed).toContain("src/a.ts");
  });

  it("finds literal matches as path and line", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "alpha\nneedle\n");
    const found = await runTool("fs.search", { query: "needle" }, context(root));
    expect(found).toContain("src/a.ts");
    expect(found).toContain("needle");
  });
});
