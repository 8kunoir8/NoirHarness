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
