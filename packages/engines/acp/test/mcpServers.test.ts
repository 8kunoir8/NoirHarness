import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpEngine } from "../src/index.js";

const FAKE_SERVER = fileURLToPath(new URL("./fakeAcpServer.ts", import.meta.url));

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir acp mcp "));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // The test may already have disposed the engine.
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a directory handle.
    }
  }
});

describe("ACP engine MCP forwarding", () => {
  it("sends the agent's bound servers in session/new", async () => {
    const root = workspace();
    const logPath = join(root, "wire.log");
    const engine = createAcpEngine({
      command: process.execPath,
      args: [FAKE_SERVER, "--omp", "--profile", "fake", "--model", "fake/fake-1"],
      cwd: root,
      env: { FAKE_ACP_LOG: logPath },
    });
    const session = await engine.start({
      sessionId: "sess-mcp",
      cwd: root,
      model: { providerName: "fake", modelId: "fake-1", contextWindow: 200_000, maxTokens: null },
      baseUrl: "",
      apiKey: "",
      history: [],
      skills: [],
      turnTimeoutMs: 10_000,
      mcpServers: [{ name: "calc", command: "/opt/calc", args: ["--stdio"], env: { CALC_MODE: "fast" } }],
    });
    cleanups.push(() => session.dispose());

    const wire = readFileSync(logPath, "utf8");
    const line = wire.split("\n").find((entry) => entry.includes('"method":"session/new"'));
    expect(line).toBeDefined();
    const params = JSON.parse((line as string).slice((line as string).indexOf("{"))) as {
      params: { mcpServers: unknown };
    };
    expect(params.params.mcpServers).toEqual([
      {
        name: "calc",
        command: "/opt/calc",
        args: ["--stdio"],
        env: [{ name: "CALC_MODE", value: "fast" }],
      },
    ]);
  });
});
