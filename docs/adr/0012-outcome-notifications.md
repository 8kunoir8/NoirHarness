# ADR-0012: The app process is the witness, and it reports outcomes only

Status: accepted (2026-11-13)

A scheduled run is announced when its turn completes or fails, by the Electron main process over its
own socket to the kernel, using the runtime token. `session.created` carries the `scheduleId` that
fired the session; that field, and nothing else, is what makes a session reportable.

Reason: the renderer cannot be the witness because the window may not exist, and the kernel cannot
show a notification because it is spawned as `ELECTRON_RUN_AS_NODE` with no Electron APIs. Reporting
the start as well as the end was rejected: a fire is not news, its outcome is. One notification per
run is enforced in the app, since a reconnect can replay a completion.

Notifications need the app process, so `Quit and stop daemon` means silence until the next launch and
a run that fails before a session exists raises no event to report. Both are documented rather than
papered over with a notification queue or a synthetic event.
