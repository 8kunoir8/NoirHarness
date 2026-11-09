# ADR-0001: Kernel runs as a separate process

Status: accepted (2026-11-09)

The kernel (state, sessions, providers, events) runs as a headless Node process spawned by Electron main. It communicates over a localhost WebSocket.

Reasons: headless tests without Electron, crash isolation between renderer and daemon, and a path to remote/mobile without rewriting the core. Cost: one localhost IPC hop.
