# ADR-0003: Provider registry is owned by the kernel

Status: accepted (2026-11-09)

Providers (base URL, API kind, key handle) and models are kernel rows, not engine configuration. Engine configuration is generated from them (Plan 2).

Reason: the product requirement is provider configuration inside NoirHarness; engine config must never become the source of truth. Secrets are stored in the OS credential vault under the provider id; the database keeps only the handle.
