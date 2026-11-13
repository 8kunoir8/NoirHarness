# OMP `--mode rpc` — what the wire actually looks like

Probed against `omp/18.19.0` on 2026-11-13, from a scratch directory, with `--no-session`. The
design spec calls the ACP surface a ceiling and requires an upgrade to `--mode rpc` "without changing
the kernel contract"; this note records what the upgrade has to speak.

## Transport

`omp --mode rpc` speaks newline-delimited JSON on stdio — one frame per line, no length prefix, no
framing header. `--no-session` keeps the probe from touching the session store.

First frame, sent before anything is asked:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],
 "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}
```

So a client negotiates a version rather than assuming one, and has a frame ceiling to respect. Two
frame limits and a capability flag suggest the protocol carries large payloads (tool output, file
reads) that may be split; that path was not exercised here.

## Requests and replies

Requests are `{"type":"<command>", …args}`. Replies carry the command back:

```json
{"type":"response","command":"prompt","success":true}
{"type":"response","command":"setModel","success":false,"error":"Unknown command: setModel"}
```

Unknown commands are answered, not fatal, which makes command discovery cheap: a wrong name returns
`Unknown command: <name>` and the process keeps running. Command names observed so far: `prompt`.
`setModel` and `getState` do not exist under those names.

`{"type":"prompt","message":"say hi"}` is accepted (`success: true`) and starts a turn.
`{"type":"prompt","text":"…"}` is not — it fails with `R.trim` on undefined, so the argument is
`message` and the field is required.

## A turn, as observed

In order, after `prompt`:

| Frame | Carries |
|---|---|
| `agent_start` | nothing; the agent loop began |
| `turn_start` | nothing; a turn began |
| `message_start` | `{message, messageId}` for the user message: `content: [{type:"text", text}]`, `attribution`, `timestamp` |
| `message_end` | the same message, committed |
| `message_start` | the assistant message: `content: [{type:"thinking", thinking, thinkingSignature, summary}]`, plus `api`, `provider`, `model`, `usage`, `stopReason`, `responseId` |
| `message_update` | `{assistantMessageEvent: {type:"thinking_start"|"thinking_delta"|…, contentIndex, delta?, partial}, message}` |

The stream is diff-shaped twice over: `message_update` carries both an incremental `delta` and the
whole `partial` message so far. That is more than ACP gives us (ACP's `session/update` is thinner),
and it is the first concrete argument for the upgrade: usage with cost per message, `responseId`
(the provider's own id), and the model actually used on each message.

Everything else seen on the wire in this probe was UI plumbing — `extension_ui_request`
(`setStatus`, `setWidget`) and `available_commands_update` (slash commands). They arrive unprompted
and would need to be ignored or surfaced, not forwarded as transcript.

## Tools

A prompt that edits a file produced the tool vocabulary, and no permission frame at all:

```json
{"type":"tool_execution_start","toolCallId":"call_00_…","toolName":"write",
 "args":{"path":"probe.txt","content":"hi"},"intent":"Creating probe.txt with hi"}
{"type":"tool_execution_end","toolCallId":"call_00_…","toolName":"write",
 "result":{"content":[{"type":"text","text":"[probe.txt#A564] Successfully wrote 2 bytes"}],
           "details":{"resolvedPath":"…"}},"isError":false}
{"type":"turn_end","message":{…}}
```

Also on the wire: `toolcall_start` / `toolcall_delta` / `toolcall_end` (the model still streaming the
call), then `tool_execution_*` (the tool running), then `turn_end` with the final assistant message.
`intent` is a human sentence, which the kernel's approval card would otherwise have to invent, and
`result.details.resolvedPath` is the workspace-relative path the editor and diff layers need.

**No permission request was raised** for a write outside the repository, in the default
configuration. Either rpc mode auto-approves, or the prompt path never asks. That is the single most
important unknown left: the kernel's whole permission model is a card that waits for a person, and an
engine that never asks would silently bypass it.

## Still unknown, and therefore not implemented

1. **Cancellation.** The command name for interrupting a turn is not known; `cancel`, `interrupt` and
   `abort` are all plausible and none was verified.
2. **Permissions.** See above: a write was executed with no request. Whether that is a configuration
   default or a property of rpc mode decides if the adapter can ship at all.
3. **File diffs.** `tool_execution_end` reports a resolved path and a byte count, not a diff; how the
   changed-line totals the shell shows would arrive is unobserved.
4. **Model selection.** `setModel` is not a command; how the model is chosen after start (a `model`
   field on `prompt`? a config command?) is open.
5. **Session continuity.** `--resume <id>` exists on the CLI; whether rpc mode can load a session and
   replay its history — the thing that makes `session.fork` carry context on OMP — is unverified.

## Plan

An `RpcEngine` beside the ACP adapter, behind the same `Engine` interface, spawned with
`--mode rpc --session-dir <dataDir>/engine`:

1. Framing and the `ready` handshake, with version negotiation and a rejection for an unsupported
   protocol version.
2. Map `message_start`/`message_update`/`message_end` to the kernel's `message.delta` /
   `message.completed`, `thinking` blocks to `reasoning`.
3. Discover and verify cancellation and permission shapes with a probe that actually edits a file —
   the next thing this note needs, and the gate on shipping the adapter.
4. Keep ACP as the default engine until the permission path is proven: a tool call that cannot be
   approved is a worse regression than a thinner stream.
