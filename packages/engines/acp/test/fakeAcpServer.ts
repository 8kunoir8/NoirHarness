// Scripted ACP agent used by the adapter tests. Runs on plain Node >= 24 via
// native type stripping: `node test/fakeAcpServer.ts`. Every argv it receives is
// ignored (the kernel appends its own omp flags).
import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";

const SESSION_ID = "fake-session-1";
const LOG_PATH = process.env.FAKE_ACP_LOG;
/** Reads stdin but never answers a single frame — handshake-timeout coverage. */
const MUTE = process.env.FAKE_ACP_MUTE === "1";
/** Answers everything except `session/close` — teardown-timeout coverage. */
const IGNORE_CLOSE = process.env.FAKE_ACP_IGNORE_CLOSE === "1";
/** When set, the turn also "reads" `skill://<name>` — skill-attribution coverage. */
const SKILL_NAME = process.env.FAKE_ACP_SKILL;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function recordLine(direction: string, text: string): void {
  if (LOG_PATH === undefined) return;
  try {
    appendFileSync(LOG_PATH, `${direction} ${text}\n`);
  } catch {
    // The log is diagnostic only.
  }
}

function send(message: JsonObject): void {
  const line = JSON.stringify(message);
  recordLine("<--", line);
  process.stdout.write(`${line}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, details: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { details } } });
}

function emitUpdate(update: JsonObject): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update } });
}

const MODELS = [
  { value: "fake/fake-1", name: "Fake One", description: "fake/fake-1" },
  { value: "fake/fake-2", name: "Fake Two", description: "fake/fake-2" },
];

let sessionCwd = "";
let currentModel = "fake/fake-1";
let nextRequestId = 0;
let onCancel: (() => void) | undefined;
const pendingReplies = new Map<number, (message: JsonObject) => void>();

function request(method: string, params: unknown): Promise<JsonObject | undefined> {
  const id = nextRequestId;
  nextRequestId += 1;
  const answer = new Promise<JsonObject | undefined>((resolveAnswer) => {
    pendingReplies.set(id, resolveAnswer);
  });
  send({ jsonrpc: "2.0", id, method, params });
  return answer;
}

function configOptions(): JsonObject[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: MODELS,
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "off",
      options: [
        { value: "off", name: "Off" },
        { value: "auto", name: "Auto" },
      ],
    },
  ];
}

function textUpdate(text: string, messageId: string): JsonObject {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId };
}

function emitSkillRead(name: string): void {
  emitUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "skill-call-1",
    title: `read ${name}`,
    kind: "read",
    rawInput: { path: `skill://${name}` },
    status: "pending",
  });
  emitUpdate({ sessionUpdate: "tool_call_update", toolCallId: "skill-call-1", status: "completed" });
}

async function streamTurn(): Promise<JsonObject> {
  const messageId = "msg-fake-1";
  const chunks = ["Hel", "lo from ", "mock."];
  for (const [index, chunk] of chunks.entries()) {
    emitUpdate(textUpdate(chunk, messageId));
    if (index === 0 && SKILL_NAME !== undefined && SKILL_NAME !== "") emitSkillRead(SKILL_NAME);
  }
  emitUpdate({ sessionUpdate: "usage_update", size: 200_000, used: 11 });
  emitUpdate({ sessionUpdate: "session_info_update", updatedAt: new Date().toISOString() });
  return { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
}

async function largeTurn(): Promise<JsonObject> {
  emitUpdate(textUpdate("x".repeat(25_000), "msg-fake-large"));
  return { stopReason: "end_turn" };
}

async function unknownTurn(): Promise<JsonObject> {
  const answer = await request("session/bogus", { sessionId: SESSION_ID });
  const error = asObject(answer?.error);
  const code = typeof error?.code === "number" ? error.code : "none";
  emitUpdate(textUpdate(`error:${code}`, "msg-fake-unknown"));
  return { stopReason: "end_turn" };
}

async function hangTurn(): Promise<JsonObject> {
  return await new Promise<JsonObject>((resolveHang) => {
    onCancel = () => resolveHang({ stopReason: "cancelled" });
  });
}

/** Emits one chunk, then waits for the client's cancel — interrupt coverage. */
async function slowTurn(): Promise<JsonObject> {
  emitUpdate(textUpdate("partial", "msg-fake-slow"));
  return await hangTurn();
}

/** Emits one chunk and exits the process — crash coverage. */
function crashTurn(): JsonObject {
  emitUpdate(textUpdate("about to crash", "msg-fake-crash"));
  process.exit(1);
}

async function permissionTurn(): Promise<JsonObject> {
  // Kernel tests use this to prove approval titles are redacted before they reach any table.
  const title = process.env.FAKE_ACP_PERMISSION_TITLE ?? "echo hi";
  const answer = await request("session/request_permission", {
    sessionId: SESSION_ID,
    toolCall: {
      toolCallId: "call_fake_1",
      title,
      kind: "execute",
      status: "pending",
      rawInput: { command: "echo hi" },
      content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
      locations: [],
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
    ],
  });

  const outcome = asObject(asObject(answer?.result)?.outcome);
  const optionId = typeof outcome?.optionId === "string" ? outcome.optionId : "";

  if (optionId === "reject_once" || optionId === "reject_always") {
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_fake_1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Tool call rejected by user (fake)" } }],
    });
    return { stopReason: "end_turn" };
  }

  const created = await request("terminal/create", {
    sessionId: SESSION_ID,
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.FAKE_TOKEN ?? 'missing-env')"],
    env: [{ name: "FAKE_TOKEN", value: "terminal-ok" }],
    cwd: sessionCwd,
    outputByteLimit: 65_536,
  });
  const rawTerminalId = asObject(created?.result)?.terminalId;
  const terminalId = typeof rawTerminalId === "string" ? rawTerminalId : undefined;
  emitUpdate(textUpdate(`terminal:${terminalId ?? "missing"}`, "msg-fake-2"));

  let outputText = "";
  if (terminalId !== undefined) {
    await request("terminal/wait_for_exit", { sessionId: SESSION_ID, terminalId });
    const output = await request("terminal/output", { sessionId: SESSION_ID, terminalId });
    const outputRecord = asObject(output?.result);
    outputText = typeof outputRecord?.output === "string" ? outputRecord.output : "";
    await request("terminal/release", { sessionId: SESSION_ID, terminalId });
  }

  emitUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_fake_1",
    name: "bash",
    title: "$ echo hi",
    kind: "execute",
    status: "pending",
    rawInput: { command: "echo hi" },
    content: [{ type: "content", content: { type: "text", text: "$ echo hi" } }],
  });
  emitUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_fake_1",
    status: "in_progress",
    content: [
      { type: "content", content: { type: "text", text: "$ echo hi" } },
      { type: "terminal", terminalId: terminalId ?? "" },
    ],
  });
  emitUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_fake_1",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "$ echo hi" } },
      { type: "content", content: { type: "text", text: `terminal said ${outputText}` } },
    ],
  });
  return { stopReason: "end_turn" };
}

/**
 * A non-execute tool whose content legitimately starts with "$ " (edit diff lines): the adapter
 * must keep it, because only execute tools prefix their content with the rendered command.
 */
async function editTurn(): Promise<JsonObject> {
  emitUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_fake_edit",
    name: "edit",
    title: "$ edit file.txt",
    kind: "edit",
    status: "pending",
    rawInput: {},
    content: [{ type: "content", content: { type: "text", text: "$ edit file.txt" } }],
  });
  emitUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_fake_edit",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "$ edit file.txt" } },
      { type: "content", content: { type: "text", text: "edited" } },
    ],
  });
  return { stopReason: "end_turn" };
}

async function runPrompt(params: unknown): Promise<JsonObject> {
  const prompt = asObject(params)?.prompt;
  const first = Array.isArray(prompt) ? asObject(prompt[0]) : undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  switch (text) {
    case "stream":
      return await streamTurn();
    case "large":
      return await largeTurn();
    case "unknown":
      return await unknownTurn();
    case "hang":
      return await hangTurn();
    case "deaf":
      // Ignores session/cancel as well: only the client's cancel grace can end this turn.
      return await new Promise<JsonObject>(() => undefined);
    case "slow":
      return await slowTurn();
    case "crash":
      return crashTurn();
    case "permission":
    case "tool":
      return await permissionTurn();
    case "edit":
      return await editTurn();
    default:
      return { stopReason: "end_turn" };
  }
}

async function handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", title: "Fake ACP", version: "0.0.0" },
        authMethods: [{ id: "agent", name: "Use existing local credentials" }],
        agentCapabilities: { loadSession: false },
      });
      return;
    case "session/new": {
      const cwd = asObject(params)?.cwd;
      if (typeof cwd !== "string" || !isAbsolute(cwd)) {
        replyError(id, `ACP cwd must be absolute: ${String(cwd)}`);
        return;
      }
      sessionCwd = cwd;
      reply(id, {
        sessionId: SESSION_ID,
        configOptions: configOptions(),
        modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" },
      });
      return;
    }
    case "session/prompt":
      reply(id, await runPrompt(params));
      return;
    case "session/set_config_option": {
      const record = asObject(params) ?? {};
      if (record.configId === "model" && typeof record.value === "string") currentModel = record.value;
      reply(id, { configOptions: configOptions() });
      return;
    }
    case "session/close":
      if (IGNORE_CLOSE) return;
      reply(id, {});
      return;
    default:
      replyError(id, `Unknown ACP ext method: ${method}`);
  }
}

function handleNotification(method: string, _params: unknown): void {
  if (method !== "session/cancel") return;
  const cancel = onCancel;
  onCancel = undefined;
  cancel?.();
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") return;
  recordLine("-->", trimmed);
  if (MUTE) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const message = asObject(parsed);
  if (message === undefined) return;

  if (typeof message.method === "string") {
    if (message.id === undefined || message.id === null) {
      handleNotification(message.method, message.params);
      return;
    }
    await handleRequest(message.id, message.method, message.params);
    return;
  }

  if (typeof message.id !== "number") return;
  const resolveReply = pendingReplies.get(message.id);
  if (resolveReply === undefined) return;
  pendingReplies.delete(message.id);
  resolveReply(message);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void handleLine(line).catch((error: unknown) => {
    console.error("[fake-acp]", error);
  });
});
input.on("close", () => {
  process.exit(0);
});
