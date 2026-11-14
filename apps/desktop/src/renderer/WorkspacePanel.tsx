import { useState } from "react";

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
  /** Add a folder as a project, create its workspace, and select it — one action, as a picked folder implies. */
  onOpenProject: (path: string) => Promise<void>;
  /** The `+` on a project row whose workspace was never created. */
  onCreateWorkspace: (projectId: string) => Promise<void>;
  busy?: boolean;
}

/** The last segment of either separator style: the kernel stores absolute Windows paths. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Projects and their workspaces, as the rail's top block. A project owns exactly one workspace
 * because the kernel keys a workspace by its path, so the tree is two levels deep by construction.
 */
export function WorkspacePanel({
  projects,
  workspaces,
  workspaceId,
  onSelectWorkspace,
  onOpenProject,
  onCreateWorkspace,
  busy = false,
}: WorkspacePanelProps) {
  const [projectPath, setProjectPath] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  // First run has no project, and nothing else on this screen can fill that gap. The choice is
  // remembered only once the user makes one, so the loaded list still opens the form on an empty
  // install instead of a stale mount-time guess.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const adding = chosen ?? projects.length === 0;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // Absent in a browser: the shell there has no native dialog to open.
  const pickFolder = typeof window === "undefined" ? undefined : window.noir?.pickFolder;

  /**
   * One commit for both entry points. The OS picker *is* the choice, so picking a folder adds it
   * without a second confirmation; the typed form keeps a path a browser build can still submit.
   */
  async function addFolder(path: string): Promise<boolean> {
    const trimmed = path.trim();
    if (trimmed === "") return false;
    try {
      await onOpenProject(trimmed);
      setProjectPath("");
      setError(undefined);
      setChosen(false);
      return true;
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Could not add the project");
      return false;
    }
  }

  async function browse(): Promise<void> {
    if (pickFolder === undefined) return;
    try {
      const folder = await pickFolder();
      // A cancelled dialog leaves what the user typed alone.
      if (folder !== null) await addFolder(folder);
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : "Could not open the folder picker");
    }
  }

  async function createWorkspace(projectId: string): Promise<void> {
    try {
      await onCreateWorkspace(projectId);
      setError(undefined);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the workspace");
    }
  }

  function toggle(projectId: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  }

  return (
    <section aria-label="Projects" className="workspace-panel">
      <div className="panel-head">
        <h2 className="panel-title">Projects</h2>
        <button
          type="button"
          className="panel-action panel-icon-action"
          aria-label={adding ? "Cancel new project" : "New project"}
          aria-expanded={adding}
          title={adding ? "Cancel" : "Add a project"}
          onClick={() => setChosen(!adding)}
        >
          <span aria-hidden="true">{adding ? "×" : "+"}</span>
        </button>
      </div>

      {adding ? (
        <form
          className="project-add"
          onSubmit={(event) => {
            event.preventDefault();
            void addFolder(projectPath);
          }}
        >
          <input
            aria-label="Project path"
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder="E:\path\to\project"
            spellCheck={false}
          />
          <div className="project-add-actions">
            {pickFolder === undefined ? null : (
              <button type="button" className="panel-action" title="Choose a folder" onClick={() => void browse()} disabled={busy}>
                Browse
              </button>
            )}
            {/* The rail is 150px wide: the visible label is short, the name the tests use is not. */}
            <button type="submit" aria-label="Add project" disabled={projectPath.trim() === "" || busy}>
              Add
            </button>
          </div>
        </form>
      ) : null}

      {projects.length === 0 ? (
        <p className="panel-hint">No projects yet. Pick a folder to start.</p>
      ) : (
        <ul className="project-tree">
          {projects.map((project) => {
            const owned = workspaces.filter((workspace) => workspace.projectId === project.id);
            const open = !collapsed.has(project.id);
            return (
              <li key={project.id} className="project-node">
                <div className="project-row">
                  <button
                    type="button"
                    className="project-toggle"
                    aria-expanded={open}
                    title={project.rootPath}
                    onClick={() => toggle(project.id)}
                  >
                    <span aria-hidden="true" className="project-caret">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="project-name">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    className="project-add-workspace"
                    aria-label={`New workspace in ${project.name}`}
                    // One workspace per path is a kernel rule: an existing one is the only one.
                    title={
                      owned.length === 0
                        ? "Create this project's workspace"
                        : "This project already has a workspace"
                    }
                    disabled={owned.length > 0 || busy}
                    onClick={() => void createWorkspace(project.id)}
                  >
                    +
                  </button>
                </div>
                {open ? (
                  <ul className="workspace-list">
                    {owned.map((workspace) => (
                      <li key={workspace.id}>
                        <button
                          type="button"
                          className="workspace-row"
                          // The full path is the workspace's identity; the row shows only its tail.
                          aria-label={workspace.path}
                          title={workspace.path}
                          aria-current={workspace.id === workspaceId ? "true" : undefined}
                          onClick={() => onSelectWorkspace(workspace.id)}
                        >
                          <span className="workspace-name">{folderName(workspace.path)}</span>
                          {workspace.branch === null ? null : (
                            <span className="workspace-branch">{workspace.branch}</span>
                          )}
                        </button>
                      </li>
                    ))}
                    {owned.length === 0 ? <li className="panel-hint">No workspace yet</li> : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}
