# M1 Foundation Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable NoirHarness foundation: a headless kernel with an append-only event log, a typed RPC surface, a provider/key registry, and an Electron shell that lists and adds providers.

**Architecture:** `@noir/protocol` owns every wire type and the pure session reducer. `packages/kernel` owns SQLite, services, and the RPC server. `apps/kernel` is the daemon entry. `apps/desktop` is a thin Electron shell that spawns the daemon and hosts a React renderer. No agent execution in this plan — that is Plan 2.

**Tech Stack:** Node 24, pnpm workspaces, TypeScript (strict), zod, better-sqlite3, ws, `@napi-rs/keyring`, React 19, Vite, Electron, Vitest, Playwright, Playwright Electron.

**Spec:** `docs/superpowers/specs/2026-11-09-noirharness-design.md` (sections 3–5, 7.3, 8, 9, 11, 12).

## Global Constraints

- Node `>= 24`, pnpm `>= 10`, TypeScript `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Windows is a first-class target; every path operation must work with spaces and non-ASCII characters.
- Events are append-only. `seq` is gap-free and unique per session. Never update or delete an `events` row.
- Timestamps are epoch milliseconds (`Date.now()`).
- Secrets exist only in the OS credential vault and in kernel memory. Never in SQLite, logs, events, RPC responses, or the renderer.
- The kernel binds `127.0.0.1` only and requires the runtime token on every RPC.
- All UI copy is English. All code identifiers are English.
- One commit per task, message format `feat|test|docs|chore: …`.
- New dependencies are introduced only in the task that names them.

## Review Focus

1. **Windows paths with spaces and non-ASCII characters** — project roots and the data dir must round-trip through SQLite, `spawn`, and the UI without mangling or quoting bugs.
2. **Second kernel instance / stale runtime file** — starting twice on one data dir must fail loudly; a stale file must be replaced, never silently trusted.
3. **Concurrent appends to one session** — two prompts arriving together must still produce unique, ordered `seq` values.
4. **Provider names and URLs containing whitespace, quotes, or unicode** — must persist and render unmangled; an empty/whitespace name must be rejected.
5. **Token exposure** — the runtime token must never appear in logs, events, error messages, or UI copy.

---

## File Structure

```
package.json                         workspace root scripts
pnpm-workspace.yaml
tsconfig.base.json
.gitignore
packages/protocol/
  package.json
  tsconfig.json
  src/index.ts                       re-exports
  src/events.ts                      event envelope, payload schemas, EventType
  src/project.ts                     pure session reducer
  src/rpc.ts                         RPC envelope, method names, param schemas, RpcFault
  test/project.test.ts
  test/rpc.test.ts
packages/kernel/
  package.json
  tsconfig.json
  src/index.ts                       startKernel()
  src/appdata.ts                     dataDir()
  src/db.ts                          openDb()
  src/migrations.ts                  numbered SQL migrations
  src/eventStore.ts                  append() / list()
  src/projects.ts                    ProjectService
  src/workspaces.ts                  WorkspaceService
  src/sessions.ts                    SessionService + transition table
  src/secrets.ts                     Secrets interface + keyring implementation
  src/providers.ts                   ProviderService
  src/rpcServer.ts                   WebSocket JSON-RPC server
  src/runtimeFile.ts                 atomic runtime-file write/read
  test/*.test.ts
apps/kernel/
  package.json
  src/index.ts                       daemon entry
apps/desktop/
  package.json
  vite.config.ts
  playwright.config.ts
  src/main.ts
  src/preload.ts
  src/renderer/index.html
  src/renderer/main.tsx
  src/renderer/App.tsx
  src/renderer/api.ts
  src/renderer/Settings.tsx
  test/provider-flow.spec.ts
docs/adr/0001-kernel-process.md
docs/adr/0002-event-log.md
docs/adr/0006-rpc-transport.md
```

---

### Task 1: Monorepo scaffold + protocol event model + reducer

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/events.ts`, `packages/protocol/src/project.ts`, `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/project.test.ts`
- Create: `docs/adr/0001-kernel-process.md`, `docs/adr/0002-event-log.md`

**Interfaces:**
- Produces: `AgentEvent`, `EventType`, `SessionStatus`, `ContentBlock`, `PayloadSchemas`, `SessionState`, `reduceSession(state, event)`.
- Produces: workspace package name `@noir/protocol`, exported from `src/index.ts`.

- [ ] **Step 1: Create the workspace scaffold**

`package.json`:

```json
{
  "name": "noirharness",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.18.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --filter @noir/desktop dev"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.noir/
.env
```

`packages/protocol/package.json`:

```json
{
  "name": "@noir/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/protocol/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `corepack enable && corepack prepare pnpm@10.18.0 --activate && pnpm install`
Expected: install succeeds, `node_modules` created.

- [ ] **Step 2: Write the failing reducer test**

`packages/protocol/test/project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reduceSession } from "../src/project.js";
import type { AgentEvent, EventType } from "../src/events.js";

function ev(seq: number, type: EventType, payload: unknown): AgentEvent {
  return {
    v: 1, id: `e${seq}`, seq, ts: 1000 + seq, sessionId: "s1", agentId: "a1",
    type, payload,
    provenance: { engine: "acp", engineName: "fake", adapterVersion: "0" },
  };
}

describe("reduceSession", () => {
  it("folds status, title, message blocks, usage and file changes", () => {
    const events = [
      ev(1, "session.created", { title: "New chat" }),
      ev(2, "session.status", { status: "running" }),
      ev(3, "session.updated", { title: "Fix auth" }),
      ev(4, "message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: "Hi" } }),
      ev(5, "message.delta", { messageId: "m1", role: "assistant", block: { type: "text", text: " there" } }),
      ev(6, "message.completed", { messageId: "m1", status: "done" }),
      ev(7, "usage.updated", { inputTokens: 10, outputTokens: 5, contextUsed: 15, contextWindow: 100, costUsd: 0.01 }),
      ev(8, "file.changed", { path: "src/a.ts", change: "modified", add: 3, del: 1 }),
    ];

    const state = events.reduce((acc, e) => reduceSession(acc, e), undefined);

    expect(state.status).toBe("running");
    expect(state.title).toBe("Fix auth");
    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", blocks: [{ type: "text", text: "Hi" }, { type: "text", text: " there" }], status: "done" },
    ]);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, contextUsed: 15, contextWindow: 100, costUsd: 0.01 });
    expect(state.changedFiles).toEqual([{ path: "src/a.ts", change: "modified", add: 3, del: 1 }]);
  });

  it("is order-independent for the same final sequence", () => {
    const events = [
      ev(1, "session.created", { title: "x" }),
      ev(2, "session.status", { status: "idle" }),
    ];
    const once = events.reduce((acc, e) => reduceSession(acc, e), undefined);
    const twice = events.reduce((acc, e) => reduceSession(acc, e), undefined);
    expect(once).toEqual(twice);
  });

  it("rejects a payload that does not match its event type", () => {
    const bad = ev(1, "session.status", {status: "nonsense"});
    expect(() => reduceSession(undefined, bad)).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @noir/protocol test`
Expected: FAIL — cannot resolve `../src/project.js`.

- [ ] **Step 4: Implement the event model**

`packages/protocol/src/events.ts`:

```ts
import { z } from "zod";

export const EVENT_VERSION = 1 as const;

export const SessionStatus = z.enum(["idle", "starting", "running", "waiting", "error", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool_call"), toolCallId: z.string(), title: z.string(), status: z.string() }),
  z.object({ type: z.literal("tool_result"), toolCallId: z.string(), status: z.string(), output: z.string().optional() }),
  z.object({ type: z.literal("image"), mimeType: z.string(), blobRef: z.string() }),
  z.object({ type: z.literal("file_ref"), path: z.string() }),
  z.object({ type: z.literal("diff_ref"), path: z.string(), blobRef: z.string() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const EventType = z.enum([
  "session.created", "session.updated", "session.status", "session.closed",
  "turn.started", "turn.completed", "turn.failed",
  "message.delta", "message.completed",
  "tool.started", "tool.output", "tool.completed", "tool.failed",
  "permission.requested", "permission.resolved",
  "file.changed", "command.started", "command.output", "command.completed",
  "usage.updated", "plan.updated", "todo.updated", "skill.loaded",
  "engine.raw",
]);
export type EventType = z.infer<typeof EventType>;

export const PayloadSchemas = {
  "session.created": z.object({ title: z.string() }),
  "session.updated": z.object({ title: z.string() }),
  "session.status": z.object({ status: SessionStatus }),
  "session.closed": z.object({ reason: z.string().optional() }),
  "turn.started": z.object({ turnId: z.string(), index: z.number().int().nonnegative() }),
  "turn.completed": z.object({ turnId: z.string() }),
  "turn.failed": z.object({ turnId: z.string(), message: z.string() }),
  "message.delta": z.object({ messageId: z.string(), role: z.enum(["user", "assistant"]), block: ContentBlock }),
  "message.completed": z.object({ messageId: z.string(), status: z.enum(["done", "interrupted", "failed"]) }),
  "tool.started": z.object({ toolCallId: z.string(), title: z.string() }),
  "tool.output": z.object({ toolCallId: z.string(), chunk: z.string() }),
  "tool.completed": z.object({ toolCallId: z.string(), status: z.string() }),
  "tool.failed": z.object({ toolCallId: z.string(), message: z.string() }),
  "permission.requested": z.object({ approvalId: z.string(), category: z.enum(["shell", "delete", "rename", "write-outside-workspace", "network"]), title: z.string() }),
  "permission.resolved": z.object({ approvalId: z.string(), decision: z.enum(["allow_once", "allow_always", "reject", "reject_always"]) }),
  "file.changed": z.object({ path: z.string(), change: z.enum(["created", "modified", "deleted"]), add: z.number().int().nonnegative(), del: z.number().int().nonnegative() }),
  "command.started": z.object({ commandId: z.string(), command: z.string() }),
  "command.output": z.object({ commandId: z.string(), chunk: z.string() }),
  "command.completed": z.object({ commandId: z.string(), exitCode: z.number().int() }),
  "usage.updated": z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), contextUsed: z.number().int().nonnegative(), contextWindow: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
  "plan.updated": z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(["pending", "active", "done"]) })) }),
  "todo.updated": z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(["pending", "active", "done"]) })) }),
  "skill.loaded": z.object({ name: z.string(), scope: z.enum(["global", "project"]), hash: z.string() }),
  "engine.raw": z.object({ engine: z.string(), payload: z.unknown() }),
} satisfies Record<EventType, z.ZodType>;

export const AgentEvent = z.object({
  v: z.literal(EVENT_VERSION),
  id: z.string().min(1),
  seq: z.number().int().positive(),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  parentAgentId: z.string().nullish(),
  turnId: z.string().nullish(),
  type: EventType,
  payload: z.unknown(),
  provenance: z.object({
    engine: z.enum(["native", "acp"]),
    engineName: z.string(),
    adapterVersion: z.string(),
  }),
});
export type AgentEvent = z.infer<typeof AgentEvent>;
```

`packages/protocol/src/project.ts`:

```ts
import type { AgentEvent, ContentBlock, EventType, SessionStatus } from "./events.js";
import { PayloadSchemas } from "./events.js";

export interface MessageState { id: string; role: "user" | "assistant"; blocks: ContentBlock[]; status: "streaming" | "done" | "interrupted" | "failed"; }
export interface ChangedFileState { path: string; change: "created" | "modified" | "deleted"; add: number; del: number; }
export interface UsageState { inputTokens: number; outputTokens: number; contextUsed: number; contextWindow: number; costUsd: number; }
export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  title: string;
  messages: MessageState[];
  usage: UsageState;
  changedFiles: ChangedFileState[];
}

function payload<T extends EventType>(e: AgentEvent, type: T): import("zod").infer<(typeof PayloadSchemas)[T]> {
  if (e.type !== type) throw new Error(`expected ${type}, got ${e.type}`);
  return PayloadSchemas[type].parse(e.payload) as import("zod").infer<(typeof PayloadSchemas)[T]>;
}

const EMPTY: Omit<SessionState, "sessionId"> = {
  status: "idle",
  title: "",
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0, contextUsed: 0, contextWindow: 0, costUsd: 0 },
  changedFiles: [],
};

export function reduceSession(state: SessionState | undefined, e: AgentEvent): SessionState {
  const s: SessionState = state ?? { sessionId: e.sessionId, ...structuredClone(EMPTY) };

  switch (e.type) {
    case "session.created":
      return { ...s, title: payload(e, "session.created").title };
    case "session.updated":
      return { ...s, title: payload(e, "session.updated").title };
    case "session.status":
      return { ...s, status: payload(e, "session.status").status };
    case "message.delta": {
      const p = payload(e, "message.delta");
      const idx = s.messages.findIndex((m) => m.id === p.messageId);
      if (idx === -1) {
        return { ...s, messages: [...s.messages, { id: p.messageId, role: p.role, blocks: [p.block], status: "streaming" }] };
      }
      const messages = s.messages.slice();
      const current = messages[idx]!;
      messages[idx] = { ...current, blocks: [...current.blocks, p.block] };
      return { ...s, messages };
    }
    case "message.completed": {
      const p = payload(e, "message.completed");
      return { ...s, messages: s.messages.map((m) => (m.id === p.messageId ? { ...m, status: p.status } : m)) };
    }
    case "usage.updated":
      return { ...s, usage: payload(e, "usage.updated") };
    case "file.changed": {
      const p = payload(e, "file.changed");
      return { ...s, changedFiles: [...s.changedFiles.filter((f) => f.path !== p.path), { path: p.path, change: p.change, add: p.add, del: p.del }] };
    }
    default:
      return s;
  }
}
```

`packages/protocol/src/index.ts`:

```ts
export * from "./events.js";
export * from "./project.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @noir/protocol test`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @noir/protocol typecheck`
Expected: no errors.

- [ ] **Step 7: Write the first two ADRs**

`docs/adr/0001-kernel-process.md`:

```markdown
# ADR-0001: Kernel runs as a separate process

Status: accepted (2026-11-09)

The kernel (state, sessions, providers, events) runs as a headless Node process spawned by Electron main. It communicates over a localhost WebSocket.

Reasons: headless tests without Electron, crash isolation between renderer and daemon, and a path to remote/mobile without rewriting the core. Cost: one localhost IPC hop.
```

`docs/adr/0002-event-log.md`:

```markdown
# ADR-0002: Append-only event log is the transcript of record

Status: accepted (2026-11-09)

Every session is an ordered, immutable event stream. UI projections are pure functions of that stream (`reduceSession`). Events are never updated or deleted inside M1.

Reason: chat, inspector, diff stats, future office view, and audit all consume one truth. Consequence: payloads must be versioned and additive within `v: 1`.
```

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore packages/protocol docs/adr pnpm-lock.yaml
git commit -m "feat: scaffold workspace and event protocol"
```

---

### Task 2: RPC schemas and error model

**Files:**
- Create: `packages/protocol/src/rpc.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/rpc.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 except package config.
- Produces: `Methods`, `JsonRpcRequest`, `JsonRpcSuccess`, `JsonRpcFailure`, `RpcFault`, `ErrorCodes`, `toRpcFailure(error)`, and param schemas `ProjectAddParams`, `WorkspaceCreateParams`, `SessionCreateParams`, `ProviderCreateParams`, `ProviderListResult`, `ProjectListResult`.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/rpc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProviderCreateParams, RpcFault, toRpcFailure } from "../src/rpc.js";

describe("provider params", () => {
  it("trims and accepts a valid provider", () => {
    const parsed = ProviderCreateParams.parse({ name: "  Local  ", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "abc" });
    expect(parsed.name).toBe("Local");
    expect(parsed.enabled).toBe(true);
  });

  it("rejects a whitespace-only name", () => {
    expect(() => ProviderCreateParams.parse({ name: "   ", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k" })).toThrow();
  });

  it("rejects a non-URL baseUrl", () => {
    expect(() => ProviderCreateParams.parse({ name: "x", baseUrl: "not a url", apiKind: "openai-completions", apiKey: "k" })).toThrow();
  });
});

describe("error mapping", () => {
  it("maps RpcFault to a JSON-RPC failure", () => {
    expect(toRpcFailure(7, new RpcFault(-32004, "missing", true))).toEqual({
      jsonrpc: "2.0", id: 7,
      error: { code: -32004, message: "missing", data: { retryable: true } },
    });
  });

  it("maps unknown errors to internal without leaking the message", () => {
    const failure = toRpcFailure(8, new Error("secret sk-123"));
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toBe("Internal error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @noir/protocol test`
Expected: FAIL — cannot resolve `../src/rpc.js`.

- [ ] **Step 3: Implement the RPC contract**

`packages/protocol/src/rpc.ts`:

```ts
import { z } from "zod";

export const Methods = {
  systemHealth: "system.health",
  projectAdd: "project.add",
  projectList: "project.list",
  workspaceCreate: "workspace.create",
  workspaceList: "workspace.list",
  sessionCreate: "session.create",
  sessionList: "session.list",
  sessionSubscribe: "session.subscribe",
  providerCreate: "provider.create",
  providerList: "provider.list",
  providerDelete: "provider.delete",
} as const;

export const ProjectAddParams = z.object({ path: z.string().min(1) });
export const WorkspaceCreateParams = z.object({ projectId: z.string().min(1) });
export const SessionCreateParams = z.object({ workspaceId: z.string().min(1) });
export const SessionSubscribeParams = z.object({ sessionId: z.string().min(1), sinceSeq: z.number().int().nonnegative().default(0) });

export const ApiKind = z.enum(["openai-completions", "anthropic-messages", "google-generative-ai"]);
export type ApiKind = z.infer<typeof ApiKind>;

export const ProviderCreateParams = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  apiKind: ApiKind,
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ProviderCreateParams = z.infer<typeof ProviderCreateParams>;

export const ProviderView = z.object({
  id: z.string(), name: z.string(), baseUrl: z.string(), apiKind: ApiKind,
  enabled: z.boolean(), hasKey: z.boolean(), createdAt: z.number().int(),
});
export const ProviderListResult = z.object({ providers: z.array(ProviderView) });
export const ProjectView = z.object({ id: z.string(), name: z.string(), rootPath: z.string(), createdAt: z.number().int() });
export const ProjectListResult = z.object({ projects: z.array(ProjectView) });

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

export const JsonRpcSuccess = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown() });

export const ErrorCodes = {
  parse: -32700,
  invalidParams: -32602,
  methodNotFound: -32601,
  internal: -32603,
  unauthorized: -32001,
  notFound: -32004,
  conflict: -32009,
} as const;

export class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly retryable = false, readonly details?: unknown) {
    super(message);
    this.name = "RpcFault";
  }
}

export function toRpcFailure(id: string | number, error: unknown) {
  if (error instanceof RpcFault) {
    return {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable || error.details !== undefined ? { data: { retryable: error.retryable, ...(error.details !== undefined ? { details: error.details } : {}) } } : {}),
      },
    };
  }
  return { jsonrpc: "2.0" as const, id, error: { code: ErrorCodes.internal, message: "Internal error" } };
}
```

Modify `packages/protocol/src/index.ts`:

```ts
export * from "./events.js";
export * from "./project.js";
export * from "./rpc.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @noir/protocol test`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat: add typed RPC contract"
```

---

### Task 3: Kernel data dir, SQLite, migrations

**Files:**
- Create: `packages/kernel/package.json`, `packages/kernel/tsconfig.json`
- Create: `packages/kernel/src/appdata.ts`, `packages/kernel/src/db.ts`, `packages/kernel/src/migrations.ts`
- Create: `packages/kernel/test/db.test.ts`

**Interfaces:**
- Produces: `dataDir(): string`, `openDb(file: string): Database.Database`, `migrate(db)`.
- Depends on: `better-sqlite3`.

- [ ] **Step 1: Create the package**

`packages/kernel/package.json`:

```json
{
  "name": "@noir/kernel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit", "build": "tsc --noEmit" },
  "dependencies": {
    "@noir/protocol": "workspace:*",
    "better-sqlite3": "^11.10.0",
    "ws": "^8.18.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/ws": "^8.18.0"
  }
}
```

`packages/kernel/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`
Expected: succeeds.

- [ ] **Step 2: Write the failing test**

`packages/kernel/test/db.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "noir db "));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("openDb", () => {
  it("creates the schema and is idempotent", () => {
    const file = join(tempDir(), "noir.db");
    const db = openDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
    expect(tables).toEqual(expect.arrayContaining(["events", "sessions", "providers", "models", "projects", "workspaces", "schema_migrations"]));
    db.close();

    const again = openDb(file);
    const applied = again.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get() as number;
    expect(applied).toBe(1);
    again.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve `../src/db.js`.

- [ ] **Step 4: Implement**

`packages/kernel/src/appdata.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.NOIR_DATA_DIR) return process.env.NOIR_DATA_DIR;
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "NoirHarness");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "NoirHarness");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "noirharness");
}
```

`packages/kernel/src/migrations.ts`:

```ts
import type Database from "better-sqlite3";

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL, branch TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, engine_id TEXT NOT NULL,
        model_ref TEXT, skill_ids TEXT NOT NULL DEFAULT '[]', permission_policy TEXT NOT NULL DEFAULT '{}',
        parent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id), engine TEXT NOT NULL, engine_session_ref TEXT,
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, config_snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, closed_at INTEGER
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, usage_json TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, agent_id TEXT NOT NULL,
        parent_agent_id TEXT, turn_id TEXT, payload_json TEXT NOT NULL, blob_ref TEXT,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (session_id, seq)
      );
      CREATE TABLE file_changes (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT, path TEXT NOT NULL, change TEXT NOT NULL, add INTEGER NOT NULL, del INTEGER NOT NULL,
        diff_blob TEXT, applied_at INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, decision TEXT, decided_at INTEGER
      );
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (scope, name)
      );
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_kind TEXT NOT NULL,
        api_key_ref TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL, display_name TEXT NOT NULL, context_window INTEGER, max_tokens INTEGER,
        caps_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (provider_id, model_id)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `,
  },
];

export function migrate(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").pluck().all() as number[]);
  const run = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
    }
  });
  run();
}
```

`packages/kernel/src/db.ts`:

```ts
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel pnpm-lock.yaml
git commit -m "feat: add kernel sqlite schema and migrations"
```

---

### Task 4: Event store with sequence, projection, and replay

**Files:**
- Create: `packages/kernel/src/eventStore.ts`
- Create: `packages/kernel/test/eventStore.test.ts`
- Modify: `packages/kernel/package.json` (add `uuid`)

**Interfaces:**
- Consumes: `AgentEvent`, `EventType` from `@noir/protocol`; `openDb`.
- Produces: `class EventStore { constructor(db, onEvent?); append(input): AgentEvent; list(sessionId, sinceSeq?): AgentEvent[]; }`
- Produces: `append` input shape `{ sessionId, agentId, type, payload, parentAgentId?, turnId?, provenance, ts? }`.

- [ ] **Step 1: Add the UUID dependency**

Run: `pnpm --filter @noir/kernel add uuid`
Expected: `uuid` added to `packages/kernel/package.json`.

- [ ] **Step 2: Write the failing test**

`packages/kernel/test/eventStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

function makeStore() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1','p','/tmp/p',1)").run();
  db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES ('w1','p1','/tmp/p','main','local','ready',1)").run();
  db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES ('a1','A','default','acp')").run();
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES ('s1','w1','a1','acp','starting',1)").run();
  return new EventStore(db);
}

const provenance = { engine: "acp" as const, engineName: "fake", adapterVersion: "0" };

describe("EventStore", () => {
  it("assigns gap-free sequence numbers per session", () => {
    const store = makeStore();
    const a = store.append({ sessionId: "s1", agentId: "a1", type: "session.created", payload: { title: "x" }, provenance });
    const b = store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "running" }, provenance });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(store.list("s1", 1).map((e) => e.seq)).toEqual([2]);
  });

  it("projects status and title inside the append transaction", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "session.updated", payload: { title: "Renamed" }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "idle" }, provenance });
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT title, status FROM sessions WHERE id='s1'").get() as { title: string; status: string };
    expect(row).toEqual({ title: "Renamed", status: "idle" });
  });

  it("replays to identical state", () => {
    const store = makeStore();
    store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "running" }, provenance });
    store.append({ sessionId: "s1", agentId: "a1", type: "message.delta", payload: { messageId: "m", role: "assistant", block: { type: "text", text: "hi" } }, provenance });
    const all = store.list("s1");
    expect(all).toHaveLength(2);
    expect(all[1]!.payload).toEqual({ messageId: "m", role: "assistant", block: { type: "text", text: "hi" } });
  });

  it("rejects an event with an invalid payload without writing it", () => {
    const store = makeStore();
    expect(() => store.append({ sessionId: "s1", agentId: "a1", type: "session.status", payload: { status: "bogus" }, provenance })).toThrow();
    expect(store.list("s1")).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve `../src/eventStore.js`.

- [ ] **Step 4: Implement**

`packages/kernel/src/eventStore.ts`:

```ts
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { AgentEvent as AgentEventSchema, PayloadSchemas, type AgentEvent, type EventType } from "@noir/protocol";

export interface AppendInput {
  sessionId: string;
  agentId: string;
  type: EventType;
  payload: unknown;
  parentAgentId?: string | null;
  turnId?: string | null;
  provenance: AgentEvent["provenance"];
  ts?: number;
}

export class EventStore {
  constructor(private readonly db: Database.Database, private readonly onEvent?: (event: AgentEvent) => void) {}

  append(input: AppendInput): AgentEvent {
    const payload = PayloadSchemas[input.type].parse(input.payload);
    const tx = this.db.transaction(() => {
      const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?").get(input.sessionId) as { seq: number };
      const event: AgentEvent = AgentEventSchema.parse({
        v: 1, id: uuidv7(), seq, ts: input.ts ?? Date.now(),
        sessionId: input.sessionId, agentId: input.agentId, type: input.type, payload,
        parentAgentId: input.parentAgentId ?? null, turnId: input.turnId ?? null,
        provenance: input.provenance,
      });
      this.db.prepare(`INSERT INTO events (id, session_id, seq, ts, type, agent_id, parent_agent_id, turn_id, payload_json, provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        event.id, event.sessionId, event.seq, event.ts, event.type, event.agentId, event.parentAgentId, event.turnId, JSON.stringify(payload), JSON.stringify(event.provenance),
      );
      this.project(event, payload);
      return event;
    });
    const event = tx();
    this.onEvent?.(event);
    return event;
  }

  list(sessionId: string, sinceSeq = 0): AgentEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC").all(sessionId, sinceSeq) as Array<Record<string, unknown>>;
    return rows.map((r) => AgentEventSchema.parse({
      v: 1, id: r.id, seq: r.seq, ts: r.ts, sessionId: r.session_id, agentId: r.agent_id,
      parentAgentId: r.parent_agent_id ?? null, turnId: r.turn_id ?? null,
      type: r.type, payload: JSON.parse(r.payload_json as string),
      provenance: JSON.parse(r.provenance_json as string),
    }));
  }

  private project(event: AgentEvent, payload: unknown): void {
    if (event.type === "session.status") {
      this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run((payload as { status: string }).status, event.sessionId);
    } else if (event.type === "session.updated") {
      this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run((payload as { title: string }).title, event.sessionId);
    } else if (event.type === "session.closed") {
      this.db.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(event.ts, event.sessionId);
    } else if (event.type === "turn.started") {
      const p = payload as { turnId: string; index: number };
      this.db.prepare("INSERT INTO turns (id, session_id, idx, status, started_at) VALUES (?,?,?,'running',?)").run(p.turnId, event.sessionId, p.index, event.ts);
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      const p = payload as { turnId: string };
      const status = event.type === "turn.completed" ? "completed" : "failed";
      this.db.prepare("UPDATE turns SET status = ?, ended_at = ? WHERE id = ?").run(status, event.ts, p.turnId);
    } else if (event.type === "file.changed") {
      const p = payload as { path: string; change: string; add: number; del: number };
      this.db.prepare("INSERT INTO file_changes (id, session_id, turn_id, path, change, add, del, applied_at) VALUES (?,?,?,?,?,?,?,?)").run(
        uuidv7(), event.sessionId, event.turnId, p.path, p.change, p.add, p.del, event.ts,
      );
    }
  }
}
```

`list()` reads `provenance_json`, so provenance survives replay. The Task 3 migration already includes the column:

```sql
provenance_json TEXT NOT NULL DEFAULT '{}',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS (5 tests: 1 db + 4 event store).

- [ ] **Step 6: Commit**

```bash
git add packages/kernel pnpm-lock.yaml
git commit -m "feat: add append-only event store"
```

---

### Task 5: Projects, workspaces, sessions, and lifecycle transitions

**Files:**
- Create: `packages/kernel/src/projects.ts`, `packages/kernel/src/workspaces.ts`, `packages/kernel/src/sessions.ts`
- Create: `packages/kernel/test/services.test.ts`

**Interfaces:**
- Consumes: `openDb`, `EventStore`, `RpcFault`, `ErrorCodes`.
- Produces: `class ProjectService { add(rootPath): ProjectRow; list(): ProjectRow[] }`
- Produces: `class WorkspaceService { createLocal(projectId): WorkspaceRow; list(): WorkspaceRow[] }`
- Produces: `class SessionService { create(workspaceId): SessionRow; setStatus(sessionId, status): void; list(): SessionRow[] }`
- Produces: `assertTransition(from, to)` with the transition table from spec §6.

- [ ] **Step 1: Write the failing test**

`packages/kernel/test/services.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ProjectService } from "../src/projects.js";
import { WorkspaceService } from "../src/workspaces.js";
import { SessionService } from "../src/sessions.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir svc ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = openDb(":memory:");
  const events = new EventStore(db);
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  return { db, events, projects, workspaces, sessions };
}

describe("ProjectService", () => {
  it("adds a real directory and rejects a file", () => {
    const { projects } = setup();
    const root = tempDir();
    const project = projects.add(root);
    expect(project.rootPath).toBe(root);
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    expect(() => projects.add(file)).toThrow(RpcFault);
  });

  it("rejects a duplicate path", () => {
    const { projects } = setup();
    const root = tempDir();
    projects.add(root);
    expect(() => projects.add(root)).toThrow(/already/);
  });

  it("accepts a path with spaces and unicode", () => {
    const { projects } = setup();
    const root = join(tempDir(), "my project ü");
    mkdirSync(root, { recursive: true });
    expect(projects.add(root).rootPath).toBe(root);
  });
});

describe("WorkspaceService", () => {
  it("creates a local workspace for a project", () => {
    const { projects, workspaces } = setup();
    const project = projects.add(tempDir());
    const ws = workspaces.createLocal(project.id);
    expect(ws.kind).toBe("local");
    expect(ws.path).toBe(project.rootPath);
  });
});

describe("SessionService", () => {
  it("creates a session in starting state and allows starting -> idle", () => {
    const { projects, workspaces, sessions } = setup();
    const project = projects.add(tempDir());
    const ws = workspaces.createLocal(project.id);
    const s = sessions.create(ws.id);
    expect(s.status).toBe("starting");
    sessions.setStatus(s.id, "idle");
    expect(sessions.list()[0]!.status).toBe("idle");
  });

  it("rejects an illegal transition", () => {
    const { projects, workspaces, sessions } = setup();
    const project = projects.add(tempDir());
    const s = sessions.create(workspaces.createLocal(project.id).id);
    expect(() => sessions.setStatus(s.id, "waiting")).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve the three service modules.

- [ ] **Step 3: Implement**

`packages/kernel/src/projects.ts`:

```ts
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault } from "@noir/protocol";

export interface ProjectRow { id: string; name: string; rootPath: string; createdAt: number; }

export class ProjectService {
  constructor(private readonly db: Database.Database) {}

  add(rootPath: string): ProjectRow {
    const abs = resolve(rootPath);
    let stat;
    try { stat = statSync(abs); } catch { throw new RpcFault(ErrorCodes.invalidParams, `Path does not exist: ${abs}`); }
    if (!stat.isDirectory()) throw new RpcFault(ErrorCodes.invalidParams, `Not a directory: ${abs}`);
    const existing = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(abs);
    if (existing) throw new RpcFault(ErrorCodes.conflict, "Project already added");

    const row: ProjectRow = { id: uuidv7(), name: basename(abs) || abs, rootPath: abs, createdAt: Date.now() };
    this.db.prepare("INSERT INTO projects (id, name, root_path, created_at) VALUES (?,?,?,?)").run(row.id, row.name, row.rootPath, row.createdAt);
    return row;
  }

  list(): ProjectRow[] {
    return (this.db.prepare("SELECT id, name, root_path, created_at FROM projects ORDER BY created_at DESC").all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id as string, name: r.name as string, rootPath: r.root_path as string, createdAt: r.created_at as number }));
  }
}
```

`packages/kernel/src/workspaces.ts`:

```ts
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault } from "@noir/protocol";
import type { ProjectService } from "./projects.js";

export interface WorkspaceRow { id: string; projectId: string; path: string; branch: string | null; kind: "local"; status: "ready"; }

export class WorkspaceService {
  constructor(private readonly db: Database.Database, private readonly projects: ProjectService) {}

  createLocal(projectId: string): WorkspaceRow {
    const project = this.projects.list().find((p) => p.id === projectId);
    if (!project) throw new RpcFault(ErrorCodes.notFound, "Project not found");
    const row: WorkspaceRow = { id: uuidv7(), projectId, path: project.rootPath, branch: null, kind: "local", status: "ready" };
    this.db.prepare("INSERT INTO workspaces (id, project_id, path, branch, kind, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
      row.id, row.projectId, row.path, row.branch, row.kind, row.status, Date.now(),
    );
    return row;
  }

  list(): WorkspaceRow[] {
    return (this.db.prepare("SELECT id, project_id, path, branch, kind, status FROM workspaces ORDER BY created_at DESC").all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id as string, projectId: r.project_id as string, path: r.path as string, branch: (r.branch as string) ?? null, kind: r.kind as "local", status: r.status as "ready" }));
  }
}
```

`packages/kernel/src/sessions.ts`:

```ts
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type SessionStatus } from "@noir/protocol";
import type { EventStore } from "./eventStore.js";

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  starting: ["idle", "error", "closed"],
  idle: ["running", "closed", "error"],
  running: ["waiting", "idle", "error", "closed"],
  waiting: ["running", "idle", "error", "closed"],
  error: ["idle", "closed"],
  closed: [],
};

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new RpcFault(ErrorCodes.conflict, `Invalid session transition ${from} -> ${to}`);
}

export interface SessionRow { id: string; workspaceId: string; agentId: string; engine: string; title: string; status: SessionStatus; createdAt: number; }

export class SessionService {
  constructor(private readonly db: Database.Database, private readonly events: EventStore) {}

  create(workspaceId: string): SessionRow {
    const ws = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!ws) throw new RpcFault(ErrorCodes.notFound, "Workspace not found");
    const agentId = uuidv7();
    this.db.prepare("INSERT INTO agents (id, name, role, engine_id) VALUES (?,?,?,?)").run(agentId, "Agent", "default", "acp");
    const row: SessionRow = { id: uuidv7(), workspaceId, agentId, engine: "acp", title: "", status: "starting", createdAt: Date.now() };
    this.db.prepare("INSERT INTO sessions (id, workspace_id, agent_id, engine, status, created_at) VALUES (?,?,?,?,?,?)").run(
      row.id, row.workspaceId, row.agentId, row.engine, row.status, row.createdAt,
    );
    this.events.append({ sessionId: row.id, agentId, type: "session.created", payload: { title: "" }, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
    return row;
  }

  setStatus(sessionId: string, to: SessionStatus, opts?: { from?: SessionStatus }): void {
    const row = this.db.prepare("SELECT status, agent_id FROM sessions WHERE id = ?").get(sessionId) as { status: SessionStatus; agent_id: string } | undefined;
    if (!row) throw new RpcFault(ErrorCodes.notFound, "Session not found");
    const from = opts?.from ?? row.status;
    if (from !== row.status) throw new RpcFault(ErrorCodes.conflict, `Session is ${row.status}, not ${from}`);
    assertTransition(from, to);
    this.events.append({ sessionId, agentId: row.agent_id, type: "session.status", payload: { status: to }, provenance: { engine: "acp", engineName: "none", adapterVersion: "0" } });
  }

  list(): SessionRow[] {
    return (this.db.prepare("SELECT id, workspace_id, agent_id, engine, title, status, created_at FROM sessions ORDER BY created_at DESC").all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id as string, workspaceId: r.workspace_id as string, agentId: r.agent_id as string, engine: r.engine as string, title: r.title as string, status: r.status as SessionStatus, createdAt: r.created_at as number }));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel
git commit -m "feat: add project workspace and session services"
```

---

### Task 6: Provider registry with OS keyring secrets

**Files:**
- Create: `packages/kernel/src/secrets.ts`, `packages/kernel/src/providers.ts`
- Create: `packages/kernel/test/providers.test.ts`
- Modify: `packages/kernel/package.json` (add `@napi-rs/keyring`)
- Create: `docs/adr/0003-provider-registry.md`

**Interfaces:**
- Produces: `interface Secrets { set(id, value): void; get(id): string | null; delete(id): void }`
- Produces: `class KeyringSecrets implements Secrets`
- Produces: `class ProviderService { constructor(db, secrets); create(params): ProviderView; list(): ProviderView[]; remove(id): void; getKey(id): string }`

- [ ] **Step 1: Add the keyring dependency**

Run: `pnpm --filter @noir/kernel add @napi-rs/keyring`
Expected: dependency added.

- [ ] **Step 2: Write the failing test**

`packages/kernel/test/providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RpcFault } from "@noir/protocol";
import { openDb } from "../src/db.js";
import { ProviderService, type Secrets } from "../src/providers.js";

function memorySecrets(): Secrets & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: (id, v) => void store.set(id, v),
    get: (id) => store.get(id) ?? null,
    delete: (id) => void store.delete(id),
  };
}

describe("ProviderService", () => {
  it("stores the key in secrets and never returns it", () => {
    const db = openDb(":memory:");
    const secrets = memorySecrets();
    const service = new ProviderService(db, secrets);
    const created = service.create({ name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "sk-secret", enabled: true });
    expect(created.hasKey).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-secret");
    expect(secrets.store.get(created.id)).toBe("sk-secret");
  });

  it("rejects a duplicate provider name", () => {
    const db = openDb(":memory:");
    const service = new ProviderService(db, memorySecrets());
    const p = { name: "Dup", baseUrl: "http://x/v1", apiKind: "openai-completions" as const, apiKey: "k", enabled: true };
    service.create(p);
    expect(() => service.create(p)).toThrow(RpcFault);
  });

  it("deletes the row and the secret together", () => {
    const db = openDb(":memory:");
    const secrets = memorySecrets();
    const service = new ProviderService(db, secrets);
    const p = service.create({ name: "D", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    service.remove(p.id);
    expect(service.list()).toEqual([]);
    expect(secrets.store.has(p.id)).toBe(false);
  });

  it("preserves unicode and spaces in names", () => {
    const db = openDb(":memory:");
    const service = new ProviderService(db, memorySecrets());
    const p = service.create({ name: "Ünïcode Provider", baseUrl: "http://x/v1", apiKind: "openai-completions", apiKey: "k", enabled: true });
    expect(service.list()[0]!.name).toBe("Ünïcode Provider");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve `../src/providers.js`.

- [ ] **Step 4: Implement**

`packages/kernel/src/secrets.ts`:

```ts
import { Entry } from "@napi-rs/keyring";

export interface Secrets {
  set(id: string, value: string): void;
  get(id: string): string | null;
  delete(id: string): void;
}

export class KeyringSecrets implements Secrets {
  private entry(id: string): Entry { return new Entry("NoirHarness", id); }
  set(id: string, value: string): void { this.entry(id).setPassword(value); }
  get(id: string): string | null { try { return this.entry(id).getPassword(); } catch { return null; } }
  delete(id: string): void { try { this.entry(id).deletePassword(); } catch { /* already absent */ } }
}
```

`packages/kernel/src/providers.ts`:

```ts
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { ErrorCodes, RpcFault, type ApiKind, type ProviderCreateParams, type ProviderView } from "@noir/protocol";

export interface Secrets {
  set(id: string, value: string): void;
  get(id: string): string | null;
  delete(id: string): void;
}

interface ProviderRow { id: string; name: string; base_url: string; api_kind: ApiKind; enabled: number; created_at: number; }

export class ProviderService {
  constructor(private readonly db: Database.Database, private readonly secrets: Secrets) {}

  create(params: ProviderCreateParams): ProviderView {
    const dup = this.db.prepare("SELECT id FROM providers WHERE name = ?").get(params.name);
    if (dup) throw new RpcFault(ErrorCodes.conflict, "Provider name already exists");
    const id = uuidv7();
    const createdAt = Date.now();
    this.secrets.set(id, params.apiKey);
    this.db.prepare("INSERT INTO providers (id, name, base_url, api_kind, api_key_ref, enabled, created_at) VALUES (?,?,?,?,?,?,?)").run(
      id, params.name, params.baseUrl, params.apiKind, id, params.enabled ? 1 : 0, createdAt,
    );
    return { id, name: params.name, baseUrl: params.baseUrl, apiKind: params.apiKind, enabled: params.enabled, hasKey: true, createdAt };
  }

  list(): ProviderView[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY created_at DESC").all() as ProviderRow[]).map((r) => ({
      id: r.id, name: r.name, baseUrl: r.base_url, apiKind: r.api_kind,
      enabled: r.enabled === 1, hasKey: this.secrets.get(r.id) !== null, createdAt: r.created_at,
    }));
  }

  getKey(id: string): string {
    const key = this.secrets.get(id);
    if (!key) throw new RpcFault(ErrorCodes.notFound, "Provider key not found");
    return key;
  }

  remove(id: string): void {
    const info = this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    if (info.changes === 0) throw new RpcFault(ErrorCodes.notFound, "Provider not found");
    this.secrets.delete(id);
  }
}
```

`docs/adr/0003-provider-registry.md`:

```markdown
# ADR-0003: Provider registry is owned by the kernel

Status: accepted (2026-11-09)

Providers (base URL, API kind, key handle) and models are kernel rows, not engine configuration. Engine configuration is generated from them (Plan 2).

Reason: the product requirement is provider configuration inside NoirHarness; engine config must never become the source of truth. Secrets are stored in the OS credential vault under the provider id; the database keeps only the handle.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel docs/adr/0003-provider-registry.md pnpm-lock.yaml
git commit -m "feat: add provider registry with keyring secrets"
```

---

### Task 7: WebSocket JSON-RPC server with token auth

**Files:**
- Create: `packages/kernel/src/rpcServer.ts`
- Create: `packages/kernel/test/rpcServer.test.ts`
- Create: `docs/adr/0006-rpc-transport.md`

**Interfaces:**
- Consumes: `JsonRpcRequest`, `toRpcFailure`, `RpcFault`, `ErrorCodes`.
- Produces: `interface RpcServer { port: number; close(): Promise<void>; broadcast(event: AgentEvent): void }`
- Produces: `startRpcServer(opts: { token: string; handlers: Record<string, (params: unknown) => Promise<unknown>> }): Promise<RpcServer>`
- WebSocket URL: `ws://127.0.0.1:<port>/?token=<token>`.

- [ ] **Step 1: Write the failing test**

`packages/kernel/test/rpcServer.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startRpcServer, type RpcServer } from "../src/rpcServer.js";

let server: RpcServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function call(ws: WebSocket, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
}

describe("rpc server", () => {
  it("rejects a bad token", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    await expect(connect(server.port, "bad")).rejects.toThrow();
  });

  it("answers a health call", async () => {
    server = await startRpcServer({ token: "good", handlers: { "system.health": async () => ({ ok: true }) } });
    const ws = await connect(server.port, "good");
    const res = await call(ws, "system.health");
    expect(res.result).toEqual({ ok: true });
    ws.close();
  });

  it("returns method not found", async () => {
    server = await startRpcServer({ token: "good", handlers: {} });
    const ws = await connect(server.port, "good");
    const res = await call(ws, "nope");
    expect(res.error.code).toBe(-32601);
    ws.close();
  });

  it("never echoes the token in an error", async () => {
    server = await startRpcServer({ token: "super-secret-token", handlers: { "boom": async () => { throw new Error("x"); } } });
    const ws = await connect(server.port, "super-secret-token");
    const res = await call(ws, "boom");
    expect(JSON.stringify(res)).not.toContain("super-secret-token");
    ws.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve `../src/rpcServer.js`.

- [ ] **Step 3: Implement**

`packages/kernel/src/rpcServer.ts`:

```ts
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ErrorCodes, JsonRpcRequest, RpcFault, toRpcFailure, type AgentEvent } from "@noir/protocol";

export type Handler = (params: unknown) => Promise<unknown>;

export interface RpcServer {
  port: number;
  close(): Promise<void>;
  broadcast(event: AgentEvent): void;
}

export async function startRpcServer(opts: { token: string; handlers: Record<string, Handler> }): Promise<RpcServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== opts.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      let id: string | number = 0;
      try {
        const parsed = JsonRpcRequest.parse(JSON.parse(String(raw)));
        id = parsed.id;
        const handler = opts.handlers[parsed.method];
        if (!handler) throw new RpcFault(ErrorCodes.methodNotFound, `Unknown method: ${parsed.method}`);
        const result = await handler(parsed.params);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (error) {
        ws.send(JSON.stringify(toRpcFailure(id, error)));
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;

  return {
    port,
    broadcast(event) {
      const message = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event } });
      for (const client of clients) if (client.readyState === client.OPEN) client.send(message);
    },
    async close() {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
```

`docs/adr/0006-rpc-transport.md`:

```markdown
# ADR-0006: Localhost WebSocket JSON-RPC with a runtime token

Status: accepted (2026-11-09)

The kernel binds `127.0.0.1` on an ephemeral port and writes `{ pid, port, token }` to a `0600` runtime file. Every RPC requires the token; event frames are server-initiated notifications.

Reason: one transport serves the renderer today and a headless client or remote daemon later. The token prevents other local processes from driving the agent.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel docs/adr/0006-rpc-transport.md
git commit -m "feat: add authenticated json-rpc server"
```

---

### Task 8: Kernel entrypoint, wiring, and runtime file

**Files:**
- Create: `packages/kernel/src/runtimeFile.ts`, `packages/kernel/src/index.ts`
- Create: `apps/kernel/package.json`, `apps/kernel/tsconfig.json`, `apps/kernel/src/index.ts`
- Create: `packages/kernel/test/kernel.test.ts`

**Interfaces:**
- Consumes: every prior service.
- Produces: `startKernel(opts?: { dataDir?: string }): Promise<{ port: number; token: string; close(): Promise<void> }>`
- Produces: `runtimeFilePath(dir: string): string`, `readRuntimeFile(file): RuntimeInfo | null`, `writeRuntimeFile(file, info)`.
- RPC handlers: `system.health`, `project.add`, `project.list`, `workspace.create`, `workspace.list`, `session.create`, `session.list`, `provider.create`, `provider.list`, `provider.delete`, `session.subscribe`.

- [ ] **Step 1: Write the failing test**

`packages/kernel/test/kernel.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startKernel } from "../src/index.js";

const dirs: string[] = [];
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), "noir kernel ")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function call(port: number, token: string, method: string, params?: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const response = await new Promise<any>((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(String(data))));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
  ws.close();
  return response;
}

describe("startKernel", () => {
  it("writes a runtime file and serves health", async () => {
    const dir = tempDir();
    const kernel = await startKernel({ dataDir: dir });
    const info = JSON.parse(readFileSync(join(dir, "runtime", "kernel.json"), "utf8"));
    expect(info.port).toBe(kernel.port);
    expect(info.token).toBe(kernel.token);
    const res = await call(kernel.port, kernel.token, "system.health");
    expect(res.result.status).toBe("ok");
    await kernel.close();
  });

  it("persists a provider across restarts", async () => {
    const dir = tempDir();
    const first = await startKernel({ dataDir: dir });
    await call(first.port, first.token, "provider.create", {
      name: "Local", baseUrl: "http://localhost:11434/v1", apiKind: "openai-completions", apiKey: "k",
    });
    await first.close();

    const second = await startKernel({ dataDir: dir });
    const res = await call(second.port, second.token, "provider.list");
    expect(res.result.providers).toHaveLength(1);
    expect(res.result.providers[0].hasKey).toBe(true);
    expect(JSON.stringify(res.result)).not.toContain('"k"');
    await second.close();
  });

  it("refuses a second live instance on the same data dir", async () => {
    const dir = tempDir();
    const first = await startKernel({ dataDir: dir });
    await expect(startKernel({ dataDir: dir })).rejects.toThrow(/already running/i);
    await first.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @noir/kernel test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Implement**

`packages/kernel/src/runtimeFile.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RuntimeInfo { pid: number; port: number; token: string; }

export function runtimeFilePath(dataDir: string): string { return `${dataDir}/runtime/kernel.json`; }

export function readRuntimeFile(file: string): RuntimeInfo | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo; } catch { return null; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function writeRuntimeFile(file: string, info: RuntimeInfo): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeRuntimeFile(file: string): void {
  try { unlinkSync(file); } catch { /* absent */ }
}
```

`packages/kernel/src/index.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ErrorCodes, Methods, ProjectAddParams, ProviderCreateParams, RpcFault, SessionCreateParams, WorkspaceCreateParams } from "@noir/protocol";
import { dataDir as defaultDataDir } from "./appdata.js";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { ProjectService } from "./projects.js";
import { ProviderService } from "./providers.js";
import { startRpcServer } from "./rpcServer.js";
import { isProcessAlive, readRuntimeFile, removeRuntimeFile, runtimeFilePath, writeRuntimeFile } from "./runtimeFile.js";
import { KeyringSecrets } from "./secrets.js";
import { SessionService } from "./sessions.js";
import { WorkspaceService } from "./workspaces.js";

export interface Kernel { port: number; token: string; close(): Promise<void>; }

export async function startKernel(opts: { dataDir?: string } = {}): Promise<Kernel> {
  const dir = opts.dataDir ?? defaultDataDir();
  const file = runtimeFilePath(dir);
  mkdirSync(dir, { recursive: true });
  const existing = readRuntimeFile(file);
  if (existing && isProcessAlive(existing.pid)) throw new Error(`Kernel already running (pid ${existing.pid})`);

  const db = openDb(join(dir, "noir.db"));
  let broadcast: (event: import("@noir/protocol").AgentEvent) => void = () => {};
  const events = new EventStore(db, (event) => broadcast(event));
  const projects = new ProjectService(db);
  const workspaces = new WorkspaceService(db, projects);
  const sessions = new SessionService(db, events);
  const providers = new ProviderService(db, new KeyringSecrets());

  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    [Methods.systemHealth]: async () => ({ status: "ok", pid: process.pid }),
    [Methods.projectAdd]: async (params) => projects.add(ProjectAddParams.parse(params).path),
    [Methods.projectList]: async () => ({ projects: projects.list() }),
    [Methods.workspaceCreate]: async (params) => workspaces.createLocal(WorkspaceCreateParams.parse(params).projectId),
    [Methods.workspaceList]: async () => ({ workspaces: workspaces.list() }),
    [Methods.sessionCreate]: async (params) => sessions.create(SessionCreateParams.parse(params).workspaceId),
    [Methods.sessionList]: async () => ({ sessions: sessions.list() }),
    [Methods.providerCreate]: async (params) => providers.create(ProviderCreateParams.parse(params)),
    [Methods.providerList]: async () => ({ providers: providers.list() }),
    [Methods.providerDelete]: async (params) => { providers.remove((params as { id: string }).id); return { ok: true }; },
    [Methods.sessionSubscribe]: async (params) => {
      const { sessionId, sinceSeq } = params as { sessionId: string; sinceSeq?: number };
      const rows = events.list(sessionId, sinceSeq ?? 0);
      if (rows.length === 0) return { events: [] };
      return { events: rows };
    },
  };

  const token = randomBytes(32).toString("hex");
  const server = await startRpcServer({ token, handlers });
  broadcast = (event) => server.broadcast(event);
  writeRuntimeFile(file, { pid: process.pid, port: server.port, token });

  let closed = false;
  return {
    port: server.port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      db.close();
      removeRuntimeFile(file);
    },
  };
}
```

`session.subscribe` returns the replay batch in this plan; live streaming registration lands with the chat surface in Plan 2 and does not change the envelope.

`apps/kernel/package.json`:

```json
{
  "name": "@noir/app-kernel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc --noEmit", "test": "vitest run --passWithNoTests", "typecheck": "tsc --noEmit" },
  "dependencies": { "@noir/kernel": "workspace:*" }
}
```

Wait: the daemon needs to run with tsx or compiled JS. For dev and tests, use `tsx`. Add `tsx` as a devDependency at root. Entry `apps/kernel/src/index.ts`:

```ts
import { startKernel } from "@noir/kernel";

void (async () => {
  const kernel = await startKernel();
  const shutdown = async () => { await kernel.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(JSON.stringify({ event: "kernel.ready", port: kernel.port }));
})();
```

Note: must not log the token.

`apps/kernel/tsconfig.json` extends base with include src.

Add `tsx` to root devDependencies: `pnpm add -Dw tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @noir/kernel test`
Expected: PASS. If `@napi-rs/keyring` cannot load in CI without a keyring, the provider test uses `memorySecrets`, and `startKernel` constructs `KeyringSecrets` lazily; constructing it only creates entries on use, so no vault access at startup.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel apps/kernel package.json pnpm-lock.yaml
git commit -m "feat: wire kernel daemon and runtime handshake"
```

---

### Task 9: Electron shell, preload bridge, and renderer boot

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/vite.config.ts`, `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/main.tsx`, `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/api.ts`
- Create: `apps/desktop/test/smoke.spec.ts`
- Modify: `apps/kernel/package.json` (esbuild build script)

**Interfaces:**
- Consumes: `startKernel` output and the runtime file format `{ pid, port, token }`.
- Produces: preload API `window.noir.kernelInfo(): Promise<{ port: number; token: string }>`.
- Produces: renderer module `api.ts` exporting `kernelInfo()`, `request(method, params)`, `connect(onEvent)`.

- [ ] **Step 1: Build the daemon to JavaScript**


Replace `apps/kernel/package.json` with:

```json
{
  "name": "@noir/app-kernel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.cjs --external:better-sqlite3 --external:@napi-rs/keyring",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@noir/kernel": "workspace:*" }
}
```

Run: `pnpm --filter @noir/app-kernel add better-sqlite3 @napi-rs/keyring`

Run: `pnpm add -Dw esbuild tsx`
Run: `pnpm --filter @noir/app-kernel build`
Expected: `apps/kernel/dist/index.cjs` exists.

- [ ] **Step 2: Create the desktop package**

`apps/desktop/package.json`:

```json
{
  "name": "@noir/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/main.cjs",
  "scripts": {
    "dev": "pnpm --filter @noir/app-kernel build && concurrently -k \"vite\" \"wait-on http://127.0.0.1:5173 && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 electron .\"",
    "build": "pnpm --filter @noir/app-kernel build && vite build && esbuild src/main.ts src/preload.ts --bundle --platform=node --format=cjs --external:electron --outdir=dist --out-extension:.js=.cjs",
    "test": "vitest run --passWithNoTests",
    "test:e2e": "pnpm build && playwright test",
  },
  "dependencies": { "@noir/protocol": "workspace:*", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.4.0",
    "concurrently": "^9.1.0",
    "cross-env": "^7.0.3",
    "electron": "^38.0.0",
    "vite": "^6.0.0",
    "wait-on": "^8.0.0"
  }
}
```

Run: `pnpm install`
Expected: Electron downloads successfully.

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"] },
  "include": ["src", "test", "vite.config.ts", "playwright.config.ts"]
}
```

`apps/desktop/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
```

`apps/desktop/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
```

- [ ] **Step 3: Write the failing smoke test**

`apps/desktop/test/smoke.spec.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("boots, spawns the kernel, and reaches health", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "noir e2e "));
  const app = await electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @noir/desktop test:e2e`
Expected: FAIL — no `dist/main.cjs` or no `kernel-status` element.

- [ ] **Step 5: Implement main and preload**

`apps/desktop/src/main.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";

function runtimeFilePath(dir: string): string { return join(dir, "runtime", "kernel.json"); }
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function readRuntimeFile(file: string): { pid: number; port: number; token: string } | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number; token: string }; } catch { return null; }
}

const dataDir = process.env.NOIR_DATA_DIR ?? app.getPath("userData");
const kernelEntry = process.env.NOIR_KERNEL_ENTRY ?? join(app.getAppPath(), "..", "kernel", "dist", "index.cjs");

let kernel: ChildProcess | undefined;
let info: { port: number; token: string } | undefined;

async function waitForKernel(file: string, timeoutMs = 20_000): Promise<{ port: number; token: string }> {
  const started = Date.now();
  for (;;) {
    const current = readRuntimeFile(file);
    if (current && isProcessAlive(current.pid)) return { port: current.port, token: current.token };
    if (Date.now() - started > timeoutMs) throw new Error("Kernel did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startKernel(): Promise<{ port: number; token: string }> {
  mkdirSync(dataDir, { recursive: true });
  kernel = spawn(process.execPath, [kernelEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NOIR_DATA_DIR: dataDir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return waitForKernel(runtimeFilePath(dataDir));
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680,
    backgroundColor: "#f4efe6",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  info = await startKernel();
  ipcMain.handle("kernel:info", () => info);
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("before-quit", () => { kernel?.kill(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
```

`apps/desktop/src/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("noir", {
  kernelInfo: () => ipcRenderer.invoke("kernel:info"),
});
```

- [ ] **Step 6: Implement the minimal renderer**

`apps/desktop/src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NoirHarness</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/api.ts`:

```ts
interface KernelInfo { port: number; token: string }

declare global { interface Window { noir: { kernelInfo(): Promise<KernelInfo> } } }

let socket: WebSocket | undefined;
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

export async function connect(): Promise<void> {
  if (socket) return;
  const info = await window.noir.kernelInfo();
  socket = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("kernel connection failed")), { once: true });
  });
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as { id?: number; result?: unknown };
    if (typeof frame.id === "number") { pending.get(frame.id)?.(frame.result); pending.delete(frame.id); }
  });
}

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve) => {
    pending.set(id, (value) => resolve(value as T));
    socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
```

`apps/desktop/src/renderer/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { connect, request } from "./api.js";

export function App() {
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    void (async () => {
      try {
        await connect();
        const health = await request<{ status: string }>("system.health");
        setStatus(health.status === "ok" ? "kernel ok" : "kernel error");
      } catch {
        setStatus("kernel error");
      }
    })();
  }, []);
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 24 }}>
      <h1>NoirHarness</h1>
      <p data-testid="kernel-status">{status}</p>
    </main>
  );
}
```

`apps/desktop/src/renderer/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 7: Run the smoke test to verify it passes**

Run: `pnpm --filter @noir/desktop test:e2e`
Expected: PASS — window shows `kernel ok`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop apps/kernel packages/kernel package.json pnpm-lock.yaml
git commit -m "feat: boot electron shell against the kernel"
```

---

### Task 10: Provider settings screen

**Files:**
- Create: `apps/desktop/src/renderer/Settings.tsx`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/test/settings.test.tsx`
- Modify: `apps/desktop/package.json` (testing dependencies)
- Modify: `apps/desktop/src/renderer/App.tsx` (render Settings)

**Interfaces:**
- Consumes: `ProviderCreateParams`, `ProviderListResult`, `ProviderView` from `@noir/protocol`.
- Produces: `Settings({ request }: { request: RequestFn })` where `RequestFn = <T>(method: string, params?: unknown) => Promise<T>`.

- [ ] **Step 1: Add unit-test dependencies**

Run: `pnpm --filter @noir/desktop add -D vitest jsdom @testing-library/react @testing-library/user-event`

`test` already runs Vitest; no script change is needed.

`apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", include: ["test/**/*.test.tsx"] },
});
```

- [ ] **Step 2: Write the failing UI test**

`apps/desktop/test/settings.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../src/renderer/Settings.js";

describe("Settings", () => {
  it("lists providers and creates one", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "provider.list") return { providers: [{ id: "1", name: "Local", baseUrl: "http://x/v1", apiKind: "openai-completions", enabled: true, hasKey: true, createdAt: 1 }] };
      if (method === "provider.create") return { id: "2" };
      throw new Error(method);
    });

    render(<Settings request={request} />);
    expect(await screen.findByText("Local")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Name"), "Work");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(request).toHaveBeenCalledWith("provider.create", {
      name: "Work", baseUrl: "https://api.example.com/v1", apiKind: "openai-completions", apiKey: "sk-test", enabled: true,
    });
  });

  it("keeps the submit disabled until required fields are filled", async () => {
    const request = vi.fn(async () => ({ providers: [] }));
    render(<Settings request={request} />);
    const button = screen.getByRole("button", { name: "Add provider" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Name"), "n");
    expect(button.disabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @noir/desktop test`
Expected: FAIL — cannot resolve `../src/renderer/Settings.js`.

- [ ] **Step 4: Implement Settings**

`apps/desktop/src/renderer/Settings.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import type { ProviderView } from "@noir/protocol";

export type RequestFn = <T>(method: string, params?: unknown) => Promise<T>;

export function Settings({ request }: { request: RequestFn }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKind, setApiKind] = useState<ProviderView["apiKind"]>("openai-completions");

  const load = async () => {
    const result = await request<{ providers: ProviderView[] }>("provider.list");
    setProviders(result.providers);
  };
  useEffect(() => { void load(); }, []);

  const valid = name.trim().length > 0 && baseUrl.trim().length > 0 && apiKey.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    await request("provider.create", { name: name.trim(), baseUrl: baseUrl.trim(), apiKind, apiKey, enabled: true });
    setName(""); setBaseUrl(""); setApiKey("");
    await load();
  }

  return (
    <section>
      <h2>Providers</h2>
      <ul>
        {providers.map((p) => <li key={p.id}>{p.name} — {p.baseUrl}</li>)}
      </ul>
      <form onSubmit={submit}>
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Base URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label>API key <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        <label>API kind
          <select value={apiKind} onChange={(e) => setApiKind(e.target.value as ProviderView["apiKind"])}>
            <option value="openai-completions">OpenAI-compatible</option>
            <option value="anthropic-messages">Anthropic</option>
            <option value="google-generative-ai">Google</option>
          </select>
        </label>
        <button type="submit" disabled={!valid}>Add provider</button>
      </form>
    </section>
  );
}
```

Modify `apps/desktop/src/renderer/App.tsx` to render `<Settings request={request} />` below the status line.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `pnpm --filter @noir/desktop test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop pnpm-lock.yaml
git commit -m "feat: add provider settings screen"
```

---

### Task 11: Persistence end-to-end, README, and acceptance run

**Files:**
- Modify: `apps/desktop/test/smoke.spec.ts` (add provider persistence flow)
- Create: `README.md`
- Create: `docs/adr/0007-secrets-in-os-vault.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a documented dev/verify loop and a repeatable acceptance check.

- [ ] **Step 1: Write the failing persistence test**

Append to `apps/desktop/test/smoke.spec.ts`:

```ts
test("a provider survives an app restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "noir persist "));
  const launch = () => electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });

  const first = await launch();
  try {
    const page = await first.firstWindow();
    await page.getByLabel("Name").fill("Persisted");
    await page.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await page.getByLabel("API key").fill("k");
    await page.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByText("Persisted")).toBeVisible();
  } finally {
    await first.close();
  }

  const second = await launch();
  try {
    const page = await second.firstWindow();
    await expect(page.getByText("Persisted")).toBeVisible({ timeout: 20_000 });
  } finally {
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify the flow is broken or missing**

Run: `pnpm --filter @noir/desktop test:e2e`
Expected: FAIL if the settings screen is not wired into `App.tsx`, or PASS if Task 10 already wired it. Either outcome is acceptable; if it passes, confirm the second launch actually shows the row.

- [ ] **Step 3: Fix the wiring until the test passes**

`App.tsx` must call `connect()` before rendering `Settings`, and pass the real `request` function. Final `App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { connect, request } from "./api.js";
import { Settings } from "./Settings.js";

export function App() {
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    void (async () => {
      try {
        await connect();
        const health = await request<{ status: string }>("system.health");
        setStatus(health.status === "ok" ? "kernel ok" : "kernel error");
      } catch {
        setStatus("kernel error");
      }
    })();
  }, []);
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 24 }}>
      <h1>NoirHarness</h1>
      <p data-testid="kernel-status">{status}</p>
      {status === "kernel ok" ? <Settings request={request} /> : null}
    </main>
  );
}
```

- [ ] **Step 4: Write the README and the secrets ADR**

`README.md`:

````markdown
# NoirHarness

Local-first desktop agent harness. This repository currently contains the M1 foundation: kernel, protocol, provider registry, and Electron shell.

## Requirements

- Node 24+
- pnpm 10+ (`corepack enable`)

## Develop

```sh
pnpm install
pnpm --filter @noir/desktop dev
```

The renderer runs on `http://127.0.0.1:5173`; Electron spawns the kernel from `apps/kernel/dist/index.cjs`.

## Verify

```sh
pnpm -r typecheck
pnpm -r test
pnpm --filter @noir/desktop test
```

## Layout

- `packages/protocol` — wire types and the session reducer
- `packages/kernel` — SQLite, event store, services, RPC
- `apps/kernel` — daemon entry
- `apps/desktop` — Electron shell and React renderer
````

`docs/adr/0007-secrets-in-os-vault.md`:

```markdown
# ADR-0007: Secrets live in the OS credential vault

Status: accepted (2026-11-09)

API keys are stored with `@napi-rs/keyring` under service `NoirHarness` and account = provider id. The database stores only the provider id as `api_key_ref`. The renderer sends a key once over the authenticated local socket; the kernel never returns it.

Consequence: Linux requires a working libsecret/Secret Service. When unavailable, provider creation fails loudly instead of writing plaintext.
```

- [ ] **Step 5: Run the full acceptance sequence**

Run:

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter @noir/desktop test
pnpm --filter @noir/desktop test:e2e
```

Expected: all pass; the E2E run launches Electron twice against a temp data dir and shows the persisted provider.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/adr/0007-secrets-in-os-vault.md apps/desktop/test/smoke.spec.ts apps/desktop/src/renderer/App.tsx
git commit -m "test: prove provider persistence and document the foundation"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):**

| Spec section | Task |
|---|---|
| §3 architecture, kernel process | Tasks 1, 7, 8, 9 |
| §4 event envelope, types, RPC | Tasks 1, 2, 4, 7 |
| §5 data model, migrations | Task 3 |
| §6 lifecycle transitions | Task 5 |
| §7.3 provider registry | Task 6 |
| §8 UI shell (minimal) | Tasks 9, 10 |
| §9 secrets, localhost auth | Tasks 6, 7, 11 |
| §11 repo layout/build | Tasks 1, 3, 9 |
| §12 testing | Every task; Playwright in Tasks 9–11 |

Deferred by design to Plan 2: OMP profile materializer, ACP adapter, live `session.subscribe` streaming, chat surface. Plan 3: editor/diff, skills, hardening, installer.

**Placeholder scan:** every step names exact files, commands, and expected results. No TBD/TODO.

**Type consistency:** `Methods` names match the handlers in Task 8. `ProviderCreateParams`/`ProviderView` are defined in Task 2 and consumed unchanged in Tasks 6 and 10. `SessionStatus` and `PayloadSchemas` come from Task 1 everywhere. `EventStore.append` takes `provenance` in every call site.

**Review Focus tests:**

1. Windows paths with spaces/unicode — Task 5 `accepts a path with spaces and unicode`; Task 3 temp dir names contain spaces.
2. Second instance / stale runtime file — Task 8 `refuses a second live instance`; stale replacement is implicit in `startKernel`.
3. Concurrent appends — SQLite transaction serializes `MAX(seq)+1`; Task 4 asserts gap-free order (add a 50-iteration loop if the executor wants stronger proof).
4. Provider names with spaces/unicode — Task 6 unicode test; Task 2 trim/reject tests.
5. Token exposure — Task 7 `never echoes the token in an error`; Task 8 asserts the token appears only in the runtime file, and the kernel logs only `{event, port}`.
