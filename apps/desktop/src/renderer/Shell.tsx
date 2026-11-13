import type { ReactNode } from "react";

export interface ShellProps {
  topbar: ReactNode;
  nav: ReactNode;
  rail: ReactNode;
  list: ReactNode;
  main: ReactNode;
  sidebar?: ReactNode;
  status: ReactNode;
}

/**
 * Window chrome, a horizontal nav, four body columns and a status bar. The shell owns layout only;
 * every action and every piece of state lives in the view it frames. The right column is a permanent
 * live pane (the office), not a drawer: it is either there or the layout does not render it.
 */
export function Shell({ topbar, nav, rail, list, main, sidebar, status }: ShellProps) {
  return (
    <div className="shell" data-sidebar={sidebar === undefined ? "closed" : "open"}>
      <header className="shell-topbar">{topbar}</header>
      <nav className="shell-nav" aria-label="Main">
        {nav}
      </nav>
      <aside className="shell-rail" aria-label="Filters and projects">
        {rail}
      </aside>
      <aside className="shell-list" aria-label="Sessions and workspace">
        {list}
      </aside>
      <main className="shell-main">{main}</main>
      {sidebar === undefined ? null : (
        <aside className="shell-sidebar" aria-label="Live">
          {sidebar}
        </aside>
      )}
      <footer className="shell-status">{status}</footer>
    </div>
  );
}
