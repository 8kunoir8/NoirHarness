import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  type AgentListResult,
  type AgentRolesResult,
  type AgentRoleView,
  type AgentRosterEntry,
  type AgentRosterResult,
  type AgentView,
  type McpServerView,
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
import { approvalBubbleText, MAX_OFFICE_AGENTS, toOfficeStates } from "./office/mapper.js";
import { OFFICE_DESKS } from "./office/desks.js";
import { useReducedMotion, useRoster } from "./useRoster.js";
import "./agents.css";

type Decision = "ask" | "allow" | "reject";

/** Stable empty roster: the office's memo must not see a fresh array before the first read lands. */
const NO_ROSTER: AgentRosterEntry[] = [];

/** The six policy categories, in the order the matrix renders them. */
const POLICY_CATEGORIES: readonly PermissionCategory[] = [
  "shell",
  "delete",
  "rename",
  "write-outside-workspace",
  "network",
  "mcp",
];

const DECISIONS: readonly Decision[] = ["ask", "allow", "reject"];

/** Only the MCP row reads differently: "MCP tools" is what the user is being asked about. */
const CATEGORY_LABEL: Partial<Record<PermissionCategory, string>> = { mcp: "MCP tools" };

const DECISION_LABEL: Record<Decision, string> = { ask: "Ask", allow: "Allow", reject: "Reject" };

/** Missing key means `ask`; the form always sends every category so a save is a full replacement. */
type PermissionDraft = Record<PermissionCategory, Decision>;

const ASK_EVERYWHERE: PermissionDraft = {
  shell: "ask",
  delete: "ask",
  rename: "ask",
  "write-outside-workspace": "ask",
  network: "ask",
  mcp: "ask",
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
    mcp: policy.mcp ?? "ask",
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

interface AgentDraft {
  name: string;
  role: string;
  engineId: AgentView["engineId"];
  /** Empty means "no model": the kernel default at session start. */
  modelRef: string;
  /** Empty means "no default workspace". */
  defaultWorkspaceId: string;
  /** The MCP servers this profile runs; unbound servers never reach the engine. */
  mcpServerIds: readonly string[];
  permissionPolicy: PermissionDraft;
}

interface ConfigFormProps {
  /** `undefined` renders a blank create form; an agent renders its editable profile. */
  agent: AgentView | undefined;
  models: readonly ModelView[];
  workspaces: readonly WorkspaceView[];
  mcpServers: readonly McpServerView[];
  skills: readonly SkillView[];
  /** What this workspace can staff: the picker's options, and what a role binds when it is picked. */
  roles: readonly AgentRoleView[];
  error: string | undefined;
  busy: boolean;
  /** The office header's Configure action and the `C` command both focus this region. */
  configRef?: RefObject<HTMLElement | null> | undefined;
  onSave: (draft: AgentDraft) => void;
  /** `true` archives the current agent; `false` unarchives it. Never called in create mode. */
  onArchive: (archived: boolean) => void;
}

/**
 * The inspector form. It owns only the draft; the parent owns persistence, so a create and an
 * update share the same fields and the same validation.
 */
function AgentConfigForm({
  agent,
  models,
  workspaces,
  mcpServers,
  skills,
  roles,
  error,
  busy,
  configRef,
  onSave,
  onArchive,
}: ConfigFormProps) {
  const [name, setName] = useState(agent?.name ?? "");
  // A role is a catalog name, so one saved before this list existed stays visible and unchanged.
  const [role, setRole] = useState(agent?.role ?? roles[0]?.name ?? "");
  const [engineId, setEngineId] = useState<AgentView["engineId"]>(agent?.engineId ?? "acp");
  const [modelRef, setModelRef] = useState(agent?.modelRef ?? "");
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState(agent?.defaultWorkspaceId ?? "");
  const [mcpServerIds, setMcpServerIds] = useState<readonly string[]>(agent?.mcpServerIds ?? []);
  const [policy, setPolicy] = useState<PermissionDraft>(() => toDraft(agent?.permissionPolicy ?? {}));
  const [validationError, setValidationError] = useState<string | undefined>(undefined);

  const enabledModels = models.filter((model) => model.enabled);
  // A stored model can be disabled after the profile was saved: keep it visible and selected
  // instead of silently showing another model as the current one.
  const storedModelMissing = modelRef !== "" && !enabledModels.some((model) => model.id === modelRef);
  const availableSkills = skills.filter((skill) => skill.enabled);
  const selectedRole = roles.find((candidate) => candidate.name === role);

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
      role: roleText === "" ? (roles[0]?.name ?? "Generalist") : roleText,
      engineId,
      modelRef,
      defaultWorkspaceId,
      mcpServerIds,
      permissionPolicy: policy,
    });
  }

  const shownError = validationError ?? error;

  return (
    <section ref={configRef} tabIndex={-1} className="agents-config" aria-label="Agent config">
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
          <select
            aria-label="Role"
            value={role}
            disabled={busy}
            onChange={(event) => {
              const picked = roles.find((candidate) => candidate.name === event.target.value);
              setRole(event.target.value);
              // A role is what binds servers: picking one fills the bindings it is for, and the user
              // can still tick or untick any box afterwards.
              if (picked !== undefined) setMcpServerIds(picked.mcpServerIds);
            }}
          >
            {role === "" || roles.some((candidate) => candidate.name === role) ? null : (
              <option value={role}>{role} (saved)</option>
            )}
            {roles.map((candidate) => (
              <option key={candidate.id} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        {selectedRole === undefined ? null : (
          <div className="agents-role">
            <p className="agents-hint">{selectedRole.description}</p>
            <p className="agents-hint">
              {selectedRole.skills.length === 0
                ? "No workspace skill is specific to this role."
                : `Skills this role is for: ${selectedRole.skills.join(", ")}`}
            </p>
          </div>
        )}
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
              <legend>{CATEGORY_LABEL[category] ?? category}</legend>
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

        <fieldset className="agents-policy">
          <legend>MCP servers</legend>
          {mcpServers.length === 0 ? (
            <p className="agents-hint">No MCP servers are configured. Add one in Setup.</p>
          ) : (
            mcpServers.map((server) => (
              <label key={server.id} className="agents-policy-choice">
                <input
                  type="checkbox"
                  checked={mcpServerIds.includes(server.id)}
                  // Only binding a disabled server is blocked: a server disabled after the profile
                  // was saved must still be removable here.
                  disabled={busy || (!server.enabled && !mcpServerIds.includes(server.id))}
                  onChange={(event) =>
                    setMcpServerIds((current) =>
                      event.target.checked
                        ? [...current, server.id]
                        : current.filter((id) => id !== server.id),
                    )
                  }
                />
                {server.enabled ? server.name : `${server.name} (disabled)`}
              </label>
            ))
          )}
          {mcpServerIds.some((id) => !mcpServers.some((server) => server.id === id)) ? (
            <p className="agents-hint">This agent is bound to a server that no longer exists.</p>
          ) : null}
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
  /** Opens a chat tab; a roster row's Enter and the office's Open chat both land here. */
  onOpenChat: (session: Pick<SessionView, "id">) => void;
  /** `App` owns the ref so the `C` command can focus the inspector from anywhere in the view. */
  configRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * The Agents rail view: roster on the left, the selected agent's session pane in the middle, and the
 * profile inspector on the right. The middle region is named `Office`: it renders the lazy Phaser
 * canvas over the roster's list view, which the `List view` toggle keeps reachable.
 */
export function Agents({ workspaceId, request, onOpenChat, configRef }: AgentsProps) {
  const [agents, setAgents] = useState<AgentView[] | undefined>(undefined);
  // The batch load below carries the first roster read, so the hook only owns the live refresh.
  const { roster: liveRoster, nextSnapshot, apply: applyRoster } = useRoster(request, { subscribe: true });
  // The office and the rail always describe a list: before the first read there is simply nobody.
  const roster = liveRoster ?? NO_ROSTER;
  const [models, setModels] = useState<ModelView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [roles, setRoles] = useState<AgentRoleView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Focus is passive: it highlights the character in the office but must never move the inspector,
  // whose form is keyed by `selectedId` and would otherwise lose an unsaved draft on a mere tab.
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
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
  // `App` supplies the ref for the `C` command; alone, the view still focuses its own inspector.
  const ownConfigRef = useRef<HTMLElement | null>(null);
  const configTargetRef = configRef ?? ownConfigRef;

  // The RPC server answers concurrently, so a slower earlier batch must not overwrite a newer one.
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const run = ++loadSeq.current;
    const rosterSnapshot = nextSnapshot();
    try {
      const [agentResult, rosterResult, modelResult, workspaceResult, skillResult, mcpResult, roleResult] =
        await Promise.all([
          request<AgentListResult>("agent.list", { includeArchived }),
          request<AgentRosterResult>("agent.roster", {}),
          request<ModelListResult>("model.list"),
          request<{ workspaces: WorkspaceView[] }>("workspace.list"),
          request<SkillListResult>("skill.list", workspaceId === "" ? {} : { workspaceId }),
          request<{ servers: McpServerView[] }>("mcp.list"),
          request<AgentRolesResult>("agent.roles", workspaceId === "" ? {} : { workspaceId }),
        ]);
      if (run !== loadSeq.current) return;
      setAgents(agentResult.agents);
      applyRoster(rosterSnapshot, rosterResult.agents);
      setModels(modelResult.models);
      setWorkspaces(workspaceResult.workspaces);
      setSkills(skillResult.skills);
      setMcpServers(mcpResult.servers);
      setRoles(roleResult.roles);
      setListError(undefined);
    } catch (loadError) {
      if (run !== loadSeq.current) return;
      setListError(errorMessage(loadError));
      setAgents([]);
    }
  }, [request, includeArchived, workspaceId, applyRoster]);

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
  const officeStates = useMemo(() => toOfficeStates(roster, OFFICE_DESKS), [roster]);

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

  /** A roster row's Enter and the office header's Open chat both open the active session. */
  function openChat(agent: AgentView): void {
    const entry = roster.find((candidate) => candidate.agentId === agent.id);
    if (entry?.activeSessionId == null) return;
    onOpenChat({ id: entry.activeSessionId });
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
          mcpServerIds: [...draft.mcpServerIds],
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
          mcpServerIds?: string[];
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
        const serverIds = [...draft.mcpServerIds];
        if (
          serverIds.length !== selectedAgent.mcpServerIds.length ||
          serverIds.some((id) => !selectedAgent.mcpServerIds.includes(id))
        ) {
          update.mcpServerIds = serverIds;
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
  const selectedUsage = selectedEntry?.usage ?? null;
  const selectedUsagePercent = selectedUsage !== null && selectedUsage.size > 0
    ? Math.min(100, Math.round((selectedUsage.used / selectedUsage.size) * 100))
    : null;

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
              const bubble = entry === undefined ? null : approvalBubbleText(entry);
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
                      // Enter opens the chat through this row's own handler instead of a second
                      // global listener. Spec §9.4: focusing a row highlights its character, but
                      // focus is passive — it never moves the inspector selection or its draft.
                      onFocus={() => setFocusedId(agent.id)}
                      onBlur={() => setFocusedId(undefined)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        openChat(agent);
                      }}
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
                  {bubble === null ? null : (
                    <p className="agents-row-bubble" data-approval={entry?.pendingApproval?.approvalId ?? ""}>
                      {bubble}
                    </p>
                  )}
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
              {selectedUsagePercent === null || selectedUsage === null ? null : (
                <span className="agents-context">
                  <span
                    role="progressbar"
                    aria-label="Context usage"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={selectedUsagePercent}
                  >
                    <span className="agents-context-fill" style={{ width: `${selectedUsagePercent}%` }} />
                  </span>
                  <span className="agents-hint">
                    Context {formatTokens(selectedUsage.used)} / {formatTokens(selectedUsage.size)}
                  </span>
                </span>
              )}
              <span className="agents-hint">
                {selectedEntry?.activeSessionId == null ? "No active session" : "1 active session"}
              </span>
              <span className="agents-hint">
                {selectedEntry?.sessionCount ?? 0} session{selectedEntry?.sessionCount === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                disabled={selectedEntry?.activeSessionId == null}
                onClick={() => openChat(selectedAgent)}
              >
                Open chat
              </button>
              <button type="button" onClick={() => configTargetRef.current?.focus()}>
                Configure
              </button>
            </header>
            {roster.length <= MAX_OFFICE_AGENTS ? null : (
              <p className="agents-hint">{roster.length - MAX_OFFICE_AGENTS} more agents in the roster</p>
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
                selectedId={focusedId ?? selectedAgent.id}
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
          mcpServers={mcpServers}
          skills={skills}
          roles={roles}
          error={formError}
          busy={busy}
          configRef={configTargetRef}
          onSave={(draft) => void saveAgent(draft)}
          onArchive={(archived) => {
            if (selectedAgent !== undefined) void archiveAgent(selectedAgent, archived);
          }}
        />
      )}
    </div>
  );
}
