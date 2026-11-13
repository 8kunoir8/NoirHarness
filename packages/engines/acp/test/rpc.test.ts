import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Engine, EnginePermissionRequest, EngineUpdate, PermissionDecision } from "@noir/engine-core";
import { createRpcEngine } from "../src/rpc.js";
import type { EngineSession } from "@noir/engine-core";

const FAKE_SERVER = fileURLToPath(new URL("./fakeRpcServer.ts", import.meta.url));

async function start(): Promise<EngineSession> {
  return startOpts(
    createRpcEngine({
      command: process.execPath,
      args: [FAKE_SERVER],
      cwd: process.cwd(),
      turnTimeoutMs: 10_000,
    }),
  );
}

async function startOpts(engine: Engine): Promise<EngineSession> {
  return engine.start({
    sessionId: "s1",
    cwd: process.cwd(),
    model: { providerName: "fake", modelId: "fake-1", contextWindow: 128_000, maxTokens: null },
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused",
    history: [],
    skills: [],
    turnTimeoutMs: 10_000,
  });
}

describe("omp rpc transport", () => {
  it("streams text and reasoning, and reports the turn's usage", async () => {
    const session = await start();
    const updates: EngineUpdate[] = [];
    try {
      const result = await session.prompt([{ type: "text", text: "write it" }], {
        onUpdate: (update) => updates.push(update),
        onPermission: async (): Promise<PermissionDecision> => "allow_once",
        onSkillRead: () => undefined,
      });
      expect(result.stopReason).toBe("stop");
      expect(result.timedOut).toBe(false);
      const text = updates.flatMap((update) => (update.kind === "message" && !update.reasoning ? [update.text] : []));
      // The reply arrives after the tool-call turn ends: only `prompt_result` may end the prompt.
      expect(text.join("")).toContain("All done.");
      expect(updates.some((update) => update.kind === "message" && update.reasoning)).toBe(true);
      const usage = updates.find((update) => update.kind === "usage");
      expect(usage).toMatchObject({ kind: "usage", used: 18, costAmount: 0.0025 });
    } finally {
      await session.dispose();
    }
  });

  it("turns omp's select prompt into a permission request and answers it", async () => {
    const session = await start();
    const updates: EngineUpdate[] = [];
    const asked: EnginePermissionRequest[] = [];
    try {
      await session.prompt([{ type: "text", text: "write it" }], {
        onUpdate: (update) => updates.push(update),
        onPermission: async (request) => {
          asked.push(request);
          return "allow_once";
        },
        onSkillRead: () => undefined,
      });
      expect(asked).toHaveLength(1);
      // The title carries the tool and the path; the arguments came from the tool's own start frame.
      expect(asked[0]?.toolCall).toMatchObject({ kind: "write", rawInput: { path: "notes.txt", content: "hi" } });
      expect(asked[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
      const text = updates.flatMap((update) => (update.kind === "message" && !update.reasoning ? [update.text] : []));
      expect(text).toContain("reply:Approve");
      expect(updates.some((update) => update.kind === "tool.updated" && update.status === "completed")).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it("refuses a protocol version it does not speak", async () => {
    const engine = createRpcEngine({
      command: process.execPath,
      args: [FAKE_SERVER],
      cwd: process.cwd(),
      env: { FAKE_RPC_VERSION: "7" },
    });
    await expect(startOpts(engine)).rejects.toThrow(/protocol 7/);
  });

  it("sends abort on interrupt rather than killing the process", async () => {
    const session = await start();
    let markAborted: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    try {
      void session.prompt([{ type: "text", text: "write it" }], {
        onUpdate: (update) => {
          if (update.kind === "message" && !update.reasoning && update.text === "aborted") markAborted();
        },
        onPermission: async (): Promise<PermissionDecision> => "allow_once",
        onSkillRead: () => undefined,
      });
      await session.interrupt();
      await aborted;
      expect(session.pid).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  });
});
