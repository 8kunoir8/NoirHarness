# ADR-0008: Engine state lives in NoirHarness's own data directory

Status: accepted (2026-11-10)

`omp` resolves named profiles under its own home (`~/.omp/profiles/<name>/agent`), so `--profile noir` left the app's generated `models.yml`, session state, and caches inside the user's omp tree and forced tests to snapshot and restore that directory.

Decision: launch `omp` without a profile and set `PI_CODING_AGENT_DIR=<dataDir>/engine` in the child environment. omp then reads and writes only that directory (`omp config path` reports it, `omp models` reads `models.yml` from it), and the kernel writes the same directory via `profileAgentDir(dataDir)`. `--profile` must not be passed: when both are present the profile flag wins and omp resolves back under `~/.omp`.

Consequence: the app owns its engine state completely — a user's `~/.omp` is untouched, e2e runs need no snapshot/restore, and the profile path shown in Setup is the real one. `models.yml` keeps omp's format, so files can be copied between a user profile and the app. omp state written before this decision (`~/.omp/profiles/noir`) is abandoned; deleting it is safe.
