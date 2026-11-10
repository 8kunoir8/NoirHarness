import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
import { ErrorCodes } from "@noir/protocol";
import { startKernel, type Kernel } from "../src/index.js";

const dirs: string[] = [];
const kernels: Kernel[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir fs "));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function call(kernel: Kernel, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${kernel.port}/?token=${kernel.token}`);
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const [data] = await reply;
  ws.close();
  return JSON.parse(String(data));
}

/** Kernel + project + workspace rooted at a fresh temp dir. */
async function setup(): Promise<{ kernel: Kernel; workspaceId: string; root: string }> {
  const dataDir = tempDir();
  const root = tempDir();
  writeFileSync(join(root, "hello.txt"), "hello");
  const kernel = await startKernel({ dataDir });
  kernels.push(kernel);
  const project = await call(kernel, "project.add", { path: root });
  const workspace = await call(kernel, "workspace.create", { projectId: project.result.id });
  return { kernel, workspaceId: workspace.result.id, root };
}

describe("fs.* RPCs", () => {
  it("lists, reads and writes inside the workspace", async () => {
    const { kernel, workspaceId, root } = await setup();
    const listed = await call(kernel, "fs.list", { workspaceId, path: "" });
    expect(listed.result.entries.map((entry: { name: string }) => entry.name)).toEqual(["hello.txt"]);

    const read = await call(kernel, "fs.read", { workspaceId, path: "hello.txt" });
    expect(read.result.content).toBe("hello");
    expect(read.result.truncated).toBe(false);

    const write = await call(kernel, "fs.write", { workspaceId, path: "src/new.txt", content: "hi" });
    expect(write.error.code).toBe(ErrorCodes.notFound); // parent must exist

    await call(kernel, "fs.write", { workspaceId, path: "hello.txt", content: "changed" });
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("changed");
  });

  it("rejects paths that escape the workspace and stale writes", async () => {
    const { kernel, workspaceId } = await setup();
    const escape = await call(kernel, "fs.read", { workspaceId, path: "../outside.txt" });
    expect(escape.error.code).toBe(ErrorCodes.invalidParams);

    const first = await call(kernel, "fs.read", { workspaceId, path: "hello.txt" });
    const stale = await call(kernel, "fs.write", {
      workspaceId,
      path: "hello.txt",
      content: "x",
      expectedMtimeMs: first.result.mtimeMs - 1,
    });
    expect(stale.error.code).toBe(ErrorCodes.conflict);
  });

  it("truncates a large read and refuses binary content", async () => {
    const { kernel, workspaceId, root } = await setup();
    writeFileSync(join(root, "big.log"), "x".repeat(3 * 1024 * 1024));
    const big = await call(kernel, "fs.read", { workspaceId, path: "big.log" });
    expect(big.result.truncated).toBe(true);
    expect(big.result.content.length).toBe(2 * 1024 * 1024);

    writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const binary = await call(kernel, "fs.read", { workspaceId, path: "image.png" });
    expect(binary.error.code).toBe(ErrorCodes.invalidParams);
  });

  it("keeps listing when an entry is a dangling symlink", async (context) => {
    const { kernel, workspaceId, root } = await setup();
    try {
      symlinkSync(join(root, "missing.txt"), join(root, "link.txt"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip(); // Symlink creation needs Developer Mode or elevation on Windows.
        return;
      }
      throw error;
    }
    const listed = await call(kernel, "fs.list", { workspaceId, path: "" });
    expect(listed.result.entries.map((entry: { name: string }) => entry.name)).toEqual(["hello.txt"]);
    expect(listed.result.truncated).toBe(false);
  });

  it("truncates a read at a character boundary instead of mangling its tail", async () => {
    const { kernel, workspaceId, root } = await setup();
    const head = "a".repeat(2 * 1024 * 1024 - 1);
    writeFileSync(join(root, "utf8.log"), `${head}€€€`);
    const big = await call(kernel, "fs.read", { workspaceId, path: "utf8.log" });
    expect(big.result.truncated).toBe(true);
    expect(big.result.content).toBe(head);
    expect(big.result.content).not.toContain("\uFFFD");
  });

  it("refuses a file that is not valid UTF-8 and refuses NUL on write", async () => {
    const { kernel, workspaceId, root } = await setup();
    writeFileSync(join(root, "bad.txt"), Buffer.from([0x41, 0xff, 0xfe, 0xfd]));
    const bad = await call(kernel, "fs.read", { workspaceId, path: "bad.txt" });
    expect(bad.error.code).toBe(ErrorCodes.invalidParams);

    const nul = await call(kernel, "fs.write", { workspaceId, path: "hello.txt", content: "a\u0000b" });
    expect(nul.error.code).toBe(ErrorCodes.invalidParams);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello");
  });

  it("finds files for quick open, skipping git and dependency dirs", async () => {
    const { kernel, workspaceId, root } = await setup();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "src", "b.ts"), "");
    writeFileSync(join(root, ".git", "HEAD"), "");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    const found = await call(kernel, "fs.files", { workspaceId });
    expect(found.result.files).toEqual(["a.ts", "hello.txt", "src/b.ts"]);
    expect(found.result.truncated).toBe(false);
  });
});
