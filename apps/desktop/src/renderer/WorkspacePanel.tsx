import { useState, type FormEvent } from "react";

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
}

export interface WorkspaceView {
  id: string;
  projectId: string;
  path: string;
  branch: string | null;
  kind: string;
  status: string;
}

export interface WorkspacePanelProps {
  projects: readonly ProjectView[];
  workspaces: readonly WorkspaceView[];
  workspaceId: string;
  onSelectWorkspace: (id: string) => void;
  onAddProject: (path: string) => Promise<void>;
  onCreateWorkspace: (projectId: string) => Promise<void>;
  busy?: boolean;
}

/**
 * Project and workspace management. Kept as one region so the shell list pane can host it above
 * the session list; the control names are part of the e2e contract.
 */
export function WorkspacePanel({
  projects,
  workspaces,
  workspaceId,
  onSelectWorkspace,
  onAddProject,
  onCreateWorkspace,
  busy = false,
}: WorkspacePanelProps) {
  const [projectPath, setProjectPath] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  // First run has no workspace; keep the setup controls reachable without an extra click.
  const [expanded, setExpanded] = useState(workspaces.length === 0);

  async function addProject(event: FormEvent): Promise<void> {
    event.preventDefault();
    const path = projectPath.trim();
    if (path === "") return;
    try {
      await onAddProject(path);
      setProjectPath("");
      setError(undefined);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Could not add the project");
    }
  }

  async function createWorkspace(): Promise<void> {
    if (projectId === "") return;
    try {
      await onCreateWorkspace(projectId);
      setError(undefined);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the workspace");
    }
  }

  return (
    <section aria-label="Projects" className="workspace-panel">
      <label>
        Workspace
        <select
          aria-label="Workspace"
          value={workspaceId}
          onChange={(event) => onSelectWorkspace(event.target.value)}
        >
          <option value="">Select a workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.path}
            </option>
          ))}
        </select>
      </label>

      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Add a workspace</summary>
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <strong>{project.name}</strong> — {project.rootPath}
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => void addProject(event)}>
          <label>
            Project path
            <input
              aria-label="Project path"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="E:\path\to\project"
            />
          </label>
          <button type="submit" disabled={projectPath.trim() === "" || busy}>
            Add project
          </button>
        </form>
        <label>
          Project
          <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void createWorkspace()} disabled={projectId === "" || busy}>
          Create workspace
        </button>
      </details>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}
