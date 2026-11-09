import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { JsonRpcMethodError } from "./jsonRpc.js";

const DEFAULT_OUTPUT_BYTE_LIMIT = 1_048_576;

export type SessionCwdResolver = (sessionId: unknown) => string | undefined;

interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalEntry {
  id: string;
  child: ChildProcess;
  limit: number;
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  exit: TerminalExit | null;
  waiters: Array<(exit: TerminalExit) => void>;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JSON-RPC params must be an object");
  }
  return value as JsonObject;
}

function requireString(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing string parameter: ${key}`);
  return value;
}

function optionalString(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(params: JsonObject, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(params: JsonObject, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected an array of strings: ${key}`);
  }
  return value as string[];
}

/** ACP sends `env` as `[{name, value}]`, not as a map. */
function parseEnv(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("terminal/create env must be an array of {name, value}");
  return value.map((item) => {
    const record = asObject(item);
    const name = record.name;
    const envValue = record.value;
    if (typeof name !== "string" || typeof envValue !== "string") {
      throw new Error("terminal/create env entries must have string name and value");
    }
    return { name, value: envValue };
  });
}

function escapeWorkspaceError(path: string): Error {
  return new Error(`Path escapes the session workspace: ${path}`);
}

export function resolveInsideWorkspace(cwd: string, path: string): string {
  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw escapeWorkspaceError(path);
  return target;
}

function appendOutput(entry: TerminalEntry, chunk: Buffer): void {
  if (entry.truncated) return;
  const remaining = entry.limit - entry.bytes;
  if (chunk.length <= remaining) {
    entry.chunks.push(chunk);
    entry.bytes += chunk.length;
    return;
  }
  if (remaining > 0) {
    entry.chunks.push(chunk.subarray(0, remaining));
    entry.bytes += remaining;
  }
  entry.truncated = true;
}

function settleTerminal(entry: TerminalEntry, exit: TerminalExit): void {
  if (entry.exit !== null) return;
  entry.exit = exit;
  const waiters = entry.waiters.splice(0);
  for (const waiter of waiters) waiter(exit);
}

async function readTextFileSlice(path: string, line: number | undefined, limit: number | undefined): Promise<string> {
  const text = await readFile(path, "utf8");
  if (line === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Answers the requests the ACP agent sends to its client: terminals and a
 * workspace-confined fs. Unknown methods throw a JSON-RPC -32603 naming the
 * method so the agent is never left blocked.
 */
export class ClientRequestHandler {
  readonly #terminals = new Map<string, TerminalEntry>();
  readonly #resolveCwd: SessionCwdResolver;
  #nextTerminalId = 0;

  constructor(resolveCwd: SessionCwdResolver) {
    this.#resolveCwd = resolveCwd;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "terminal/create":
        return await this.#create(asObject(params));
      case "terminal/output":
        return this.#output(asObject(params));
      case "terminal/wait_for_exit":
        return await this.#waitForExit(asObject(params));
      case "terminal/kill":
        return this.#kill(asObject(params));
      case "terminal/release":
        return this.#release(asObject(params));
      case "fs/read_text_file":
        return await this.#readTextFile(asObject(params));
      case "fs/write_text_file":
        return await this.#writeTextFile(asObject(params));
      default:
        throw new JsonRpcMethodError(-32603, `Unknown ACP client method: ${method}`);
    }
  }

  dispose(): void {
    for (const entry of this.#terminals.values()) {
      if (entry.exit === null) entry.child.kill();
    }
    this.#terminals.clear();
  }

  async #create(params: JsonObject): Promise<{ terminalId: string }> {
    const command = requireString(params, "command");
    const args = optionalStringArray(params, "args");
    const cwd = optionalString(params, "cwd") ?? this.#requireCwd(params.sessionId);
    const limit = Math.max(1, Math.floor(optionalNumber(params, "outputByteLimit") ?? DEFAULT_OUTPUT_BYTE_LIMIT));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const pair of parseEnv(params.env)) env[pair.name] = pair.value;

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#nextTerminalId += 1;
    const id = `term-${this.#nextTerminalId}`;
    const entry: TerminalEntry = {
      id,
      child,
      limit,
      chunks: [],
      bytes: 0,
      truncated: false,
      exit: null,
      waiters: [],
    };
    this.#terminals.set(id, entry);

    child.stdout?.on("data", (chunk: Buffer) => appendOutput(entry, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(entry, chunk));
    child.on("error", (error: Error) => {
      appendOutput(entry, Buffer.from(error.message));
      settleTerminal(entry, { exitCode: null, signal: null });
    });
    child.on("exit", (code, signal) => settleTerminal(entry, { exitCode: code, signal }));

    return { terminalId: id };
  }

  #output(params: JsonObject): { output: string; truncated: boolean; exitStatus: TerminalExit | null } {
    const entry = this.#entry(params);
    return {
      output: Buffer.concat(entry.chunks).toString("utf8"),
      truncated: entry.truncated,
      exitStatus: entry.exit,
    };
  }

  async #waitForExit(params: JsonObject): Promise<TerminalExit> {
    const entry = this.#entry(params);
    if (entry.exit !== null) return entry.exit;
    const deferred = Promise.withResolvers<TerminalExit>();
    entry.waiters.push(deferred.resolve);
    return await deferred.promise;
  }

  #kill(params: JsonObject): Record<string, never> {
    const entry = this.#entry(params);
    if (entry.exit === null) entry.child.kill();
    return {};
  }

  #release(params: JsonObject): Record<string, never> {
    const entry = this.#entry(params);
    if (entry.exit === null) entry.child.kill();
    this.#terminals.delete(entry.id);
    return {};
  }

  async #readTextFile(params: JsonObject): Promise<{ content: string }> {
    const cwd = this.#requireCwd(params.sessionId);
    const path = resolveInsideWorkspace(cwd, requireString(params, "path"));
    const content = await readTextFileSlice(path, optionalNumber(params, "line"), optionalNumber(params, "limit"));
    return { content };
  }

  async #writeTextFile(params: JsonObject): Promise<Record<string, never>> {
    const cwd = this.#requireCwd(params.sessionId);
    const path = resolveInsideWorkspace(cwd, requireString(params, "path"));
    const content = params.content;
    if (typeof content !== "string") throw new Error("Missing string parameter: content");
    await writeTextFileAtomic(path, content);
    return {};
  }

  #entry(params: JsonObject): TerminalEntry {
    const terminalId = requireString(params, "terminalId");
    const entry = this.#terminals.get(terminalId);
    if (entry === undefined) throw new Error(`Unknown terminal: ${terminalId}`);
    return entry;
  }

  #requireCwd(sessionId: unknown): string {
    const cwd = this.#resolveCwd(sessionId);
    if (cwd === undefined) {
      throw new Error(`Unknown ACP session: ${typeof sessionId === "string" ? sessionId : "<missing>"}`);
    }
    return cwd;
  }
}
