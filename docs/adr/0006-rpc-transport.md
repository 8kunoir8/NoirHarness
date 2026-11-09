# ADR-0006: Localhost WebSocket JSON-RPC with a runtime token

Status: accepted (2026-11-09)

The kernel binds `127.0.0.1` on an ephemeral port and writes `{ pid, port, token }` to a `0600` runtime file. Every RPC requires the token; event frames are server-initiated notifications.

Reason: one transport serves the renderer today and a headless client or remote daemon later. The token prevents other local processes from driving the agent.
