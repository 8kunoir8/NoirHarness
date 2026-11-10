import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClientRequestHandler,
  createAcpClient,
  type AcpClient,
  type EnginePermissionRequest,
  type EngineUpdate,
  type PermissionDecision,
} from "../src/index.js";

const FAKE_SERVER = fileURLToPath(new URL("./fakeAcpServer.ts", import.meta.url));
const TEST_TIMEOUT_MS = 20_000;

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir acp ünïcode "));
  dirs.push(dir);
  return dir;
}

async function start(
  opts: { turnTimeoutMs?: number; cancelGraceMs?: number } = {},
): Promise<{ engine: AcpClient; root: string }> {
  const root = workspace();
  const engine = await createAcpClient({
    command: process.execPath,
    args: [FAKE_SERVER, "--omp", "--profile", "fake", "--model", "fake/fake-1"],
    cwd: root,
    ...(opts.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.turnTimeoutMs }),
    ...(opts.cancelGraceMs === undefined ? {} : { cancelGraceMs: opts.cancelGraceMs }),
  });
  cleanups.push(() => engine.dispose());
  return { engine, root };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // The test may already have disposed the client.
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function modelOption(options: unknown[]): Record<string, unknown> | undefined {
  return options
    .map((option) => option as Record<string, unknown>)
    .find((option) => option.category === "model");
}

function collector(decide: (request: EnginePermissionRequest) => Promise<PermissionDecision> = async () => "reject") {
  const updates: EngineUpdate[] = [];
  return {
    updates,
    handlers: {
      onUpdate(update: EngineUpdate): void {
        updates.push(update);
      },
      onPermission: decide,
    },
  };
}

function messageTexts(updates: EngineUpdate[]): string[] {
  return updates.filter((update) => update.kind === "message").map((update) => (update.kind === "message" ? update.text : ""));
}

describe("ACP engine adapter", () => {
  it(
    "initializes the agent and exposes the model config option",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);

      expect(session.sessionId).toBe("fake-session-1");
      expect(modelOption(session.configOptions)?.currentValue).toBe("fake/fake-1");

      await session.setConfigOption("model", "fake/fake-2");
      expect(modelOption(session.configOptions)?.currentValue).toBe("fake/fake-2");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "streams message chunks in order and keeps the session usable for a second prompt",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const { updates, handlers } = collector();

      const result = await session.prompt([{ type: "text", text: "stream" }], handlers);
      expect(result).toEqual({
        stopReason: "end_turn",
        timedOut: false,
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
      expect(messageTexts(updates)).toEqual(["Hel", "lo from ", "mock."]);
      expect(
        updates.every(
          (update) => update.kind !== "message" || (update.messageId === "msg-fake-1" && !update.reasoning),
        ),
      ).toBe(true);
      expect(updates.some((update) => update.kind === "usage" && update.size === 200_000 && update.used === 11)).toBe(
        true,
      );

      updates.length = 0;
      const second = await session.prompt([{ type: "text", text: "stream" }], handlers);
      expect(second.stopReason).toBe("end_turn");
      expect(messageTexts(updates)).toEqual(["Hel", "lo from ", "mock."]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers a permission request, returns a terminalId, and streams tool updates",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const updates: EngineUpdate[] = [];
      let permission: EnginePermissionRequest | undefined;
      let permissionBeforeToolStart = false;

      const result = await session.prompt([{ type: "text", text: "permission" }], {
        onUpdate(update) {
          if (update.kind === "tool.started") permissionBeforeToolStart = permission !== undefined;
          updates.push(update);
        },
        async onPermission(request) {
          permission = request;
          return "allow_once";
        },
      });

      expect(permission?.options.map((option) => option.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always",
      ]);
      expect(permission?.toolCall.kind).toBe("execute");
      expect(permission?.toolCall.title).toBe("echo hi");
      expect(permissionBeforeToolStart).toBe(true);

      const terminalMessage = messageTexts(updates).find((text) => text.startsWith("terminal:"));
      expect(terminalMessage).toMatch(/^terminal:term-\d+$/);

      const started = updates.find((update) => update.kind === "tool.started");
      expect(started?.kind === "tool.started" ? started.toolKind : "").toBe("execute");
      expect(
        updates
          .filter((update) => update.kind === "tool.updated")
          .map((update) => (update.kind === "tool.updated" ? update.status : "")),
      ).toEqual(["in_progress", "completed"]);

      const completed = updates.find((update) => update.kind === "tool.updated" && update.status === "completed");
      // The rendered command omp prefixes to the content is dropped; only the result survives.
      expect(completed?.kind === "tool.updated" ? completed.text : "").toBe("terminal said terminal-ok");
      expect(result.stopReason).toBe("end_turn");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps a non-execute tool's leading \"$ \" content",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const { updates, handlers } = collector();

      const result = await session.prompt([{ type: "text", text: "edit" }], handlers);

      const completed = updates.find((update) => update.kind === "tool.updated" && update.status === "completed");
      expect(completed?.kind === "tool.updated" ? completed.text : "").toBe("$ edit file.txt\nedited");
      expect(result.stopReason).toBe("end_turn");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a permission request and still completes the turn",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const { updates, handlers } = collector(async () => "reject");

      const result = await session.prompt([{ type: "text", text: "permission" }], handlers);
      const failed = updates.find((update) => update.kind === "tool.updated" && update.status === "failed");
      expect(failed?.kind === "tool.updated" ? failed.text : "").toContain("rejected");
      expect(updates.some((update) => update.kind === "tool.started")).toBe(false);
      expect(result).toEqual({ stopReason: "end_turn", timedOut: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancels a hung prompt after the turn timeout and reaps the child on dispose",
    async () => {
      const { engine, root } = await start({ turnTimeoutMs: 250 });
      const session = await engine.newSession(root);
      const startedAt = Date.now();

      const result = await session.prompt([{ type: "text", text: "hang" }], collector().handlers);
      expect(result).toEqual({ stopReason: "cancelled", timedOut: true });
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      const pid = engine.pid;
      expect(isAlive(pid)).toBe(true);
      await engine.dispose();
      expect(isAlive(pid)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not let the client-wide request timeout end a prompt",
    async () => {
      const root = workspace();
      const logPath = join(root, "wire.log");
      const engine = await createAcpClient({
        command: process.execPath,
        args: [FAKE_SERVER],
        cwd: root,
        env: { FAKE_ACP_LOG: logPath },
        // The handshake on a loaded machine takes ~100 ms, so the client-wide timeout must be well
        // clear of it; the prompt still outlives it because the watchdog runs at 3 s.
        requestTimeoutMs: 1_500,
        turnTimeoutMs: 3_000,
      });
      cleanups.push(() => engine.dispose());

      const session = await engine.newSession(root);
      const startedAt = Date.now();
      const result = await session.prompt([{ type: "text", text: "hang" }], collector().handlers);
      expect(result).toEqual({ stopReason: "cancelled", timedOut: true });
      expect(Date.now() - startedAt).toBeGreaterThan(1_800);

      const wire = readFileSync(logPath, "utf8");
      expect(wire).toContain('"method":"session/prompt"');
      expect(wire).toContain('"method":"session/cancel"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "abandons the pending prompt when the agent ignores the cancel",
    async () => {
      const { engine, root } = await start({ turnTimeoutMs: 150, cancelGraceMs: 150 });
      const session = await engine.newSession(root);

      await expect(session.prompt([{ type: "text", text: "deaf" }], collector().handlers)).rejects.toThrow(
        /did not settle 150ms after session\/cancel/,
      );
      expect(engine.client.pendingCount).toBe(0);

      const next = await session.prompt([{ type: "text", text: "stream" }], collector().handlers);
      expect(next.stopReason).toBe("end_turn");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "times out a handshake with an agent that never speaks ACP",
    async () => {
      const root = workspace();
      const startedAt = Date.now();
      await expect(
        createAcpClient({
          command: process.execPath,
          args: [FAKE_SERVER],
          cwd: root,
          env: { FAKE_ACP_MUTE: "1" },
          requestTimeoutMs: 150,
        }),
      ).rejects.toThrow(/timed out after 150ms: initialize/);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "bounds session/close against an agent that ignores it and still reaps the child",
    async () => {
      const root = workspace();
      const engine = await createAcpClient({
        command: process.execPath,
        args: [FAKE_SERVER],
        cwd: root,
        env: { FAKE_ACP_IGNORE_CLOSE: "1" },
      });
      cleanups.push(() => engine.dispose());
      const session = await engine.newSession(root);

      const startedAt = Date.now();
      await session.close();
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const pid = engine.pid;
      await engine.dispose();
      expect(isAlive(pid)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "parses a single ~25 KB frame",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const { updates, handlers } = collector();

      const result = await session.prompt([{ type: "text", text: "large" }], handlers);
      const message = updates.find((update) => update.kind === "message");
      expect(message?.kind === "message" ? message.text.length : 0).toBe(25_000);
      expect(result.stopReason).toBe("end_turn");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replies with an error to an unknown inbound method and stays usable",
    async () => {
      const { engine, root } = await start();
      const session = await engine.newSession(root);
      const { updates, handlers } = collector();

      await session.prompt([{ type: "text", text: "unknown" }], handlers);
      expect(messageTexts(updates)).toContain("error:-32603");

      updates.length = 0;
      const second = await session.prompt([{ type: "text", text: "stream" }], handlers);
      expect(second.stopReason).toBe("end_turn");
      expect(messageTexts(updates)).toEqual(["Hel", "lo from ", "mock."]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("ClientRequestHandler", () => {
  it("confines fs access to the session workspace", async () => {
    const root = workspace();
    const handler = new ClientRequestHandler((sessionId) => (sessionId === "s1" ? root : undefined));
    try {
      writeFileSync(join(root, "note.txt"), "one\ntwo\nthree\n", "utf8");

      const full = (await handler.handle("fs/read_text_file", { sessionId: "s1", path: "note.txt" })) as {
        content: string;
      };
      expect(full.content).toBe("one\ntwo\nthree\n");

      const slice = (await handler.handle("fs/read_text_file", {
        sessionId: "s1",
        path: join(root, "note.txt"),
        line: 2,
        limit: 1,
      })) as { content: string };
      expect(slice.content).toBe("two");

      await expect(
        handler.handle("fs/write_text_file", { sessionId: "s1", path: "../escape.txt", content: "x" }),
      ).rejects.toThrow(/escapes the session workspace/);
      await expect(
        handler.handle("fs/write_text_file", {
          sessionId: "s1",
          path: join(tmpdir(), "noir-acp-outside.txt"),
          content: "x",
        }),
      ).rejects.toThrow(/escapes the session workspace/);

      await handler.handle("fs/write_text_file", { sessionId: "s1", path: join("sub", "new.txt"), content: "hi" });
      expect(readFileSync(join(root, "sub", "new.txt"), "utf8")).toBe("hi");

      await expect(handler.handle("fs/bogus", { sessionId: "s1" })).rejects.toThrow(/fs\/bogus/);
      await expect(handler.handle("fs/read_text_file", { sessionId: "other", path: "note.txt" })).rejects.toThrow(
        /Unknown ACP session/,
      );
    } finally {
      handler.dispose();
    }
  });

  it("runs terminals with the agent's env array and reports their output", async () => {
    const root = workspace();
    const handler = new ClientRequestHandler((sessionId) => (sessionId === "s1" ? root : undefined));
    try {
      const created = (await handler.handle("terminal/create", {
        sessionId: "s1",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.FAKE_TOKEN ?? 'missing-env')"],
        env: [{ name: "FAKE_TOKEN", value: "terminal-ok" }],
        cwd: root,
        outputByteLimit: 65_536,
      })) as { terminalId: string };
      expect(created.terminalId).toMatch(/^term-\d+$/);

      const exit = (await handler.handle("terminal/wait_for_exit", {
        sessionId: "s1",
        terminalId: created.terminalId,
      })) as { exitCode: number | null };
      expect(exit.exitCode).toBe(0);

      const output = (await handler.handle("terminal/output", {
        sessionId: "s1",
        terminalId: created.terminalId,
      })) as { output: string; truncated: boolean; exitStatus: { exitCode: number | null } | null };
      expect(output.output).toBe("terminal-ok");
      expect(output.truncated).toBe(false);
      expect(output.exitStatus?.exitCode).toBe(0);

      await expect(handler.handle("terminal/output", { sessionId: "s1", terminalId: "nope" })).rejects.toThrow(
        /Unknown terminal/,
      );
      await handler.handle("terminal/release", { sessionId: "s1", terminalId: created.terminalId });
      await expect(
        handler.handle("terminal/output", { sessionId: "s1", terminalId: created.terminalId }),
      ).rejects.toThrow(/Unknown terminal/);

      const slow = (await handler.handle("terminal/create", {
        sessionId: "s1",
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        cwd: root,
      })) as { terminalId: string };
      await handler.handle("terminal/kill", { sessionId: "s1", terminalId: slow.terminalId });
      const killed = (await handler.handle("terminal/wait_for_exit", {
        sessionId: "s1",
        terminalId: slow.terminalId,
      })) as { exitCode: number | null; signal: string | null };
      expect(killed.exitCode !== null || killed.signal !== null).toBe(true);
      await handler.handle("terminal/release", { sessionId: "s1", terminalId: slow.terminalId });
    } finally {
      handler.dispose();
    }
  });
});
