# NoirHarness

Local-first desktop agent harness. This repository currently contains the M1.1 agent runtime:
kernel, protocol, provider registry, the `omp` ACP engine adapter, and the Electron shell.

The app talks to the real `omp` binary over ACP; NoirHarness owns the provider registry, the
model selection, the workspaces, and the chat surface. Nothing leaves the machine except the
provider calls `omp` makes.

## Requirements

- Node 24+
- pnpm 10+ (`corepack enable`)
- `omp` on `PATH` (`omp --version`). Every chat turn spawns `omp --profile noir … acp`; without
  the binary the UI loads but a prompt fails with an engine-spawn error.

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
2. **Model.** Pick the provider and enter the model id, display name, and context window.
3. **Workspace.** Add a project path, create a workspace for it, then select that workspace.
4. **Chat.** Create a new chat on the workspace with a model, type a prompt, and press send.

The first turn spawns the engine: the kernel regenerates the `omp` profile, launches
`omp --profile noir --session-dir <workspace>/.noir/sessions --model <provider>/<model> acp` with
the workspace as `cwd`, then streams assistant text, tool calls, approvals, and usage into the
chat. Tool calls block on a permission prompt; approving runs `omp`'s terminal round-trip and
streams the result.

### The generated profile

`~/.omp/profiles/noir/agent/` is owned by the kernel:

- `models.yml` — the enabled providers and models, with the session default declared first (omp
  treats the first model of a provider as the default) and the current model selector applied
  again via `--model`.
- `config.yml` — model role bindings (empty unless the kernel sets roles).

Both files are written atomically with mode `0600` and contain the provider API keys. They are
rewritten (overwritten) whenever a provider or model is created or deleted, whenever a chat is
created, and again before each engine start, so edits take effect on the next chat/turn.
Deleting the last enabled provider or model deletes `models.yml`, so a removed key does not
linger on disk. Use `NOIR_PROFILE_HOME` to point the whole tree somewhere else (tests do this).

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `NOIR_OMP_COMMAND` | `omp` | binary to spawn |
| `NOIR_OMP_ARGS_JSON` | `[]` | JSON array of strings inserted before the generated `--profile … acp` flags |
| `NOIR_PROFILE_HOME` | `os.homedir()` | root of `.omp/profiles/noir/agent` |
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
streams a reply and completes a permission-approved tool call. The app rewrites the real
`~/.omp/profiles/noir/agent` while the specs run; the suite snapshots the directory first and
restores it afterwards, so a run leaves your profile as it found it.

## Layout

- `packages/protocol` — wire types and the session reducer
- `packages/kernel` — SQLite, event store, services, RPC, engine manager
- `packages/engines/acp` — ACP client over stdio (JSON-RPC framing, terminals, turn watchdog)
- `packages/adapters/omp-profile` — `models.yml`/`config.yml` renderer
- `apps/kernel` — daemon entry
- `apps/desktop` — Electron shell and React renderer

The `omp acp` wire behaviour this is built against is documented in
`docs/superpowers/notes/2026-11-10-acp-spike.md`.
