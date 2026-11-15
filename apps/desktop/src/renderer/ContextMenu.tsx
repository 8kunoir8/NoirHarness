import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shortcutLabel, type Command } from "./commands.js";

export type MenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      id: string;
      label: string;
      /** Command whose shortcut is shown right-aligned; resolved at open, never written literally. */
      commandId?: string;
      /** Present means unavailable, and the text is the reason a person reads. */
      disabled?: string;
      danger?: boolean;
      run: () => void;
    };

/** The element a menu belongs to: the pointer's target, or the focused element for a keyboard open. */
export interface MenuTarget {
  element: HTMLElement;
}

export interface MenuHandle {
  /** `at` is viewport client coordinates, as a pointer event reports them. */
  open(items: readonly MenuItem[], at: { x: number; y: number }, target: MenuTarget): void;
  /** Opens anchored to the element's own box, for a keyboard invocation. */
  openFor(items: readonly MenuItem[], target: MenuTarget): void;
  close(): void;
}

interface MenuState {
  items: readonly MenuItem[];
  at: { x: number; y: number };
  target: MenuTarget;
  index: number;
}

const MARGIN = 8;

/**
 * Places a menu near a point without letting it leave the viewport: past the right or bottom edge it
 * flips to the other side of the point before it shifts inward.
 */
export function placeMenu(input: {
  at: { x: number; y: number };
  size: { width: number; height: number };
  viewport: { width: number; height: number };
}): { left: number; top: number } {
  const { at, size, viewport } = input;
  const left =
    at.x + size.width + MARGIN <= viewport.width ? at.x : Math.max(MARGIN, at.x - size.width);
  const top =
    at.y + size.height + MARGIN <= viewport.height ? at.y : Math.max(MARGIN, at.y - size.height);
  return {
    left: Math.max(MARGIN, Math.min(left, Math.max(MARGIN, viewport.width - size.width - MARGIN))),
    top: Math.max(MARGIN, Math.min(top, Math.max(MARGIN, viewport.height - size.height - MARGIN))),
  };
}

/** Only the fields a shortcut reads, so a React synthetic event and a DOM event both fit. */
export interface KeyChord {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** `Shift+F10` and the dedicated menu key open the focused element's menu, as on any desktop. */
export function menuForShortcut(event: KeyChord): "open" | "context" | undefined {
  if (event.key === "ContextMenu") return "context";
  if (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return "open";
  return undefined;
}

/** Moves by `step` over items that can be focused, wrapping at both ends. */
function step(items: readonly MenuItem[], from: number, direction: 1 | -1): number {
  for (let count = 1; count <= items.length; count += 1) {
    const candidate = (from + direction * count + items.length * count) % items.length;
    const item = items[candidate];
    if (item?.kind === "item" && item.disabled === undefined) return candidate;
    if (from === -1 && count === items.length) return -1;
  }
  return from;
}

const MenuContext = createContext<MenuHandle | undefined>(undefined);

/**
 * One menu lives here for the whole window: a second open replaces the first, so two surfaces can
 * never leave orphaned overlays behind, and Escape has exactly one owner.
 */
export function ContextMenuProvider({ commands = [], children }: { commands?: readonly Command[]; children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined);
  const box = useRef<HTMLDivElement | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  const close = useCallback((): void => {
    setMenu((current) => {
      if (current !== undefined && current.target.element.isConnected) current.target.element.focus();
      return undefined;
    });
    setPosition(undefined);
  }, []);

  const open = useCallback((next: readonly MenuItem[], at: { x: number; y: number }, target: MenuTarget): void => {
    setPosition(undefined);
    setMenu({ items: next, at, target, index: next.findIndex((item) => item.kind === "item" && item.disabled === undefined) });
  }, []);

  const openFor = useCallback(
    (next: readonly MenuItem[], target: MenuTarget): void => {
      const rect = target.element.getBoundingClientRect();
      open(next, { x: rect.left, y: rect.bottom + 2 }, target);
    },
    [open],
  );

  const handle = useMemo<MenuHandle>(() => ({ open, openFor, close }), [open, openFor, close]);

  // Measured after mount, so a menu near an edge flips instead of overflowing.
  useLayoutEffect(() => {
    if (menu === undefined) {
      setPosition(undefined);
      return;
    }
    const element = box.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setPosition(
      placeMenu({
        at: menu.at,
        size: { width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, [menu]);

  // A hidden element cannot take focus, and the first paint is hidden until it is measured, so this
  // waits for the position rather than for the menu: the same commit that reveals it moves focus.
  useLayoutEffect(() => {
    if (menu === undefined || position === undefined) return;
    items.current[menu.index]?.focus();
  }, [menu, position]);

  // A menu is a snapshot of one moment: any of these means that moment is gone.
  useLayoutEffect(() => {
    if (menu === undefined) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (box.current?.contains(event.target as Node) === true) return;
      close();
    };
    const dismiss = (): void => close();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu, close]);

  const hint = (commandId: string | undefined): string | undefined => {
    if (commandId === undefined) return undefined;
    const shortcut = commands.find((command) => command.id === commandId)?.shortcut;
    return shortcut === undefined ? undefined : shortcutLabel(shortcut);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (menu === undefined) return;
    const at = menu.index;
    switch (event.key) {
      case "Escape":
        // Innermost surface: a dialog behind the menu must not answer the same Escape.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Tab":
        event.preventDefault();
        close();
        return;
      case "ArrowDown":
        event.preventDefault();
        setMenu({ ...menu, index: step(menu.items, at, 1) });
        return;
      case "ArrowUp":
        event.preventDefault();
        setMenu({ ...menu, index: step(menu.items, at, -1) });
        return;
      case "Home": {
        event.preventDefault();
        const first = menu.items.findIndex((item) => item.kind === "item" && item.disabled === undefined);
        if (first !== -1) setMenu({ ...menu, index: first });
        return;
      }
      case "End": {
        event.preventDefault();
        const last = menu.items.findLastIndex((item) => item.kind === "item" && item.disabled === undefined);
        if (last !== -1) setMenu({ ...menu, index: last });
        return;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        const item = menu.items[at];
        if (item?.kind !== "item" || item.disabled !== undefined) return;
        close();
        item.run();
        return;
      }
      default:
        return;
    }
  };

  return (
    <MenuContext.Provider value={handle}>
      {children}
      {menu === undefined
        ? null
        : createPortal(
            <div
              ref={box}
              role="menu"
              className="context-menu"
              // Hidden until measured, so the first paint never flashes at an unclamped position.
              style={position === undefined ? { left: 0, top: 0, visibility: "hidden" } : position}
              onKeyDown={onKeyDown}
              onContextMenu={(event) => event.preventDefault()}
            >
              {menu.items.map((item, index) =>
                item.kind === "separator" ? (
                  <div key={`separator-${String(index)}`} role="separator" className="context-menu-separator" />
                ) : (
                  <button
                    key={item.id}
                    ref={(element) => {
                      items.current[index] = element;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    aria-disabled={item.disabled === undefined ? undefined : true}
                    data-danger={item.danger === true ? "true" : undefined}
                    title={item.disabled}
                    className={index === menu.index ? "context-menu-item is-active" : "context-menu-item"}
                    onPointerEnter={() => {
                      if (item.disabled === undefined) setMenu((current) => (current === undefined ? current : { ...current, index }));
                    }}
                    onClick={() => {
                      if (item.disabled !== undefined) return;
                      close();
                      item.run();
                    }}
                  >
                    <span className="context-menu-label">{item.label}</span>
                    {hint(item.commandId) === undefined ? null : (
                      <kbd className="context-menu-hint">{hint(item.commandId)}</kbd>
                    )}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )}
    </MenuContext.Provider>
  );
}

/** A surface rendered outside the provider keeps working; its menu simply never opens. */
const NO_MENU: MenuHandle = { open: () => undefined, openFor: () => undefined, close: () => undefined };

export function useContextMenu(): MenuHandle {
  return useContext(MenuContext) ?? NO_MENU;
}
