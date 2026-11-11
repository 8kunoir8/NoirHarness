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
}

/** Spec §9.5: the office renders at most 32 characters; the rest stay in the roster. */
export const MAX_OFFICE_AGENTS = 32;

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
 * Assigns one desk per agent. Ids are processed in sorted order and start at their hashed desk, so
 * the assignment depends on the id set alone — never on roster order or event timing. A collision
 * probes forward to the next free desk; agents beyond the desk count reuse their hashed desk.
 */
export function assignDesks(
  agentIds: readonly string[],
  desks: readonly OfficePoint[],
): Map<string, OfficePoint> {
  const assignment = new Map<string, OfficePoint>();
  if (desks.length === 0) return assignment;

  const taken = new Set<number>();
  for (const agentId of [...new Set(agentIds)].sort()) {
    const start = hashAgentId(agentId) % desks.length;
    let index = start;
    for (let probe = 0; probe < desks.length; probe += 1) {
      index = (start + probe) % desks.length;
      if (!taken.has(index)) break;
    }
    // Every desk is occupied: share deterministically instead of dropping the agent.
    if (taken.has(index)) index = start;
    taken.add(index);
    const desk = desks[index];
    if (desk !== undefined) assignment.set(agentId, desk);
  }
  return assignment;
}

/** Roster → office states, capped at {@link MAX_OFFICE_AGENTS} in roster order. */
export function toOfficeStates(
  roster: readonly AgentRosterEntry[],
  desks: readonly OfficePoint[],
): AgentOfficeState[] {
  const visible = roster.slice(0, MAX_OFFICE_AGENTS);
  const assignment = assignDesks(
    visible.map((entry) => entry.agentId),
    desks,
  );
  const states: AgentOfficeState[] = [];
  for (const entry of visible) {
    const desk = assignment.get(entry.agentId);
    if (desk === undefined) continue;
    states.push({
      agentId: entry.agentId,
      name: entry.name,
      status: entry.status,
      action: actionFor(entry),
      desk,
    });
  }
  return states;
}
