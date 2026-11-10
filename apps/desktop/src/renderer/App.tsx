import { useCallback, useEffect, useRef, useState } from "react";
import { ModelListResult, SessionView, SystemHealthResult } from "@noir/protocol";
import { connect, offEvent, request } from "./api.js";
import { Chat } from "./Chat.js";
import { useSessionEvents } from "./events.js";
import { Inspector } from "./Inspector.js";
import { SessionList, type ReadState, type SessionFilter } from "./SessionList.js";
import { Setup } from "./Setup.js";
import { Shell } from "./Shell.js";
import { StatusBar } from "./StatusBar.js";
import { Tabs } from "./Tabs.js";
import { useTheme } from "./theme.js";
import { WorkspacePanel, type ProjectView, type WorkspaceView } from "./WorkspacePanel.js";
import "./styles.css";

type View = "setup" | "chats";

const READ_KEY = "noir.read.sessions";
const TABS_KEY = "noir.tabs";

interface StoredTabs {
  open: string[];
  active?: string;
}

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
  const [, , toggleTheme] = useTheme();

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [models, setModels] = useState<ModelListResult["models"]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [newChatModelId, setNewChatModelId] = useState("");
  const [openIds, setOpenIds] = useState<string[]>(() => loadJson<StoredTabs>(TABS_KEY, { open: [] }).open);
  const [activeId, setActiveId] = useState<string | undefined>(() => loadJson<StoredTabs>(TABS_KEY, { open: [] }).active);
  const [read, setRead] = useState<ReadState>(() => loadJson<ReadState>(READ_KEY, {}));
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const events = useSessionEvents(activeId ?? "", request);
  const refreshTimer = useRef<number | undefined>(undefined);

  const loadSessions = useCallback(async (): Promise<SessionView[]> => {
    const result = await request<{ sessions: SessionView[] }>("session.list");
    setSessions(result.sessions);
    return result.sessions;
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
        request<{ sessions: SessionView[] }>("session.list"),
      ]);
      setProjects(projectResult.projects);
      setWorkspaces(workspaceResult.workspaces);
      setModels(modelResult.models);
      setSessions(sessionList.sessions);
      setNewChatModelId((current) => (current !== "" ? current : (modelResult.models[0]?.id ?? "")));
      setWorkspaceId((current) => current !== "" ? current : (workspaceResult.workspaces[0]?.id ?? ""));
      setView((current) => (current === "chats" || modelResult.models.length === 0 ? current : "chats"));
      setError(undefined);
    } catch (loadError) {
      setStatus("kernel error");
      setError(loadError instanceof Error ? loadError.message : "Kernel unavailable");
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const listener = (): void => {
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        void loadSessions().catch(() => undefined);
      }, 250);
    };
    void connect(listener).catch(() => undefined);
    return () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      offEvent(listener);
    };
  }, [loadSessions]);

  // Keep the read watermark on the active session so "Unread" means "not opened since it changed".
  useEffect(() => {
    if (activeId === undefined) return;
    const session = sessions.find((candidate) => candidate.id === activeId);
    if (session === undefined) return;
    setRead((current) => (current[activeId] === session.lastEventSeq ? current : { ...current, [activeId]: session.lastEventSeq }));
  }, [activeId, sessions]);

  useEffect(() => {
    storeJson(READ_KEY, read);
  }, [read]);

  useEffect(() => {
    const stored: StoredTabs = { open: openIds };
    if (activeId !== undefined) stored.active = activeId;
    storeJson(TABS_KEY, stored);
  }, [openIds, activeId]);

  // Drop tabs whose sessions no longer exist (a fresh database, or rows removed by hand).
  useEffect(() => {
    if (sessions.length === 0) return;
    const known = new Set(sessions.map((session) => session.id));
    setOpenIds((current) => {
      const kept = current.filter((id) => known.has(id));
      return kept.length === current.length ? current : kept;
    });
    setActiveId((current) => (current !== undefined && known.has(current) ? current : undefined));
  }, [sessions]);

  const workspaceSessions = sessions.filter((session) => workspaceId === "" || session.workspaceId === workspaceId);
  const activeSession = sessions.find((session) => session.id === activeId);
  const openSessions = openIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionView => session !== undefined);
  const running = workspaceSessions.filter((session) => session.status === "running" || session.status === "starting").length;
  const pendingApprovals = workspaceSessions.filter((session) => session.pendingApproval).length;

  function openSession(session: SessionView): void {
    setOpenIds((current) => (current.includes(session.id) ? current : [...current, session.id]));
    setActiveId(session.id);
  }

  function closeTab(sessionId: string): void {
    setOpenIds((current) => {
      const index = current.indexOf(sessionId);
      const next = current.filter((id) => id !== sessionId);
      if (sessionId === activeId) {
        const fallback = next[Math.min(index, Math.max(next.length - 1, 0))];
        setActiveId(fallback);
      }
      return next;
    });
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

  const rail = (
    <>
      <button
        type="button"
        aria-pressed={view === "chats"}
        onClick={() => {
          setView("chats");
          void loadAll();
        }}
        title="Chats"
      >
        Chats
      </button>
      <button type="button" aria-pressed={view === "setup"} onClick={() => setView("setup")} title="Setup">
        Setup
      </button>
      <span className="rail-spacer" />
      <button type="button" onClick={toggleTheme} aria-label="Switch theme" title="Switch theme">
        ◐
      </button>
    </>
  );

  const topbar = (
    <>
      <span className="brand">NoirHarness</span>
      <span className="topbar-workspace">{workspaceSessions.length === 0 ? "" : `${workspaceSessions.length} chat${workspaceSessions.length === 1 ? "" : "s"}`}</span>
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

  if (view === "setup" || models.length === 0) {
    return (
      <Shell
        rail={rail}
        topbar={topbar}
        list={
          models.length === 0 ? (
            <p className="empty">Add a provider and a model to unlock chats.</p>
          ) : (
            <WorkspacePanel
              projects={projects}
              workspaces={workspaces}
              workspaceId={workspaceId}
              onSelectWorkspace={setWorkspaceId}
              onAddProject={addProject}
              onCreateWorkspace={createWorkspace}
            />
          )
        }
        main={
          status === "kernel ok" ? (
            <Setup
              request={request}
              onOpenChat={() => {
                setView("chats");
                void loadAll();
              }}
            />
          ) : (
            <p className="empty">{error ?? "Connecting to the kernel…"}</p>
          )
        }
        status={statusbar}
      />
    );
  }

  return (
    <Shell
      rail={rail}
      topbar={topbar}
      list={
        <>
          <WorkspacePanel
            projects={projects}
            workspaces={workspaces}
            workspaceId={workspaceId}
            onSelectWorkspace={setWorkspaceId}
            onAddProject={addProject}
            onCreateWorkspace={createWorkspace}
          />
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
              activeId={activeId}
              read={read}
              filter={filter}
              onFilterChange={setFilter}
              query={query}
              onQueryChange={setQuery}
              onSelect={openSession}
              onNewChat={() => void newChat()}
              canCreate={workspaceId !== ""}
            />
          </section>
        </>
      }
      main={
        <>
          {error === undefined ? null : <p role="alert">{error}</p>}
          <Tabs sessions={openSessions} activeId={activeId} onSelect={setActiveId} onClose={closeTab} />
          {activeSession === undefined ? (
            <p className="empty">
              {workspaces.length === 0 ? "Add a workspace to start." : "Create a chat to start talking to the agent."}
            </p>
          ) : (
            <Chat
              key={activeSession.id}
              session={activeSession}
              models={models}
              request={request}
              events={events}
              onSessionChange={() => void loadSessions().catch(() => undefined)}
            />
          )}
        </>
      }
      {...(inspectorOpen
        ? {
            inspector: (
              <Inspector
                session={activeSession}
                status={events.state.status}
                usage={events.state.usage}
                turnStartedAt={events.state.turnStartedAt}
                lastTurn={events.state.lastTurn}
                files={events.state.files}
                plan={events.state.plan}
                approvalTitles={events.state.approval === undefined ? [] : [events.state.approval.title]}
                onClose={() => setInspectorOpen(false)}
              />
            ),
          }
        : {})}
      status={statusbar}
    />
  );
}
