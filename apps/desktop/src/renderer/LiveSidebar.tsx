import { useMemo, useState } from "react";
import type { AgentRosterEntry } from "@noir/protocol";
import { AgentOffice } from "./office/AgentOffice.js";
import { OFFICE_DESKS } from "./office/desks.js";
import { toOfficeStates } from "./office/mapper.js";
import { useReducedMotion } from "./useRoster.js";

export interface LiveSidebarProps {
  /** The live roster, or `undefined` until its first read lands. Owned by the shell, not this pane. */
  roster: readonly AgentRosterEntry[] | undefined;
  /** The chat on screen; its agent is the one this column describes. */
  agentId: string | undefined;
  /**
   * The tool this chat's agent is running right now, as the chat names it ("Run `pnpm test`").
   * Only the open session has one, so every other agent falls back to its status word.
   */
  activity: string | undefined;
  /**
   * Off while the Agents view is open: that page mounts its own canvas, and two Phaser games in one
   * window is two render loops for the same picture.
   */
  showOffice: boolean;
  onOpenAgents: () => void;
  /** Opens the chat behind an agent, so a name or a character is enough to reach its session. */
  onOpenAgent: (agentId: string) => void;
}

const STATUS_LABEL: Record<AgentRosterEntry["status"], string> = {
  idle: "Idle",
  working: "Working",
  needs_you: "Needs you",
  error: "Error",
};

const STATUS_TONE: Record<AgentRosterEntry["status"], string> = {
  idle: "neutral",
  working: "accent",
  needs_you: "warn",
  error: "danger",
};

/**
 * The permanent right column: the office canvas and the agent behind the open chat. It holds no
 * selection of its own — the office highlights the active chat's agent — so opening a chat is the
 * only way to focus a character here.
 */
export function LiveSidebar({
  roster: entries,
  agentId,
  activity,
  showOffice,
  onOpenAgents,
  onOpenAgent,
}: LiveSidebarProps) {
  const [unavailable, setUnavailable] = useState(false);
  const reducedMotion = useReducedMotion();

  const states = useMemo(
    () => (entries === undefined ? [] : toOfficeStates(entries, OFFICE_DESKS)),
    [entries],
  );
  const active = entries?.find((entry) => entry.agentId === agentId);
  const working = entries?.filter((entry) => entry.status === "working").length ?? 0;
  const waiting = entries?.filter((entry) => entry.status === "needs_you").length ?? 0;
  // Status first: a tool can still read "running" for a tick after an approval or a stop arrives.
  const doing =
    active === undefined
      ? undefined
      : active.status === "needs_you"
        ? "Waiting on your approval"
        : active.status === "error"
          ? "Stopped on an error"
          : (activity ?? (active.status === "working" ? "Thinking" : "Idle"));

  return (
    <>
      <section className="sidebar-section" aria-label="Pixel office">
        <header className="sidebar-head">
          <h2>Pixel office</h2>
          <span className="sidebar-live">
            <span className="nav-dot" data-tone={working > 0 ? "ok" : "idle"} aria-hidden="true" />
            {working === 0 ? "All quiet" : `${String(working)} working`}
            {waiting === 0 ? "" : ` · ${String(waiting)} needs you`}
          </span>
        </header>
        {entries === undefined ? (
          <p className="empty">Reading the roster…</p>
        ) : entries.length === 0 ? (
          <p className="empty">
            No agents yet.{" "}
            <button type="button" className="link" onClick={onOpenAgents}>
              Create one
            </button>
          </p>
        ) : !showOffice ? (
          <p className="empty">The canvas is on the Agents page.</p>
        ) : unavailable ? (
          <p className="empty">Office unavailable — the roster is on the Agents page.</p>
        ) : (
          <AgentOffice
            states={states}
            selectedId={agentId}
            reducedMotion={reducedMotion}
            onSelect={onOpenAgent}
            onUnavailable={() => setUnavailable(true)}
          />
        )}
        {entries === undefined || entries.length === 0 ? null : (
          // The canvas shows where an agent stands, not who it is: the list names each one, and a
          // click opens the chat the office has no room to describe.
          <ul className="sidebar-roster" aria-label="Office agents">
            {entries.map((entry) => (
              <li key={entry.agentId}>
                <button
                  type="button"
                  aria-current={entry.agentId === agentId}
                  aria-label={`Open ${entry.name}`}
                  onClick={() => onOpenAgent(entry.agentId)}
                >
                  <span className={`dot dot-${STATUS_TONE[entry.status]}`} aria-hidden="true" />
                  <span className="sidebar-roster-name">{entry.name}</span>
                  <span className="sidebar-roster-status">{STATUS_LABEL[entry.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sidebar-section" aria-label="Live agent">
        <h3>Agent</h3>
        {active === undefined ? (
          <p className="empty">This chat has no agent in the roster.</p>
        ) : (
          <dl className="sidebar-kv">
            <dt>Name</dt>
            <dd>{active.name}</dd>
            <dt>Status</dt>
            <dd>{active.status === "needs_you" ? "Needs you" : active.status}</dd>
            <dt>Doing</dt>
            <dd className="sidebar-doing">{doing}</dd>
            <dt>Sessions</dt>
            <dd>{active.sessionCount}</dd>
            {active.usage === null ? null : (
              <>
                <dt>Context</dt>
                <dd>{Math.round((active.usage.used / Math.max(active.usage.size, 1)) * 100)}% used</dd>
              </>
            )}
          </dl>
        )}
        <div className="sidebar-actions">
          <button type="button" onClick={onOpenAgents}>
            Open in Agents
          </button>
        </div>
      </section>
    </>
  );
}
