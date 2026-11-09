# ADR-0002: Append-only event log is the transcript of record

Status: accepted (2026-11-09)

Every session is an ordered, immutable event stream. UI projections are pure functions of that stream (`reduceSession`). Events are never updated or deleted inside M1.

Reason: chat, inspector, diff stats, future office view, and audit all consume one truth. Consequence: payloads must be versioned and additive within `v: 1`.
