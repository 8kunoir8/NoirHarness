import type { AgentRosterEntry } from "@noir/protocol";

/**
 * The office action an agent performs. It is derived from the roster alone, so the mapping stays
 * testable without Phaser and the scene never has to interpret roster statuses.
 */
export type OfficeAction = "idle" | "working" | "reading" | "shell" | "blocked" | "error";

export interface OfficePoint {
  x: number;
  y: number;
}

export interface AgentOfficeState {
  agentId: string;
  name: string;
  status: AgentRosterEntry["status"];
  action: OfficeAction;
  desk: OfficePoint;
  /** Index into the map's desk list; published so an E2E can compare the assignment across restarts. */
  deskIndex: number;
  /** What the character says in its speech bubble; `null` only while idle. */
  bubble: string | null;
}

/** Spec §9.5: the office renders at most 32 characters; the rest stay in the roster. */
export const MAX_OFFICE_AGENTS = 32;

/** Spec §9.4: a bubble is truncated at 80 characters so it never covers the map. */
export const MAX_BUBBLE_CHARS = 80;

/**
 * The text a `needs_you` character says. A readable request carries its title; a corrupt one falls
 * back to the category the kernel kept from the approval row. The roster row renders the same text,
 * so the bubble is never the only way to read it.
 */
export function approvalBubbleText(
  entry: Pick<AgentRosterEntry, "status" | "pendingApproval">,
): string | null {
  if (entry.status !== "needs_you") return null;
  const approval = entry.pendingApproval;
  if (approval === null) return null;
  const title = approval.title.trim();
  return (title === "" ? approval.category : title).slice(0, MAX_BUBBLE_CHARS);
}

/** Spec §9.3: `needs_you` wins over the tool kind, and `idle` ignores the last tool. */
export function actionFor(entry: Pick<AgentRosterEntry, "status" | "activeToolKind">): OfficeAction {
  switch (entry.status) {
    case "needs_you":
      return "blocked";
    case "error":
      return "error";
    case "working":
      switch (entry.activeToolKind) {
        case "read":
        case "search":
        case "skill":
          return "reading";
        case "shell":
          return "shell";
        default:
          return "working";
      }
    case "idle":
      return "idle";
  }
}

/** The one word a character says while it works: the action, never a description of the tool. */
const ACTION_LABELS: Record<OfficeAction, string> = {
  idle: "",
  working: "Working",
  reading: "Reading",
  shell: "Shell",
  blocked: "Approval",
  error: "Error",
};

/**
 * The bubble text an agent shows: the approval it is waiting on when there is one, otherwise the
 * single word for what it is doing. Idle characters say nothing, so a quiet room stays quiet.
 */
export function statusBubbleText(
  entry: Pick<AgentRosterEntry, "status" | "activeToolKind" | "pendingApproval">,
): string | null {
  const approval = approvalBubbleText(entry);
  if (approval !== null) return approval;
  const label = ACTION_LABELS[actionFor(entry)];
  return label === "" ? null : label;
}

/**
 * FNV-1a over UTF-16 code units. Pure and platform-independent, so a desk survives a restart on
 * every machine the profile syncs to.
 */
export function hashAgentId(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Assigns one desk index per agent. Ids are processed in sorted order and start at their hashed
 * desk, so the assignment depends on the id set alone — never on roster order or event timing. A
 * collision probes forward to the next free desk; agents beyond the desk count reuse their hashed
 * desk.
 */
export function assignDeskIndices(agentIds: readonly string[], deskCount: number): Map<string, number> {
  const assignment = new Map<string, number>();
  if (deskCount <= 0) return assignment;

  const taken = new Set<number>();
  for (const agentId of [...new Set(agentIds)].sort()) {
    const start = hashAgentId(agentId) % deskCount;
    let index = start;
    for (let probe = 0; probe < deskCount; probe += 1) {
      index = (start + probe) % deskCount;
      if (!taken.has(index)) break;
    }
    // Every desk is occupied: share deterministically instead of dropping the agent.
    if (taken.has(index)) index = start;
    taken.add(index);
    assignment.set(agentId, index);
  }
  return assignment;
}

/** Roster → office states, capped at {@link MAX_OFFICE_AGENTS} in roster order. */
export function toOfficeStates(
  roster: readonly AgentRosterEntry[],
  desks: readonly OfficePoint[],
): AgentOfficeState[] {
  const visible = roster.slice(0, MAX_OFFICE_AGENTS);
  const assignment = assignDeskIndices(
    visible.map((entry) => entry.agentId),
    desks.length,
  );
  const states: AgentOfficeState[] = [];
  for (const entry of visible) {
    const deskIndex = assignment.get(entry.agentId);
    const desk = deskIndex === undefined ? undefined : desks[deskIndex];
    if (deskIndex === undefined || desk === undefined) continue;
    states.push({
      agentId: entry.agentId,
      name: entry.name,
      status: entry.status,
      action: actionFor(entry),
      desk,
      deskIndex,
      bubble: statusBubbleText(entry),
    });
  }
  return states;
}
