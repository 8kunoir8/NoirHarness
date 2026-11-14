import { describe, expect, it } from "vitest";
import type { SessionView } from "@noir/protocol";
import { mergeSessions, sessionListQuery, SESSION_PAGE } from "../src/renderer/sessionQuery.js";
import { SessionList } from "../src/renderer/SessionList.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function session(patch: Partial<SessionView> & Pick<SessionView, "id">): SessionView {
  return {
    workspaceId: "w1",
    agentId: "a1",
    engine: "acp",
    title: "",
    status: "idle",
    modelId: null,
    scheduleId: null,
    createdAt: 1,
    lastEventSeq: 0,
    lastEventAt: 1,
    pendingApproval: false,
    ...patch,
  };
}

describe("sessionListQuery", () => {
  it("asks for a page of the current workspace and nothing else by default", () => {
    expect(sessionListQuery({ filter: "all", query: "", workspaceId: "w1" })).toEqual({
      limit: SESSION_PAGE,
      workspaceId: "w1",
    });
  });

  it("sends the filters the kernel can answer and leaves unread behind", () => {
    expect(sessionListQuery({ filter: "needs", query: "", workspaceId: "" }).filter).toBe("needs_you");
    expect(sessionListQuery({ filter: "working", query: "", workspaceId: "" }).filter).toBe("working");
    expect(sessionListQuery({ filter: "done", query: "", workspaceId: "" }).filter).toBe("done");
    expect(sessionListQuery({ filter: "unread", query: "", workspaceId: "" }).filter).toBeUndefined();
  });

  it("trims the search and keeps a cursor only when paging", () => {
    expect(sessionListQuery({ filter: "all", query: "  nightly ", workspaceId: "" }).search).toBe("nightly");
    expect(sessionListQuery({ filter: "all", query: "   ", workspaceId: "" }).search).toBeUndefined();
    expect(sessionListQuery({ filter: "all", query: "", workspaceId: "", cursor: "10:s1" }).cursor).toBe("10:s1");
  });
});

describe("mergeSessions", () => {
  it("replaces a row that moved instead of showing it twice", () => {
    const older = session({ id: "s1", lastEventAt: 1 });
    const moved = session({ id: "s2", lastEventAt: 2 });
    const page = session({ id: "s2", lastEventAt: 9 });
    expect(mergeSessions([older, moved], [page]).map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(mergeSessions([older, moved], [page]).find((entry) => entry.id === "s2")?.lastEventAt).toBe(9);
  });
});

describe("SessionList paging", () => {
  const base = {
    models: [],
    read: {},
    filter: "all" as const,
    onFilterChange: () => undefined,
    query: "",
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    onNewChat: () => undefined,
    canCreate: true,
  };

  it("says how many more the kernel holds and asks for them once", async () => {
    const user = userEvent.setup();
    const loads: number[] = [];
    render(<SessionList {...base} sessions={[session({ id: "s1" })]} hasMore total={7} onLoadMore={() => loads.push(1)} />);
    const button = screen.getByRole("button", { name: /Load older chats/ });
    expect(button.textContent).toContain("6 more");
    await user.click(button);
    expect(loads).toHaveLength(1);
  });

  it("offers nothing to load when the kernel has no next page", () => {
    render(<SessionList {...base} sessions={[session({ id: "s1" })]} total={1} onLoadMore={() => undefined} />);
    expect(screen.queryByRole("button", { name: /Load older chats/ })).toBeNull();
  });
});

describe("SessionList delete", () => {
  const base = {
    models: [],
    read: {},
    filter: "all" as const,
    query: "",
    onQueryChange: () => undefined,
    onSelect: () => undefined,
    onNewChat: () => undefined,
    canCreate: true,
  };

  it("arms the row on the first click and only deletes on the second", async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    render(
      <SessionList
        {...base}
        sessions={[session({ id: "s1", title: "Fix the parser" })]}
        onDelete={(target) => deleted.push(target.id)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete Fix the parser" }));
    expect(deleted).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Confirm delete Fix the parser" }));
    expect(deleted).toEqual(["s1"]);
    // One delete per arming: the row is no longer armed after it fires.
    expect(screen.getByRole("button", { name: "Delete Fix the parser" })).toBeTruthy();
  });

  it("moves the arming to the row that was clicked last", async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    render(
      <SessionList
        {...base}
        sessions={[session({ id: "s1", title: "First" }), session({ id: "s2", title: "Second" })]}
        onDelete={(target) => deleted.push(target.id)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete First" }));
    await user.click(screen.getByRole("button", { name: "Delete Second" }));
    expect(deleted).toEqual([]);
    expect(screen.queryByRole("button", { name: "Confirm delete First" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm delete Second" }));
    expect(deleted).toEqual(["s2"]);
  });

  it("offers no delete control when the caller cannot delete", () => {
    render(<SessionList {...base} sessions={[session({ id: "s1", title: "Tea" })]} />);
    expect(screen.queryByRole("button", { name: "Delete Tea" })).toBeNull();
  });
});
