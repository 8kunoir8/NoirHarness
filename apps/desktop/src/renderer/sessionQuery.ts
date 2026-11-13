import type { SessionView } from "@noir/protocol";
import type { SessionFilter } from "./SessionList.js";

/** What the list asks the kernel for; the kernel cannot answer "unread", so it is not sent. */
export interface SessionListQuery {
  limit: number;
  workspaceId?: string;
  filter?: "needs_you" | "working" | "done";
  search?: string;
  cursor?: string;
}

/** The window renders a page; a hundred rows is more than a person scrolls before filtering. */
export const SESSION_PAGE = 100;

const KERNEL_FILTER: Partial<Record<SessionFilter, SessionListQuery["filter"]>> = {
  needs: "needs_you",
  working: "working",
  done: "done",
};

export function sessionListQuery(input: {
  filter: SessionFilter;
  query: string;
  workspaceId: string;
  cursor?: string | undefined;
  limit?: number;
}): SessionListQuery {
  const query: SessionListQuery = { limit: input.limit ?? SESSION_PAGE };
  if (input.workspaceId !== "") query.workspaceId = input.workspaceId;
  const filter = KERNEL_FILTER[input.filter];
  if (filter !== undefined) query.filter = filter;
  const search = input.query.trim();
  if (search !== "") query.search = search;
  if (input.cursor !== undefined) query.cursor = input.cursor;
  return query;
}

/**
 * Merges a page into what is already shown. Rows are keyed by id: a session that moved because it
 * just took a turn replaces its old copy instead of appearing twice.
 */
export function mergeSessions(current: readonly SessionView[], page: readonly SessionView[]): SessionView[] {
  const seen = new Set(page.map((session) => session.id));
  const kept = current.filter((session) => !seen.has(session.id));
  return [...kept, ...page];
}

/** Unread is the window's own question — it depends on what each tab has rendered. */
export function countUnread(sessions: readonly SessionView[], read: Readonly<Record<string, number>>): number {
  return sessions.filter((session) => session.status !== "closed" && session.lastEventSeq > (read[session.id] ?? 0)).length;
}
