import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
import { ErrorCodes } from "@noir/protocol";
import { MAX_ARTIFACT_BINARY_BYTES, MAX_ARTIFACT_TEXT_BYTES, readArtifact } from "../src/fsService.js";
import type { Kernel } from "../src/index.js";
import { startKernel } from "./support.js";

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

    const lone = await call(kernel, "fs.write", { workspaceId, path: "hello.txt", content: "a\uD800b" });
    expect(lone.error.code).toBe(ErrorCodes.invalidParams);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello");
  });

  it("refuses to resurrect a file deleted on disk", async () => {
    const { kernel, workspaceId, root } = await setup();
    const first = await call(kernel, "fs.read", { workspaceId, path: "hello.txt" });
    rmSync(join(root, "hello.txt"));

    const write = await call(kernel, "fs.write", {
      workspaceId,
      path: "hello.txt",
      content: "back",
      expectedMtimeMs: first.result.mtimeMs,
    });
    expect(write.error.code).toBe(ErrorCodes.conflict);
    expect(readdirSync(root)).toEqual([]);

    // Without an expected mtime this is a first write, which still creates the file.
    const created = await call(kernel, "fs.write", { workspaceId, path: "hello.txt", content: "fresh" });
    expect(created.error).toBeUndefined();
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("fresh");
  });

  it("saves through a temp file and leaves no temp behind", async () => {
    const { kernel, workspaceId, root } = await setup();
    const content = "line one\nline two\n\ntrailing\n";
    const write = await call(kernel, "fs.write", { workspaceId, path: "hello.txt", content });
    expect(write.error).toBeUndefined();
    expect(typeof write.result.mtimeMs).toBe("number");
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe(content);
    expect(readdirSync(root).filter((name) => name.includes(".noir-"))).toEqual([]);

    // A rejected save cleans its temp up as well and leaves the target untouched.
    mkdirSync(join(root, "dir.txt"));
    const rejected = await call(kernel, "fs.write", { workspaceId, path: "dir.txt", content: "x" });
    expect(rejected.error.code).toBe(ErrorCodes.invalidParams);
    expect(readdirSync(root).filter((name) => name.includes(".noir-"))).toEqual([]);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe(content);

    const fresh = await call(kernel, "fs.write", { workspaceId, path: "new.txt", content: "new" });
    expect(fresh.error).toBeUndefined();
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("new");
    expect(readdirSync(root).filter((name) => name.includes(".noir-"))).toEqual([]);
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

describe("artifact.read", () => {
  it("reads markdown as utf8 and refuses an unsupported extension", async () => {
    const root = tempDir();
    writeFileSync(join(root, "notes.md"), "# hi");
    await expect(readArtifact(root, "notes.md")).resolves.toMatchObject({
      encoding: "utf8",
      content: "# hi",
      truncated: false,
    });
    await expect(readArtifact(root, "dump.exe")).rejects.toThrow(/Unsupported artifact type/);

    // A binary file renamed to a text extension is refused instead of decoded as mojibake.
    writeFileSync(join(root, "data.csv"), Buffer.from([0x41, 0x00, 0x42]));
    await expect(readArtifact(root, "data.csv")).rejects.toThrow(/Not a UTF-8 text file/);
  });

  it("returns a PNG as base64, so a chat answer can show the picture", async () => {
    const root = tempDir();
    // The eight-byte PNG signature: enough to prove nothing decodes it as text.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(root, "chart.PNG"), png);
    await expect(readArtifact(root, "chart.PNG")).resolves.toMatchObject({
      encoding: "base64",
      content: png.toString("base64"),
      size: png.length,
      truncated: false,
    });
  });

  it("rejects a path outside the workspace", async () => {
    const root = tempDir();
    await expect(readArtifact(root, "../secret.md")).rejects.toThrow();
  });

  it("returns a PDF as base64 without decoding it as text", async () => {
    const root = tempDir();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00]);
    writeFileSync(join(root, "report.pdf"), pdf);
    await expect(readArtifact(root, "report.pdf")).resolves.toMatchObject({
      encoding: "base64",
      content: pdf.toString("base64"),
      size: pdf.length,
      truncated: false,
    });
  });

  it("truncates a text artifact above 2 MiB and reports the real size", async () => {
    const root = tempDir();
    writeFileSync(join(root, "big.csv"), Buffer.alloc(MAX_ARTIFACT_TEXT_BYTES + 1, 0x61));
    const result = await readArtifact(root, "big.csv");
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(MAX_ARTIFACT_TEXT_BYTES);
    expect(result.size).toBe(MAX_ARTIFACT_TEXT_BYTES + 1);
  });

  it("refuses a PDF above the 32 MB cap instead of truncating it", async () => {
    const root = tempDir();
    writeFileSync(join(root, "big.pdf"), Buffer.alloc(MAX_ARTIFACT_BINARY_BYTES + 1));
    await expect(readArtifact(root, "big.pdf")).rejects.toThrow(/larger than 32 MB/);
  });

  it("rejects an invalid request before touching the filesystem", async () => {
    const { kernel, workspaceId } = await setup();
    const reply = await call(kernel, "artifact.read", { workspaceId, path: "" });
    expect(reply.error.code).toBe(ErrorCodes.invalidParams);
  });
});
