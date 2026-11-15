import { menuForShortcut, useContextMenu, type MenuItem } from "./ContextMenu.js";
import type { Tab } from "./tabs.js";

export interface TabStripProps {
  tabs: readonly Tab[];
  activeId: string | undefined;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** Session titles by session id; a missing entry renders `Untitled chat`. */
  titles: Readonly<Record<string, string>>;
  dirty?: ((path: string) => boolean) | undefined;
  /** Close every other tab; omitted where the strip cannot own that action. */
  onCloseOthers?: ((tabId: string) => void) | undefined;
  onCloseRight?: ((tabId: string) => void) | undefined;
}

function labelFor(tab: Tab, titles: Readonly<Record<string, string>>, dirty?: (path: string) => boolean): string {
  if (tab.kind === "chat") {
    const title = titles[tab.sessionId] ?? "";
    return title === "" ? "Untitled chat" : title;
  }
  const name = tab.path.split("/").at(-1) ?? tab.path;
  const text = tab.kind === "diff" ? `diff: ${name}` : name;
  return tab.kind === "editor" && dirty?.(tab.path) === true ? `${text} •` : text;
}

export function TabStrip({ tabs, activeId, onSelect, onClose, titles, dirty, onCloseOthers, onCloseRight }: TabStripProps) {
  const menu = useContextMenu();
  if (tabs.length === 0) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Open tabs">
      {tabs.map((tab, index) => {
        const text = labelFor(tab, titles, dirty);
        const active = tab.id === activeId;
        const items: MenuItem[] = [
          { kind: "item", id: "close", label: "Close", commandId: "close-tab", run: () => onClose(tab.id) },
          ...(onCloseOthers === undefined
            ? []
            : [{ kind: "item" as const, id: "close-others", label: "Close others", run: () => onCloseOthers(tab.id) }]),
          ...(onCloseRight === undefined
            ? []
            : [
                {
                  kind: "item" as const,
                  id: "close-right",
                  label: "Close to the right",
                  ...(index === tabs.length - 1 ? { disabled: "Nothing to the right" } : {}),
                  run: () => onCloseRight(tab.id),
                },
              ]),
        ];
        return (
          <div
            key={tab.id}
            className="tab"
            data-active={active}
            data-kind={tab.kind}
            onContextMenu={(event) => {
              event.preventDefault();
              menu.open(items, { x: event.clientX, y: event.clientY }, { element: event.currentTarget });
            }}
            onKeyDown={(event) => {
              if (menuForShortcut(event) === undefined) return;
              event.preventDefault();
              menu.openFor(items, { element: event.currentTarget });
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
            >
              {text}
            </button>
            <button type="button" className="tab-close" aria-label={`Close ${text}`} onClick={() => onClose(tab.id)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
