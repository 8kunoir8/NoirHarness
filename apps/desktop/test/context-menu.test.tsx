import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextMenuProvider, menuForShortcut, placeMenu, useContextMenu, type MenuItem } from "../src/renderer/ContextMenu.js";

function Opener({ items }: { items: MenuItem[] }) {
  const menu = useContextMenu();
  return (
    <button type="button" onClick={(event) => menu.open(items, { x: 10, y: 10 }, { element: event.currentTarget })}>
      open
    </button>
  );
}

const items: MenuItem[] = [
  { kind: "item", id: "a", label: "Alpha", run: () => undefined },
  { kind: "item", id: "b", label: "Beta", disabled: "No checkpoint for this turn", run: () => undefined },
  { kind: "separator" },
  { kind: "item", id: "c", label: "Gamma", run: () => undefined },
];

describe("ContextMenuProvider", () => {
  it("moves focus with the arrow keys, skipping unavailable items", () => {
    render(
      <ContextMenuProvider>
        <Opener items={items} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const menu = screen.getByRole("menu");
    expect(document.activeElement?.textContent).toBe("Alpha");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Gamma");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Alpha");
  });

  it("states why an item is unavailable instead of hiding it", () => {
    render(
      <ContextMenuProvider>
        <Opener items={items} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const beta = screen.getByRole("menuitem", { name: "Beta" });
    expect(beta.getAttribute("title")).toBe("No checkpoint for this turn");
    expect(beta.getAttribute("aria-disabled")).toBe("true");
  });

  it("consumes Escape, closes, and returns focus to the opener", () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    render(
      <ContextMenuProvider>
        <Opener items={items} />
      </ContextMenuProvider>,
    );
    const opener = screen.getByRole("button", { name: "open" });
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
    // A dialog behind the menu must not answer the same Escape.
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });

  it("runs the chosen item and closes", () => {
    const run = vi.fn();
    const single: MenuItem[] = [{ kind: "item", id: "a", label: "Alpha", run }];
    render(
      <ContextMenuProvider>
        <Opener items={single} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a pointer press outside it", () => {
    render(
      <ContextMenuProvider>
        <Opener items={items} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run an item that is unavailable", () => {
    const run = vi.fn();
    const single: MenuItem[] = [{ kind: "item", id: "a", label: "Alpha", disabled: "Nothing staged to commit", run }];
    render(
      <ContextMenuProvider>
        <Opener items={single} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("shows the shortcut of the command an item names", () => {
    const single: MenuItem[] = [{ kind: "item", id: "rename", label: "Rename", commandId: "open-file", run: () => undefined }];
    render(
      <ContextMenuProvider
        commands={[
          {
            id: "open-file",
            label: "Open file",
            shortcut: { key: "p", mod: true },
            enabled: true,
            run: () => undefined,
          },
        ]}
      >
        <Opener items={single} />
      </ContextMenuProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByText(process.platform === "darwin" ? "⌘P" : "Ctrl+P")).toBeTruthy();
  });
});

describe("placeMenu", () => {
  const viewport = { width: 1000, height: 800 };

  it("opens down-right when there is room", () => {
    expect(placeMenu({ at: { x: 40, y: 50 }, size: { width: 180, height: 120 }, viewport })).toEqual({ left: 40, top: 50 });
  });

  it("flips to the left of the point at the right edge", () => {
    expect(placeMenu({ at: { x: 990, y: 50 }, size: { width: 180, height: 120 }, viewport }).left).toBe(810);
  });

  it("flips above the point at the bottom edge", () => {
    expect(placeMenu({ at: { x: 40, y: 790 }, size: { width: 180, height: 120 }, viewport }).top).toBe(670);
  });

  it("keeps an oversized menu inside the margin", () => {
    expect(placeMenu({ at: { x: 900, y: 700 }, size: { width: 2000, height: 2000 }, viewport })).toEqual({ left: 8, top: 8 });
  });
});

describe("menuForShortcut", () => {
  it("recognizes Shift+F10 and the dedicated menu key", () => {
    expect(menuForShortcut({ key: "F10", shiftKey: true } as KeyboardEvent)).toBe("open");
    expect(menuForShortcut({ key: "ContextMenu", shiftKey: false } as KeyboardEvent)).toBe("context");
    expect(menuForShortcut({ key: "F10", shiftKey: true, ctrlKey: true } as KeyboardEvent)).toBeUndefined();
    expect(menuForShortcut({ key: "F10", shiftKey: false } as KeyboardEvent)).toBeUndefined();
  });
});
