import { useEffect, useState, type FormEvent } from "react";
import type { ModelView, SessionView } from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { Chat } from "./Chat.js";
import { errorMessage } from "./events.js";

interface WorkspaceView {
  id: string;
  projectId: string;
  path: string;
  branch: string | null;
  kind: string;
  status: string;
}

interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
}

interface SessionListResult { sessions: SessionView[] }
interface ModelListResult { models: ModelView[] }
interface ProjectListResult { projects: ProjectView[] }
interface WorkspaceListResult { workspaces: WorkspaceView[] }


export function Workspace({ request }: { request: RequestFn }) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [newChatModelId, setNewChatModelId] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  async function loadProjects(): Promise<void> {
    try {
      const result = await request<ProjectListResult>("project.list");
      setProjects(result.projects);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }

  async function loadWorkspaces(): Promise<void> {
    try {
      const result = await request<WorkspaceListResult>("workspace.list");
      setWorkspaces(result.workspaces);
      setSelectedWorkspaceId((current) => current !== "" ? current : (result.workspaces[0]?.id ?? ""));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }

  async function loadModels(): Promise<void> {
    try {
      const result = await request<ModelListResult>("model.list");
      setModels(result.models);
      setNewChatModelId((current) => current !== "" ? current : (result.models[0]?.id ?? ""));
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }


  async function loadSessions(): Promise<void> {
    try {
      const result = await request<SessionListResult>("session.list");
      setSessions(result.sessions);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }

  useEffect(() => {
    void Promise.all([loadProjects(), loadWorkspaces(), loadModels(), loadSessions()]);
  }, []);

  async function addProject(event: FormEvent): Promise<void> {
    event.preventDefault();
    const path = projectPath.trim();
    if (path === "") return;
    try {
      const created = await request<ProjectView>("project.add", { path });
      setProjectPath("");
      setError(undefined);
      await loadProjects();
      if (typeof created?.id === "string") setSelectedProjectId(created.id);
    } catch (addError) {
      setError(errorMessage(addError));
    }
  }

  async function createWorkspace(): Promise<void> {
    if (selectedProjectId === "") return;
    try {
      const created = await request<WorkspaceView>("workspace.create", { projectId: selectedProjectId });
      setError(undefined);
      await loadWorkspaces();
      if (typeof created?.id === "string") setSelectedWorkspaceId(created.id);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }

  async function newChat(): Promise<void> {
    if (selectedWorkspaceId === "") return;
    const params: { workspaceId: string; modelId?: string } = { workspaceId: selectedWorkspaceId };
    if (newChatModelId !== "") params.modelId = newChatModelId;
    try {
      const created = await request<SessionView>("session.create", params);
      setError(undefined);
      await loadSessions();
      if (typeof created?.id === "string") setSelectedSessionId(created.id);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId);

  return (
    <section className="workspace" aria-label="Workspace">
      <h2>Workspace</h2>
      {error === undefined ? null : <p role="alert">{error}</p>}

      <section aria-label="Projects">
        <h3>Projects</h3>
        <ul>
          {projects.map((project) => (
            <li key={project.id}><strong>{project.name}</strong> — {project.rootPath}</li>
          ))}
        </ul>
        <form onSubmit={(event) => void addProject(event)}>
          <label>Project path <input aria-label="Project path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} /></label>
          <button type="submit" disabled={projectPath.trim() === ""}>Add project</button>
        </form>
        <label>
          Project
          <select aria-label="Project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
            <option value="">Select a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void createWorkspace()} disabled={selectedProjectId === ""}>Create workspace</button>
        <label>
          Workspace
          <select aria-label="Workspace" value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
            <option value="">Select a workspace</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.path}</option>)}
          </select>
        </label>
      </section>

      {models.length === 0 ? (
        <p className="hint">No models yet — add a provider and a model on the Setup page first.</p>
      ) : null}

      <section aria-label="Sessions">
        <h3>Sessions</h3>
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <button type="button" onClick={() => setSelectedSessionId(session.id)}>
                {session.title === "" ? session.id : session.title}
              </button>
              <span>{session.status}</span>
            </li>
          ))}
        </ul>
        <label>
          New chat model
          <select aria-label="New chat model" value={newChatModelId} onChange={(event) => setNewChatModelId(event.target.value)}>
            <option value="">Default</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void newChat()} disabled={selectedWorkspaceId === ""}>New chat</button>
      </section>

      {selectedSession === undefined ? <p>Select a session to chat.</p> : <Chat key={selectedSession.id} session={selectedSession} models={models} request={request} />}
    </section>
  );
}
