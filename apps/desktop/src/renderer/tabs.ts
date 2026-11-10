export type Tab =
  | { id: string; kind: "chat"; sessionId: string }
  | { id: string; kind: "editor"; path: string }
  | { id: string; kind: "diff"; path: string };

export interface TabsState {
  tabs: Tab[];
  active: string | undefined;
}

export const TABS_KEY = "noir.tabs.v2";

export function chatTab(sessionId: string): Tab {
  return { id: `chat:${sessionId}`, kind: "chat", sessionId };
}
export function editorTab(path: string): Tab {
  return { id: `editor:${path}`, kind: "editor", path };
}
export function diffTab(path: string): Tab {
  return { id: `diff:${path}`, kind: "diff", path };
}

export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((candidate) => candidate.id === tab.id)) {
    return state.active === tab.id ? state : { tabs: state.tabs, active: tab.id };
  }
  return { tabs: [...state.tabs, tab], active: tab.id };
}

export function activateTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((tab) => tab.id === id) || state.active === id) return state;
  return { tabs: state.tabs, active: id };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.active !== id) return { tabs, active: state.active };
  const neighbour = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, active: neighbour?.id };
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "chat") return typeof candidate.sessionId === "string" && candidate.sessionId !== "";
  if (candidate.kind === "editor" || candidate.kind === "diff") {
    return typeof candidate.path === "string" && candidate.path !== "";
  }
  return false;
}

function normalize(tab: Tab): Tab {
  if (tab.kind === "chat") return chatTab(tab.sessionId);
  return tab.kind === "editor" ? editorTab(tab.path) : diffTab(tab.path);
}

/** Accepts the v2 shape and migrates the v1 chat-id list only when `tabs` is not an array; anything unrecognized becomes empty. */
export function loadTabs(raw: unknown): TabsState {
  if (typeof raw !== "object" || raw === null) return { tabs: [], active: undefined };
  const record = raw as { tabs?: unknown; open?: unknown; active?: unknown };
  const source: Tab[] = Array.isArray(record.tabs)
    ? record.tabs.filter(isTab)
    : Array.isArray(record.open)
      ? record.open.filter((id): id is string => typeof id === "string" && id !== "").map(chatTab)
      : [];
  const tabs: Tab[] = [];
  for (const tab of source.map(normalize)) {
    if (!tabs.some((candidate) => candidate.id === tab.id)) tabs.push(tab);
  }
  const requested = typeof record.active === "string" ? record.active : undefined;
  const active =
    requested !== undefined && tabs.some((tab) => tab.id === requested)
      ? requested
      : requested !== undefined && tabs.some((tab) => tab.id === `chat:${requested}`)
        ? `chat:${requested}`
        : tabs[0]?.id;
  return { tabs, active };
}
