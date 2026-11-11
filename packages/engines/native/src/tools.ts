import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { EngineMcpTool, EnginePermissionRequest, EngineStartOptions, PermissionDecision } from "@noir/engine-core";

/** The result every tool returns when its approval was not granted. The loop marks it failed. */
export const PERMISSION_DENIED = "Permission denied by the user";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_REGEX_LENGTH = 200;
const DEFAULT_LIST_DEPTH = 2;
const MAX_LIST_DEPTH = 5;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 120_000;
const TRUNCATED = "\n[truncated]";
/** Same shape the kernel materializes; a name can never traverse out of the engine root. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * What the loop hands every tool call. The native engine runs inside the kernel process and is
 * the filesystem authority for its own workspace, so the root is the session's workspace root
 * and never anything else.
 */
export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  onPermission(request: EnginePermissionRequest): Promise<PermissionDecision>;
  /** The enabled skill set the engine was started with; `skill.list` reports it. */
  skills: ReadonlyArray<EngineStartOptions["skills"][number]>;
  /** Loads a skill body the kernel controls the location of. */
  readSkill(name: string): Promise<string>;
  /** Runs a namespaced `mcp__<server>__<tool>` call on the session's MCP servers. */
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/** The ACP tool-call kinds `EngineManager.permissionCategory` maps to approval categories. */
type ApprovalKind = "edit" | "delete" | "execute" | "mcp";

type ToolKind = "read" | "write" | "shell" | "search" | "skill" | "other";

interface Target {
  /** The workspace root after symlinks, so every comparison uses one spelling. */
  root: string;
  absolute: string;
  relative: string;
  /** False when the lexical path or a symlink on the way leaves the workspace. */
  inside: boolean;
}

/** The real path of the deepest existing ancestor. Errors other than "nothing here" fail closed. */
async function existingRealPath(target: string): Promise<string | undefined> {
  let probe = target;
  for (;;) {
    try {
      return await realpath(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

/** Tool output always spells paths with `/`, so a Windows workspace reads the same as a POSIX one. */
function portablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

async function resolveTarget(root: string, input: string): Promise<Target> {
  const realRoot = await realpath(root);
  const absolute = resolve(realRoot, input);
  const lexical = relative(realRoot, absolute);
  let inside = lexical === "" || (!lexical.startsWith("..") && !isAbsolute(lexical));
  // The lexical check misses a link inside the workspace; compare the real location instead.
  const real = await existingRealPath(absolute);
  if (real !== undefined) {
    const realRelative = relative(realRoot, real);
    inside = realRelative === "" || (!realRelative.startsWith("..") && !isAbsolute(realRelative));
  }
  return { root: realRoot, absolute, relative: lexical === "" ? "." : portablePath(lexical), inside };
}

/** Read-only tools never leave the workspace. */
async function insideWorkspace(root: string, input: string): Promise<Target> {
  const target = await resolveTarget(root, input);
  if (!target.inside) throw new Error(`Path is outside the workspace: ${input}`);
  return target;
}

async function approve(ctx: ToolContext, title: string, kind: ApprovalKind, rawInput: unknown): Promise<boolean> {
  const decision = await ctx.onPermission({
    sessionId: ctx.sessionId,
    toolCall: { toolCallId: randomUUID(), title, kind, rawInput },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  return decision === "allow_once";
}

function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
  const buffer = Buffer.from(text);
  return buffer.length <= limit ? text : `${buffer.subarray(0, limit).toString("utf8")}${TRUNCATED}`;
}

async function readCapped(absolute: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, MAX_OUTPUT_BYTES)).toString("utf8"),
      truncated: bytesRead > MAX_OUTPUT_BYTES,
    };
  } finally {
    await handle.close();
  }
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const { promise, resolve: settle } = Promise.withResolvers<string>();
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    // A new process group is what makes the POSIX tree kill reach the shell's children.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = {
    stdout: { text: "", truncated: false },
    stderr: { text: "", truncated: false },
  };
  let aborted = false;
  let timedOut = false;
  let settled = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const collect = (stream: { text: string; truncated: boolean }, chunk: string): void => {
    const room = MAX_OUTPUT_BYTES - Buffer.byteLength(stream.text);
    if (room <= 0) {
      stream.truncated = true;
      return;
    }
    const buffer = Buffer.from(chunk);
    if (buffer.length > room) stream.truncated = true;
    stream.text += buffer.subarray(0, room).toString("utf8");
  };

  const kill = (): void => {
    if (child.pid !== undefined) killTree(child.pid);
    // A process that refuses to die must not wedge the turn: report the kill once the grace ends.
    forceTimer ??= setTimeout(() => finish(null, "Command did not exit after it was killed."), 2_000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const finish = (code: number | null, failure?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceTimer);
    signal.removeEventListener("abort", onAbort);
    const parts: string[] = [];
    if (failure !== undefined) parts.push(failure);
    if (output.stdout.text !== "") {
      const text = output.stdout.text.trimEnd();
      parts.push(output.stdout.truncated ? `${text}${TRUNCATED}` : text);
    }
    if (output.stderr.text !== "") {
      const text = output.stderr.text.trimEnd();
      parts.push(output.stderr.truncated ? `${text}${TRUNCATED}` : text);
    }
    if (aborted) parts.push("Command aborted.");
    else if (timedOut) parts.push(`Command timed out after ${timeoutMs}ms.`);
    parts.push(`exit code: ${code === null ? "unknown" : code}`);
    settle(parts.join("\n"));
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    collect(output.stdout, chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    collect(output.stderr, chunk);
  });
  child.on("error", (error) => finish(null, `Command failed to start: ${error.message}`));
  child.on("close", (code) => finish(code));
  return promise;
}

async function listWorkspace(root: string, input: string, depth: number): Promise<string> {
  const target = await insideWorkspace(root, input);
  const entries: Array<{ path: string; kind: "file" | "directory" | "link"; size: number }> = [];
  let truncated = false;

  const walk = async (dir: string, level: number): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      const absolute = join(dir, entry.name);
      const rel = portablePath(relative(target.root, absolute));
      if (entry.isSymbolicLink()) {
        entries.push({ path: rel, kind: "link", size: 0 });
      } else if (entry.isDirectory()) {
        entries.push({ path: `${rel}/`, kind: "directory", size: 0 });
        if (level < depth) await walk(absolute, level + 1);
      } else if (entry.isFile()) {
        entries.push({ path: rel, kind: "file", size: (await stat(absolute)).size });
      }
    }
  };

  await walk(target.absolute, 1);
  return JSON.stringify({ entries, truncated });
}

type SearchArgs = z.infer<typeof SearchSchema>;

async function searchWorkspace(root: string, args: SearchArgs): Promise<string> {
  const target = await insideWorkspace(root, args.path ?? ".");
  let expression: RegExp | undefined;
  if (args.regex === true) {
    if (args.query.length > MAX_REGEX_LENGTH) throw new Error(`Regex patterns are limited to ${MAX_REGEX_LENGTH} characters`);
    try {
      expression = new RegExp(args.query, "u");
    } catch {
      throw new Error("Invalid search regex");
    }
  }

  const matches: Array<{ path: string; line: number; text: string }> = [];
  let scanned = 0;
  let truncated = false;

  const scan = async (dir: string): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (truncated) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".noir") continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      const rel = portablePath(relative(target.root, absolute));
      if (entry.isDirectory()) {
        await scan(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (args.glob !== undefined && !matchesGlob(rel, args.glob)) continue;
      if (++scanned > MAX_SEARCH_FILES) {
        truncated = true;
        return;
      }
      const info = await stat(absolute);
      if (info.size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await readFile(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const hit = expression === undefined ? line.includes(args.query) : expression.test(line);
        if (!hit) continue;
        matches.push({ path: rel, line: index + 1, text: line });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          return;
        }
      }
    }
  };

  await scan(target.absolute);
  return JSON.stringify({ matches, truncated });
}

const ReadSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
const ListSchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional(),
});
const SearchSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  regex: z.boolean().optional(),
});
const WriteSchema = z.object({ path: z.string().min(1), content: z.string() });
const ReplaceSchema = z.object({ path: z.string().min(1), find: z.string().min(1), newText: z.string() });
const DeleteSchema = z.object({ path: z.string().min(1) });
const ShellSchema = z.object({ command: z.string().min(1), timeoutMs: z.number().int().positive().optional() });
const SkillReadSchema = z.object({ name: z.string().min(1) });

interface ToolSpec {
  kind: ToolKind;
  description: string;
  parameters: Record<string, unknown>;
  // The schema parse narrows the raw arguments before the handler runs.
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

const PATH_PROPERTY = { type: "string", description: "Workspace-relative path" };

const TOOL_SPECS: Record<string, ToolSpec> = {
  "fs.read": {
    kind: "read",
    description: "Read a UTF-8 text file inside the workspace. Output is capped at 64 KiB.",
    parameters: {
      type: "object",
      properties: {
        path: PATH_PROPERTY,
        offset: { type: "integer", minimum: 1, description: "First line to return (1-based)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = ReadSchema.parse(raw);
      const target = await insideWorkspace(ctx.workspaceRoot, args.path);
      const { text, truncated } = await readCapped(target.absolute);
      if (!truncated && args.offset === undefined && args.limit === undefined) return text;
      const lines = text.split(/\r?\n/);
      const start = (args.offset ?? 1) - 1;
      const end = args.limit === undefined ? undefined : start + args.limit;
      const sliced = lines.slice(start, end).join("\n");
      return truncated ? `${sliced}${TRUNCATED}` : sliced;
    },
  },

  "fs.list": {
    kind: "read",
    description: "List files and directories inside the workspace, up to 2,000 entries.",
    parameters: {
      type: "object",
      properties: {
        path: PATH_PROPERTY,
        depth: { type: "integer", minimum: 1, maximum: MAX_LIST_DEPTH },
      },
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = ListSchema.parse(raw);
      return await listWorkspace(ctx.workspaceRoot, args.path ?? ".", args.depth ?? DEFAULT_LIST_DEPTH);
    },
  },

  "fs.search": {
    kind: "search",
    description: "Search text files inside the workspace. Literal by default; set regex for a capped pattern. At most 200 matches.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text, or a regular expression when regex is true" },
        path: PATH_PROPERTY,
        glob: { type: "string", description: "Glob filtered against workspace-relative paths" },
        regex: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = SearchSchema.parse(raw);
      return await searchWorkspace(ctx.workspaceRoot, args);
    },
  },

  "fs.write": {
    kind: "write",
    description: "Write a UTF-8 text file. Always asks for approval in this version.",
    parameters: {
      type: "object",
      properties: { path: PATH_PROPERTY, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = WriteSchema.parse(raw);
      const target = await resolveTarget(ctx.workspaceRoot, args.path);
      if (!(await approve(ctx, `Write ${target.relative}`, "edit", args))) return PERMISSION_DENIED;
      await writeFile(target.absolute, args.content, "utf8");
      return JSON.stringify({ bytes: Buffer.byteLength(args.content) });
    },
  },

  "fs.replace": {
    kind: "write",
    description: "Replace exactly one occurrence of find in a UTF-8 text file. Always asks for approval.",
    parameters: {
      type: "object",
      properties: {
        path: PATH_PROPERTY,
        find: { type: "string", description: "Text that must occur exactly once" },
        newText: { type: "string" },
      },
      required: ["path", "find", "newText"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = ReplaceSchema.parse(raw);
      const target = await resolveTarget(ctx.workspaceRoot, args.path);
      // Ask first: an outside target must not be read (or probed for `find`) before approval.
      if (!(await approve(ctx, `Edit ${target.relative}`, "edit", args))) return PERMISSION_DENIED;
      const existing = await readFile(target.absolute, "utf8");
      if (existing.split(args.find).length - 1 !== 1) throw new Error("find must match exactly once");
      // A function replacement keeps `$&`/`$$`/`$'` in newText literal instead of expanding them.
      await writeFile(target.absolute, existing.replace(args.find, () => args.newText), "utf8");
      return JSON.stringify({ replacements: 1 });
    },
  },

  "fs.delete": {
    kind: "write",
    description: "Delete a file with approval. Directories are refused.",
    parameters: {
      type: "object",
      properties: { path: PATH_PROPERTY },
      required: ["path"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = DeleteSchema.parse(raw);
      const target = await resolveTarget(ctx.workspaceRoot, args.path);
      if (!(await approve(ctx, `Delete ${target.relative}`, "delete", args))) return PERMISSION_DENIED;
      const info = await lstat(target.absolute);
      if (info.isDirectory()) throw new Error("fs.delete removes files only");
      await unlink(target.absolute);
      return JSON.stringify({ deleted: true });
    },
  },

  "shell.exec": {
    kind: "shell",
    description: "Run a shell command in the workspace root with approval. Output is capped at 64 KiB per stream.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: MAX_SHELL_TIMEOUT_MS },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = ShellSchema.parse(raw);
      if (!(await approve(ctx, args.command, "execute", args))) return PERMISSION_DENIED;
      if (ctx.signal.aborted) return "Command aborted before it started.";
      const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
      return await runShell(args.command, ctx.workspaceRoot, ctx.signal, timeoutMs);
    },
  },

  "skill.list": {
    kind: "skill",
    description: "List the enabled skills with their scope and description.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run(_raw, ctx) {
      return JSON.stringify({
        skills: ctx.skills.map((skill) => ({
          name: skill.name,
          scope: skill.scope,
          description: skill.description,
        })),
      });
    },
  },

  "skill.read": {
    kind: "skill",
    description: "Read a skill's SKILL.md body. Output is capped at 64 KiB.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async run(raw, ctx) {
      const args = SkillReadSchema.parse(raw);
      if (!SKILL_NAME.test(args.name)) throw new Error(`Unknown skill: ${args.name}`);
      return truncate(await ctx.readSkill(args.name));
    },
  },
};

/** The OpenAI `tools` array: one function definition per kernel-backed tool. */
export const NATIVE_TOOLS = Object.entries(TOOL_SPECS).map(([name, spec]) => ({
  type: "function" as const,
  function: { name, description: spec.description, parameters: spec.parameters },
}));

/** The MCP half of the `tools` array: the session's discovered tools, schemas unchanged. */
export function mcpToolDefinitions(
  tools: ReadonlyArray<EngineMcpTool>,
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function toolKind(name: string): string {
  return TOOL_SPECS[name]?.kind ?? "other";
}

export function toolTitle(name: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  switch (name) {
    case "fs.read":
      return `Read ${text("path")}`;
    case "fs.list":
      return `List ${text("path") === "" ? "." : text("path")}`;
    case "fs.search":
      return `Search "${text("query")}"`;
    case "fs.write":
      return `Write ${text("path")}`;
    case "fs.replace":
      return `Edit ${text("path")}`;
    case "fs.delete":
      return `Delete ${text("path")}`;
    case "shell.exec":
      return text("command");
    case "skill.read":
      return `Read skill ${text("name")}`;
    case "skill.list":
      return "List skills";
    default:
      return name;
  }
}

/**
 * Loads a skill body from the workspace's materialized engine tree. The kernel writes the enabled
 * set there before every engine spawn, so the engine never reads the user's source directories.
 */
export async function readMaterializedSkill(root: string, name: string): Promise<string> {
  if (!SKILL_NAME.test(name)) throw new Error(`Unknown skill: ${name}`);
  const target = await insideWorkspace(root, join(".noir", "skills-engine", name, "SKILL.md"));
  return await readFile(target.absolute, "utf8");
}

/** `mcp__<server>__<tool>`: approved as its own category, then handed to the kernel's broker. */
async function runMcpTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  const call = ctx.callMcpTool;
  if (call === undefined) throw new Error(`Unknown tool: ${name}`);
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  if (!(await approve(ctx, name, "mcp", record))) return PERMISSION_DENIED;
  return await call(name, record);
}

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<string> {
  if (name.startsWith("mcp__")) return await runMcpTool(name, args, ctx);
  const spec = TOOL_SPECS[name];
  if (spec === undefined) throw new Error(`Unknown tool: ${name}`);
  return await spec.run(args, ctx);
}
