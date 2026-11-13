# ADR-0011: The app supervises the daemon it did not start

Status: accepted (2026-11-13)

The desktop process polls `/health` every fifteen seconds and restarts the kernel after two
consecutive failures, at most once a minute, using the same attach-or-spawn path a launch uses. A
kernel answering under a different pid is adopted rather than replaced.

Reason: the daemon exists so runs happen with no window, which means a dead daemon is invisible —
the tray keeps looking healthy and the next fire is silently lost. One failed probe is not evidence
(it can be a paused process or a loaded machine); a restart loop is worse than a dead kernel, so the
rate limit is part of the contract, not a refinement. Adoption follows the same principle: someone
who restarted the kernel by hand is still talking to the data directory, and fighting them would
produce two daemons.

A deliberate stop — `Quit and stop daemon` — stops the supervisor first, so the absence it caused is
not read as a crash.
