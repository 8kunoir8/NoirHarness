import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentListResult,
  ModelListResult,
  ScheduleListResult,
  SESSION_STATUS_FACTS,
  SessionListResult,
  SessionView,
  SystemHealthResult,
  UpdateState,
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
import { ContextMenuProvider } from "./ContextMenu.js";
import { after, coalesce, every } from "./defer.js";
import { runningToolTitle, useSessionEvents, type ChatFile } from "./events.js";
import { FileTree } from "./FileTree.js";
import { Inspector } from "./Inspector.js";
import { KernelBanner } from "./KernelBanner.js";
import { MonacoEditor, type EditorSelection } from "./MonacoEditor.js";
import { Help } from "./Help.js";
import { UpdateRow, UpdateToast } from "./UpdateNotice.js";
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
import { Source } from "./Source.js";
import { StatusBar } from "./StatusBar.js";
import { TabStrip } from "./TabStrip.js";
import {
  activateTab,
  chatTab,
  closeTab,
  closeOthers,
  closeRightOf,
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
import { WindowControlsBar } from "./WindowControls.js";
import { WorkspacePanel, type ProjectView, type WorkspaceView } from "./WorkspacePanel.js";
import "./styles.css";

type View = "setup" | "chats" | "skills" | "agents" | "automations" | "source" | "help";

/** The two messages `api.ts` raises when there is no socket at all. */
const CONNECTION_FAILURE = /kernel connection (failed|closed)|kernel not connected/;
const NOT_PAIRED = "This device is not paired with the kernel. Ask the desktop app for a pairing link.";

type ListMode = "chats" | "files";

/** Which file overlay is open; `undefined` means none, so only one can render. */
type QuickOpenMode = "files" | "preview";
/**
 * The kernel stores the resolved absolute path, so a folder re-picked from the OS dialog matches
 * loosely: the separator style always differs, and a Windows drive letter is case-insensitive.
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  return /^[a-z]:\//i.test(a) && /^[a-z]:\//i.test(b) && a.toLowerCase() === b.toLowerCase();
}

/** One open editor document: the text last read from (or written to) disk, and the editable draft. */
interface DocumentState {
  text: string;
  draft: string;
  mtimeMs: number;
}

const READ_KEY = "noir.read.sessions";

/** Which of the two left columns are open. A closed column is a preference, not a view. */
const COLUMNS_KEY = "noir.columns";

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
  /** The build the kernel reports; Help names it so a bug report can identify the bytes running. */
  const [version, setVersion] = useState("0.0.0");
  const [view, setView] = useState<View>("setup");
  const [theme, , toggleTheme] = useTheme();
  const [kernel, setKernel] = useState<KernelInfo | undefined>(undefined);

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [models, setModels] = useState<ModelListResult["models"]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [newChatModelId, setNewChatModelId] = useState("");
  // A chat that picks no agent still runs as one: the kernel resolves its default profile, and the
  // picker names it here so a second profile is never invented by accident.
  const [agents, setAgents] = useState<AgentListResult["agents"]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [newChatAgentId, setNewChatAgentId] = useState("");
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
  // Two preferences, not two views: a closed column unmounts its contents and leaves its toggle in
  // the nav, so bringing it back is one click.
  const [columns, setColumns] = useState<{ rail: boolean; list: boolean }>(() =>
    loadJson<{ rail: boolean; list: boolean }>(COLUMNS_KEY, { rail: true, list: true }),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The kernel's answer about newer tags; undefined until the one check this window makes lands. */
  const [update, setUpdate] = useState<UpdateState | undefined>(undefined);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** Text another surface (a message menu, an editor selection) drops into the next chat's composer. */
  const [quote, setQuote] = useState<string | undefined>(undefined);
  const [armed, setArmed] = useState(0);
  const [skillCount, setSkillCount] = useState<number | undefined>(undefined);
  // One live roster for the shell: the nav badge and the sidebar office read the same snapshot.
  const { roster } = useRoster(request, { subscribe: true, initial: true });
  // The Office header's Configure button and the `C` command both focus the inspector it names.
  const agentConfigRef = useRef<HTMLElement | null>(null);
  // An archived or deleted pick falls back to the default instead of making the next chat fail.
  const chatAgentId = agents.some((agent) => agent.id === newChatAgentId) ? newChatAgentId : defaultAgentId;
  /** The workspace whose files the tree lists; the reveal action needs its absolute root. */
  const workspaceRoot = workspaces.find((candidate) => candidate.id === workspaceId)?.path;
  const reveal =
    workspaceRoot === undefined || window.noir?.revealInFolder === undefined
      ? undefined
      : (path: string) => {
          void window.noir?.revealInFolder?.(workspaceRoot, path).catch(() => undefined);
        };
  // The last chat tab is where a quoted selection lands: opening one first would surprise more than
  // quoting into the conversation the person was already having.
  const quoteTarget = [...tabState.tabs].reverse().find((tab) => tab.kind === "chat");
  const addSelection =
    quoteTarget === undefined
      ? undefined
      : (selection: EditorSelection) => {
          setQuote(
            [`\`\`\`${selection.path}:${String(selection.from)}-${String(selection.to)}`, selection.text, "```"].join("\n"),
          );
          setTabState((current) => activateTab(current, quoteTarget.id));
        };
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
  // Whether the coalesced refresh still owes a git scan: session updates alone only need the list.
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

  useEffect(() => {
    storeJson(COLUMNS_KEY, columns);
  }, [columns]);

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
  }, [workspaceId]);

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
    const stop = every(15_000, () => void report());
    return () => {
      cancelled = true;
      stop();
    };
  }, [workspaceId]);

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
  }, [status, workspaceId]);

  // One check per window, after the kernel is healthy, so a slow remote never delays start-up. The
  // kernel owns the 24-hour cadence and what was dismissed, so two windows cannot disagree.
  useEffect(() => {
    if (status !== "kernel ok" || update !== undefined) return;
    let cancelled = false;
    void request<UpdateState>("update.check", { force: false })
      .then((state) => {
        if (!cancelled) setUpdate(UpdateState.parse(state));
      })
      // A check that cannot run (an older kernel, a blocked write) changes nothing on screen.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status, update]);

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
      setVersion(health.version);
      const [projectResult, workspaceResult, modelResult, sessionList, agentResult] = await Promise.all([
        request<{ projects: ProjectView[] }>("project.list"),
        request<{ workspaces: WorkspaceView[] }>("workspace.list"),
        request<ModelListResult>("model.list"),
        request<SessionListResult>("session.list", sessionListQuery({ filter: "all", query: "", workspaceId: "" })),
        request<AgentListResult>("agent.list", {}),
      ]);
      setProjects(projectResult.projects);
      setWorkspaces(workspaceResult.workspaces);
      setModels(modelResult.models);
      setAgents(agentResult.agents);
      setDefaultAgentId(agentResult.defaultAgentId);
      sessionsLoaded.current = true;
      nextCursor.current = sessionList.nextCursor;
      setHasMore(sessionList.nextCursor !== null);
      setSessionTotal(sessionList.total);
      setSessions(sessionList.sessions);
      setNewChatModelId((current) => (current !== "" ? current : (modelResult.models[0]?.id ?? "")));
      setNewChatAgentId((current) => (current !== "" ? current : agentResult.defaultAgentId));
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
    return after(200, () => void loadSessions().catch(() => undefined));
  }, [filter, query, workspaceId, loadSessions]);

  useEffect(() => {
    // A burst of events collapses into one refresh: the first starts the wait, the rest are
    // absorbed. A file change anywhere in the burst still earns the git scan.
    const refresh = coalesce(250, () => {
      const filesChanged = pendingFileChange.current;
      pendingFileChange.current = false;
      void loadSessions().catch(() => undefined);
      if (filesChanged) void refreshGit();
    });
    const listener = (event: AgentEvent): void => {
      // Session titles, statuses and badges refresh after every event; only a scan of the whole
      // workspace waits for one that can actually change files on disk.
      if (FILE_EVENTS[event.type] === true) pendingFileChange.current = true;
      refresh.schedule();
    };
    void connect(listener).catch(() => undefined);
    return () => {
      // The pending run belongs to this subscription: a workspace change must not let an old
      // workspace's refresh fire against the new one.
      refresh.cancel();
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
  }, [workspaceId]);

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
  // "Running" is the fact, not a status spelling: a turn is executing while the session is
  // `starting` or `running`. An approval wait is live and is counted separately, as the status bar
  // has always reported it — counting it here too would claim concurrency the app does not have.
  const running = workspaceSessions.filter((session) => SESSION_STATUS_FACTS[session.status].working).length;
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
  }, [documents, tabState, workspaceId, refreshGit]);

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

  async function addProject(path: string): Promise<ProjectView> {
    try {
      const added = await request<ProjectView>("project.add", { path });
      // The kernel lists newest first; prepending keeps this window in the same order.
      setProjects((current) => [added, ...current]);
      return added;
    } catch (addError) {
      // Another client may already have added this folder: it is still the folder the user chose,
      // so the list is refetched instead of failing the one action they asked for.
      const fresh = await request<{ projects: ProjectView[] }>("project.list");
      setProjects(fresh.projects);
      const known = fresh.projects.find((candidate) => samePath(candidate.rootPath, path));
      if (known === undefined) throw addError;
      return known;
    }
  }

  async function createWorkspace(projectId: string): Promise<void> {
    const created = await request<WorkspaceView>("workspace.create", { projectId });
    const result = await request<{ workspaces: WorkspaceView[] }>("workspace.list");
    setWorkspaces(result.workspaces);
    setWorkspaceId(created.id);
  }

  /** Adding a folder is one action: the project, its one workspace, and the selection it implies. */
  async function openProject(path: string): Promise<void> {
    const project = await addProject(path);
    const listed = await request<{ workspaces: WorkspaceView[] }>("workspace.list");
    setWorkspaces(listed.workspaces);
    const existing = listed.workspaces.find((workspace) => workspace.projectId === project.id);
    if (existing !== undefined) {
      setWorkspaceId(existing.id);
      return;
    }
    await createWorkspace(project.id);
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

  /**
   * The kernel answers with the session it just wrote, and the row takes that answer: the open
   * chat's header updates from its own `session.updated` event, so this only touches the list.
   */
  async function renameSession(session: SessionView, title: string): Promise<void> {
    setError(undefined);
    try {
      const updated = await request<SessionView>("session.rename", { sessionId: session.id, title });
      setSessions((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Could not rename the chat");
    }
  }

  async function newChat(): Promise<void> {
    if (workspaceId === "") {
      setError("Add a workspace before creating a chat");
      return;
    }
    setError(undefined);
    try {
      const params: { workspaceId: string; modelId?: string; agentId?: string } = { workspaceId };
      if (newChatModelId !== "") params.modelId = newChatModelId;
      if (chatAgentId !== "") params.agentId = chatAgentId;
      const created = await request<SessionView>("session.create", params);
      await loadSessions();
      openSession(created);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the chat");
    }
  }

  /** The conversation up to `upToSeq` becomes the parent; the fork continues from it and leaves it alone. */
  async function forkSession(sessionId: string, upToSeq?: number): Promise<void> {
    setError(undefined);
    try {
      const result = await request<{ session: SessionView; copiedEvents: number }>("session.fork", {
        sessionId,
        ...(upToSeq === undefined ? {} : { upToSeq }),
      });
      await loadSessions();
      openSession(result.session);
    } catch (forkError) {
      setError(forkError instanceof Error ? forkError.message : "Could not fork the chat");
    }
  }

  /** `force` re-reads the remote; an unforced call is answered from the kernel's 24-hour cache. */
  async function checkUpdates(force: boolean): Promise<void> {
    setCheckingUpdate(true);
    try {
      setUpdate(UpdateState.parse(await request<UpdateState>("update.check", { force })));
    } catch {
      // A check that cannot run changes nothing: Help keeps whatever it last showed.
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function dismissUpdate(release: string): Promise<void> {
    if (release === "") return;
    // The kernel records it, so the badge stays off in every window and across restarts.
    const next = update === undefined ? undefined : { ...update, dismissed: true };
    setUpdate(next);
    await request("update.dismiss", { version: release }).catch(() => undefined);
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
        <button
          type="button"
          aria-pressed={view === "source"}
          onClick={() => setView("source")}
          title="Source control"
        >
          Source
        </button>
        {workspaceGitStatus === undefined || workspaceGitStatus.files.length === 0 ? null : (
          <span className="nav-count" aria-hidden="true">
            {workspaceGitStatus.files.length}
          </span>
        )}
      </span>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "help"} onClick={() => goTo("help")} title="Help and shortcuts">
          Help
        </button>
        {update?.status === "available" && !update.dismissed ? (
          <span className="nav-count" data-tone="warn" aria-hidden="true">
            ●
          </span>
        ) : null}
      </span>
      <span className="nav-item">
        <button type="button" aria-pressed={view === "setup"} onClick={() => goTo("setup")} title="Setup">
          Setup
        </button>
      </span>
      <span className="nav-spacer" />
      {/* The two left columns are toggles, not views: `aria-pressed` reports whether each is open. */}
      <button
        type="button"
        className="nav-column"
        aria-pressed={columns.rail}
        aria-label="Projects column"
        title={columns.rail ? "Hide the projects column" : "Show the projects column"}
        onClick={() => setColumns((current) => ({ ...current, rail: !current.rail }))}
      >
        ▤
      </button>
      <button
        type="button"
        className="nav-column"
        aria-pressed={columns.list}
        aria-label="Chats column"
        title={columns.list ? "Hide the chats column" : "Show the chats column"}
        onClick={() => setColumns((current) => ({ ...current, list: !current.list }))}
      >
        ☰
      </button>
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
        onOpenProject={openProject}
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
        {branch === null ? null : (
          // The branch is the page's subject, so it is the page's second door.
          <button type="button" className="topbar-branch" title="Open source control" onClick={() => setView("source")}>
            {branch}
          </button>
        )}
        {workspaceSessions.length === 0
          ? null
          : `${branch === null ? "" : " · "}${workspaceSessions.length} chat${workspaceSessions.length === 1 ? "" : "s"}`}
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
      <WindowControlsBar />
    </>
  );

  const statusbar = (
    <StatusBar status={status} running={running} pendingApprovals={pendingApprovals} engineDir={engineDir} />
  );
  // One notice per release, and never over a dialog: an approval or the palette owns the window
  // until it closes, so the notice waits rather than covering the thing the user must answer.
  const updateToast =
    update === undefined || paletteOpen || pendingApprovals > 0 ? null : (
      <UpdateToast state={update} onDismiss={(release) => void dismissUpdate(release)} />
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
      enabled: activeChatId !== undefined && SESSION_STATUS_FACTS[events.state.status].interruptible,
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
      id: "open-source",
      label: "Open source control",
      keywords: "git stage unstage commit changes diff",
      shortcut: { key: "g", mod: true, shift: true },
      enabled: workspaceId !== "",
      // Opening a page never types a character, so it has to work from inside a commit message.
      allowInInput: true,
      run: () => setView("source"),
    },
    {
      id: "open-help",
      label: "Open help",
      keywords: "keyboard shortcuts keys version about",
      shortcut: { key: "f1" },
      enabled: true,
      allowInInput: true,
      run: () => setView("help"),
    },
    {
      id: "toggle-projects-column",
      label: "Toggle the projects column",
      keywords: "rail sidebar hide show projects",
      shortcut: { key: "1", mod: true, shift: true },
      enabled: true,
      allowInInput: true,
      run: () => setColumns((current) => ({ ...current, rail: !current.rail })),
    },
    {
      id: "toggle-chats-column",
      label: "Toggle the chats column",
      keywords: "list sidebar hide show sessions files",
      shortcut: { key: "2", mod: true, shift: true },
      enabled: true,
      allowInInput: true,
      run: () => setColumns((current) => ({ ...current, list: !current.list })),
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

  // Agents may exist with `modelRef: null`, the profile is configurable before any model is added,
  // and source control, help and the office have nothing to do with a model, so only chats need one.
  if (
    view === "setup" ||
    (models.length === 0 &&
      view !== "skills" &&
      view !== "agents" &&
      view !== "automations" &&
      view !== "source" &&
      view !== "help")
  ) {
    // The same element type as the chats branch: a fragment here would remount the whole shell the
    // moment a model is added, dropping focus and any element a pointer was already over.
    return (
      <ContextMenuProvider commands={commands}>
        {kernel === undefined ? null : <KernelBanner daemon={kernel.daemon} buildMatches={kernel.buildMatches} />}
        <Shell
          nav={nav}
          topbar={topbar}
          rail={columns.rail ? rail : undefined}
          list={
            columns.list ? (
              models.length === 0 ? (
                <p className="empty">Add a provider and a model to unlock chats.</p>
              ) : (
                <p className="empty">Pick a chat from the list, or create one.</p>
              )
            ) : undefined
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
        {updateToast}
      </ContextMenuProvider>
    );
  }

  return (
    <ContextMenuProvider commands={commands}>
      {kernel === undefined ? null : <KernelBanner daemon={kernel.daemon} buildMatches={kernel.buildMatches} />}
      <Shell
        nav={nav}
        topbar={topbar}
        rail={columns.rail ? rail : undefined}
        list={columns.list ? (
          <>
            {listModeSwitch}
            {listMode === "files" ? (
              <FileTree
                request={request}
                workspaceId={workspaceId}
                activePath={activeTab?.kind === "editor" ? activeTab.path : undefined}
                onOpenFile={(path) => void openFile(path)}
                onPreviewFile={openPreview}
                onDiffFile={(path) => setTabState((current) => openTab(current, diffTab(path)))}
                {...(reveal === undefined ? {} : { onReveal: reveal })}
              />
            ) : (
              <section aria-label="Sessions" className="sessions-region">
                <div className="new-chat-row">
                  <label>
                    New chat agent
                    <select
                      aria-label="New chat agent"
                      value={chatAgentId}
                      onChange={(event) => setNewChatAgentId(event.target.value)}
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.id === defaultAgentId ? `${agent.name} (default)` : agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
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
                  onRename={(session, title) => void renameSession(session, title)}
                  onNewChat={() => void newChat()}
                  canCreate={workspaceId !== "" && models.length > 0}
                  hasMore={hasMore}
                  total={sessionTotal}
                  onLoadMore={() => void loadSessions(true).catch(() => undefined)}
                />
              </section>
            )}
          </>
        ) : undefined}
        main={
          view === "source" ? (
            <>
              {error === undefined ? null : <p role="alert">{error}</p>}
              <Source
                key={workspaceId}
                request={request}
                workspaceId={workspaceId}
                workspaceName={workspaces.find((candidate) => candidate.id === workspaceId)?.path ?? "No workspace"}
                onOpenDiff={(path) => {
                  // The diff is a tab, and tabs render in the chats view.
                  setTabState((current) => openTab(current, diffTab(path)));
                  setView("chats");
                }}
              />
            </>
          ) : view === "help" ? (
            <Help
              version={version}
              buildId={kernel?.buildId ?? undefined}
              commands={commands}
              update={
                update === undefined ? undefined : (
                  <UpdateRow
                    state={update}
                    checking={checkingUpdate}
                    onCheck={() => void checkUpdates(true)}
                    onDismiss={(release) => void dismissUpdate(release)}
                  />
                )
              }
            />
          ) : view === "skills" ? (
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
                onCloseOthers={(id) => setTabState((current) => closeOthers(current, id))}
                onCloseRight={(id) => setTabState((current) => closeRightOf(current, id))}
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
                    onFork={(upToSeq) => void forkSession(activeSession.id, upToSeq)}
                    quote={quote}
                    onQuoteApplied={() => setQuote(undefined)}
                    onOpenSource={() => setView("source")}
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
                      {...(addSelection === undefined ? {} : { onAddSelection: addSelection })}
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
      {updateToast}
    </ContextMenuProvider>
  );
}
