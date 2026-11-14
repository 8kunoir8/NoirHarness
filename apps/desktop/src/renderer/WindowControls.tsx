import { useEffect, useState, type ReactNode } from "react";
import type { WindowControls } from "./api.js";

const bridge = (): WindowControls | undefined =>
  typeof window === "undefined" ? undefined : window.noir?.windowControls;

/** A 12 px glyph on a 46×40 hit target: the same geometry as the OS caption it replaces. */
const GLYPH: Record<"minimize" | "maximize" | "restore" | "close", ReactNode> = {
  minimize: <path d="M2 7h10" />,
  maximize: <rect x="2.5" y="2.5" width="9" height="9" rx="1" />,
  restore: (
    <>
      <rect x="2.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M5 2.5h5.5a1 1 0 0 1 1 1V9" />
    </>
  ),
  close: <path d="M2.5 2.5l9 9M11.5 2.5l-9 9" />,
};

/**
 * Window caption buttons for the frameless window. Rendered only where a preload exists — a browser
 * tab is served by the kernel and already has the OS chrome — so the row simply does not appear
 * there, and no layout is reserved for it in the browser.
 *
 * The row is a `no-drag` island inside the draggable topbar; `onState` keeps the maximize glyph and
 * the double-click-to-restore affordance in step with the real window, including a maximize done
 * from the OS (snap, Win+Up, a taskbar gesture).
 */
export function WindowControlsBar() {
  const controls = bridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (controls === undefined) return;
    let live = true;
    void controls
      .state()
      .then((state) => {
        if (live) setMaximized(state.maximized || state.fullScreen);
      })
      .catch(() => undefined);
    const off = controls.onState((state) => setMaximized(state.maximized || state.fullScreen));
    return () => {
      live = false;
      off();
    };
  }, [controls]);

  if (controls === undefined) return null;
  const glyph = maximized ? GLYPH.restore : GLYPH.maximize;
  return (
    <div className="window-controls" data-maximized={maximized ? "true" : "false"}>
      <button
        type="button"
        className="window-control"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void controls.minimize()}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true" stroke="currentColor" strokeWidth="1" fill="none">
          {GLYPH.minimize}
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => {
          void controls.toggleMaximize().then((state) => setMaximized(state.maximized || state.fullScreen));
        }}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true" stroke="currentColor" strokeWidth="1" fill="none">
          {glyph}
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        aria-label="Close window"
        title="Close"
        onClick={() => void controls.close()}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true" stroke="currentColor" strokeWidth="1" fill="none">
          {GLYPH.close}
        </svg>
      </button>
    </div>
  );
}
