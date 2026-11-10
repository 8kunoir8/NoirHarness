import type { Tab } from "./tabs.js";

export interface TabStripProps {
  tabs: readonly Tab[];
  activeId: string | undefined;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** Session titles by session id; a missing entry renders `Untitled chat`. */
  titles: Readonly<Record<string, string>>;
  dirty?: ((path: string) => boolean) | undefined;
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

export function TabStrip({ tabs, activeId, onSelect, onClose, titles, dirty }: TabStripProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Open tabs">
      {tabs.map((tab) => {
        const text = labelFor(tab, titles, dirty);
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className="tab" data-active={active} data-kind={tab.kind}>
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
