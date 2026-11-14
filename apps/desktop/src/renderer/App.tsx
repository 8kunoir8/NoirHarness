import { useCallback, useEffect, useRef, useState } from "react";
import {
  ModelListResult,
  ScheduleListResult,
  SessionListResult,
  SessionView,
  SystemHealthResult,
  type AgentEvent,
  type FsReadResult,
  type GitStatusResult,
  type SkillListResult,
} from "@noir/protocol";
import { connect, kernelInfo, offEvent, reportArmed, request, type KernelInfo } from "./api.js";
import { isBrowser } from "./transport.js";
import { Agents } from "./Agents.js";
import { Automations } from "./Automations.js";
import { Chat } from "./Chat.js";
import type { DiffStats } from "./ChatHeader.js";
import { CommandPalette } from "./CommandPalette.js";
import type { Command } from "./commands.js";
import { DiffView } from "./DiffView.js";
import { runningToolTitle, useSessionEvents, type ChatFile } from "./events.js";
import { FileTree } from "./FileTree.js";
import { Inspector } from "./Inspector.js";
import { KernelBanner } from "./KernelBanner.js";
import { MonacoEditor } from "./MonacoEditor.js";
import { ArtifactPreview } from "./preview/ArtifactPreview.js";
import { previewKind } from "./preview/kind.js";
import { LiveSidebar } from "./LiveSidebar.js";
import { NavClock } from "./NavClock.js";
import { QuickOpen } from "./QuickOpen.js";
import { SessionFilters, SessionList, type ReadState, type SessionFilter } from "./SessionList.js";
import { countUnread, mergeSessions, sessionListQuery } from "./sessionQuery.js";
import { useRoster } from "./useRoster.js";
import { Setup } from "./Setup.js";
import { Shell } from "./Shell.js";
import { Skills } from "./Skills.js";
import { StatusBar } from "./StatusBar.js";
import { TabStrip } from "./TabStrip.js";
import {
  activateTab,
  chatTab,
  closeTab,
  diffTab,
  editorTab,
  loadTabs,
  openTab,
  previewTab,
  pruneChatTabs,
  scopeTabs,
  TABS_KEY,
  type Tab,
  type TabsState,
} from "./tabs.js";
import { useTheme } from "./theme.js";
import { useShortcuts } from "./useShortcuts.js";
import { WorkspacePanel, type ProjectView, type WorkspaceView } from "./WorkspacePanel.js";
import "./styles.css";

type View = "setup" | "chats" | "skills" | "agents" | "automations";

/** The two messages `api.ts` raises when there is no socket at all. */
const CONNECTION_FAILURE = /kernel connection (failed|closed)|kernel not connected/;
const NOT_PAIRED = "This device is not paired with the kernel. Ask the desktop app for a pairing link.";

type ListMode = "chats" | "files";

/** Which file overlay is open; `undefined` means none, so only one can render. */
type QuickOpenMode = "files" | "preview";

/** One open editor document: the text last read from (or written to) disk, and the editable draft. */
interface DocumentState {
  text: string;
  draft: string;
  mtimeMs: number;
}

const READ_KEY = "noir.read.sessions";

/**
 * Only events after which the workspace on disk can differ are worth a scan. Streaming produces
 * several events per token, and every one used to trigger a whole-tree `git.status`.
 */
const FILE_EVENTS: Readonly<Partial<Record<AgentEvent["type"], true>>> = {
  "file.changed": true,
  "session.rewound": true,
  "tool.completed": true,
  "tool.failed": true,
  "turn.completed": true,
  "turn.failed": true,
};

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function storeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage only costs persistence across launches.
  }
}

export function App() {
  const [status, setStatus] = useState("connecting");
  const [engineDir, setEngineDir] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>("setup");
  const [theme, , toggleTheme] = useTheme();
  const [kernel, setKernel] = useState<KernelInfo | undefined>(undefined);

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [models, setModels] = useState<ModelListResult["models"]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [newChatModelId, setNewChatModelId] = useState("");
  const [tabState, setTabState] = useState<TabsState>(() =>
    loadTabs(loadJson<unknown>(TABS_KEY, loadJson<unknown>("noir.tabs.v2", loadJson<unknown>("noir.tabs", null)))),
  );
  const [documents, setDocuments] = useState<Record<string, DocumentState>>({});
  const [gitStatus, setGitStatus] = useState<{ workspaceId: string; status: GitStatusResult } | undefined>(
    undefined,
  );
  const [failedReads, setFailedReads] = useState<Record<string, string>>({});
  const [listMode, setListMode] = useState<ListMode>("chats");
  const [quickOpen, setQuickOpen] = useState<QuickOpenMode | undefined>(undefined);
  const [read, setRead] = useState<ReadState>(() => loadJson<ReadState>(READ_KEY, {}));
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [query, setQuery] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [sessionTotal, setSessionTotal] = useState(0);
  const nextCursor = useRef<string | null>(null);
  /** The state the request is built from; a ref so a keystroke does not rebuild every callback. */
  const listQuery = useRef({ filter, query, workspaceId: "" });
  const sessionsRef = useRef(sessions);
  const [error, setError] = useState<string | undefined>(undefined);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [armed, setArmed] = useState(0);
  const [skillCount, setSkillCount] = useState<number | undefined>(undefined);
  // One live roster for the shell: the nav badge and the sidebar office read the same snapshot.
  const { roster } = useRoster(request, { subscribe: true, initial: true });
  // The Office header's Configure button and the `C` command both focus the inspector it names.
  const agentConfigRef = useRef<HTMLElement | null>(null);

  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.active);
  // Opening a file leaves the chat subscription alone: the last chat that was actually active stays
  // the one subscribed (and the only one whose read watermark moves), instead of falling back to
  // whichever chat tab happens to be last.
  const lastChatId = useRef<string | undefined>(
    tabState.tabs.filter((tab) => tab.kind === "chat").at(-1)?.sessionId,
  );
  const activeTabChatId = activeTab?.kind === "chat" ? activeTab.sessionId : undefined;
  useEffect(() => {
    if (activeTabChatId !== undefined) lastChatId.current = activeTabChatId;
  }, [activeTabChatId]);
  const activeChatId = activeTabChatId ?? lastChatId.current;
  // Subscribe only once the socket is up: a restored tab mounts before `loadAll` connects, and a
  // subscribe request on a cold socket fails without retrying.
  const events = useSessionEvents(status === "kernel ok" ? (activeChatId ?? "") : "", request);
  const refreshTimer = useRef<number | undefined>(undefined);
  // Whether the debounced refresh still owes a git scan: session updates alone only need the list.
  const pendingFileChange = useRef(false);
  // `git.status` scans the whole workspace; a burst of edits can overlap. Only the newest run may
  // publish, so an older scan can never overwrite a newer one.
  const gitSeq = useRef(0);
  // Reads carry the generation they started in; only a workspace change or an explicit reload bumps
  // it, so a late read can never overwrite a document that belongs to another workspace (or to the
  // disk after a reload). Writes only compare their workspace, so a status flap cannot throw away a
  // save that already reached the disk.
  const readGeneration = useRef(0);
  // The workspace whose open documents have already been requested; a reconnect must not re-read
  // (and thereby drop) live drafts.
  const syncedWorkspace = useRef<string | undefined>(undefined);
  const tabsRef = useRef<readonly Tab[]>(tabState.tabs);
  const documentsRef = useRef(documents);
  const workspaceRef = useRef(workspaceId);
  // Pruning must wait for the first real session list: before it arrives every chat tab looks dead.
  const sessionsLoaded = useRef(false);
  const appliedQuery = useRef<string | null>(null);

  useEffect(() => {
    listQuery.current = { filter, query, workspaceId };
  }, [filter, query, workspaceId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    tabsRef.current = tabState.tabs;
  }, [tabState]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    workspaceRef.current = workspaceId;
  }, [workspaceId]);

  useEffect(() => {
    storeJson(TABS_KEY, tabState);
  }, [tabState]);

  // Editor/diff/preview tabs are paths inside one workspace. Once the workspace is known, pin them to it:
  // adopt it when the stored set predates the field, drop editor/diff/preview tabs when the stored set was
  // saved under a different one (chat tabs survive a workspace switch).
  useEffect(() => {
    if (workspaceId === "") return;
    setTabState((current) => scopeTabs(current, workspaceId));
  }, [workspaceId]);

  // A session that was removed (or a restored tab for a session that no longer exists) would render
  // an "Untitled chat" tab whose main pane can never fill in.
  useEffect(() => {
    // Only a complete, unfiltered list can prove a tab's session is gone; a page cannot.
    if (!sessionsLoaded.current || hasMore || filter !== "all" || query.trim() !== "") return;
    const ids = new Set(sessions.map((session) => session.id));
    setTabState((current) => pruneChatTabs(current, ids));
  }, [sessions, hasMore, filter, query]);

  // Never leave the subscription on a chat tab that pruning just removed.
  useEffect(() => {
    if (lastChatId.current === undefined) return;
    if (tabState.tabs.some((tab) => tab.kind === "chat" && tab.sessionId === lastChatId.current)) return;
    lastChatId.current = tabState.tabs.filter((tab) => tab.kind === "chat").at(-1)?.sessionId;
  }, [tabState]);

  // Git status belongs to one workspace; an answer that arrives after a switch describes the wrong
  // tree, so both success and failure check the workspace they were asked for. A newer run also
  // invalidates every older one, so overlapping scans cannot land out of order.
  const refreshGit = useCallback(async (): Promise<void> => {
    const run = ++gitSeq.current;
    if (workspaceId === "") {
      setGitStatus(undefined);
      return;
    }
    const asked = workspaceId;
    try {
      const status = await request<GitStatusResult>("git.status", { workspaceId });
      if (gitSeq.current !== run || workspaceRef.current !== asked) return;
      setGitStatus({ workspaceId: asked, status });
    } catch {
      if (gitSeq.current !== run || workspaceRef.current !== asked) return;
      // A workspace that is not a repo (or an unavailable `git`) keeps working without stats.
      setGitStatus(undefined);
    }
  }, [request, workspaceId]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  // The window owns two facts the tray cannot see: which build its daemon is, and how many
  // automations are armed. Neither affects rendering except through the banner.
  useEffect(() => {
    void kernelInfo().then(setKernel).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (workspaceId === "") return;
    let cancelled = false;
    // The same call and the same parse the Automations pane makes, so the tray, the nav badge and
    // the pane cannot disagree about what is armed.
    const report = async (): Promise<void> => {
      const listed = await request<unknown>("schedule.list", { workspaceId }).catch(() => undefined);
      if (cancelled || listed === undefined) return;
      const parsed = ScheduleListResult.safeParse(listed);
      if (!parsed.success) return;
      const enabled = parsed.data.schedules.filter((entry) => entry.enabled).length;
      setArmed(enabled);
      reportArmed(enabled);
    };
    void report();
    const timer = setInterval(() => void report(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [request, workspaceId]);

  // The nav badge asks the kernel for a count the shell does not otherwise load. A kernel without
  // the method (or no workspace yet) leaves the badge off rather than failing the shell.
  useEffect(() => {
    if (status !== "kernel ok") return;
    let cancelled = false;
    void request<SkillListResult>("skill.list", workspaceId === "" ? {} : { workspaceId })
      .then((result) => {
        if (!cancelled) setSkillCount(result.skills.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request, status, workspaceId]);

  /**
   * The list is a page, not a table read: the window asks for what it renders, and the kernel
   * answers the filter. `unread` stays in the window because only it knows what each tab has shown.
   */
  const loadSessions = useCallback(async (append = false): Promise<SessionView[]> => {
    const cursor = append ? (nextCursor.current ?? undefined) : undefined;
    const result = await request<SessionListResult>(
      "session.list",
      sessionListQuery({ filter: listQuery.current.filter, query: listQuery.current.query, workspaceId: listQuery.current.workspaceId, ...(cursor === undefined ? {} : { cursor }) }),
    );
    sessionsLoaded.current = true;
    nextCursor.current = result.nextCursor;
    setHasMore(result.nextCursor !== null);
    setSessionTotal(result.total);
    const next = append ? mergeSessions(sessionsRef.current, result.sessions) : result.sessions;
    setSessions(next);
    return next;
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    try {
      await connect();
      const health = SystemHealthResult.parse(await request("system.health"));
      setStatus("kernel ok");
      setEngineDir(health.engineDir);
      const [projectResult, workspaceResult, modelResult, sessionList] = await Promise.all([
        request<{ projects: ProjectView[] }>("project.list"),
        request<{ workspaces: WorkspaceView[] }>("workspace.list"),
        request<ModelListResult>("model.list"),
        request<SessionListResult>("session.list", sessionListQuery({ filter: "all", query: "", workspaceId: "" })),
      ]);
      setProjects(projectResult.projects);
      setWorkspaces(workspaceResult.workspaces);
      setModels(modelResult.models);
      sessionsLoaded.current = true;
      nextCursor.current = sessionList.nextCursor;
      setHasMore(sessionList.nextCursor !== null);
      setSessionTotal(sessionList.total);
      setSessions(sessionList.sessions);
      setNewChatModelId((current) => (current !== "" ? current : (modelResult.models[0]?.id ?? "")));
      setWorkspaceId((current) => current !== "" ? current : (workspaceResult.workspaces[0]?.id ?? ""));
      setView((current) =>
        current === "setup" && modelResult.models.length > 0 ? "chats" : current,
      );
      setError(undefined);
    } catch (loadError) {
      setStatus("kernel error");
      const message = loadError instanceof Error ? loadError.message : "Kernel unavailable";
      // In a browser the socket is refused for exactly one reason: this device is not paired.
      setError(isBrowser() && CONNECTION_FAILURE.test(message) ? NOT_PAIRED : message);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Typing narrows the kernel's answer, so it is not free: one request per pause, not per key.
  useEffect(() => {
    const key = JSON.stringify({ filter, query, workspaceId });
    if (appliedQuery.current === key) return;
    const first = appliedQuery.current === null;
    appliedQuery.current = key;
    // `loadAll` already asked for the first list; asking again would race it.
    if (first) return;
    const timer = setTimeout(() => {
      void loadSessions().catch(() => undefined);
    }, 200);
    return () => clearTimeout(timer);
  }, [filter, query, workspaceId, loadSessions]);

  useEffect(() => {
    const listener = (event: AgentEvent): void => {
      // Session titles, statuses and badges refresh after every event; only a scan of the whole
      // workspace waits for one that can actually change files on disk.
      if (FILE_EVENTS[event.type] === true) pendingFileChange.current = true;
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        const filesChanged = pendingFileChange.current;
        pendingFileChange.current = false;
        void loadSessions().catch(() => undefined);
        if (filesChanged) void refreshGit();
      }, 250);
    };
    void connect(listener).catch(() => undefined);
    return () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      // The ref must not stay set across effect re-runs (workspace change): a stale timer id would
      // suppress every later event's refresh for the rest of the session.
      refreshTimer.current = undefined;
      pendingFileChange.current = false;
      offEvent(listener);
    };
  }, [loadSessions, refreshGit]);

  // Keep the read watermark on the active chat so "Unread" means "not opened since it changed".
  // Only a chat tab advances it: an editor tab keeps the subscription alive but must not mark the
  // remembered chat as read behind the user's back.
  useEffect(() => {
    if (activeTab?.kind !== "chat" || activeChatId === undefined) return;
    const session = sessions.find((candidate) => candidate.id === activeChatId);
    if (session === undefined) return;
    setRead((current) => (current[activeChatId] === session.lastEventSeq ? current : { ...current, [activeChatId]: session.lastEventSeq }));
  }, [activeTab, activeChatId, sessions]);

  useEffect(() => {
    storeJson(READ_KEY, read);
  }, [read]);

  const applyDocument = useCallback((path: string, file: { content: string; mtimeMs: number }): void => {
    setDocuments((current) => ({ ...current, [path]: { text: file.content, draft: file.content, mtimeMs: file.mtimeMs } }));
    setFailedReads((current) => {
      if (current[path] === undefined) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  /** Reads one file; `undefined` means the read failed, was refused, or a reload superseded it. */
  const fetchDocument = useCallback(async (path: string): Promise<FsReadResult | undefined> => {
    const started = readGeneration.current;
    try {
      const file = await request<FsReadResult>("fs.read", { workspaceId, path });
      if (started !== readGeneration.current) return undefined;
      // A capped read is a prefix of the file. Opening it as a document would let the next save
      // write that prefix back over the real file, so refuse it before any buffer exists.
      if (file.truncated) {
        const message = `${path} is larger than 2 MiB; not opened for editing`;
        setError(message);
        setFailedReads((current) => ({ ...current, [path]: message }));
        return undefined;
      }
      return file;
    } catch (cause) {
      if (started !== readGeneration.current) return undefined;
      const message = cause instanceof Error ? cause.message : `Could not read ${path}`;
      setError(message);
      setFailedReads((current) => ({ ...current, [path]: message }));
      return undefined;
    }
  }, [request, workspaceId]);

  // Paths are workspace-relative, so every document belongs to exactly one workspace: a switch (or
  // deselecting the workspace) drops the whole record before anything can render or save the old text.
  useEffect(() => {
    readGeneration.current += 1;
    syncedWorkspace.current = undefined;
    const dropped = Object.entries(documentsRef.current)
      .filter(([, document]) => document.draft !== document.text)
      .map(([path]) => path);
    setDocuments((current) => (Object.keys(current).length === 0 ? current : {}));
    setFailedReads((current) => (Object.keys(current).length === 0 ? current : {}));
    // Stats describe the previous tree; never render them against the new workspace's files.
    setGitStatus(undefined);
    if (dropped.length > 0) setError(`Unsaved changes discarded for ${dropped.join(", ")}`);
  }, [workspaceId]);

  // Read the editor documents of the selected workspace once the kernel is up, and re-read them after
  // a switch. A reconnect must not re-read: that would silently replace live drafts with disk content.
  useEffect(() => {
    if (workspaceId === "" || status !== "kernel ok" || syncedWorkspace.current === workspaceId) return;
    // Only tabs already scoped to this workspace may be read. Anything else (another workspace, or a
    // legacy blob with no owner) is dropped by the scoping effect, so reading its paths here would
    // bind this workspace's document map to files that belong elsewhere.
    if (tabState.workspaceId !== workspaceId) {
      syncedWorkspace.current = workspaceId;
      return;
    }
    syncedWorkspace.current = workspaceId;
    const started = readGeneration.current;
    const paths = tabsRef.current.flatMap((tab) => (tab.kind === "editor" ? [tab.path] : []));
    for (const path of paths) {
      void fetchDocument(path).then((file) => {
        if (file === undefined || started !== readGeneration.current) return;
        // A tab closed (or scoped away) while the read was in flight must not leave a stray buffer.
        if (!tabsRef.current.some((tab) => tab.kind === "editor" && tab.path === path)) return;
        applyDocument(path, file);
      });
    }
  }, [applyDocument, fetchDocument, status, tabState.workspaceId, workspaceId]);

  const workspaceSessions = sessions.filter((session) => workspaceId === "" || session.workspaceId === workspaceId);
  const activeSession = activeTab?.kind === "chat" ? sessions.find((session) => session.id === activeTab.sessionId) : undefined;
  const running = workspaceSessions.filter((session) => session.status === "running" || session.status === "starting").length;
  const pendingApprovals = workspaceSessions.filter((session) => session.pendingApproval).length;

  const unread = countUnread(workspaceSessions, read);
  // The nav's one status line: a kernel fault outranks a queue of approvals, which outranks work.
  const navTone = status !== "kernel ok" ? "danger" : pendingApprovals > 0 ? "warn" : "ok";
  const navState =
    status !== "kernel ok"
      ? status
      : pendingApprovals > 0
        ? `${String(pendingApprovals)} need you`
        : running > 0
          ? `${String(running)} running`
          : "Nominal";

  // Branch and totals describe the workspace they were scanned in. A chat tab can outlive a
  // workspace switch, so the chat header and the inspector only use a snapshot that matches the
  // active session's workspace; otherwise the event-reported files stand alone.
  const workspaceGitStatus = gitStatus !== undefined && gitStatus.workspaceId === workspaceId ? gitStatus.status : undefined;
  const activeGitStatus =
    gitStatus !== undefined && activeSession !== undefined && gitStatus.workspaceId === activeSession.workspaceId
      ? gitStatus.status
      : undefined;
  const branch = workspaceGitStatus?.branch ?? null;

  const diffStats: DiffStats | undefined =
    activeGitStatus === undefined || activeGitStatus.files.length === 0
      ? undefined
      : activeGitStatus.files.reduce<DiffStats>(
          (total, file) => ({ add: total.add + file.add, del: total.del + file.del }),
          { add: 0, del: 0 },
        );

  // Git is the source of truth for what changed; event files fill in anything git cannot see (a
  // deleted tracked file is in both, so git's counts win per path).
  const inspectorFiles = (() => {
    const byPath = new Map<string, ChatFile>(events.state.files.map((file) => [file.path, file]));
    for (const file of activeGitStatus?.isRepo === true ? activeGitStatus.files : []) byPath.set(file.path, file);
    return [...byPath.values()];
  })();

  // `noUncheckedIndexedAccess` does not narrow a repeated `documents[path]` read; resolve it once.
  const editorPath = activeTab?.kind === "editor" ? activeTab.path : undefined;
  const editorDocument = editorPath === undefined ? undefined : documents[editorPath];
  const editorFailure = editorPath === undefined ? undefined : failedReads[editorPath];

  const dirty = (path: string): boolean => {
    const document = documents[path];
    return document !== undefined && document.draft !== document.text;
  };

  const openPreview = useCallback((path: string): void => {
    setTabState((current) => openTab(current, previewTab(path)));
    // The artifact body mounts only in the chats view; setup and skills can still reach the
    // palette, so a preview must not open invisibly there. With no model configured the chats
    // view only renders the setup page, so leaving skills would hide the artifact and the view.
    setView((current) => (models.length === 0 && current === "skills" ? current : "chats"));
  }, [models.length]);

  const openFile = useCallback(async (path: string): Promise<void> => {
    setTabState((current) => openTab(current, editorTab(path)));
    if (workspaceId === "" || documents[path] !== undefined) return;
    const started = readGeneration.current;
    const file = await fetchDocument(path);
    // Ignore a response whose workspace and tab are no longer the state this read started from.
    if (file === undefined || started !== readGeneration.current) return;
    if (!tabsRef.current.some((tab) => tab.kind === "editor" && tab.path === path)) return;
    applyDocument(path, file);
  }, [applyDocument, documents, fetchDocument, workspaceId]);

  const saveActive = useCallback(async (): Promise<void> => {
    const tab = tabState.tabs.find((candidate) => candidate.id === tabState.active);
    if (tab?.kind !== "editor" || workspaceId === "") return;
    const document = documents[tab.path];
    if (document === undefined || document.draft === document.text) return;
    const savedWorkspace = workspaceId;
    try {
      const saved = await request<{ mtimeMs: number }>("fs.write", {
        workspaceId,
        path: tab.path,
        content: document.draft,
        expectedMtimeMs: document.mtimeMs,
      });
      // A status flap is not a reason to throw a save away; a workspace switch is.
      if (workspaceRef.current !== savedWorkspace) return;
      setDocuments((current) => {
        const latest = current[tab.path];
        // Keep a draft typed while the write was in flight; only the disk copy moved.
        return latest === undefined
          ? current
          : { ...current, [tab.path]: { text: document.draft, draft: latest.draft, mtimeMs: saved.mtimeMs } };
      });
      setError(undefined);
      void refreshGit();
    } catch (cause) {
      if (workspaceRef.current !== savedWorkspace) return;
      setError(cause instanceof Error ? cause.message : `Could not save ${tab.path}`);
    }
  }, [documents, request, tabState, workspaceId, refreshGit]);

  // Re-read the active file after a save conflict (or any change made outside the editor). Unsaved
  // edits are dropped, which is what the command label says.
  const reloadActive = useCallback(async (): Promise<void> => {
    const tab = tabState.tabs.find((candidate) => candidate.id === tabState.active);
    if (tab?.kind !== "editor" || workspaceId === "") return;
    readGeneration.current += 1;
    const started = readGeneration.current;
    const file = await fetchDocument(tab.path);
    if (started !== readGeneration.current) return;
    if (file === undefined) {
      // Show the failure instead of a stale buffer that would be saved back over the new file.
      setDocuments((current) => {
        if (current[tab.path] === undefined) return current;
        const next = { ...current };
        delete next[tab.path];
        return next;
      });
      return;
    }
    applyDocument(tab.path, file);
    setError(undefined);
  }, [applyDocument, fetchDocument, tabState, workspaceId]);

  function openSession(session: Pick<SessionView, "id">): void {
    setTabState((current) => openTab(current, chatTab(session.id)));
  }

  /**
   * A character in the office and a name in the sidebar list both mean "this agent". An agent with
   * no open session has no chat to show, so it lands on the Agents page where one can start.
   */
  function openAgent(agentId: string): void {
    const entry = roster?.find((candidate) => candidate.agentId === agentId);
    if (entry?.activeSessionId === null || entry?.activeSessionId === undefined) {
      setView("agents");
      return;
    }
    openSession({ id: entry.activeSessionId });
  }

  function closeTabById(id: string): void {
    const tab = tabState.tabs.find((candidate) => candidate.id === id);
    // A dirty editor tab must not lose its edits to a stray ⌘W; saving or reloading comes first.
    if (tab?.kind === "editor" && dirty(tab.path)) {
      setError(`${tab.path} has unsaved changes — save with ⌘S before closing`);
      return;
    }
    if (tab?.kind === "editor") {
      // The buffer belongs to the workspace; a later open must read the file again, not resurrect it.
      setDocuments((current) => {
        if (current[tab.path] === undefined) return current;
        const next = { ...current };
        delete next[tab.path];
        return next;
      });
      setFailedReads((current) => {
        if (current[tab.path] === undefined) return current;
        const next = { ...current };
        delete next[tab.path];
        return next;
      });
    }
    setTabState((current) => closeTab(current, id));
  }

  async function addProject(path: string): Promise<void> {
    await request("project.add", { path });
    const result = await request<{ projects: ProjectView[] }>("project.list");
    setProjects(result.projects);
  }

  async function createWorkspace(projectId: string): Promise<void> {
    const created = await request<WorkspaceView & { id: string }>("workspace.create", { projectId });
    const result = await request<{ workspaces: WorkspaceView[] }>("workspace.list");
    setWorkspaces(result.workspaces);
    setWorkspaceId(created.id);
  }

  /**
   * Deleting a chat is the irreversible action; closing its tab only closed the view and left the
   * row in the list. The kernel closes a live session before removing it, so no engine survives.
   */
  async function deleteSession(session: SessionView): Promise<void> {
    setError(undefined);
    try {
      await request("session.delete", { sessionId: session.id });
      setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
      setRead((current) => {
        if (current[session.id] === undefined) return current;
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      // The tab renders rows the kernel no longer has, so it goes in the same commit as the row.
      closeTabById(chatTab(session.id).id);
      // The page under the deleted row refills from the filter the window is showing.
      void loadSessions().catch((refreshError: unknown) => {
        setError(refreshError instanceof Error ? refreshError.message : "Deleted, but the list did not refresh");
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete the chat");
    }
  }

  async function newChat(): Promise<void> {
    if (workspaceId === "") {
      setError("Add a workspace before creating a chat");
      return;
    }
    setError(undefined);
    try {
      const params: { workspaceId: string; modelId?: string } = { workspaceId };
      if (newChatModelId !== "") params.modelId = newChatModelId;
      const created = await request<SessionView>("session.create", params);
      await loadSessions();
      openSession(created);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the chat");
    }
  }

  /** The conversation so far becomes the parent; the fork continues from it and leaves it alone. */
  async function forkSession(sessionId: string): Promise<void> {
    setError(undefined);
    try {
      const result = await request<{ session: SessionView; copiedEvents: number }>("session.fork", { sessionId });
      await loadSessions();
      openSession(result.session);
    } catch (forkError) {
      setError(forkError instanceof Error ? forkError.message : "Could not fork the chat");
    }
  }

  // Named once: the nav, the palette and the `C` shortcut all reach the same view switch.
  const goTo = (target: View): void => {
    setView(target);
    // The chats view is the only one that lists sessions; landing on it re-reads the page it shows.
    if (target === "chats") void loadAll();
  };

  const nav = (
    <>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "chats"} onClick={() => goTo("chats")} title="Chats">
          Chats
        </button>
        {unread === 0 ? null : (
          <span className="nav-count" data-tone="warn" aria-hidden="true">
            {unread}
          </span>
        )}
        <span className="nav-count" aria-hidden="true">
          {sessionTotal}
        </span>
      </span>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "agents"} onClick={() => goTo("agents")} title="Agents">
          Agents
        </button>
        {roster === undefined ? null : (
          <span className="nav-count" aria-hidden="true">
            {roster.length}
          </span>
        )}
      </span>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "skills"} onClick={() => goTo("skills")} title="Skills">
          Skills
        </button>
        {skillCount === undefined ? null : (
          <span className="nav-count" aria-hidden="true">
            {skillCount}
          </span>
        )}
      </span>
      <span className="nav-item">
        <button
          type="button"
          aria-pressed={view === "automations"}
          onClick={() => goTo("automations")}
          title="Automations"
        >
          Automations
        </button>
        <span className="nav-count" aria-hidden="true">
          {armed}
        </span>
      </span>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "setup"} onClick={() => goTo("setup")} title="Setup">
          Setup
        </button>
      </span>
      <span className="nav-spacer" />
      <span className="nav-state" data-tone={navTone}>
        <span className="nav-dot" aria-hidden="true" />
        {navState}
      </span>
      <NavClock />
      <button type="button" className="nav-theme" onClick={toggleTheme} aria-label="Switch theme" title="Switch theme">
        ◐
      </button>
    </>
  );

  // The rail: what narrows the list on the left, and the projects the list belongs to. The new-chat
  // controls stay with the list they create into, so the e2e contract keeps one Sessions region.
  const rail = (
    <>
      <div className="rail-heading">Filters</div>
      <SessionFilters filter={filter} onFilterChange={setFilter} />
      <WorkspacePanel
        projects={projects}
        workspaces={workspaces}
        workspaceId={workspaceId}
        onSelectWorkspace={setWorkspaceId}
        onAddProject={addProject}
        onCreateWorkspace={createWorkspace}
      />
    </>
  );

  // The fourth column: the office, the agent behind the open chat, and the inspector when asked for.
  // It is never a drawer — the office is the point of the column.
  const sidebar = (
    <>
      <LiveSidebar
        roster={roster}
        agentId={activeSession?.agentId}
        activity={runningToolTitle(events.state)}
        showOffice={view !== "agents"}
        onOpenAgents={() => goTo("agents")}
        onOpenAgent={openAgent}
      />
      {inspectorOpen ? (
        <Inspector
          session={activeSession}
          status={events.state.status}
          usage={events.state.usage}
          turnStartedAt={events.state.turnStartedAt}
          lastTurn={events.state.lastTurn}
          files={inspectorFiles}
          plan={events.state.plan}
          approvalTitles={events.state.approval === undefined ? [] : [events.state.approval.title]}
          onShowDiff={(path) => setTabState((current) => openTab(current, diffTab(path)))}
          onPreview={openPreview}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}
    </>
  );

  const topbar = (
    <>
      <span className="brand">NoirHarness</span>
      <span className="topbar-workspace">
        {branch === null ? "" : `${branch} · `}
        {workspaceSessions.length === 0 ? "" : `${workspaceSessions.length} chat${workspaceSessions.length === 1 ? "" : "s"}`}
      </span>
      <button type="button" className="topbar-action" onClick={() => setPaletteOpen(true)} aria-label="Commands">
        ⌘K
      </button>
      {view === "chats" && models.length > 0 ? (
        <button
          type="button"
          className="topbar-action"
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen((current) => !current)}
        >
          Inspector
        </button>
      ) : null}
    </>
  );

  const statusbar = (
    <StatusBar status={status} running={running} pendingApprovals={pendingApprovals} engineDir={engineDir} />
  );

  const emptyMain = (
    <p className="empty">
      {workspaces.length === 0 ? "Add a workspace to start." : "Create a chat to start talking to the agent."}
    </p>
  );

  const commands: Command[] = [
    {
      id: "new-chat",
      label: "New chat",
      shortcut: { key: "n", mod: true },
      enabled: workspaceId !== "" && models.length > 0,
      run: () => void newChat(),
    },
    {
      id: "open-file",
      label: "Open file",
      keywords: "quick open goto",
      shortcut: { key: "p", mod: true },
      enabled: workspaceId !== "" && view === "chats",
      allowInInput: true,
      run: () => setQuickOpen("files"),
    },
    {
      id: "preview-file",
      label: "Preview file…",
      keywords: "artifact markdown csv pdf",
      // Runs from any view (it switches to chats), but the chats view is the only one that mounts
      // a tab body, and it does not exist before a model is configured.
      enabled: workspaceId !== "" && models.length > 0,
      allowInInput: true,
      run: () => setQuickOpen("preview"),
    },
    {
      id: "save-file",
      label: "Save file",
      keywords: "write disk",
      shortcut: { key: "s", mod: true },
      enabled: activeTab?.kind === "editor" && dirty(activeTab.path),
      allowInInput: true,
      run: () => void saveActive(),
    },
    {
      id: "reload-file",
      label:
        activeTab?.kind === "editor" && dirty(activeTab.path)
          ? "Reload file from disk (discards unsaved edits)"
          : "Reload file from disk",
      keywords: "reread revert conflict refresh",
      enabled: activeTab?.kind === "editor",
      run: () => void reloadActive(),
    },
    {
      id: "close-tab",
      label: "Close tab",
      keywords: "close tab",
      shortcut: { key: "w", mod: true },
      enabled: tabState.active !== undefined,
      allowInInput: true,
      run: () => {
        if (tabState.active !== undefined) closeTabById(tabState.active);
      },
    },
    {
      id: "toggle-inspector",
      label: "Toggle inspector",
      shortcut: { key: "b", mod: true },
      enabled: view === "chats" && models.length > 0,
      run: () => setInspectorOpen((current) => !current),
    },
    {
      id: "focus-composer",
      label: "Focus the composer",
      keywords: "prompt message input",
      shortcut: { key: "j", mod: true },
      enabled: activeTab?.kind === "chat",
      allowInInput: true,
      run: () => {
        const prompt = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
        prompt?.focus();
      },
    },
    {
      id: "configure-agent",
      label: "Configure the selected agent",
      keywords: "agent profile inspector permissions",
      // Spec §9.4: `C` focuses the inspector, and the typing guard keeps it out of the form fields.
      shortcut: { key: "c" },
      enabled: view === "agents",
      run: () => agentConfigRef.current?.focus(),
    },
    {
      id: "interrupt",
      label: "Interrupt the running turn",
      keywords: "stop cancel",
      shortcut: { key: ".", mod: true },
      enabled: activeChatId !== undefined && (events.state.status === "running" || events.state.status === "waiting"),
      allowInInput: true,
      run: () => {
        if (activeChatId === undefined) return;
        void request("session.interrupt", { sessionId: activeChatId }).catch((interruptError: unknown) => {
          setError(interruptError instanceof Error ? interruptError.message : "Could not interrupt the turn");
        });
      },
    },
    {
      id: "open-setup",
      label: "Open setup",
      keywords: "providers models settings",
      shortcut: { key: ",", mod: true },
      enabled: true,
      run: () => setView("setup"),
    },
    {
      id: "agents",
      label: "Open agents",
      keywords: "roster office dashboard profiles",
      shortcut: { key: "a", mod: true, shift: true },
      enabled: true,
      run: () => setView("agents"),
    },
    {
      id: "skills",
      label: "Open skills",
      keywords: "skills capabilities instructions",
      enabled: workspaceId !== "",
      run: () => setView("skills"),
    },
    {
      id: "automations",
      label: "Open automations",
      keywords: "schedules cron recurring nightly automation",
      enabled: workspaceId !== "",
      run: () => setView("automations"),
    },
    {
      id: "switch-theme",
      label: "Switch theme",
      keywords: "paper ink dark light",
      shortcut: { key: "t", mod: true, shift: true },
      enabled: true,
      run: () => toggleTheme(),
    },
    {
      id: "fork-session",
      label: "Fork this chat",
      keywords: "branch duplicate copy continue from here",
      enabled: activeChatId !== undefined,
      run: () => {
        if (activeChatId === undefined) return;
        void forkSession(activeChatId);
      },
    },
    {
      id: "copy-session-id",
      label: "Copy session id",
      keywords: "clipboard identifier",
      enabled: activeChatId !== undefined,
      run: () => {
        if (activeChatId === undefined) return;
        void navigator.clipboard?.writeText(activeChatId).catch(() => undefined);
      },
    },
    {
      id: "command-palette",
      label: "Show all commands",
      keywords: "palette",
      shortcut: { key: "k", mod: true },
      enabled: true,
      allowInInput: true,
      run: () => setPaletteOpen(true),
    },
  ];

  useShortcuts(commands);

  const palette = paletteOpen ? (
    <CommandPalette
      commands={commands}
      onRun={(command) => {
        setPaletteOpen(false);
        command.run();
      }}
      onClose={() => setPaletteOpen(false)}
    />
  ) : null;

  // An overlay, not part of any view: the palette's "Preview file…" is enabled wherever a
  // workspace is selected, so the file list must render on the setup page too.
  const quickOpenOverlay =
    quickOpen === undefined ? null : quickOpen === "preview" ? (
      <QuickOpen
        request={request}
        workspaceId={workspaceId}
        filter={(path) => previewKind(path) !== undefined}
        label="Preview file"
        onPick={(path) => {
          setQuickOpen(undefined);
          openPreview(path);
        }}
        onClose={() => setQuickOpen(undefined)}
      />
    ) : (
      <QuickOpen
        request={request}
        workspaceId={workspaceId}
        onPick={(path) => {
          setQuickOpen(undefined);
          void openFile(path);
        }}
        onClose={() => setQuickOpen(undefined)}
      />
    );

  const listModeSwitch = (
    <div className="list-mode" role="group" aria-label="List pane">
      <button type="button" aria-pressed={listMode === "chats"} onClick={() => setListMode("chats")}>
        Chat list
      </button>
      <button type="button" aria-pressed={listMode === "files"} onClick={() => setListMode("files")}>
        File list
      </button>
    </div>
  );

  // Agents may exist with `modelRef: null`, and the profile is configurable before any model is
  // added, so only chats depend on a configured model.
  if (
    view === "setup" ||
    (models.length === 0 && view !== "skills" && view !== "agents" && view !== "automations")
  ) {
    return (
      <>
        {kernel === undefined ? null : <KernelBanner daemon={kernel.daemon} buildMatches={kernel.buildMatches} />}
        <Shell
          nav={nav}
          topbar={topbar}
          rail={rail}
          list={
            models.length === 0 ? (
              <p className="empty">Add a provider and a model to unlock chats.</p>
            ) : (
              <p className="empty">Pick a chat from the list, or create one.</p>
            )
          }
          main={
            status === "kernel ok" ? (
              <Setup request={request} onOpenChat={() => goTo("chats")} />
            ) : (
              <p className="empty">{error ?? "Connecting to the kernel…"}</p>
            )
          }
          sidebar={sidebar}
          status={statusbar}
        />
        {quickOpenOverlay}
        {palette}
      </>
    );
  }

  return (
    <>
      {kernel === undefined ? null : <KernelBanner daemon={kernel.daemon} buildMatches={kernel.buildMatches} />}
      <Shell
        nav={nav}
        topbar={topbar}
        rail={rail}
        list={
          <>
            {listModeSwitch}
            {listMode === "files" ? (
              <FileTree
                request={request}
                workspaceId={workspaceId}
                activePath={activeTab?.kind === "editor" ? activeTab.path : undefined}
                onOpenFile={(path) => void openFile(path)}
                onPreviewFile={openPreview}
              />
            ) : (
              <section aria-label="Sessions" className="sessions-region">
                <div className="new-chat-row">
                  <label>
                    New chat model
                    <select
                      aria-label="New chat model"
                      value={newChatModelId}
                      onChange={(event) => setNewChatModelId(event.target.value)}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <SessionList
                  sessions={workspaceSessions}
                  models={models}
                  activeId={activeTab?.kind === "chat" ? activeTab.sessionId : undefined}
                  read={read}
                  filter={filter}
                  query={query}
                  onQueryChange={setQuery}
                  onSelect={openSession}
                  onDelete={(session) => void deleteSession(session)}
                  onNewChat={() => void newChat()}
                  canCreate={workspaceId !== "" && models.length > 0}
                  hasMore={hasMore}
                  total={sessionTotal}
                  onLoadMore={() => void loadSessions(true).catch(() => undefined)}
                />
              </section>
            )}
          </>
        }
        main={
          view === "skills" ? (
            <>
              {error === undefined ? null : <p role="alert">{error}</p>}
              <Skills key={workspaceId} workspaceId={workspaceId} request={request} />
            </>
          ) : view === "automations" ? (
            <>
              {error === undefined ? null : <p role="alert">{error}</p>}
              <Automations
                key={workspaceId}
                workspaceId={workspaceId}
                request={request}
                onOpenSession={(sessionId) => {
                  openSession({ id: sessionId });
                  // The chat lives in the chats view, and its row must be known before the tab loads.
                  setView("chats");
                  void loadSessions().catch(() => undefined);
                }}
              />
            </>
          ) : view === "agents" ? (
            <>
              {error === undefined ? null : <p role="alert">{error}</p>}
              <Agents
                key={workspaceId}
                workspaceId={workspaceId}
                request={request}
                configRef={agentConfigRef}
                onOpenChat={(session) => {
                  openSession(session);
                  // A started session is only visible in the chats view; the session list must know
                  // it before the tab body can resolve the row.
                  setView("chats");
                  void loadSessions().catch(() => undefined);
                }}
              />
            </>
          ) : (
            <>
              {error === undefined ? null : <p role="alert">{error}</p>}
              <TabStrip
                tabs={tabState.tabs}
                activeId={tabState.active}
                onSelect={(id) => setTabState((current) => activateTab(current, id))}
                onClose={closeTabById}
                titles={Object.fromEntries(sessions.map((session) => [session.id, session.title]))}
                dirty={dirty}
              />
              {activeTab === undefined ? (
                emptyMain
              ) : activeTab.kind === "chat" ? (
                activeSession === undefined ? (
                  emptyMain
                ) : (
                  <Chat
                    key={activeSession.id}
                    session={activeSession}
                    models={models}
                    request={request}
                    events={events}
                    diffStats={diffStats}
                    onSessionChange={() => void loadSessions().catch(() => undefined)}
                    onPreview={openPreview}
                  />
                )
              ) : activeTab.kind === "editor" ? (
                <section aria-label="Editor" className="editor-pane">
                  {editorDocument === undefined ? (
                    editorFailure === undefined ? (
                      <p className="empty">
                        {workspaceId === "" ? "Select a workspace to read this file." : `Loading ${activeTab.path}…`}
                      </p>
                    ) : (
                      <p role="status">
                        Could not open {activeTab.path}: {editorFailure}
                      </p>
                    )
                  ) : (
                    <MonacoEditor
                      path={activeTab.path}
                      value={editorDocument.draft}
                      theme={theme}
                      onChange={(draft) =>
                        setDocuments((current) => {
                          const document = current[activeTab.path];
                          return document === undefined ? current : { ...current, [activeTab.path]: { ...document, draft } };
                        })
                      }
                    />
                  )}
                </section>
              ) : activeTab.kind === "diff" ? (
                <DiffView request={request} workspaceId={workspaceId} path={activeTab.path} />
              ) : (
                <ArtifactPreview
                  key={activeTab.path}
                  workspaceId={workspaceId}
                  path={activeTab.path}
                  request={request}
                  onOpenPath={(path) => {
                    // A markdown anchor is not part of the file name: `other.md#usage` is `other.md`.
                    const target = path.split("#")[0] ?? path;
                    if (previewKind(target) !== undefined) openPreview(target);
                    else void openFile(target);
                  }}
                />
              )}
            </>
          )
        }
        sidebar={sidebar}
        status={statusbar}
      />
      {quickOpenOverlay}
      {palette}
    </>
  );
}
