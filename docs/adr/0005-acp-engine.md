# ADR-0005: ACP is the first engine contract

Status: accepted (2026-11-10)

The kernel talks to agents through a normalized `AgentEngine` interface. The first implementation is an ACP stdio client that launches `omp --profile noir --session-dir <workspace>/.noir/sessions acp`. ACP's update stream maps onto the existing event types; unmappable payloads become `engine.raw`. The native engine (M2) implements the same interface, and the kernel contract does not change when OMP's ACP surface is upgraded to `--mode rpc`.

Consequence: engine quirks stay in `@noir/engine-acp`; the kernel and renderer never parse ACP.
