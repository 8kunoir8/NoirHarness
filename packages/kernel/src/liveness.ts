import type { SessionView } from "@noir/protocol";
import { SESSION_STATUS_FACTS } from "@noir/protocol";

/**
 * Sessions whose death would discard work. A replacement stops the daemon, so these are exactly the
 * states that make stopping a question instead of a fact — the same question the protocols's
 * `SessionStatusFacts.live` answers, so this cannot disagree with the rest of the kernel.
 */
export function liveCount(views: SessionView[]): number {
  let live = 0;
  for (const view of views) if (SESSION_STATUS_FACTS[view.status].live) live += 1;
  return live;
}
