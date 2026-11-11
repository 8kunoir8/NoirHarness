export type Tab =
  | { id: string; kind: "chat"; sessionId: string }
  | { id: string; kind: "editor"; path: string }
  | { id: string; kind: "diff"; path: string }
  | { id: string; kind: "preview"; path: string };

export interface TabsState {
  tabs: Tab[];
  active: string | undefined;
  /** Workspace the editor/diff tabs belong to; `""` until a workspace has been selected. */
  workspaceId: string;
}

export const TABS_KEY = "noir.tabs.v3";

export function chatTab(sessionId: string): Tab {
  return { id: `chat:${sessionId}`, kind: "chat", sessionId };
}
export function editorTab(path: string): Tab {
  return { id: `editor:${path}`, kind: "editor", path };
}
export function diffTab(path: string): Tab {
  return { id: `diff:${path}`, kind: "diff", path };
}
export function previewTab(path: string): Tab {
  // `.` segments and duplicate slashes name the same artifact, exactly as the kernel's guard treats them.
  const canonical = path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
  return { id: `preview:${canonical}`, kind: "preview", path: canonical };
}

export function openTab(state: TabsState, tab: Tab): TabsState {
  if (state.tabs.some((candidate) => candidate.id === tab.id)) {
    return state.active === tab.id ? state : { ...state, active: tab.id };
  }
  return { ...state, tabs: [...state.tabs, tab], active: tab.id };
}

export function activateTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((tab) => tab.id === id) || state.active === id) return state;
  return { ...state, active: id };
}

export function closeTab(state: TabsState, id: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.active !== id) return { ...state, tabs };
  const neighbour = tabs[Math.min(index, tabs.length - 1)];
  return { ...state, tabs, active: neighbour?.id };
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "chat") return typeof candidate.sessionId === "string" && candidate.sessionId !== "";
  if (candidate.kind === "editor" || candidate.kind === "diff" || candidate.kind === "preview") {
    return typeof candidate.path === "string" && candidate.path !== "";
  }
  return false;
}

function normalize(tab: Tab): Tab {
  if (tab.kind === "chat") return chatTab(tab.sessionId);
  if (tab.kind === "editor") return editorTab(tab.path);
  return tab.kind === "diff" ? diffTab(tab.path) : previewTab(tab.path);
}

/** Accepts the v2 and v3 shapes; migrates the v1 chat-id list only when `tabs` is not an array; anything unrecognized becomes empty. */
export function loadTabs(raw: unknown): TabsState {
  if (typeof raw !== "object" || raw === null) return { tabs: [], active: undefined, workspaceId: "" };
  const record = raw as { tabs?: unknown; open?: unknown; active?: unknown; workspaceId?: unknown };
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
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : "";
  return { tabs, active, workspaceId };
}

/**
 * Pins the stored tab set to the workspace it was saved in. Editor/diff/preview paths are
 * workspace-relative, so a tab restored under another workspace would silently read (and later save)
 * a same-named file from the wrong tree: those tabs are dropped, while chat tabs stay usable.
 *
 * An unset workspace id does not prove ownership either: legacy v2 blobs predate the field, so
 * adopting their editor/diff tabs would bind them to whichever workspace is selected first. They are
 * dropped like a mismatch; v1 blobs are chat-only, so no legitimate tab is lost.
 */
export function scopeTabs(state: TabsState, workspaceId: string): TabsState {
  if (workspaceId === "" || state.workspaceId === workspaceId) return state;
  const tabs = state.tabs.filter((tab) => tab.kind === "chat");
  const active = state.active !== undefined && tabs.some((tab) => tab.id === state.active) ? state.active : tabs[0]?.id;
  return { tabs, active, workspaceId };
}

/** Drops chat tabs whose session no longer exists; editor, diff, and preview tabs are workspace state and stay. */
export function pruneChatTabs(state: TabsState, sessionIds: ReadonlySet<string>): TabsState {
  const tabs = state.tabs.filter((tab) => tab.kind !== "chat" || sessionIds.has(tab.sessionId));
  if (tabs.length === state.tabs.length) return state;
  const active = state.active !== undefined && tabs.some((tab) => tab.id === state.active) ? state.active : tabs[0]?.id;
  return { ...state, tabs, active };
}
