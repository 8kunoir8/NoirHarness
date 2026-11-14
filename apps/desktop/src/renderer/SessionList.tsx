import { useState } from "react";
import { SESSION_STATUS_FACTS, type ModelView, type SessionView } from "@noir/protocol";

export type SessionFilter = "all" | "needs" | "working" | "unread" | "done";

export const FILTERS: Array<{ id: SessionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "unread", label: "Unread" },
  { id: "done", label: "Done" },
];

export type ReadState = Readonly<Record<string, number>>;

/** Filters read kernel metadata only; "unread" compares the newest seq with the last seq shown. */
export function matchesFilter(session: SessionView, filter: SessionFilter, read: ReadState): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs":
      return session.pendingApproval || session.status === "error";
    case "working":
      // The kernel's own `working` filter: live, and not waiting on the user. This copy exists only
      // because `unread` cannot be answered server-side; the rest must not answer differently.
      return SESSION_STATUS_FACTS[session.status].live && !session.pendingApproval;
    case "unread":
      return !SESSION_STATUS_FACTS[session.status].terminal && session.lastEventSeq > (read[session.id] ?? 0);
    case "done":
      return SESSION_STATUS_FACTS[session.status].terminal;
  }
}

export function sortSessions(sessions: readonly SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt);
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface SessionGroup {
  label: "Today" | "Yesterday" | "Earlier";
  sessions: SessionView[];
}

export function groupSessions(sessions: readonly SessionView[], now: number): SessionGroup[] {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const groups: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Earlier", sessions: [] },
  ];
  for (const session of sortSessions(sessions)) {
    const day = startOfDay(session.lastEventAt);
    const group = day >= today ? groups[0]! : day >= yesterday ? groups[1]! : groups[2]!;
    group.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}

export function sessionStatusLabel(session: SessionView): string {
  if (session.pendingApproval) return "Needs you";
  switch (session.status) {
    case "starting":
    case "running":
      return "Working";
    case "waiting":
      return "Waiting";
    case "error":
      return "Error";
    case "closed":
      return "Done";
    default:
      return "Idle";
  }
}

export function sessionStatusTone(session: SessionView): "neutral" | "accent" | "warn" | "danger" | "muted" {
  if (session.pendingApproval) return "warn";
  switch (session.status) {
    case "starting":
    case "running":
      return "accent";
    case "error":
      return "danger";
    case "closed":
      return "muted";
    default:
      return "neutral";
  }
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The glyph beside each filter in the rail; the label still carries the meaning for a reader. */
const FILTER_ICON: Readonly<Record<SessionFilter, string>> = {
  all: "◻",
  needs: "!",
  working: "●",
  unread: "■",
  done: "✕",
};

export interface SessionFiltersProps {
  filter: SessionFilter;
  onFilterChange: (filter: SessionFilter) => void;
}

/**
 * The filter list that lives in the shell's rail. It keeps the accessible group name the list used
 * to carry inline, so only its position in the shell changed.
 */
export function SessionFilters({ filter, onFilterChange }: SessionFiltersProps) {
  return (
    <div className="rail-filters" role="group" aria-label="Chat filters">
      {FILTERS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={filter === entry.id}
          onClick={() => onFilterChange(entry.id)}
        >
          <span className="filter-icon" aria-hidden="true">
            {FILTER_ICON[entry.id]}
          </span>
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function modelLabel(session: SessionView, models: readonly ModelView[]): string | undefined {
  if (session.modelId === null) return undefined;
  const model = models.find((candidate) => candidate.id === session.modelId);
  return model === undefined ? undefined : model.displayName;
}

export interface SessionListProps {
  sessions: readonly SessionView[];
  models: readonly ModelView[];
  activeId?: string | undefined;
  read: ReadState;
  filter: SessionFilter;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (session: SessionView) => void;
  /** Deleting is irreversible, so the row arms it on the first click and only fires on the second. */
  onDelete?: (session: SessionView) => void;
  onNewChat: () => void;
  canCreate: boolean;
  /** True while the kernel has another page behind this one. */
  hasMore?: boolean;
  /** How many sessions match the filter in the kernel, including the pages not loaded. */
  total?: number;
  onLoadMore?: () => void;
  now?: number;
}

export function SessionList({
  sessions,
  models,
  activeId,
  read,
  filter,
  query,
  onQueryChange,
  onSelect,
  onDelete,
  onNewChat,
  canCreate,
  hasMore = false,
  total,
  onLoadMore,
  now = Date.now(),
}: SessionListProps) {
  // One row at a time can be armed: a second click anywhere else re-arms that row instead.
  const [armed, setArmed] = useState<string | undefined>(undefined);
  const needle = query.trim().toLowerCase();
  const visible = sortSessions(sessions).filter(
    (session) =>
      matchesFilter(session, filter, read) &&
      (needle === "" || (session.title === "" ? "untitled chat" : session.title.toLowerCase()).includes(needle)),
  );

  return (
    <div className="session-list">
      <div className="session-list-head">
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button type="button" className="primary" onClick={onNewChat} disabled={!canCreate}>
          New chat
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="empty">
          {sessions.length === 0 ? "No chats yet. Create one to start talking to the agent." : "No chats match this filter."}
        </p>
      ) : (
        groupSessions(visible, now).map((group) => (
          <section key={group.label} className="session-group" aria-label={group.label}>
            <h3>{group.label}</h3>
            <ul>
              {group.sessions.map((session) => {
                const label = session.title === "" ? "Untitled chat" : session.title;
                const meta = modelLabel(session, models);
                const isArmed = armed === session.id;
                return (
                  <li key={session.id} className="session-item">
                    <button
                      type="button"
                      className="session-row"
                      aria-current={session.id === activeId}
                      onClick={() => onSelect(session)}
                    >
                      <span className={`dot dot-${sessionStatusTone(session)}`} aria-hidden="true" />
                      <span className="session-row-main">
                        <span className="session-row-title">{label}</span>
                        <span className="session-row-meta">
                          {sessionStatusLabel(session)}
                          {meta === undefined ? "" : ` · ${meta}`}
                          {session.scheduleId === null ? null : <span className="session-tag">scheduled</span>}
                        </span>
                      </span>
                      <time dateTime={new Date(session.lastEventAt).toISOString()}>{timeLabel(session.lastEventAt)}</time>
                    </button>
                    {onDelete === undefined ? null : (
                      // A sibling, not a child: the row above is itself a button.
                      <button
                        type="button"
                        className="session-delete"
                        data-armed={isArmed}
                        aria-label={isArmed ? `Confirm delete ${label}` : `Delete ${label}`}
                        title={isArmed ? "Click again to delete this chat" : "Delete chat"}
                        onClick={() => {
                          if (isArmed) {
                            setArmed(undefined);
                            onDelete(session);
                            return;
                          }
                          setArmed(session.id);
                        }}
                      >
                        {isArmed ? "Delete?" : "✕"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      {hasMore && onLoadMore !== undefined ? (
        <button type="button" className="load-more" onClick={onLoadMore}>
          Load older chats{total === undefined ? "" : ` (${String(total - sessions.length)} more)`}
        </button>
      ) : null}
    </div>
  );
}
