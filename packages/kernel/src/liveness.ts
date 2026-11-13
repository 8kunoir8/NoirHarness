import type { SessionView } from "@noir/protocol";

/**
 * Sessions whose death would discard work. A replacement stops the daemon, so these are exactly the
 * states that make stopping a question instead of a fact.
 */
const LIVE: Record<string, true> = { starting: true, running: true, waiting: true };

export function liveCount(views: SessionView[]): number {
  let live = 0;
  for (const view of views) if (LIVE[view.status] === true) live += 1;
  return live;
}
