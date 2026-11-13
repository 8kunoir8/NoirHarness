import type { MenuItemConstructorOptions } from "electron";

export interface TrayActions {
  show(): void;
  quit(): void;
  quitAndStop(): void;
}

/** Always a full sentence: the menu must not change height when the count does. */
export function armedLabel(count: number): string {
  if (count === 0) return "No automations armed";
  return count === 1 ? "1 automation armed" : `${count} automations armed`;
}

/**
 * Two quit rows because they mean different things: quitting leaves the daemon to fire schedules
 * with no window, and stopping ends it. Neither may be reachable by pressing the row above.
 */
export function trayMenu(armed: number, actions: TrayActions): MenuItemConstructorOptions[] {
  return [
    { label: "Show NoirHarness", click: () => actions.show() },
    { label: armedLabel(armed), enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => actions.quit() },
    { label: "Quit and stop daemon", click: () => actions.quitAndStop() },
  ];
}
