# NoirHarness

Local-first desktop agent harness. This repository contains three milestones' worth of app: the
chat shell and editor, a native engine beside the `omp` ACP adapter, an artifact viewer, and the
agents dashboard with its pixel office. Kernel, protocol, provider registry, both engine adapters,
the Electron shell, the workspace editor (file tree, Monaco, quick open, diffs with line notes), and
the JSON/CSV/PDF preview surfaces all live here.

The app talks to the real `omp` binary over ACP by default, or to any OpenAI-compatible endpoint
through its own engine when a model asks for it; NoirHarness owns the provider registry, the model
selection, the workspaces, the agents, and the chat surface. Nothing leaves the machine except the
provider calls the engine makes.

## Requirements

- Node 24+
- pnpm 10+ (`corepack enable`)
- `omp` on `PATH` (`omp --version`). Every chat turn spawns `omp … acp`; without the binary the UI
  loads but a prompt fails with an engine-spawn error.
- `git` 2.13+ on `PATH` (`git --version`), for the status and diff RPCs. A workspace that is not a
  repository, or a machine without `git`, shows no diff stats and still edits and saves;
  `NOIR_GIT_COMMAND` points the kernel at another binary.

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

### The native engine

Each model carries an engine, chosen on **Setup** (`Engine`: `acp` by default, or `native`). `native`
is only offered when the model's provider has `apiKind` `openai-completions`; the select is disabled
with `Native requires an OpenAI-compatible provider` otherwise, and the kernel refuses the same
combination if it arrives over the socket. Model rows read `mock-1 · native` so the engine in use is
visible without opening the form.

The native engine runs inside the kernel process. It posts to the provider's
`/chat/completions` and reads the SSE stream itself, reassembling tool-call deltas that arrive split
across frames. It exposes ten built-in tools — `fs.read`, `fs.list`, `fs.search`, `fs.write`,
`fs.replace`, `fs.delete`, `shell.exec`, `skill.list`, `skill.read`, `web.fetch` — plus the
session's MCP tools (see [MCP servers](#mcp-servers)), and allows at most 24 tool rounds per turn.
Every tool call is an approval card (`Allow once` / `Reject`) unless the session's permission policy
allows that category; `shell.exec` is never sandboxed, so the approval is the only gate. Writes,
deletes, and renames are checked against the workspace with the resolved real path before they run,
and a write that resolves outside it needs the `write-outside-workspace` approval. Each turn
publishes `usage.updated` from the provider's token counts, and the kernel falls back to the model's
context window when the provider reports none. A turn is interruptible through the same
`session.interrupt` path as ACP, and the watchdog in `NOIR_TURN_TIMEOUT_MS` applies.

History is reconstructed from the event log, not kept in memory: a kernel restart replays the
session's turns back into the prompt, dropping calls that lost their name or their JSON arguments, so
the transcript the model sees matches the transcript on screen. A session freezes `agentId`,
`engine`, `modelId`, and `permissionPolicy` when it is created.

## MCP servers

**Setup** carries an `MCP servers` panel: a list of configured servers with a live `Enabled`
switch, `Test`, `Edit`, `Cancel`, and `Remove` actions, and one form for name, command, arguments,
and `KEY=value` environment lines. The name becomes part of a tool name, so it is `[a-z0-9_-]{1,40}`
and unique; arguments are one per line, not shell syntax. `Test` starts the real
command, completes the handshake, lists the tools, and reports `n tools` or the server's own error —
the probe is discarded when the row is edited or removed. `Edit` loads the row into the same form and
saves through `mcp.update`.

An agent selects the servers it may use in the `Agent config` inspector, and every MCP call is
approved by the `mcp` permission category, the sixth alongside `shell`, `delete`, `rename`,
`write-outside-workspace`, and `network`. Servers are resolved once per engine start, so a binding
change applies to the next session. The kernel speaks MCP over stdio itself
(`packages/kernel/src/mcp/`): newline-delimited JSON-RPC with a 10 s handshake and a 120 s call
deadline, 64 KiB of server stderr kept for diagnostics, and `SIGTERM` then `SIGKILL` after 3 s on
dispose; a server process dies with the session that started it. On Windows a command like `npx` is
a `.cmd` shim, so it is run through `cmd.exe` — with its arguments passed in the environment, so a
literal `%PATH%` in one reaches the server unexpanded — and killed with its process tree. A server
that fails to start does not fail the session; its tools are absent and the transcript carries
`name: reason`.

For the native engine the kernel spawns the session's servers, aggregates their tools as
`mcp__<server>__<tool>` with the server's own JSON schema, and routes `tools/call` back through the
approval card. An ACP agent spawns the servers itself from the `session/new` payload, so the kernel
only forwards the list there and spawns nothing.

## Reaching the web

The native engine has one outbound tool, `web.fetch`: a single `GET` of a public URL, with no
request body, no cookies, and no caller-chosen headers, following at most five redirects. A URL that
carries credentials is refused rather than turned into `Authorization: Basic`. It is approved as the
`network` category, so a `network: allow` policy skips the card, `reject` refuses without one, and
nothing is fetched before the decision.

What comes back is readable text, not the document. HTML goes through the engine's own tokenizer
(`packages/engines/native/src/htmlText.ts`): `<title>` becomes the first heading, `<main>`-like
landmarks scope the content when a page has one, navigation and hidden subtrees are dropped, links
keep their targets resolved against the final URL, nested lists and tables survive as text, and
`<code>` is marked with backticks. JSON is pretty-printed unless indenting it would cost more than
64 KiB, which is what the returned text is capped at anyway; other textual types pass through; a
binary type is refused with its name and size — the size the server declared — instead of its bytes,
and its body is counted rather than buffered. Text is decoded as its declared charset — the header,
a BOM, then a `<meta charset>`. A page that declares nothing is read as UTF-8 when it is valid UTF-8
and as windows-1252 when it is not, which is HTML's own rule. The text is capped at 64 KiB, and a
non-2xx status is prefixed as `HTTP 404 Not Found`. A page longer than the 2 MiB download cap ends
with a line saying the body stopped there, so a cut page does not read as a complete one.

Targets are refused before the request leaves the machine, or by the socket's own DNS answer: only
`http` and `https`; no `localhost`, `.local`, `.internal`, or `home.arpa` name; and no private,
loopback, link-local, multicast, reserved, or IPv4-in-IPv6 address. The `lookup` handed to
`net.connect` validates every address the host resolves to and connects to that same answer, so a
second resolution cannot point back at the local machine. The check runs again on every redirect
hop, and a literal address in the URL is checked directly — `net.connect` never asks DNS for one.
`Accept-Encoding: identity` is sent, and a page that arrives compressed anyway is decoded —
`gzip`, `deflate`, `brotli` — with the decoded size capped at the body limit, so a compression
bomb stops where a long body does. An encoding with no decoder is refused by name. A body stops at
2 MiB, a fetch at 20 s in total across redirects, a stalled response at 10 s, and an interrupt
aborts the socket. Only `301`, `302`, `303`, `307`, and `308` are followed, and a redirect's body is
never read.

Only the native engine has it. An ACP agent reaches the network through whatever tools it brings.

## The chat shell

The **Chats** view is five regions:

- **Rail** — `Chats` / `Setup` and the theme toggle. Entering `Chats` reloads providers, models,
  workspaces, and sessions, so setup changes show up without a restart.
- **List pane** — `Projects` (project path, project, workspace) over `Sessions`: the new-chat model
  picker, `New chat`, a search box, filter buttons, and sessions grouped by `Today` / `Yesterday` /
  `Earlier` from the last event time.
- **Main pane** — tab strip, chat header (session status, model picker, token usage, `Interrupt`),
  transcript (assistant text, tool cards, permission cards, diffs), and the composer.
- **Inspector** — optional right panel with usage, the changed files (git's uncommitted changes plus
  the files the session reported), the plan, and pending approvals.
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
| `⌘P` / `Ctrl+P` | Quick open |
| `⌘S` / `Ctrl+S` | Save the active file |
| `⌘W` / `Ctrl+W` | Close the active tab |
| `⌘B` / `Ctrl+B` | Toggle the inspector |
| `⌘J` / `Ctrl+J` | Focus the composer |
| `⌘.` / `Ctrl+.` | Interrupt the running turn |
| `⌘,` / `Ctrl+,` | Open setup |
| `⌘⇧T` / `Ctrl+Shift+T` | Switch `paper` / `ink` theme |

The palette lists available commands with their shortcut, filters on label and keywords as you type,
and greys out commands whose preconditions are unmet (no workspace, no active chat, no running turn).
It only dispatches actions that already exist — kernel RPCs such as `session.interrupt` and shell
actions such as `new-chat`. `Reload file from disk` is palette-only; otherwise nothing is reachable
from the palette that a button cannot do.

In the composer, `Enter` sends, `⇧Enter` inserts a newline, and `⌘Enter` queues the draft while a turn
runs. `Esc` interrupts a streaming turn. While a permission card is open it owns the keyboard: `1`–`9`
pick an option by position and `Esc` picks the reject option. The send button always reads `Send`; the
state line under it reports `Sending…`, `Queued for after this turn`, `Streaming`, `Interrupted`, or
`Failed`.

Queued turns live in kernel memory. They survive an interrupt — the turn ahead is cancelled and the
queue drains — but not a kernel restart: turns persisted as `running` or `queued` are reported as
failed the next time the app touches that session, with any open approval rejected. Open tabs, the
active tab, and the theme (`noir.theme` in `localStorage`, applied as `<html data-theme>`) are
restored on launch, and each restored chat tab replays its transcript from sequence 0.

## Editing

`Chat list` / `File list` switch what the list pane shows: sessions, or the workspace tree. `⌘P`
searches the whole workspace by path; opening a file adds an editor tab beside the chat tabs.
`Show diff` adds a diff tab the same way, and `⌘W` closes whichever tab is active — a dirty editor
tab refuses to close until it is saved. Restored editor and diff tabs belong to the workspace they
were opened in: when the selected workspace differs they are dropped and the chat tabs stay, and
chat tabs whose session no longer exists are dropped too.

**Saving.** `⌘S` writes the buffer through `fs.write`, which is atomic: the kernel writes a temp file
beside the target, fsyncs it, and renames it over the file, so a crash mid-write cannot leave a torn
file. The write carries the `mtimeMs` the file had when it was read, so a file changed in the
meantime by the agent or another program is refused with a conflict and the draft stays in the tab;
a file deleted on disk is a conflict too, not a new file. `Reload file from disk` (palette only) is
the way back: it re-reads the file and drops whatever was typed.

**Large files.** A file over 2 MiB is refused for editing rather than opened as a prefix: the alert
reads `<path> is larger than 2 MiB; not opened for editing`, and the tab shows that reason instead
of an editor. The read itself stops at 2 MiB.

**Diff stats.** The chat header and the inspector read `git.status` — line adds and deletes against
`HEAD` — refreshed after each save, when the workspace changes, and shortly after a kernel event
that can change files (`file.changed`, `tool.completed` / `tool.failed`, `turn.completed` /
`turn.failed`), batched with a 250 ms debounce. A workspace that is not a git repository shows no
stats and still edits and saves.

**Diffs and notes.** `Show diff` opens a unified diff tab for the file. Clicking a line number opens
an inline input: `Enter` stores the note, `Esc` cancels. The note carries the hash of the diff it was
rendered from, so if the file changed meanwhile the add is refused and the diff reloads. A note
written against an older diff is listed under `Notes from an earlier version` rather than pointing
at unrelated lines; that check runs when the diff loads again.

**Limits.** A directory listing stops at 2 000 entries — the cap is per directory, and the tree notes
truncation for the root only today — a read at 2 MiB (larger files are refused for editing), a write
at 5 000 000 characters, and quick open at 5 000 files. Files that are not UTF-8 text and symlinks
are refused or skipped rather than rendered.

## Artifacts

A preview tab opens from a `Preview` button in the file tree, from the inspector's changed files, from
quick open (restricted to previewable files and labelled `Preview file`), and from a link inside a
rendered Markdown artifact: a relative `other.md` link opens another preview, `other.md#usage` splits
the fragment off before resolving, and anything that is not previewable opens in an editor tab. The
viewer reads through `artifact.read`, so the kernel — not the renderer — decides what may be read:
text is capped at 2 MiB, PDF at 32 MiB, and the path is resolved inside the workspace first.

- **Markdown** renders GFM tables and highlights code, and drops raw HTML (a `skipHtml` pass plus a
  sanitizing one), so a hostile `notes.md` shows its text and runs nothing. The static CSP in
  `index.html` (`default-src 'self'`, no `unsafe-inline`) is the second line of defence.
- **CSV** is parsed with RFC 4180 quoting — quoted commas, embedded newlines, a UTF-8 BOM, CRLF — and
  is bounded at 5 000 rows, 100 columns, and 500 characters per cell. Everything past a bound is
  dropped and the viewer says so rather than rendering a partial table silently.
- **PDF** renders page by page through pdf.js and reports `n / n`. It uses pdf.js's `legacy` bundle
  with its legacy worker: the modern build calls `Map.prototype.getOrInsertComputed`, which this
  Electron's Chromium does not implement, and the failure mode is a blank canvas rather than an error.

Preview tabs persist with the other tabs (`noir.tabs.v3`) and are restored only for the workspace
they were opened in. Reloading a deleted file reports `File not found: <path>`; an oversized PDF
reports the kernel's own `Artifact is larger than 32 MB`. External links never load inside the app:
the renderer hands them to `shell:openExternal`, and the main process validates the protocol before
calling the OS browser.

## Skills

Each workspace gets a skill set from two directories: `<data dir>/skills` (Windows default
`%APPDATA%/NoirHarness/skills`, overridable by `NOIR_DATA_DIR`) and `<workspace>/.noir/skills`
(project). A skill is a directory with a `SKILL.md` whose frontmatter carries `name` and
`description`. When both scopes define a name, the project copy wins and the global one is marked
shadowed.

The kernel hashes each skill directory, copies the enabled effective set into
`<workspace>/.noir/skills-engine`, and points the generated `config.yml` at it with a cwd-relative
`skills.customDirectories` entry. Global skills are copied into each workspace that uses them, so a
name claimed by a project skill stays claimed even when that project skill is disabled. Disabling a
skill removes it from the materialized copy — never from its source — and applies to the next
session started in that workspace. Global skill toggles are machine-wide: the flag is stored once
and affects every workspace. A `skill://` read by the engine becomes a `skill.loaded` event
carrying the name, scope and hash; the chat shows a `Skills loaded` group.

The manifest beside that directory, `<workspace>/.noir/skills-engine.json`, is rewritten atomically
and records `version: 1` plus one entry per materialized skill with `name`, `scope`, `hash` and
`description`. A workspace that cannot be written gets an engine with no skills until it becomes
writable; the `Skills` view still lists the sources.

The `Skills` view lists both scopes with a hash, a live toggle, and a read-only `SKILL.md` viewer.
Scanning skips anything it cannot trust rather than failing: a skill with more than 200 files or
8 MiB of content, a `SKILL.md` over 1 MiB, or a directory without valid frontmatter is reported as
a warning and skipped; a symlinked `SKILL.md` is reported as a warning; symlinked skill directories
and links inside a skill are skipped silently and do not enter the hash.

**Installing a skill.** A skill comes from an `https` git URL or a local directory, and installs into
either the machine's skill root or the workspace's. Every install is pinned to the SHA-256 of its
files, and a git install is pinned to its commit as well. Updating is not automatic — the panel asks
the source what it now has, shows the old and new hashes, and only then offers the update, which the
kernel accepts only if the fetched hash matches the one you were shown. A git source is cloned
shallow, with submodules and the `ext` transport disabled, and without a credential prompt: plain
`http` is accepted only for loopback addresses, so a test or a local mirror works without a
certificate, while `ssh`, `git`, `file`, and `ext` are refused. `ext::` is remote command execution,
and the rest cannot be fetched without credentials this harness does not collect. The fetched tree is
capped at 2000 entries and 32 MiB, and the skill directory it yields at 200 files, 8 MiB, and 1 MiB
per `SKILL.md`; past any cap the install is refused and its staging copy deleted. A local source must
be an absolute path that is itself a real directory, and it may not contain a symbolic link anywhere
in its tree — scanning skips links, but an install refuses them rather than copying bytes its hash
would not cover.

The listing itself never claims an update exists — `skill.list` must not touch the network — so the
verdict is only the hash `skill.checkUpdate` returned, held by the panel until it is either
confirmed or discarded.

**Removing a skill** deletes its directory, its source record, and its enabled flag; the kernel
answers with the listing that follows, because removing the project copy of a name unshadows the
global one. A remove is a confirmation, not a single click. The panel resolves a name to its
directory through the scan rather than assuming the folder is named after the skill, and refuses to
report a workspace it cannot read as having no such skill.

A global hidden behind a project skill is listed as shadowed and offers only a remove: it cannot be
read or toggled into effect while the project copy holds the name, but it is still a real directory
the user may want gone.

## Agents and the office

The **Agents** view is three regions: the `Agents` roster, the `Office` main pane, and the
`Agent config` inspector.

An agent carries a name, a role, an engine, an optional model, an optional default workspace, the MCP
servers it may use, and a decision for each of the six permission categories (`shell`, `delete`,
`rename`, `write-outside-workspace`, `network`, `mcp`) with `allow` / `ask` / `reject`. The roster reads
`agent.roster` and shows each agent's status, the tool it is running, its session count, and its
context usage; status precedence is `needs you` over `working` over `error` over `idle`. `Start`
creates a session from the agent, freezing its engine, model, and policy, and opens the new chat.
Saving the form sends only the fields that changed, so an agent that still references a deleted model
can be edited without first clearing that model.

The roster refreshes for live events (`session.status`, `turn.*`, `tool.*`, `permission.*`,
`usage.updated`) with a trailing 250 ms debounce, and applies snapshots in request order, so a slow
answer cannot overwrite a newer one. An approval that needs you shows as a `Needs you` row carrying
the approval title, and as a speech bubble over the agent's character.

The **Office** pane renders a Phaser pixel office from the same roster data: each agent gets a stable
desk derived from its id, wanders to the lounge after an idle spell, and shows its state on the
character. The canvas is `aria-hidden` and publishes `data-office-ready`, `data-office-count`,
`data-office-desks`, and `data-office-selected` for tests; the roster and the inspector carry the
same information in text, so nothing is canvas-only. The `List view` / `Office view` toggle hides the
canvas and keeps the roster. Phaser and the scene load through dynamic imports, so the startup
bundle never contains them, and the office art is a CC0 Kenney pack committed under
`apps/desktop/src/renderer/office/assets/` with its licence and a frame manifest beside it — nothing
is fetched at runtime.

## Automations

A schedule is a workspace, an agent, a prompt, and a cadence: every `N` minutes, or every `N` days
at a wall-clock time. A cadence below a day also carries a phase — the minute past the hour it is
lined up on — so "every 15 minutes" can start at :07 and an hourly schedule can run at :15; the
kernel keeps that phase through every step, and a wall-clock anchor left over from a daily schedule
is read as its minute, not as 540 minutes past the hour. The **Automations** view lists them with
their next run, edits one at a time, and shows the run history; `Run now` records a manual run and
opens its chat. The open view re-reads its rows and the selected schedule's history every 15 seconds
— a fire is recorded in the kernel with no event to announce it, so the pane polls rather than
waiting to be told. The kernel's scheduler holds one timer, armed for the earliest enabled
`next_run_at`, and re-arms after every tick and after every create, edit, or delete, so a schedule
added while the app is open fires without a restart.

Each due schedule gets exactly one row in `schedule_runs` before anything else happens: the run is
recorded and `next_run_at` advanced in a single transaction, so a crash in between cannot fire the
same instant twice. Then, if the schedule is not still working on its previous run, the kernel
creates an ordinary session tagged with the schedule id, sends the prompt, and lets the turn run
detached — the timer is never blocked by a slow turn. `scheduleId` rides along on `session.list`, so
Chats marks the row `scheduled`, approvals land in Needs you like any other session, and deleting a
schedule leaves its transcripts in place while the run history cascades away.

Overlaps are skipped, not queued: a schedule whose previous run is still live records `skipped`.
Occurrences that came due while the app was closed are recorded as a single `missed` run carrying the
count, never replayed — a week away from a nightly schedule does not start seven sessions at boot. A
tick that lands up to 60 s late still fires, because a timer that wakes 20 ms after the instant is not
an absence. A failed fire (no agent, a refused session) marks the run `failed` and leaves the schedule
enabled, so the next occurrence is tried rather than the schedule silently dying. Re-enabling a
schedule that has been paused past its next run re-aligns that instant first, so resuming does not
emit a wall of `missed` rows.

The kernel is a daemon, so none of that needs the window: it is spawned detached from the app, writes
its port, token and pid to `<dataDir>/runtime/kernel.json`, and the next app start reattaches to it
rather than replacing it. Closing the window leaves the daemon and any turn it is running alone —
the turn's transcript is already in the kernel, so reopening the app shows it mid-flight. The tray
keeps the app reachable once its window is gone: `Show` reopens it, `Quit` leaves the daemon running,
and `Quit and stop daemon` ends both. A build change is the one thing that forces a restart, and the
app asks before it stops a daemon that is running turns. Stopping the daemon is not closing a chat:
a live turn is interrupted and the session reopens as `error` at the next launch, ready to resume.
The daemon is spawned with no inherited handles — an inherited stdout would keep the launching
process's pipe open for as long as the daemon runs — so it logs to `<dataDir>/logs/kernel.log`,
rotated to `kernel.1.log` once it passes 2 MB.

The same daemon can be reached from another device on the local network. Setup → *Devices* →
*Allow devices on this network* starts a second listener (the loopback one is untouched and still
uses the runtime token); *Create a pairing link* shows a URL whose `#` fragment carries a one-time
code good for ten minutes. Opening it on a phone exchanges the code for an `HttpOnly` cookie, and the
full harness loads: same sessions, same approvals, same event stream, because both listeners share
one kernel. A paired device is listed with what it is doing right now and is revocable; revoking
closes the sockets it already holds. Host and `Origin` must both name this machine, which is what
stops DNS rebinding from reaching the socket. The network listener speaks only TLS: it signs its own
X.509 certificate with a P-256 key under `<dataDir>/tls` (no `openssl`, no CA — the DER is encoded in
`packages/kernel/src/tls.ts`), the device cookie is `Secure`, and plaintext on that port never
reaches the application. Nothing vouched for that certificate, so the browser warns once: the
Devices pane prints its SHA-256 fingerprint to compare before accepting, and a certificate is
reissued — with a new fingerprint — when the machine's addresses change. The `remote.*` methods —
enable, disable, pair, devices, revoke — refuse anything that is not loopback, so a stolen cookie
cannot mint or remove devices.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `NOIR_OMP_COMMAND` | `omp` | binary to spawn |
| `NOIR_OMP_ARGS_JSON` | `[]` | JSON array of strings inserted before the generated `--session-dir … acp` flags |
| `NOIR_TURN_TIMEOUT_MS` | `120000` | per-turn watchdog; on expiry the kernel sends `session/cancel` and reports the turn as failed |
| `NOIR_GIT_COMMAND` | `git` | binary used for `git.status` and `git.diff`; set it when `git` is not on `PATH` |
| `NOIR_KERNEL_LOG` | `<dataDir>/logs/kernel.log` | where the spawned daemon writes its own log; set by the app, read by `apps/kernel` |
| `NOIR_NO_TRAY` | unset | `1` skips the tray, so closing the window quits the app; the end-to-end specs use it |
| `NOIR_WEB_ROOT` | unset | directory of the built renderer served to a paired browser; the app passes its own `dist/renderer`, unset means a paired device has no page to load |

The desktop shell also honours `NOIR_DATA_DIR`, `NOIR_KERNEL_ENTRY`, and `NOIR_NODE_BIN`.

## Verify

```sh
pnpm -r typecheck
pnpm -r test
pnpm --filter @noir/desktop test
pnpm --filter @noir/desktop test:e2e
```

`test:e2e` builds the app and drives Electron with Playwright against a local mock provider. Fourteen
specs, seventeen tests: `smoke` (2) — boot, process spawn, health, and a provider surviving an app
restart; `chat` (2) — a streamed reply and a permission-approved tool call; `shell` (1) — a tool turn
that survives the restart, a prompt queued behind a slow turn, an interrupt, the queued turn draining
after it, and a restart that replays the transcript; `editor` (2) — open a file, edit it, save
through the kernel, assert the file on disk, check the diff stats and `Show diff` from the
inspector, and refuse a file larger than the read cap; `skills` (1) — list a project skill, view its
body, materialize it through a turn, then disable it and assert the manifest entry and materialized
directory drop it; `recovery` (1) — a crashed kernel is reported and its session recovered; `native`
(1) — the native engine's SSE stream, a real `Allow once`, and a restart that reconstructs the wire
history; `artifacts` (1) — Markdown, CSV, and PDF previews, hostile Markdown staying inert, a
restored tab, and a deleted file; `office` (1) — two agents painted from the roster, an approval
bubble that clears, desks that survive a cold start, and `Enter` opening a chat from a focused row;
`mcp` (1) — an MCP server configured in Setup and probed, an agent bound to it, and a brokered
`mcp__calc__add` call approved through the card; `automations` (1) — a schedule created in the panel,
retimed to a minute, fired by the kernel's own timer into a real agent, and the run appearing in the
open pane without a remount; `daemon` (1) — the kernel still answering `/health` after the app's
window closes, and a relaunch reattaching to the same pid; `daemon-fire` (1) — a schedule firing with
no window open at all, observed over the kernel socket and only then seen in the reopened panel;
`remote` (1) — a browser with no Electron behind it, paired by code over TLS, running the harness
over the LAN listener with a `Secure` cookie, then revoked and refused on the next load (needs
`pnpm exec playwright install chromium`).
Each spec gets its own temporary data directory and its own Electron profile
(`--user-data-dir` inside that directory), so engine state and restored tabs stay inside it. Since
the daemon outlives the app, each spec's teardown asks it to stop through `/shutdown` before the
directory is removed.

The packaged app is checked separately: `_electron.launch({ executablePath })` against
`release/win-unpacked/NoirHarness.exe` asserts a rendered PDF page and the office's `data-office-*`
hooks, which is the only way to prove the pdf.js worker, the Phaser chunk, and the PNG atlases
resolve from `app.asar` under `file://`.

## Installer

Build a Windows installer from a clean checkout:

```sh
pnpm install
pnpm --filter @noir/desktop package
```

`release/NoirHarness Setup <version>.exe` installs per user; `release/win-unpacked/NoirHarness.exe` is
the same app without the NSIS wrapper. The package ships its own Node runtime
(`resources/runtime/node.exe`) and the bundled kernel (`resources/kernel`), so a machine without Node
can run it.

## Layout

- `packages/protocol` — wire types and the session reducer
- `packages/kernel` — SQLite, event store, services, RPC, engine manager
- `packages/engines/acp` — ACP client over stdio (JSON-RPC framing, terminals, turn watchdog)
- `packages/engines/native` — in-process chat-completions engine: SSE parser, tool registry, turn
  loop, history reconstruction
- `packages/adapters/omp-profile` — `models.yml`/`config.yml` renderer
- `apps/kernel` — daemon entry
- `apps/desktop` — Electron shell and React renderer
- `apps/desktop/src/renderer/preview` — the artifact renderers; `…/office` — the pixel office

The `omp acp` wire behaviour this is built against is documented in
`docs/superpowers/notes/2026-11-10-acp-spike.md`.
