import type { ReactNode } from "react";

export interface ShellProps {
  rail: ReactNode;
  topbar: ReactNode;
  list: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
  status: ReactNode;
}

/**
 * Four regions plus a top bar and a status bar. The shell owns layout only; every action and
 * every piece of state lives in the view it frames.
 */
export function Shell({ rail, topbar, list, main, inspector, status }: ShellProps) {
  return (
    <div className="shell" data-inspector={inspector === undefined ? "closed" : "open"}>
      <header className="shell-topbar">{topbar}</header>
      <nav className="shell-rail" aria-label="Main">
        {rail}
      </nav>
      <aside className="shell-list" aria-label="Sessions and workspace">
        {list}
      </aside>
      <main className="shell-main">{main}</main>
      {inspector === undefined ? null : (
        <aside className="shell-inspector" aria-label="Inspector">
          {inspector}
        </aside>
      )}
      <footer className="shell-status">{status}</footer>
    </div>
  );
}
