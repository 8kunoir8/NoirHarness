import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { armedLabel, trayMenu } from "../src/tray.js";

const labels = (menu: MenuItemConstructorOptions[]): string[] =>
  menu.flatMap((item) => ("label" in item && typeof item.label === "string" ? [item.label] : []));

const noop = { show: () => undefined, quit: () => undefined, quitAndStop: () => undefined };

describe("armedLabel", () => {
  it("names the count without pluralising one", () => {
    expect(armedLabel(0)).toBe("No automations armed");
    expect(armedLabel(1)).toBe("1 automation armed");
    expect(armedLabel(3)).toBe("3 automations armed");
  });
});

describe("trayMenu", () => {
  it("shows the window and reports the armed count without offering it as a click", () => {
    const menu = trayMenu(2, noop);
    expect(labels(menu)).toContain("Show NoirHarness");
    expect(labels(menu)).toContain("2 automations armed");
    const armed = menu.find((item) => "label" in item && item.label === "2 automations armed");
    expect(armed?.enabled).toBe(false);
  });

  it("wires every row to its own action", () => {
    const calls = { show: vi.fn(), quit: vi.fn(), quitAndStop: vi.fn() };
    const menu = trayMenu(0, calls);
    const click = (label: string): void => {
      const item = menu.find((candidate) => "label" in candidate && candidate.label === label);
      if (item === undefined || !("click" in item) || item.click === undefined) throw new Error(`no row ${label}`);
      item.click({} as never, {} as never, {} as never);
    };
    click("Show NoirHarness");
    click("Quit");
    click("Quit and stop daemon");
    expect(calls.show).toHaveBeenCalledOnce();
    expect(calls.quit).toHaveBeenCalledOnce();
    expect(calls.quitAndStop).toHaveBeenCalledOnce();
  });
});
