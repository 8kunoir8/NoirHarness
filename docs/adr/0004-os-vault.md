# ADR-0004: OS credential vault over app-managed encryption

Status: accepted (2026-11-10)

Provider API keys live in the OS credential vault (`@napi-rs/keyring`, service `NoirHarness`, account = provider id). SQLite stores only the vault handle. Kernel memory holds a key only while materializing the engine directory or during a provider health check. The engine file necessarily contains the key for `omp`; it is written atomically with 0600 to `<dataDir>/engine/models.yml` (see ADR-0008) and is excluded from events, logs, and the workspace.

Consequence: Linux requires libsecret/Secret Service; provider creation fails loudly without it.
