# NoirHarness — Design Specification

- Date: 2026-11-09
- Status: proposed, awaiting review
- Repo: `8kunoir8/NoirHarness`
- Scope: milestone 1 (M1) in full detail; later milestones only as direction

## 1. Intent

NoirHarness is a local-first desktop **agent harness** — an agent in its own right, not a manager that shells out to other agents. It owns the provider configuration, the workspace/session model, the event history, skills, and the UI. Its differentiators are: honest live visibility into what each agent is doing, a first-class editor/diff surface, and one shared skill set across every agent it runs.

Success for M1: a user adds a provider (base URL, API key, model), opens a repo as a workspace, starts a chat, prompts an agent, watches it work, approves or rejects destructive actions, and reviews/edits the resulting changes in an embedded editor — all without touching a terminal.

Non-goals for M1: multi-tenant hosting, mobile, team collaboration, billing, marketplaces, cloud execution, fine-tuning, local model serving.

## 2. Product decisions

| Decision | Choice | Rationale |
|---|---|---|
| Execution model | Contract-first kernel; ACP adapter first (OMP), native engine M2 | Validate UI and contracts on a real agent without owning the loop yet; ACP is shared by OMP and DeepSeek Harness |
| Shell | Electron + React + Monaco | One toolchain with the kernel; proven by Orca; VS Code-grade editor/diff for free |
| State | Append-only event log, projections derived | Every surface (chat, inspector, office, automation, audit) consumes the same truth |
| Provider config | Owned by NoirHarness | Stated requirement; materialized into the engine profile, never the source of truth in engine config |
| Secrets | OS credential vault, kernel memory only | Renderer, SQLite, logs and events never see plaintext keys |

## 3. Architecture

Four ownership layers. The kernel owns all state; Electron main owns OS integration only.

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main — window, menus, dialogs, updater, lifecycle  │
│  spawns kernel · exposes only {invoke, subscribe} preload   │
└───────────────┬─────────────────────────────────────────────┘
                │ 127.0.0.1 WebSocket, JSON-RPC + event stream
┌───────────────▼─────────────────────────────────────────────┐
│ noir-kernel (Node/TS, headless, testable without Electron)  │
│  · SQLite WAL: metadata + append-only event log             │
│  · provider registry · workspaces/git · sessions · skills   │
│  · fs / git / PTY services (LSP in M2)                      │
│  · engine registry ─► ACP adapter ─► `omp acp`              │
│                   └► native engine (M2)                     │
└───────────────┬─────────────────────────────────────────────┘
                │ events (append-only) + RPC
┌───────────────▼─────────────────────────────────────────────┐
│ Renderer (React + Monaco) — no Node access, pure consumer   │
└─────────────────────────────────────────────────────────────┘
```

Why a separate kernel process: headless tests, crash isolation between UI and daemon, and a path to remote/mobile without rewriting the core. Electron main stays thin enough to be replaceable.

### Ownership invariants

| Concern | Owner | Never allowed |
|---|---|---|
| Secrets | OS keychain → kernel memory | renderer, SQLite plaintext, logs |
| Events/transcripts | kernel append-only log | renderer-held authoritative state |
| UI state | renderer, derived from events | provider/agent logic in components |
| Provider/model config | kernel registry | engine config as source of truth |
| Engine quirks | adapter package | kernel core, renderer |
| Diff truth | git in kernel | engine-reported change claims |

## 4. Protocol

Transport: WebSocket JSON-RPC 2.0 on `127.0.0.1`, random port. The kernel writes `{port, token}` to `%APPDATA%/NoirHarness/runtime/kernel.json` (`0600`, current user only) and Electron main passes it to the renderer through preload; every request carries the token. Event frames cap at 64 events; heartbeat 15 s.

### 4.1 Event envelope

```ts
type AgentEvent = {
  v: 1;
  id: string;                 // UUIDv7
  seq: number;                // monotonic per session, starts at 1, gap-free
  ts: number;
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  turnId?: string;
  type: EventType;
  payload: unknown;           // narrowed per type
  provenance: { engine: "native" | "acp"; engineName: string; adapterVersion: string };
};
```

Rules:

- Events are immutable. `seq` and its projection update commit in one SQLite transaction.
- Replaying `seq 1..N` must reproduce the projection exactly.
- Unmappable engine payloads are preserved as `engine.raw`, never dropped.
- Payloads over 16 KiB move to content-addressed blobs; the event keeps `blobRef`.
- Redaction runs at ingest: secrets, env values, and configured patterns are replaced before persistence.

### 4.2 M1 event types

| Group | Types |
|---|---|
| session | `session.created`, `session.updated`, `session.status`, `session.closed` |
| turn | `turn.started`, `turn.completed`, `turn.failed` |
| message | `message.delta`, `message.completed` |
| tool | `tool.started`, `tool.output`, `tool.completed`, `tool.failed` |
| permission | `permission.requested`, `permission.resolved` |
| files | `file.changed` |
| command | `command.started`, `command.output`, `command.completed` |
| usage | `usage.updated` |
| plan | `plan.updated`, `todo.updated` |
| skill | `skill.loaded` |
| escape | `engine.raw` |

Reserved, defined for later, not emitted in M1: `subagent.*`, `checkpoint.*`, `file.read`.

Status values: `idle | starting | running | waiting | error | closed`.
Permission decisions: `allow_once | allow_always | reject | reject_always`.
Content blocks: `text | reasoning | tool_call | tool_result | image | file_ref | diff_ref`.

### 4.3 RPC namespaces

`project.*`, `workspace.*`, `session.*`, `provider.*`, `model.*`, `skill.*`, `fs.*`, `git.*`, `approval.*`, `system.*`. `lsp.*` is reserved for M2.

`session.subscribe { sessionId, sinceSeq }` replays from the log then streams live. All errors are structured `{ code, message, retryable, details? }`.

`packages/protocol` is the single source: zod schemas generate TypeScript types, JSON Schema, and the protocol reference. Contract versioning is additive only within `v: 1`; breaking changes ship as a new event type.

## 5. Data model

SQLite (WAL) at the platform app-data directory — `%APPDATA%/NoirHarness/noir.db` on Windows, `~/Library/Application Support/NoirHarness/noir.db` on macOS, `$XDG_DATA_HOME/noirharness/noir.db` on Linux. Schema changes ship as numbered SQL migrations.

```
projects(id, name, root_path, created_at)
workspaces(id, project_id, path, branch, kind, status)
agents(id, name, role, engine_id, model_ref, skill_ids, permission_policy, parent_id)
sessions(id, workspace_id, agent_id, engine, engine_session_ref, title, status,
         config_snapshot_json, created_at, closed_at)
turns(id, session_id, idx, status, started_at, ended_at, usage_json)
events(id, session_id, seq, ts, type, agent_id, parent_agent_id, turn_id,
       payload_json, blob_ref)
file_changes(id, session_id, turn_id, path, change, add, del, diff_blob, applied_at)
approvals(id, session_id, event_id, kind, payload_json, decision, decided_at)
skills(id, scope, name, dir, hash, manifest_json, enabled)
providers(id, name, base_url, api_kind, api_key_ref, enabled)
models(id, provider_id, model_id, display_name, context_window, max_tokens,
       caps_json, enabled)
settings(key, value_json)
```

- `UNIQUE(session_id, seq)` is the ordering guarantee.
- `workspaces.kind`: `local | worktree | ssh | container` (only `local` and `worktree` in M1).
- Blobs are content-addressed by SHA-256; unreferenced blobs are collected on boot.
- Secrets live only in the OS vault; `api_key_ref` is a vault handle.
- Archive keeps events and drops projections; no event is ever deleted in M1.

## 6. Session lifecycle

```
created → starting → idle ⇄ running → waiting(permission|input) → running
                        └──────────→ closed
   any → error → (resume) → idle | closed
```

- Invalid transitions raise `state.invalid_transition`; the kernel never silently corrects state.
- Prompts sent while `running` are queued and delivered at the next idle boundary.
- `interrupt` cancels the engine turn; the partial message persists with `interrupted: true`.
- On boot, sessions left `running` become `error(kernel_restart)` and offer resume; no zombie sessions.
- `session.prompt` takes a client `requestId`; duplicate submissions are idempotent.
- Forking copies an event prefix into a new session; schema supports it, UI is deferred.

The status enum is not interpreted ad hoc: `packages/protocol/src/lifecycle.ts` owns the table of
what each status *means* — `live` (killing the kernel discards work), `working` (a turn is
executing), `interruptible`, `terminal` — plus the legal transitions and `canTransition`. An
approval wait is live and interruptible but not working, which is why "Working" excludes it in both
the kernel's `session.list` filter and the client's copy. Adding a status to the enum fails every
consumer that forgot to answer for it.

## 7. Engines and providers

### 7.1 Engine interface

```ts
interface AgentEngine {
  id: string;
  capabilities: { streaming: boolean; tools: boolean; diffs: boolean;
                  approvals: boolean; subagents: boolean; steering: boolean;
                  modelSelection: boolean };
  start(opts: EngineStartOptions): Promise<EngineSession>;
}
```

`EngineSession` emits normalized `AgentEvent`s and exposes `prompt`, `steer`, `interrupt`, `setModel`, `dispose`. The M1 implementation is the ACP adapter; the M2 native engine implements the same interface.

### 7.2 Managed engine directory

OMP's ACP mode takes credentials from its own configuration and advertises per-session model/thinking selection. The kernel therefore materializes an agent directory it owns at `<dataDir>/engine`:

- Provider changes → `models.yml` (OpenAI-compatible, Anthropic, Google, local kinds; mapped by the adapter).
- Agent model policy → `config.yml` role mapping.
- Skills → the directory's skill folder, linked with hash stamps (copy fallback where links are unavailable).
- Launch: `omp --session-dir <workspace>/.noir/sessions --model <provider>/<model> acp`, cwd = workspace, with `PI_CODING_AGENT_DIR=<dataDir>/engine` in the child environment. `.noir/` is kernel-created and added to the workspace `.gitignore` on first use.
- `--profile` is not passed: named profiles resolve under omp's own home (`~/.omp/profiles/<name>`), which would put the app's state inside the user's omp tree. `PI_CODING_AGENT_DIR` relocates omp's agent directory itself, and a profile flag would override it.
- The directory is generated; manual edits are overwritten. The user's own `~/.omp` is never read or written.
- Verified on omp 18.18.3: `PI_CODING_AGENT_DIR` moves `omp config path`, and `omp models` reads `models.yml` from that directory; `--profile` takes precedence when both are given. The format is omp's own, so a `models.yml` copied from an existing profile works verbatim.

### 7.3 Provider registry

Providers: `name`, `baseUrl`, `apiKind`, `apiKeyRef`, `enabled`. Models: `id`, `contextWindow`, `maxTokens`, capabilities. Per-agent model policy: one default plus optional role overrides (`smol`, `slow`, `plan`, `commit`) mapped onto engine roles.

M1 UI supports `openai-completions`, `anthropic-messages`, `google-generative-ai`, and local OpenAI-compatible servers. OAuth flows are M2.

## 8. UI

### 8.1 Information architecture

Top bar: workspace switcher · branch · engine status · ⌘K search · notifications · settings. Body: rail + list + main + inspector. Bottom status bar: kernel health, running agents, quota, keyboard hints.

The window is frameless (ADR-0013): the top bar is the titlebar, it carries the minimize /
maximize-restore / close buttons at its right edge, and it is the drag surface. The kernel banner
above it is draggable too, so the window keeps a handle while the banner shows.

| Rail item | List pane | Main |
|---|---|---|
| Chats | filters (`All / Needs you / Working / Unread / Done`), status/time-grouped rows with model·project tags | Session tabs |
| Agents | roster: name, role, model, workspace, live status, last activity | Agent config: model policy, skills, permissions |
| Skills | global and project sections, enabled toggle, hash | `SKILL.md` viewer |
| Settings | sections | Providers/models, appearance, keys, engine |

Main tabs are `chat`, `editor`, `diff`, all bound to the current workspace/session. The chat header carries model picker, context meter, cost, `+/-` stats, turn timer, and status. The inspector carries status, usage, changed files with per-file stats and `Show diff`, and pending approvals.

Command palette (⌘K) is the primary action surface. Every action exists as a kernel RPC first; UI and future automation share it. Shortcuts: ⌘N chat, ⌘⇧N workspace, ⌘P file open, ⌘B inspector, ⌘S save, ⌘. stop.

### 8.2 Design language

CSS custom properties + CSS Modules; Radix primitives for dialogs, menus, tabs, tooltips; no utility framework. Two themes sharing semantic tokens: `Paper` (warm light, default) and `Ink` (dark). Tokens: `surface, surface-raised, border, text, muted, accent, success, warning, danger, diff-add, diff-del`.

Type: Inter Variable for UI, JetBrains Mono for paths, commands, and metrics; both bundled for offline use. Density compact by default (32 px rows), comfortable toggle (40 px). Motion 120–180 ms ease-out; `prefers-reduced-motion` honored. WCAG AA contrast, visible focus rings, full keyboard navigation.

### 8.3 M1 components

AppShell, Rail, ListPane, ThreadRow, Tabs, ChatStream, MessageBlock, ToolCard, UsageMeter, Composer, ModelPicker, Inspector, FileTree, MonacoEditor, DiffView, CommandPalette, ProviderForm, SkillList, StatusBar.

Editor: Monaco with themes derived from tokens, language detection by extension, file tree virtualized, open/save through kernel fs, diff through kernel git, line annotations stored against a diff reference. LSP diagnostics are M2.

## 9. Security and permissions

- Permission requests become events with a category: `shell`, `delete`, `rename`, `write-outside-workspace`, `network`.
- Per-agent policy `ask | allow | reject` per category, default `ask`, fail closed.
- Workspace is the write boundary; anything outside requires explicit approval.
- Secrets: `@napi-rs/keyring`; keys enter the kernel once over the authenticated socket and stay in memory.
- Materialized config files are written with `0600`.
- A CI redaction test fails if any configured secret appears in events or logs.

## 10. Skills

M1 loads `SKILL.md` from `%APPDATA%/NoirHarness/skills` (global) and `<workspace>/.noir/skills` (project). Precedence: project over global, name collision resolved by scope and reported in the UI. Each skill is hashed and stamped into the managed engine profile so `skill.loaded` events can be attributed. Registry, versioning, and distribution are M3.

## 11. Repository layout and build

```
apps/desktop/src/{main,preload}     Electron main + preload
apps/kernel/src/                    daemon entry
packages/protocol/src/              zod schemas, RPC types, generated docs
packages/kernel/src/                db, events, sessions, providers, workspaces,
                                    skills, fs, git
packages/engines/acp/src/           ACP client adapter
packages/adapters/omp-profile/src/  profile materializer
packages/ui/src/                    tokens, primitives, screens
```

pnpm workspaces, TypeScript strict, Vite for the renderer, esbuild for kernel/desktop, electron-builder (NSIS on Windows first). Scripts: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## 12. Testing

- Unit: protocol schema round-trip; event reducer; lifecycle state machine; redaction; profile materializer.
- Integration: kernel RPC over a real socket; ACP conformance against a fake ACP engine before OMP is wired.
- Replay: same event stream reproduces identical projections.
- E2E: one Playwright Electron path — launch, add workspace, start fake session, prompt, render message, show diff.
- No screenshot snapshots. No tests for wiring-only code.

## 13. Milestones

| Milestone | Content | Exit criterion |
|---|---|---|
| M1.0 | Scaffold, protocol package, kernel boot, SQLite, event append/replay, RPC, Electron window | Replay test green; renderer round-trips an RPC to the kernel through preload |
| M1.1 | ACP/profile spike first (risks 1–3), then provider/model CRUD, keyring, OMP profile materializer, ACP adapter, session create/prompt/stream | A real prompt through a configured provider streams into the UI |
| M1.2 | Chat shell: rail, list, tabs, composer, queue, interrupt, inspector, palette | Full session lifecycle visible and controllable |
| M1.3 | Editor: file tree, Monaco, save, git diff, line annotations | Editing a file updates diff stats and opens a diff tab |
| M1.4 | Skills: discovery, precedence, enable/disable, viewer, profile stamping | Skill listed, loaded, and attributed in events |
| M1.5 | Crash recovery, redaction hardening, installer | Installer runs; restart mid-session recovers to `error` + resume |

Direction after M1: M2 native engine + Office view + agents dashboard; M3 skill registry + tool broker + reach layer; M4 automation + remote runtime.

## 14. Risks and open verification items

1. **OMP engine-directory isolation** — resolved in M1.1: omp reads `<dataDir>/engine` via `PI_CODING_AGENT_DIR`; `--profile` would resolve under `~/.omp` and is not used.
2. **ACP session configuration** — verify the model/thinking selection payload against a live `omp acp` handshake.
3. **ACP permission shape** — verify how shell/delete/rename requests arrive; the policy model depends on it.
4. **ACP richness** — OMP's ACP surface may expose less than its native RPC stream. The adapter must upgrade to `--mode rpc` without changing the kernel contract.
5. **Electron footprint** — acceptable for a local dev tool; the thin kernel boundary keeps a Tauri or web shell possible later.

## 15. ADRs to record during implementation

- ADR-0001: kernel as a separate process, not embedded in Electron main.
- ADR-0002: append-only event log as the transcript of record.
- ADR-0003: kernel-owned provider registry with materialized engine profiles.
- ADR-0004: OS credential vault over app-managed encryption.
- ADR-0005: ACP as the first engine contract; native engine second.

## 16. After the milestones

M5 closed the automation story (outcome notifications, kernel supervision, start at login). What the
design still names as owed:

| Item | State |
|---|---|
| `session.fork` | shipped — prefix copy, palette entry; the engine's context is replayed only for the native engine |
| Paged `session.list` | shipped — page, total, keyset cursor, kernel-answered filters |
| ADRs 0009–0013 | recorded (pairing, TLS, supervision, notifications, frameless window) |
| ACP → `--mode rpc` | transport shipped behind `NOIR_OMP_TRANSPORT=rpc`: same `Engine`, one approve-per-tool prompt (`extension_ui_request` select, answered from the approval card), usage per message. The earlier "write ran without asking" reading was omp's default auto-approve; `--approval-mode always-ask` is now always passed. Default stays ACP until a field run; `docs/superpowers/notes/2026-11-13-omp-rpc-mode.md` has the wire |
| `lsp.*` | unstarted; reserved since M2, needs a product decision before code |
| Mobile shell | unstarted; a phone loads the desktop layout today |
