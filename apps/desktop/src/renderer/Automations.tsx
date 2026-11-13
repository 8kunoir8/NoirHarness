import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentListResult,
  ScheduleListResult,
  ScheduleRunsResult,
  ScheduleRunView,
  ScheduleView,
  type AgentView,
} from "@noir/protocol";
import type { RequestFn } from "./api.js";
import { errorMessage } from "./events.js";
import { formatCadence, formatClock } from "./format.js";

interface AutomationsProps {
  workspaceId: string;
  request: RequestFn;
  /** Opening a run's chat; the session is ordinary, so the tab opens like any other. */
  onOpenSession: (sessionId: string) => void;
}

/** The cadences the editor offers; an interval outside this set keeps its own option. */
const CADENCES: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Hourly" },
  { minutes: 1_440, label: "Daily" },
  { minutes: 7 * 1_440, label: "Weekly" },
];

const DAY_MINUTES = 1_440;

interface Draft {
  id: string | null;
  /** The row the draft was loaded from, so saving sends only what the user changed. */
  loaded: ScheduleView | undefined;
  name: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  anchorMinutes: number;
  enabled: boolean;
}

function blankDraft(agentId: string): Draft {
  return {
    id: null,
    loaded: undefined,
    name: "",
    agentId,
    prompt: "",
    intervalMinutes: 1_440,
    anchorMinutes: 9 * 60,
    enabled: true,
  };
}

function draftFrom(schedule: ScheduleView): Draft {
  return {
    id: schedule.id,
    loaded: schedule,
    name: schedule.name,
    agentId: schedule.agentId,
    prompt: schedule.prompt,
    intervalMinutes: schedule.intervalMinutes,
    anchorMinutes: schedule.anchorMinutes,
    enabled: schedule.enabled,
  };
}

/** Only the fields the user actually changed; the kernel rejects an update with no field. */
function draftPatch(draft: Draft): Record<string, unknown> {
  const loaded = draft.loaded;
  if (loaded === undefined) return {};
  const patch: Record<string, unknown> = {};
  if (draft.name !== loaded.name) patch.name = draft.name.trim();
  if (draft.prompt !== loaded.prompt) patch.prompt = draft.prompt.trim();
  if (draft.intervalMinutes !== loaded.intervalMinutes) patch.intervalMinutes = draft.intervalMinutes;
  if (draft.anchorMinutes !== loaded.anchorMinutes) patch.anchorMinutes = draft.anchorMinutes;
  if (draft.enabled !== loaded.enabled) patch.enabled = draft.enabled;
  return patch;
}

/** `HH:MM` -> minutes past midnight; undefined for the empty string a cleared time input yields. */
function anchorFrom(clock: string): number | undefined {
  const [hours, minutes] = clock.split(":");
  const h = Number(hours);
  const m = Number(minutes);
  if (hours === undefined || minutes === undefined || !Number.isFinite(h) || !Number.isFinite(m)) return undefined;
  return h * 60 + m;
}

/**
 * Automations: schedules replayed against one agent in this workspace. Every run is an ordinary
 * session, so this pane links to the chat rather than showing a log of its own.
 */
export function Automations({ workspaceId, request, onOpenSession }: AutomationsProps) {
  const [schedules, setSchedules] = useState<ScheduleView[] | undefined>(undefined);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [runs, setRuns] = useState<ScheduleRunView[]>([]);
  const [draft, setDraft] = useState<Draft>(blankDraft(""));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // A workspace switch bumps this, so a listing that resolves late is dropped.
  const generation = useRef(0);
  // The row the editor is showing, read by callbacks that outlive the render that started them.
  const draftId = useRef<string | null>(null);
  useEffect(() => {
    draftId.current = draft.id;
  }, [draft.id]);

  const load = useCallback(
    async (ticket: number, workspace: string): Promise<void> => {
      try {
        const [list, roster] = await Promise.all([
          request<unknown>("schedule.list", { workspaceId: workspace }).then((value) => ScheduleListResult.parse(value)),
          request<unknown>("agent.list", {}).then((value) => AgentListResult.parse(value)),
        ]);
        if (generation.current !== ticket) return;
        setSchedules(list.schedules);
        setAgents(roster.agents);
        setError(undefined);
      } catch (loadError) {
        if (generation.current === ticket) setError(errorMessage(loadError));
      }
    },
    [request],
  );

  useEffect(() => {
    generation.current += 1;
    setSchedules(undefined);
    setRuns([]);
    setError(undefined);
    setDraft(blankDraft(""));
    if (workspaceId === "") return;
    void load(generation.current, workspaceId);
  }, [workspaceId, load]);

  // The first usable agent is the sensible default for a new schedule.
  useEffect(() => {
    if (draft.id !== null || draft.agentId !== "") return;
    const first = agents.find((agent) => agent.archivedAt === null);
    if (first === undefined) return;
    setDraft((current) => (current.agentId === "" ? { ...current, agentId: first.id } : current));
  }, [agents, draft.id, draft.agentId]);

  async function loadRuns(scheduleId: string, ticket: number): Promise<void> {
    try {
      const result = ScheduleRunsResult.parse(await request<unknown>("schedule.runs", { id: scheduleId }));
      // Both guards matter: the workspace may have switched, and a slower answer for the previous
      // row would otherwise render under the row now selected.
      if (generation.current !== ticket || draftId.current !== scheduleId) return;
      setRuns(result.runs);
    } catch (loadError) {
      if (generation.current === ticket && draftId.current === scheduleId) setError(errorMessage(loadError));
    }
  }

  function select(schedule: ScheduleView): void {
    setDraft(draftFrom(schedule));
    setRuns([]);
    void loadRuns(schedule.id, generation.current);
  }

  async function save(): Promise<void> {
    const ticket = generation.current;
    setBusy(true);
    try {
      if (draft.id === null) {
        await request<unknown>("schedule.create", {
          workspaceId,
          agentId: draft.agentId,
          name: draft.name.trim(),
          prompt: draft.prompt.trim(),
          intervalMinutes: draft.intervalMinutes,
          anchorMinutes: draft.intervalMinutes % DAY_MINUTES === 0 ? draft.anchorMinutes : 0,
          enabled: draft.enabled,
        });
      } else {
        await request<unknown>("schedule.update", { id: draft.id, ...draftPatch(draft) });
      }
      if (generation.current !== ticket) return;
      setDraft(blankDraft(draft.agentId));
      setRuns([]);
      await load(ticket, workspaceId);
    } catch (saveError) {
      if (generation.current === ticket) setError(errorMessage(saveError));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }

  async function toggle(schedule: ScheduleView): Promise<void> {
    const ticket = generation.current;
    setBusy(true);
    try {
      const updated = ScheduleView.parse(
        await request<unknown>("schedule.update", { id: schedule.id, enabled: !schedule.enabled }),
      );
      if (generation.current !== ticket) return;
      setSchedules((current) =>
        current === undefined ? current : current.map((row) => (row.id === updated.id ? updated : row)),
      );
      setDraft((current) => (current.id === updated.id ? draftFrom(updated) : current));
      setError(undefined);
    } catch (toggleError) {
      if (generation.current !== ticket) return;
      // The row must show what the kernel kept, not what the click hoped for.
      await load(ticket, workspaceId);
      if (generation.current !== ticket) return;
      setError(`${schedule.name}: ${errorMessage(toggleError)}`);
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }

  async function runNow(schedule: ScheduleView): Promise<void> {
    const ticket = generation.current;
    setBusy(true);
    try {
      const run = ScheduleRunView.parse(
        (await request<{ run: unknown }>("schedule.runNow", { id: schedule.id })).run,
      );
      if (generation.current !== ticket) return;
      setError(undefined);
      await load(ticket, workspaceId);
      if (generation.current !== ticket) return;
      if (run.sessionId !== null) {
        onOpenSession(run.sessionId);
        return;
      }
      setError(`${schedule.name}: the run was recorded but no session was created`);
      if (draft.id === schedule.id) await loadRuns(schedule.id, ticket);
    } catch (runError) {
      if (generation.current !== ticket) return;
      setError(`${schedule.name}: ${errorMessage(runError)}`);
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }

  async function remove(schedule: ScheduleView): Promise<void> {
    const ticket = generation.current;
    setBusy(true);
    try {
      await request<unknown>("schedule.delete", { id: schedule.id });
      if (generation.current !== ticket) return;
      if (draft.id === schedule.id) {
        setDraft(blankDraft(draft.agentId));
        setRuns([]);
      }
      await load(ticket, workspaceId);
    } catch (removeError) {
      if (generation.current === ticket) setError(errorMessage(removeError));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }

  if (workspaceId === "") {
    return (
      <section className="automations" aria-label="Automations">
        <p className="hint">Select a workspace to schedule runs.</p>
      </section>
    );
  }

  const cadenceKnown = CADENCES.some((option) => option.minutes === draft.intervalMinutes);
  const daily = draft.intervalMinutes % DAY_MINUTES === 0;
  // An existing schedule with no edits has nothing to send: `schedule.update` needs a field, and a
  // button that silently does nothing reads as a broken button.
  const dirty = draft.id === null || Object.keys(draftPatch(draft)).length > 0;
  const canSave = dirty && draft.name.trim() !== "" && draft.prompt.trim() !== "" && draft.agentId !== "" && !busy;

  return (
    <section className="automations" aria-label="Automations">
      {error === undefined ? null : (
        <p role="alert" className="automations-error">
          {error}
        </p>
      )}
      <div className="automations-panes">
        <section className="automations-list" role="region" aria-label="Schedules">
          <h3>Schedules</h3>
          {schedules === undefined ? (
            <p className="hint">Loading…</p>
          ) : schedules.length === 0 ? (
            <p className="hint">No schedules yet.</p>
          ) : (
            <ul>
              {schedules.map((schedule) => (
                <li
                  key={schedule.id}
                  className="automations-row"
                  aria-current={draft.id === schedule.id ? "true" : undefined}
                >
                  <button type="button" className="automations-open" onClick={() => select(schedule)}>
                    <strong>{schedule.name}</strong>
                    <span className="automations-meta">
                      {agents.find((agent) => agent.id === schedule.agentId)?.name ?? "unknown agent"} ·{" "}
                      {formatCadence(schedule.intervalMinutes, schedule.anchorMinutes)}
                    </span>
                    <span className="automations-meta">
                      {schedule.running ? "Running now · " : ""}
                      {schedule.enabled
                        ? `Next ${new Date(schedule.nextRunAt).toLocaleString()}`
                        : "Paused"}
                    </span>
                    <span className="automations-state">{schedule.enabled ? "Enabled" : "Disabled"}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`}
                    onClick={() => void toggle(schedule)}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Run ${schedule.name} now`}
                    onClick={() => void runNow(schedule)}
                  >
                    Run now
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="automations-editor" aria-label="Schedule editor">
          <h3>{draft.id === null ? "New schedule" : "Edit schedule"}</h3>
          <label htmlFor="schedule-name">Name</label>
          <input
            id="schedule-name"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Nightly review"
          />
          <label htmlFor="schedule-agent">Agent</label>
          <select
            id="schedule-agent"
            value={draft.agentId}
            onChange={(event) => setDraft((current) => ({ ...current, agentId: event.target.value }))}
          >
            {agents
              .filter((agent) => agent.archivedAt === null)
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
          <label htmlFor="schedule-prompt">Prompt</label>
          <textarea
            id="schedule-prompt"
            value={draft.prompt}
            rows={5}
            onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
            placeholder="What should this run do?"
          />
          <label htmlFor="schedule-cadence">Cadence</label>
          <select
            id="schedule-cadence"
            value={String(draft.intervalMinutes)}
            onChange={(event) =>
              setDraft((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))
            }
          >
            {cadenceKnown ? null : <option value={String(draft.intervalMinutes)}>Every {draft.intervalMinutes} min</option>}
            {CADENCES.map((option) => (
              <option key={option.minutes} value={String(option.minutes)}>
                {option.label}
              </option>
            ))}
          </select>
          {daily ? (
            <>
              <label htmlFor="schedule-time">Time</label>
              <input
                id="schedule-time"
                type="time"
                value={formatClock(draft.anchorMinutes)}
                onChange={(event) => {
                  const anchor = anchorFrom(event.target.value);
                  // A cleared input is not midnight: an unparseable time leaves the anchor alone.
                  if (anchor !== undefined) setDraft((current) => ({ ...current, anchorMinutes: anchor }));
                }}
              />
            </>
          ) : null}
          <div className="automations-actions">
            <button type="button" disabled={!canSave} onClick={() => void save()}>
              Save schedule
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(blankDraft(draft.agentId));
                setRuns([]);
              }}
            >
              New schedule
            </button>
            {draft.loaded === undefined ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const loaded = draft.loaded;
                  if (loaded !== undefined) void remove(loaded);
                }}
              >
                Delete schedule
              </button>
            )}
          </div>
        </section>

        <section className="automations-runs" role="region" aria-label="Run history">
          <h3>Run history</h3>
          {runs.length === 0 ? (
            <p className="hint">No runs yet.</p>
          ) : (
            <ul>
              {runs.map((run) => (
                <li key={run.id}>
                  <span>{new Date(run.startedAt).toLocaleString()}</span>
                  <span className="automations-run-status">{run.status}</span>
                  {run.reason === null ? null : <span className="automations-meta">{run.reason}</span>}
                  {run.sessionId === null ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        if (run.sessionId !== null) onOpenSession(run.sessionId);
                      }}
                    >
                      Open chat
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
