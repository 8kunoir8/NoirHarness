# ADR-0007: Secrets live in the OS credential vault

Status: accepted (2026-11-09)

API keys are stored with `@napi-rs/keyring` under service `NoirHarness` and account = provider id. The database stores only the provider id as `api_key_ref`. The renderer sends a key once over the authenticated local socket; the kernel never returns it.

Consequence: Linux requires a working libsecret/Secret Service. When unavailable, provider creation fails loudly instead of writing plaintext.
