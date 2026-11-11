import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  type AgentListResult,
  type AgentRosterEntry,
  type AgentRosterResult,
  type AgentView,
  type ModelListResult,
  type ModelView,
  type PermissionCategory,
  type PermissionPolicy,
  type SessionView,
  type SkillListResult,
  type SkillView,
} from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";
import { formatTokens } from "./format.js";
import type { WorkspaceView } from "./WorkspacePanel.js";
import { AgentOffice } from "./office/AgentOffice.js";
import { toOfficeStates } from "./office/mapper.js";
import officeMap from "./office/map.json";
import "./agents.css";

type Decision = "ask" | "allow" | "reject";

/** The five policy categories, in the order the matrix renders them. */
const POLICY_CATEGORIES: readonly PermissionCategory[] = [
  "shell",
  "delete",
  "rename",
  "write-outside-workspace",
  "network",
];

const DECISIONS: readonly Decision[] = ["ask", "allow", "reject"];

const DECISION_LABEL: Record<Decision, string> = { ask: "Ask", allow: "Allow", reject: "Reject" };

/** Missing key means `ask`; the form always sends all five so a save is a full replacement. */
type PermissionDraft = Record<PermissionCategory, Decision>;

const ASK_EVERYWHERE: PermissionDraft = {
  shell: "ask",
  delete: "ask",
  rename: "ask",
  "write-outside-workspace": "ask",
  network: "ask",
};

const STATUS_LABEL: Record<AgentRosterEntry["status"], string> = {
  idle: "Idle",
  working: "Working",
  needs_you: "Needs you",
  error: "Error",
};

function toDraft(policy: PermissionPolicy): PermissionDraft {
  return {
    shell: policy.shell ?? "ask",
    delete: policy.delete ?? "ask",
    rename: policy.rename ?? "ask",
    "write-outside-workspace": policy["write-outside-workspace"] ?? "ask",
    network: policy.network ?? "ask",
  };
}

function withDecision(policy: PermissionDraft, category: PermissionCategory, decision: Decision): PermissionDraft {
  return { ...policy, [category]: decision };
}

/** The last path segment reads better than a full path in a roster row or a picker. */
function workspaceLabel(workspace: WorkspaceView): string {
  const segments = workspace.path.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.at(-1) ?? workspace.path;
}

function modelLabel(models: readonly ModelView[], modelRef: string | null): string {
  if (modelRef === null) return "Kernel default model";
  const model = models.find((candidate) => candidate.id === modelRef);
  return model === undefined ? modelRef : model.displayName;
}

/** The office renders seated states instead of walking when the OS asks for reduced motion. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  return reduced;
}

interface AgentDraft {
  name: string;
  role: string;
  engineId: AgentView["engineId"];
  /** Empty means "no model": the kernel default at session start. */
  modelRef: string;
  /** Empty means "no default workspace". */
  defaultWorkspaceId: string;
  permissionPolicy: PermissionDraft;
}

interface ConfigFormProps {
  /** `undefined` renders a blank create form; an agent renders its editable profile. */
  agent: AgentView | undefined;
  models: readonly ModelView[];
  workspaces: readonly WorkspaceView[];
  skills: readonly SkillView[];
  error: string | undefined;
  busy: boolean;
  onSave: (draft: AgentDraft) => void;
  /** `true` archives the current agent; `false` unarchives it. Never called in create mode. */
  onArchive: (archived: boolean) => void;
}

/**
 * The inspector form. It owns only the draft; the parent owns persistence, so a create and an
 * update share the same fields and the same validation.
 */
function AgentConfigForm({ agent, models, workspaces, skills, error, busy, onSave, onArchive }: ConfigFormProps) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "Coder");
  const [engineId, setEngineId] = useState<AgentView["engineId"]>(agent?.engineId ?? "acp");
  const [modelRef, setModelRef] = useState(agent?.modelRef ?? "");
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState(agent?.defaultWorkspaceId ?? "");
  const [policy, setPolicy] = useState<PermissionDraft>(() => toDraft(agent?.permissionPolicy ?? {}));
  const [validationError, setValidationError] = useState<string | undefined>(undefined);

  const enabledModels = models.filter((model) => model.enabled);
  // A stored model can be disabled after the profile was saved: keep it visible and selected
  // instead of silently showing another model as the current one.
  const storedModelMissing = modelRef !== "" && !enabledModels.some((model) => model.id === modelRef);
  const availableSkills = skills.filter((skill) => skill.enabled);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setValidationError("Name is required");
      return;
    }
    setValidationError(undefined);
    const roleText = role.trim();
    onSave({
      name: trimmed,
      role: roleText === "" ? "Coder" : roleText,
      engineId,
      modelRef,
      defaultWorkspaceId,
      permissionPolicy: policy,
    });
  }

  const shownError = validationError ?? error;

  return (
    <section className="agents-config" aria-label="Agent config">
      <h2>{agent === undefined ? "New agent" : agent.name}</h2>
      {shownError === undefined ? null : (
        <p role="alert" className="agents-error">
          {shownError}
        </p>
      )}

      <form className="agents-form" onSubmit={submit}>
        <label>
          Name
          <input
            value={name}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setValidationError(undefined);
            }}
          />
        </label>
        <label>
          Role
          <input value={role} disabled={busy} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          Engine
          <select
            aria-label="Engine"
            value={engineId}
            disabled={busy}
            onChange={(event) => setEngineId(event.target.value as AgentView["engineId"])}
          >
            <option value="acp">ACP</option>
            <option value="native">Native</option>
          </select>
        </label>
        <p className="agents-hint">
          {engineId === "native"
            ? "Native speaks the OpenAI chat-completions protocol; the model's provider must support it."
            : "ACP runs the configured agent through the CLI engine."}
        </p>
        <label>
          Default model
          <select
            aria-label="Default model"
            value={modelRef}
            disabled={busy}
            onChange={(event) => setModelRef(event.target.value)}
          >
            <option value="">Kernel default</option>
            {storedModelMissing ? <option value={modelRef}>{modelRef}</option> : null}
            {enabledModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default workspace
          <select
            aria-label="Default workspace"
            value={defaultWorkspaceId}
            disabled={busy}
            onChange={(event) => setDefaultWorkspaceId(event.target.value)}
          >
            <option value="">No default</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspaceLabel(workspace)}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="agents-policy">
          <legend>Permissions</legend>
          {POLICY_CATEGORIES.map((category) => (
            <fieldset key={category} className="agents-policy-row">
              <legend>{category}</legend>
              {DECISIONS.map((decision) => (
                <label key={decision} className="agents-policy-choice">
                  <input
                    type="radio"
                    name={`permission-${category}`}
                    value={decision}
                    checked={policy[category] === decision}
                    disabled={busy}
                    onChange={() => setPolicy((current) => withDecision(current, category, decision))}
                  />
                  {DECISION_LABEL[decision]}
                </label>
              ))}
            </fieldset>
          ))}
        </fieldset>

        <div className="agents-actions">
          <button type="submit" disabled={busy}>
            Save
          </button>
          {agent === undefined ? null : (
            <button type="button" disabled={busy} onClick={() => onArchive(agent.archivedAt === null)}>
              {agent.archivedAt === null ? "Archive" : "Unarchive"}
            </button>
          )}
        </div>
      </form>

      <h3>Available skills</h3>
      <ul className="agents-skills" aria-label="Available skills">
        {availableSkills.map((skill) => (
          <li key={`${skill.scope}:${skill.name}`}>
            <strong>{skill.name}</strong> <span className="agents-skill-scope">{skill.scope}</span>
            <p className="agents-hint">{skill.description}</p>
          </li>
        ))}
      </ul>
      {availableSkills.length === 0 ? <p className="agents-hint">No skills are enabled.</p> : null}
      <p className="agents-hint">Every enabled skill is available to every agent; the list is informational.</p>
    </section>
  );
}

export interface AgentsProps {
  workspaceId: string;
  request: RequestFn;
  onOpenChat: (session: SessionView) => void;
}

/**
 * The Agents rail view: roster on the left, the selected agent's session pane in the middle, and the
 * profile inspector on the right. The middle region is named `Office`: it renders the lazy Phaser
 * canvas over the roster's list view, which the `List view` toggle keeps reachable.
 */
export function Agents({ workspaceId, request, onOpenChat }: AgentsProps) {
  const [agents, setAgents] = useState<AgentView[] | undefined>(undefined);
  const [roster, setRoster] = useState<AgentRosterEntry[]>([]);
  const [models, setModels] = useState<ModelView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [officeError, setOfficeError] = useState<string | undefined>(undefined);
  const [startWorkspaceId, setStartWorkspaceId] = useState(workspaceId);
  const [startModelId, setStartModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [showOffice, setShowOffice] = useState(true);
  const [officeUnavailable, setOfficeUnavailable] = useState(false);
  const reducedMotion = useReducedMotion();

  // The RPC server answers concurrently, so a slower earlier batch must not overwrite a newer one.
  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const run = ++loadSeq.current;
    try {
      const [agentResult, rosterResult, modelResult, workspaceResult, skillResult] = await Promise.all([
        request<AgentListResult>("agent.list", { includeArchived }),
        request<AgentRosterResult>("agent.roster", {}),
        request<ModelListResult>("model.list"),
        request<{ workspaces: WorkspaceView[] }>("workspace.list"),
        request<SkillListResult>("skill.list", workspaceId === "" ? {} : { workspaceId }),
      ]);
      if (run !== loadSeq.current) return;
      setAgents(agentResult.agents);
      setRoster(rosterResult.agents);
      setModels(modelResult.models);
      setWorkspaces(workspaceResult.workspaces);
      setSkills(skillResult.skills);
      setListError(undefined);
    } catch (loadError) {
      if (run !== loadSeq.current) return;
      setListError(errorMessage(loadError));
      setAgents([]);
    }
  }, [request, includeArchived, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep one row selected so the office pane and the inspector always describe a real agent, but
  // never steal the selection while a blank create form is open.
  useEffect(() => {
    if (agents === undefined || creating) return;
    if (selectedId !== undefined && agents.some((agent) => agent.id === selectedId)) return;
    setSelectedId(agents[0]?.id);
  }, [agents, selectedId, creating]);

  const selectedAgent = agents?.find((agent) => agent.id === selectedId);
  const selectedEntry = selectedAgent === undefined
    ? undefined
    : roster.find((entry) => entry.agentId === selectedAgent.id);
  const officeStates = useMemo(() => toOfficeStates(roster, officeMap.desks), [roster]);

  // A profile's default workspace is what the start panel preselects; a workspace switch applies to
  // an agent with no default of its own.
  useEffect(() => {
    setStartWorkspaceId(selectedAgent?.defaultWorkspaceId ?? workspaceId);
    setStartModelId("");
  }, [selectedAgent?.id, selectedAgent?.defaultWorkspaceId, workspaceId]);

  function select(id: string): void {
    setSelectedId(id);
    setCreating(false);
    setFormError(undefined);
    setOfficeError(undefined);
  }

  function beginCreate(): void {
    setCreating(true);
    setFormError(undefined);
  }

  async function saveAgent(draft: AgentDraft): Promise<void> {
    setBusy(true);
    setFormError(undefined);
    try {
      if (creating || selectedAgent === undefined) {
        const created = await request<AgentView>("agent.create", {
          name: draft.name,
          role: draft.role,
          engineId: draft.engineId,
          modelRef: draft.modelRef === "" ? null : draft.modelRef,
          permissionPolicy: draft.permissionPolicy,
          defaultWorkspaceId: draft.defaultWorkspaceId === "" ? null : draft.defaultWorkspaceId,
        });
        await load();
        setCreating(false);
        setSelectedId(created.id);
      } else {
        // Send only what changed: the kernel validates a model whenever `engineId` or `modelRef` is
        // present, so re-sending the loaded profile would fail once its model was deleted.
        const modelRef = draft.modelRef === "" ? null : draft.modelRef;
        const defaultWorkspaceId = draft.defaultWorkspaceId === "" ? null : draft.defaultWorkspaceId;
        const update: {
          id: string;
          name?: string;
          role?: string;
          engineId?: AgentView["engineId"];
          modelRef?: string | null;
          permissionPolicy?: PermissionDraft;
          defaultWorkspaceId?: string | null;
        } = { id: selectedAgent.id };
        if (draft.name !== selectedAgent.name) update.name = draft.name;
        if (draft.role !== selectedAgent.role) update.role = draft.role;
        if (draft.engineId !== selectedAgent.engineId) update.engineId = draft.engineId;
        if (modelRef !== selectedAgent.modelRef) update.modelRef = modelRef;
        if (defaultWorkspaceId !== selectedAgent.defaultWorkspaceId) {
          update.defaultWorkspaceId = defaultWorkspaceId;
        }
        const loadedPolicy = toDraft(selectedAgent.permissionPolicy);
        if (POLICY_CATEGORIES.some((category) => draft.permissionPolicy[category] !== loadedPolicy[category])) {
          update.permissionPolicy = draft.permissionPolicy;
        }
        if (Object.keys(update).length > 1) {
          await request<AgentView>("agent.update", update);
        }
        await load();
      }
    } catch (saveError) {
      setFormError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function archiveAgent(agent: AgentView, archived: boolean): Promise<void> {
    setBusy(true);
    setFormError(undefined);
    try {
      await request("agent.archive", { id: agent.id, archived });
      await load();
      if (archived) setSelectedId(undefined);
      setCreating(false);
    } catch (archiveError) {
      setFormError(errorMessage(archiveError));
    } finally {
      setBusy(false);
    }
  }

  async function start(
    agent: AgentView,
    overrides?: { workspaceId: string; modelId: string },
  ): Promise<void> {
    const targetWorkspace = overrides?.workspaceId ?? agent.defaultWorkspaceId ?? workspaceId;
    if (targetWorkspace === "") {
      setOfficeError("Select a workspace before starting an agent");
      return;
    }
    const params: { workspaceId: string; agentId: string; modelId?: string } = {
      workspaceId: targetWorkspace,
      agentId: agent.id,
    };
    // The agent's own model is the default; only a deliberate pick in the start panel is sent.
    if (overrides !== undefined && overrides.modelId !== "") params.modelId = overrides.modelId;
    setBusy(true);
    setOfficeError(undefined);
    try {
      const created = await request<SessionView>("session.create", params);
      onOpenChat(created);
      await load();
    } catch (startError) {
      setOfficeError(errorMessage(startError));
    } finally {
      setBusy(false);
    }
  }

  const configTarget = creating ? "new" : selectedAgent?.id;

  return (
    <div className="agents-view">
      <section className="agents-roster" aria-label="Agents">
        <header className="agents-roster-head">
          <h2>Agents</h2>
          <label className="agents-filter">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include archived
          </label>
          <button type="button" onClick={beginCreate}>
            Create agent
          </button>
        </header>

        {listError === undefined ? null : (
          <p role="alert" className="agents-error">
            {listError}
          </p>
        )}

        {agents === undefined ? (
          <p className="agents-hint">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p className="agents-empty">No agents yet</p>
        ) : (
          <ul className="agents-list">
            {agents.map((agent) => {
              const entry = roster.find((candidate) => candidate.agentId === agent.id);
              const status = agent.archivedAt === null
                ? entry === undefined ? "Unknown" : STATUS_LABEL[entry.status]
                : "Archived";
              const defaultWorkspace = workspaces.find(
                (workspace) => workspace.id === agent.defaultWorkspaceId,
              );
              const rowWorkspace = agent.defaultWorkspaceId ?? workspaceId;
              const activeTool = entry?.status === "working" ? entry.activeToolKind : null;
              const usagePercent = entry?.usage != null && entry.usage.size > 0
                ? Math.round((entry.usage.used / entry.usage.size) * 100)
                : null;
              return (
                <li
                  key={agent.id}
                  className={`agents-row${agent.id === selectedId && !creating ? " agents-row-selected" : ""}`}
                >
                  <div className="agents-row-head">
                    <button
                      type="button"
                      className="agents-row-select"
                      aria-label={`Select ${agent.name}`}
                      aria-pressed={agent.id === selectedId && !creating}
                      onClick={() => select(agent.id)}
                    >
                      <strong>{agent.name}</strong>
                      <span className="agents-row-role">{agent.role}</span>
                      <span className="agents-status" data-status={entry?.status ?? "unknown"}>
                        {status}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy || agent.archivedAt !== null || rowWorkspace === ""}
                      onClick={() => {
                        // Report the failure under this row's agent, not whichever was selected.
                        select(agent.id);
                        void start(agent);
                      }}
                    >
                      Start
                    </button>
                  </div>
                  <p className="agents-row-meta">
                    {modelLabel(models, agent.modelRef)} ·{" "}
                    {defaultWorkspace === undefined
                      ? agent.defaultWorkspaceId ?? "No default workspace"
                      : workspaceLabel(defaultWorkspace)}{" "}
                    · {entry?.activeSessionId == null ? "No active session" : "1 active session"} ·{" "}
                    {entry?.sessionCount ?? 0} session{entry?.sessionCount === 1 ? "" : "s"} ·{" "}
                    {activeTool === null ? null : <>Tool: {activeTool} · </>}
                    {usagePercent === null ? null : <>{usagePercent}% context · </>}
                    {new Date(entry?.lastActivityAt ?? agent.createdAt).toLocaleString()}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="agents-office" aria-label="Office">
        {selectedAgent === undefined ? (
          <p className="agents-empty">Select an agent to see its session and start one.</p>
        ) : (
          <>
            <header className="agents-office-head">
              <h2>{selectedAgent.name}</h2>
              <span className="agents-status" data-status={selectedEntry?.status ?? "unknown"}>
                {selectedAgent.archivedAt === null
                  ? selectedEntry === undefined ? "Unknown" : STATUS_LABEL[selectedEntry.status]
                  : "Archived"}
              </span>
              <span className="agents-hint">{modelLabel(models, selectedAgent.modelRef)}</span>
              <span className="agents-hint">
                {selectedEntry?.activeSessionId == null ? "No active session" : "1 active session"}
              </span>
              <span className="agents-hint">
                {selectedEntry?.sessionCount ?? 0} session{selectedEntry?.sessionCount === 1 ? "" : "s"}
              </span>
            </header>
            {selectedEntry?.usage == null ? null : (
              <p className="agents-hint">
                Context {formatTokens(selectedEntry.usage.used)} / {formatTokens(selectedEntry.usage.size)}
              </p>
            )}
            <div className="office-bar">
              <button type="button" aria-pressed={!showOffice} onClick={() => setShowOffice((shown) => !shown)}>
                {showOffice ? "List view" : "Office view"}
              </button>
              {officeUnavailable ? <span className="agents-hint">Office unavailable</span> : null}
            </div>
            {showOffice && !officeUnavailable ? (
              <AgentOffice
                states={officeStates}
                selectedId={selectedAgent.id}
                reducedMotion={reducedMotion}
                onSelect={(agentId) => {
                  if (agents?.some((agent) => agent.id === agentId) === true) select(agentId);
                }}
                onUnavailable={() => setOfficeUnavailable(true)}
              />
            ) : null}
            <form
              className="agents-start"
              onSubmit={(event) => {
                event.preventDefault();
                void start(selectedAgent, { workspaceId: startWorkspaceId, modelId: startModelId });
              }}
            >
              <label>
                Start workspace
                <select
                  aria-label="Start workspace"
                  value={startWorkspaceId}
                  disabled={busy}
                  onChange={(event) => setStartWorkspaceId(event.target.value)}
                >
                  {startWorkspaceId === "" ? <option value="">Select a workspace</option> : null}
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspaceLabel(workspace)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Start model
                <select
                  aria-label="Start model"
                  value={startModelId}
                  disabled={busy}
                  onChange={(event) => setStartModelId(event.target.value)}
                >
                  <option value="">Agent default</option>
                  {models.filter((model) => model.enabled).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={busy || startWorkspaceId === ""}>
                Start session
              </button>
            </form>
            {officeError === undefined ? null : (
              <p role="alert" className="agents-error">
                {officeError}
              </p>
            )}
          </>
        )}
      </section>

      {configTarget === undefined ? null : (
        <AgentConfigForm
          key={configTarget}
          agent={creating ? undefined : selectedAgent}
          models={models}
          workspaces={workspaces}
          skills={skills}
          error={formError}
          busy={busy}
          onSave={(draft) => void saveAgent(draft)}
          onArchive={(archived) => {
            if (selectedAgent !== undefined) void archiveAgent(selectedAgent, archived);
          }}
        />
      )}
    </div>
  );
}
