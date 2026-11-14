import type { ReactNode } from "react";

export interface ShellProps {
  topbar: ReactNode;
  nav: ReactNode;
  /** `undefined` collapses the rail: the grid column goes to zero and its contents unmount. */
  rail?: ReactNode | undefined;
  /** `undefined` collapses the list, on the same terms as the rail. */
  list?: ReactNode | undefined;
  main: ReactNode;
  sidebar?: ReactNode | undefined;
  status: ReactNode;
}

/**
 * Window chrome, a horizontal nav, four body columns and a status bar. The shell owns layout only;
 * every action and every piece of state lives in the view it frames. The two left columns collapse
 * by rendering nothing into them, and the right column is a permanent live pane (the office), not a
 * drawer: it is either there or the layout does not render it.
 */
export function Shell({ topbar, nav, rail, list, main, sidebar, status }: ShellProps) {
  return (
    <div
      className="shell"
      data-rail={rail === undefined ? "closed" : "open"}
      data-list={list === undefined ? "closed" : "open"}
      data-sidebar={sidebar === undefined ? "closed" : "open"}
    >
      <header className="shell-topbar">{topbar}</header>
      <nav className="shell-nav" aria-label="Main">
        {nav}
      </nav>
      {/* The aside stays so the grid keeps its areas; its contents unmount so no focus stops in it. */}
      <aside className="shell-rail" aria-label="Filters and projects">
        {rail ?? null}
      </aside>
      <aside className="shell-list" aria-label="Chats and files">
        {list ?? null}
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
