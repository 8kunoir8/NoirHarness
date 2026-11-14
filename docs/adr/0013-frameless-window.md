# ADR-0013: The window has no frame, and the page draws the caption

Status: accepted (2026-11-14)

The main window is created with `frame: false` and `thickFrame: true`, and the renderer draws the
minimize, maximize/restore and close buttons in the topbar. Dragging is `-webkit-app-region: drag` on
the topbar (and on the kernel banner, which can sit above it), with `no-drag` on every control inside
that row. Four IPC verbs back the buttons: `window:minimize`, `window:toggle-maximize`,
`window:close`, `window:state`, plus the first main→renderer channel in the app, `window:changed`,
emitted from the window's own `maximize`/`unmaximize`/`enter-full-screen`/`leave-full-screen` events.

Reason: a custom titlebar is the only way the chrome can follow `data-theme` — `titleBarOverlay` is
OS-drawn and stays light in the Ink theme, and on Windows it also reserves its own system-menu
behaviour. `thickFrame: true` keeps what a frameless window otherwise loses: the resize border, snap
layouts, the maximize animation, and Win+Up/Win+Down.

The buttons report the window's state rather than the click that asked for it. `window:changed`
therefore exists even though every button could update itself optimistically: a maximize also arrives
from snapping, from a taskbar gesture, and from Windows restoring the window, and a glyph that
disagreed with the window would be a bug the click path can never see.

`window:close` calls `win.close()`, never `win.hide()`. The window's own `close` handler still decides
whether a tray turns a close into a hide, so the custom button cannot diverge from the titlebar it
replaced. In full screen the maximize button leaves full screen instead of maximizing under it.

The state shape is written out three times — preload, renderer `api.ts`, and the two handler replies —
because the preload is bundled separately and cannot import from the renderer. The duplication is
checked by the typechecker at each end; a shared module would move it, not remove it.

Closing is observable only from inside the process. Electron's exit after `quit` is delivered
asynchronously by the OS, and under a debugger it waits for the debugger to detach first, so a test
that treats "the process left" as the proof of a close button is really testing the test runner's
teardown. `NOIR_QUIT_LOG` therefore records the app's own shutdown one step per line
(`window:close quit`, `window:closed`, `app:window-all-closed`, `app:before-quit`, `app:will-quit`,
`app:quit`), and the window spec asserts that sequence. It also makes the two real failures legible:
a `window:close hide` means the tray path took over, and a log that stops at `app:will-quit` means
something prevented the quit.
