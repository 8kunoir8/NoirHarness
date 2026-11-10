import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelView, SessionView } from "@noir/protocol";
import {
  groupSessions,
  matchesFilter,
  SessionList,
  type ReadState,
  type SessionFilter,
} from "../src/renderer/SessionList.js";

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id,
    workspaceId: "ws-1",
    agentId: "agent-1",
    engine: "omp",
    title: `Chat ${id}`,
    status: "idle",
    modelId: "model-1",
    createdAt: NOW - 3_600_000,
    lastEventSeq: 1,
    lastEventAt: NOW - 600_000,
    pendingApproval: false,
    ...patch,
  };
}

const model: ModelView = {
  id: "model-1",
  providerId: "provider-1",
  modelId: "mock-1",
  displayName: "Mock One",
  contextWindow: 200_000,
  maxTokens: null,
  enabled: true,
  createdAt: NOW,
};

function filterIds(sessions: readonly SessionView[], filter: SessionFilter, read: ReadState = {}): string[] {
  return sessions.filter((entry) => matchesFilter(entry, filter, read)).map((entry) => entry.id);
}

describe("matchesFilter", () => {
  const sessions = [
    session("idle"),
    session("running", { status: "running", lastEventSeq: 4 }),
    session("waiting", { status: "waiting" }),
    session("approval", { status: "waiting", pendingApproval: true, lastEventSeq: 2 }),
    session("error", { status: "error" }),
    session("closed", { status: "closed" }),
  ];

  it("separates the buckets", () => {
    expect(filterIds(sessions, "all")).toHaveLength(6);
    expect(filterIds(sessions, "needs")).toEqual(["approval", "error"]);
    expect(filterIds(sessions, "working")).toEqual(["running", "waiting"]);
    expect(filterIds(sessions, "done")).toEqual(["closed"]);
  });

  it("treats a session as unread until the read watermark reaches its newest event", () => {
    expect(filterIds(sessions, "unread")).toEqual(["idle", "running", "waiting", "approval", "error"]);
    expect(filterIds(sessions, "unread", { idle: 1, running: 4, waiting: 1, approval: 2, error: 1 })).toEqual([]);
    // Closed chats never resurface as unread.
    expect(filterIds(sessions, "unread", {})).not.toContain("closed");
  });
});

describe("groupSessions", () => {
  it("buckets by local day and orders newest first inside a bucket", () => {
    const groups = groupSessions(
      [
        session("old", { lastEventAt: NOW - 5 * 86_400_000 }),
        session("today-early", { lastEventAt: NOW - 3_600_000 }),
        session("today-late", { lastEventAt: NOW - 60_000 }),
        session("yesterday", { lastEventAt: NOW - 86_400_000 }),
      ],
      NOW,
    );
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups[0]?.sessions.map((entry) => entry.id)).toEqual(["today-late", "today-early"]);
    expect(groups[1]?.sessions.map((entry) => entry.id)).toEqual(["yesterday"]);
    expect(groups[2]?.sessions.map((entry) => entry.id)).toEqual(["old"]);
  });

  it("omits empty buckets", () => {
    expect(groupSessions([session("only")], NOW).map((group) => group.label)).toEqual(["Today"]);
  });
});

function renderList(sessions: SessionView[], read: ReadState = {}, query = "") {
  const onSelect = vi.fn();
  const onNewChat = vi.fn();
  render(
    <SessionList
      sessions={sessions}
      models={[model]}
      query={query}
      filter="all"
      onFilterChange={() => undefined}
      onQueryChange={() => undefined}
      onSelect={onSelect}
      onNewChat={onNewChat}
      canCreate
      now={NOW}
    />,
  );
  return { onSelect, onNewChat };
}

describe("SessionList", () => {
  it("renders rows with status, model and time", () => {
    renderList([session("a", { title: "Refactor kernel" })]);
    const row = screen.getByRole("button", { name: /Refactor kernel/ });
    expect(row.textContent).toContain("Idle · Mock One");
    expect(row.getAttribute("aria-current")).toBe("false");
    expect(screen.getByRole("group", { name: "Chat filters" })).toBeTruthy();
  });

  it("selects a row and starts a new chat", async () => {
    const user = userEvent.setup();
    const { onSelect, onNewChat } = renderList([session("a", { title: "Refactor kernel" })]);
    await user.click(screen.getByRole("button", { name: /Refactor kernel/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when nothing matches the query", () => {
    renderList([session("a", { title: "Refactor kernel" })], {}, "zzz");
    expect(screen.queryByRole("button", { name: /Refactor kernel/ })).toBeNull();
    expect(screen.getByText("No chats match this filter.")).toBeTruthy();
  });

  it("labels a missing title as Untitled chat", () => {
    renderList([session("a", { title: "" })]);
    expect(screen.getByRole("button", { name: /Untitled chat/ })).toBeTruthy();
  });
});
