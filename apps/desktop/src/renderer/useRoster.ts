import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentRosterEntry, AgentRosterResult } from "@noir/protocol";
import { connect, offEvent, type RequestFn } from "./api.js";
import { coalesce } from "./defer.js";

/** Trailing window for the live roster refresh: a burst of events costs one `agent.roster` call. */
const ROSTER_REFRESH_MS = 250;

/** Nobody to draw; stable so the office's memo does not see a fresh array on every render. */
const NO_AGENTS: AgentRosterEntry[] = [];

/**
 * Broadcast events that can change the roster. Everything else (message deltas, file changes) is
 * irrelevant to status, the active tool and the context share, so it must not schedule a fetch.
 */
function refreshesRoster(type: AgentEvent["type"]): boolean {
  return (
    type === "session.status" ||
    type === "usage.updated" ||
    type.startsWith("turn.") ||
    type.startsWith("tool.") ||
    type.startsWith("permission.")
  );
}

/** The office renders seated states instead of walking when the OS asks for reduced motion. */
export function useReducedMotion(): boolean {
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

export interface RosterOptions {
  /**
   * Re-read on every broadcast that can change the roster, and read once on mount. The shell's
   * always-visible panes need this; a view whose batch load owns the first read passes `false` and
   * applies its own answer instead, so one screen never holds two subscriptions to one fact.
   */
  subscribe?: boolean;
  /**
   * Read once on mount. Off for a view whose batch load already asks for the roster, so mounting it
   * costs one request rather than two.
   */
  initial?: boolean;
}

export interface RosterHandle {
  /** The newest snapshot, or `undefined` until the first read lands. */
  roster: AgentRosterEntry[] | undefined;
  /**
   * Takes the ticket a caller must present with its answer. Read it *before* the request: a refresh
   * may overlap another refresh or a batch load, and only the newest ticket may win, or a late
   * answer would roll status, the active tool and a `needs_you` bubble back to an older value.
   */
  nextSnapshot: () => number;
  /** Writes a snapshot fetched elsewhere (a batch load, a mutation) under its ticket. */
  apply: (snapshot: number, entries: AgentRosterEntry[]) => void;
  /** Reads the roster now and applies it; a failure keeps the last good snapshot. */
  refresh: () => Promise<void>;
}

/** One live `agent.roster` snapshot, plus the ticket scheme that keeps overlapping reads ordered. */
export function useRoster(request: RequestFn, { subscribe = false, initial = false }: RosterOptions = {}): RosterHandle {
  const [roster, setRoster] = useState<AgentRosterEntry[] | undefined>(undefined);
  const seq = useRef(0);
  const applied = useRef(0);

  const nextSnapshot = useCallback((): number => ++seq.current, []);

  const apply = useCallback((snapshot: number, entries: AgentRosterEntry[]): void => {
    if (snapshot <= applied.current) return;
    applied.current = snapshot;
    setRoster(entries);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = nextSnapshot();
    try {
      // The first read runs on mount, when the window may still be opening the socket: a request
      // refused for that reason would be cached as "nobody in the roster" and nothing would read
      // again until some unrelated event arrived. Waiting for the socket keeps the empty state
      // meaning what it says.
      await connect().catch(() => undefined);
      const result = await request<AgentRosterResult>("agent.roster", {});
      apply(snapshot, result.agents);
    } catch {
      // Failures keep the last good snapshot. Before any snapshot exists the pane has to leave
      // "reading" and say there is nobody to draw; the kernel banner carries the real error.
      if (applied.current === 0) setRoster((current) => current ?? NO_AGENTS);
    }
  }, [request, nextSnapshot, apply]);

  useEffect(() => {
    if (!subscribe) return;
    if (initial) void refresh();
    // Many events in one burst schedule exactly one fetch.
    const soon = coalesce(ROSTER_REFRESH_MS, () => void refresh());
    const listener = (event: AgentEvent): void => {
      if (!refreshesRoster(event.type)) return;
      soon.schedule();
    };
    void connect(listener).catch(() => undefined);
    return () => {
      soon.cancel();
      offEvent(listener);
    };
  }, [subscribe, initial, refresh]);

  return { roster, nextSnapshot, apply, refresh };
}
