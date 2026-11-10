# NoirHarness

Local-first desktop agent harness. This repository currently contains the M1.1 agent runtime:
kernel, protocol, provider registry, the `omp` ACP engine adapter, and the Electron shell.

The app talks to the real `omp` binary over ACP; NoirHarness owns the provider registry, the
model selection, the workspaces, and the chat surface. Nothing leaves the machine except the
provider calls `omp` makes.

## Requirements

- Node 24+
- pnpm 10+ (`corepack enable`)
- `omp` on `PATH` (`omp --version`). Every chat turn spawns `omp … acp`; without the binary the UI
  loads but a prompt fails with an engine-spawn error.

## Develop

```sh
pnpm install
pnpm --filter @noir/desktop dev
```

The renderer runs on `http://127.0.0.1:5173`; Electron spawns the kernel from `apps/kernel/dist/index.cjs`.

## Quick start

The app is driven by one chain: **provider → model → workspace → chat**. The first two steps live on
the **Setup** page (the app opens there until a model exists); the last two live on **Chat**.

1. **Provider.** Enter a name, base URL, API kind, and API key. The key is sent once over the local
   socket, kept in the OS keyring, and written only to the owner-only `models.yml` below so the
   engine can use it; it never enters SQLite, logs, or any RPC response.
2. **Model.** Pick the provider and enter the model id, display name, and context window. The id is
   the model's own id (`gpt-4.1`, `claude-sonnet-4-5`) and may contain `/` when the provider uses
   path-style ids (`meta-llama/Llama-3.3-70B`): the engine selector is `<provider>/<id>` and the
   engine splits it at the first slash, so the id's slashes are preserved.
3. **Workspace.** Add a project path, create a workspace for it, then select that workspace.
4. **Chat.** Create a new chat on the workspace with a model, type a prompt, and press send.

The first turn spawns the engine: the kernel regenerates its agent directory, launches
`omp --session-dir <workspace>/.noir/sessions --model <provider>/<model> acp` with the workspace
as `cwd` and `PI_CODING_AGENT_DIR` pointing at that directory, then streams assistant text, tool
calls, approvals, and usage into the chat. Tool calls block on a permission prompt; approving runs
`omp`'s terminal round-trip and streams the result.

### The engine directory

`<data dir>/engine/` is owned by NoirHarness and is the only configuration `omp` reads when it runs
as this app's engine. `<data dir>` is Electron's `userData` directory (on Windows
`%APPDATA%\NoirHarness`), overridable with `NOIR_DATA_DIR`. The user's own `~/.omp` profile is never
read or written.

- `models.yml` — the enabled providers and models, with the session default declared first (omp
  treats the first model of a provider as the default) and the current model selector applied
  again via `--model`.
- `config.yml` — model role bindings (empty unless the kernel sets roles).
- session and cache files that `omp` writes for that directory.

`models.yml` and `config.yml` are written atomically with mode `0600` and contain the provider API
keys. They are rewritten (overwritten) whenever a provider or model is created or deleted, whenever
a chat is created, and again before each engine start, so edits take effect on the next chat/turn.
Deleting the last enabled provider or model deletes `models.yml`, so a removed key does not linger
on disk. The format is omp's own, so a `models.yml` copied from an existing omp profile works
verbatim.

## The chat shell

The **Chats** view is five regions:

- **Rail** — `Chats` / `Setup` and the theme toggle. Entering `Chats` reloads providers, models,
  workspaces, and sessions, so setup changes show up without a restart.
- **List pane** — `Projects` (project path, project, workspace) over `Sessions`: the new-chat model
  picker, `New chat`, a search box, filter buttons, and sessions grouped by `Today` / `Yesterday` /
  `Earlier` from the last event time.
- **Main pane** — tab strip, chat header (session status, model picker, token usage, `Interrupt`),
  transcript (assistant text, tool cards, permission cards, diffs), and the composer.
- **Inspector** — optional right panel with usage, files touched, the plan, and pending approvals.
- **Status bar** — kernel health, turns running, approvals waiting, and the engine directory in use.

Filters read kernel session metadata, not the transcript: `All`; `Needs you` (a pending approval or
an errored session); `Working` (starting, running, or waiting without an approval); `Unread` (the
session's newest event is past the last event its tab rendered); `Done` (closed). Search matches the
session title, with untitled chats matching `untitled chat`.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Command palette |
| `⌘N` / `Ctrl+N` | New chat on the selected workspace and model |
| `⌘W` / `Ctrl+W` | Close the active tab |
| `⌘B` / `Ctrl+B` | Toggle the inspector |
| `⌘J` / `Ctrl+J` | Focus the composer |
| `⌘.` / `Ctrl+.` | Interrupt the running turn |
| `⌘,` / `Ctrl+,` | Open setup |
| `⌘⇧T` / `Ctrl+Shift+T` | Switch `paper` / `ink` theme |

The palette lists available commands with their shortcut, filters on label and keywords as you type,
and greys out commands whose preconditions are unmet (no workspace, no active chat, no running turn).
It only dispatches actions that already exist — kernel RPCs such as `session.interrupt` and shell
actions such as `new-chat` — so nothing is reachable from the palette that a button cannot do.

In the composer, `Enter` sends, `⇧Enter` inserts a newline, and `⌘Enter` queues the draft while a turn
runs. `Esc` interrupts a streaming turn. While a permission card is open it owns the keyboard: `1`–`9`
pick an option by position and `Esc` picks the reject option. The send button always reads `Send`; the
state line under it reports `Sending…`, `Queued for after this turn`, `Streaming`, `Interrupted`, or
`Failed`.

Queued turns live in kernel memory. They survive an interrupt — the turn ahead is cancelled and the
queue drains — but not a kernel restart: turns persisted as `running` or `queued` are reported as
failed the next time the app touches that session, with any open approval rejected. Open tabs, the
active tab, and the theme (`noir.theme` in `localStorage`, applied as `<html data-theme>`) are
restored on launch, and each restored tab replays its transcript from sequence 0.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `NOIR_OMP_COMMAND` | `omp` | binary to spawn |
| `NOIR_OMP_ARGS_JSON` | `[]` | JSON array of strings inserted before the generated `--session-dir … acp` flags |
| `NOIR_TURN_TIMEOUT_MS` | `120000` | per-turn watchdog; on expiry the kernel sends `session/cancel` and reports the turn as failed |

The desktop shell also honours `NOIR_DATA_DIR`, `NOIR_KERNEL_ENTRY`, and `NOIR_NODE_BIN`.

## Verify

```sh
pnpm -r typecheck
pnpm -r test
pnpm --filter @noir/desktop test
pnpm --filter @noir/desktop test:e2e
```

`test:e2e` builds the app and drives Electron with Playwright against a local mock provider: it
streams a reply, completes a permission-approved tool call, and runs the shell lifecycle spec — a
tool turn, a prompt queued behind a slow turn, an interrupt, the queued turn draining after it, and
an app restart that replays the transcript. Each spec uses its own temporary data directory, so
engine state stays inside it.

## Layout

- `packages/protocol` — wire types and the session reducer
- `packages/kernel` — SQLite, event store, services, RPC, engine manager
- `packages/engines/acp` — ACP client over stdio (JSON-RPC framing, terminals, turn watchdog)
- `packages/adapters/omp-profile` — `models.yml`/`config.yml` renderer
- `apps/kernel` — daemon entry
- `apps/desktop` — Electron shell and React renderer

The `omp acp` wire behaviour this is built against is documented in
`docs/superpowers/notes/2026-11-10-acp-spike.md`.
