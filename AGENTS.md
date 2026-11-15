# AGENTS.md

Instructions for any agent working in this repository. `README.md` describes what the app does; this
file states the rules that keep it working. Follow them without being asked.

## Verify before you claim anything

Run the narrowest check that exercises your change, then stop.

```sh
pnpm lint            # eslint . — one flat config at the root
pnpm lint:proof      # each local rule must reject the file it exists to stop
pnpm -r typecheck
pnpm -r test
pnpm --filter @noir/desktop test                     # vitest, renderer + main
pnpm --filter @noir/desktop test:e2e                  # Playwright; builds first, needs Electron
```

`test:e2e` spawns `apps/kernel/dist/index.cjs`, so a kernel change is invisible to it until `pnpm
build` runs. A single spec: `cd apps/desktop && npx playwright test test/<spec>.spec.ts
--reporter=line`.

Never report a passing suite you did not run. When a check cannot run, say which one and why.

## The lint rules are the review

`tools/eslint-plugin-noir` holds this repo's own rules. Each one encodes a defect that already
happened here, so a fix that cannot become a rule comes back. Before adding a rule:

1. Add the failing fixture and the accepting neighbour to `tools/prove-rules.mjs`, with the exact
   finding count.
2. Add the rule to the config block where it applies — not globally if it only makes sense in the
   renderer or in specs.
3. Mention it in `README.md` under Verify.

A rule whose proof passes but whose message does not name the fix is not finished: state what to do
instead of the bare rule id.

### What the rules mean when you trip one

- `noir/no-cross-process-import` — the renderer is a browser tab. `@noir/protocol` and renderer files
  are the only imports; everything else goes through `renderer/api.ts` (the RPC client) or
  `renderer/bridge.ts`. A `node:` import, `electron`, or a path into `src/main` is a boundary break,
  not a lint nit.
- `noir/no-bare-timer` — take timers from `renderer/defer.ts`: `after`, `every`, `coalesce`,
  `debounce`. They return the canceller, so an unmount cannot leave a callback running. Never
  suppress this rule to keep a raw `setTimeout`.
- `noir/strict-locator-name` — add `exact: true` to a Playwright `getByRole`/`getByLabel`. Fix the
  locator, not the accessible name, unless the name itself is wrong for the UI.

## Code rules

- Node 24+, pnpm 10+, TypeScript strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`, ESM with `.js` specifiers.
- No `any` in product code, including `as any` and `: any`. Tests may use it for untyped wire
  fixtures, where the reply shape a test asserts is the point.
- A promise that is neither awaited nor returned is a bug the compiler cannot see. Write `void` when
  dropping one on purpose; if a callback type is `void`-returning and you need to await inside, wrap
  the async body and pass an explicit `void` call.
- No one-expression wrapper functions, and no second convention beside an existing one. Read the
  neighbours first.
- Optional callbacks are `onX?: ((a: A) => void) | undefined`; pass them with
  `{...(onX === undefined ? {} : { onX })}` under `exactOptionalPropertyTypes`.

## Process boundaries

The kernel owns SQLite, the event log, and every engine; the renderer owns none of it. A state change
travels as an RPC that appends an event, and the event store projects it, so every subscribed window
updates for free. Do not add a second write path that updates one surface directly.

## Commits

One commit per change set on `main`. Write the message to a file and use `git commit -F`. Never
branch, never push, never amend someone else's commit.
