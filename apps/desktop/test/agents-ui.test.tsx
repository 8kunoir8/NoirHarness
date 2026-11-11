import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentEvent, AgentRosterEntry, AgentView, ModelView, SessionView, SkillView } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import type { WorkspaceView } from "../src/renderer/WorkspacePanel.js";

// `App` imports the socket module directly; the component tests pass the same mock in as `request`,
// so one switch covers both the rail wiring and the panel calls.
const appApi = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  offEvent: vi.fn((_listener?: unknown) => undefined),
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
    throw new Error("unmocked request");
  }),
}));
vi.mock("../src/renderer/api.js", () => appApi);

// The canvas itself is covered by `office.test.tsx`; a double keeps Phaser out of jsdom here and
// lets these tests assert the List view toggle, the office props and the selection round trip.
vi.mock("../src/renderer/office/AgentOffice.js", () => ({
  AgentOffice: ({
    states,
    selectedId,
    onSelect,
  }: {
    states: readonly { agentId: string; bubble: string | null }[];
    selectedId?: string | undefined;
    onSelect?: ((agentId: string) => void) | undefined;
  }) => (
    <div data-testid="agent-office" data-count={states.length} data-selected={selectedId ?? ""}>
      {states.map((state) =>
        state.bubble === null ? null : (
          <span key={state.agentId} data-testid="office-bubble">
            {state.bubble}
          </span>
        ),
      )}
      <button
        type="button"
        onClick={() => {
          const first = states[0];
          if (first !== undefined) onSelect?.(first.agentId);
        }}
      >
        Select first character
      </button>
    </div>
  ),
}));

import { Agents } from "../src/renderer/Agents.js";
import { App } from "../src/renderer/App.js";

type RequestMock = Mock<(method: string, params?: unknown) => Promise<unknown>>;

const AGENT: AgentView = {
  id: "a-1",
  name: "Scout",
  role: "Coder",
  engineId: "acp",
  modelRef: null,
  permissionPolicy: {},
  defaultWorkspaceId: null,
  mcpServerIds: [],
  archivedAt: null,
  createdAt: 1,
};

const ROSTER: AgentRosterEntry = {
  agentId: "a-1",
  name: "Scout",
  role: "Coder",
  status: "working",
  activeSessionId: "s-1",
  activeSessionStatus: "running",
  activeToolKind: "read",
  sessionCount: 2,
  lastActivityAt: 1,
  usage: null,
  pendingApproval: null,
};

const MODEL: ModelView = {
  id: "m-1",
  providerId: "p-1",
  modelId: "mock-1",
  displayName: "Mock One",
  contextWindow: 200_000,
  maxTokens: null,
  enabled: true,
  createdAt: 1,
  engine: "acp",
};

const WORKSPACE: WorkspaceView = {
  id: "w1",
  projectId: "p1",
  path: "C:/work/demo",
  branch: null,
  kind: "git",
  status: "clean",
};

const SESSION: SessionView = {
  id: "s-new",
  workspaceId: "w1",
  agentId: "a-1",
  engine: "acp",
  title: "Scout chat",
  status: "starting",
  modelId: null,
  createdAt: 2,
  lastEventSeq: 0,
  lastEventAt: 2,
  pendingApproval: false,
};

const SKILL: SkillView = {
  scope: "project",
  name: "pdf",
  description: "Render and extract PDFs",
  hash: "h1",
  enabled: true,
};

/** The five `agent.*` fields plus the lists every panel reads; each test overrides what it asserts. */
function makeRequest(overrides: Partial<Record<string, (params?: unknown) => unknown>> = {}): RequestMock {
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const override = overrides[method];
    if (override !== undefined) return override(params);
    switch (method) {
      case "agent.list":
        return { agents: [] };
      case "agent.roster":
        return { agents: [], generatedAt: 1 };
      case "model.list":
        return { models: [] };
      case "workspace.list":
        return { workspaces: [] };
      case "skill.list":
        return { skills: [], shadowed: [], warnings: [] };
      case "mcp.list":
        return { servers: [] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return request as unknown as RequestMock;
}

function renderAgents(request: RequestMock, onOpenChat = vi.fn()): void {
  render(<Agents workspaceId="w1" request={request as unknown as RequestFn} onOpenChat={onOpenChat} />);
}

function rosterCalls(request: RequestMock): number {
  return request.mock.calls.filter(([method]) => method === "agent.roster").length;
}

/** A broadcast frame; only `type` matters to the roster listener. */
function frame(type: AgentEvent["type"]): AgentEvent {
  return {
    v: 1,
    id: `${type}-1`,
    seq: 1,
    ts: 1,
    sessionId: "s-1",
    agentId: "a-1",
    parentAgentId: null,
    turnId: null,
    type,
    payload: {},
    provenance: { engine: "acp", engineName: "test", adapterVersion: "0" },
  };
}

/** The roster is the region named `Agents`; the inspector is the region named `Agent config`. */
function roster(): HTMLElement {
  return screen.getByRole("region", { name: "Agents" });
}

function config(): HTMLElement {
  return screen.getByRole("region", { name: "Agent config" });
}

describe("Agents", () => {
  it("offers Create agent when no agents exist", async () => {
    renderAgents(makeRequest());

    expect(await within(roster()).findByText("No agents yet")).toBeTruthy();
    expect(within(roster()).getByRole("button", { name: "Create agent" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Office" })).toBeTruthy();
  });

  it("rejects a blank name without calling agent.create", async () => {
    const request = makeRequest({ "agent.list": () => ({ agents: [AGENT] }) });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Create agent" }));
    const inspector = config();
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    expect(within(inspector).getByRole("alert").textContent).toContain("Name is required");
    expect(request.mock.calls.some(([method]) => method === "agent.create")).toBe(false);
  });

  it("shows the kernel's duplicate-name error inline", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.create": () => {
        throw new Error("Agent name already exists: Scout");
      },
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Create agent" }));
    const inspector = config();
    const nameInput = within(inspector).getByLabelText("Name");
    await userEvent.type(nameInput, "Scout Copy");
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(inspector).getByRole("alert").textContent).toContain("Agent name already exists: Scout"),
    );
    // A failed save must not discard what the user typed.
    expect((nameInput as HTMLInputElement).value).toBe("Scout Copy");
  });

  it("toggles the office canvas against the roster list view", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [ROSTER], generatedAt: 1 }),
    });
    renderAgents(request);

    expect(await screen.findByTestId("agent-office")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.queryByTestId("agent-office")).toBeNull();
    expect(within(roster()).getByRole("button", { name: "Select Scout" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Office view" }));
    expect(await screen.findByTestId("agent-office")).toBeTruthy();
  });

  it("renders roster status text and starts a session from the row", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [ROSTER], generatedAt: 1 }),
      "session.create": () => SESSION,
    });
    const onOpenChat = vi.fn();
    renderAgents(request, onOpenChat);

    expect(await within(roster()).findByText("Working")).toBeTruthy();
    await userEvent.click(within(roster()).getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("session.create", { workspaceId: "w1", agentId: "a-1" }),
    );
    expect(onOpenChat).toHaveBeenCalledWith(SESSION);
  });

  it("saves the permission matrix as a full policy", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.update": (params) => ({ ...AGENT, ...(params as Partial<AgentView>) }),
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const inspector = config();
    const shell = within(inspector).getByRole("group", { name: "shell" });
    await userEvent.click(within(shell).getByRole("radio", { name: "Allow" }));
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.update",
        expect.objectContaining({
          id: "a-1",
          permissionPolicy: expect.objectContaining({ shell: "allow", delete: "ask", network: "ask" }),
        }),
      ),
    );
  });

  it("archives an agent and drops it from the default list", async () => {
    let agents: AgentView[] = [AGENT];
    const request = makeRequest({
      "agent.list": () => ({ agents }),
      "agent.archive": () => {
        agents = [];
        return { ok: true };
      },
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    await userEvent.click(within(config()).getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("agent.archive", { id: "a-1", archived: true }));
    await waitFor(() => expect(within(roster()).queryByRole("button", { name: "Select Scout" })).toBeNull());
    expect(within(roster()).getByText("No agents yet")).toBeTruthy();
  });

  it("lists available skills read-only, with no per-skill control", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "skill.list": () => ({ skills: [SKILL], shadowed: [], warnings: [] }),
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const inspector = config();
    const available = await within(inspector).findByRole("list", { name: "Available skills" });
    expect(available.textContent).toContain("pdf");
    expect(available.textContent).toContain("Render and extract PDFs");
    expect(within(available).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(inspector).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("only sends a model override the user picked in the start panel", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "model.list": () => ({ models: [MODEL] }),
      "session.create": () => SESSION,
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const office = screen.getByRole("region", { name: "Office" });
    expect(await within(office).findByRole("option", { name: "Mock One" })).toBeTruthy();
    await userEvent.selectOptions(within(office).getByLabelText("Start model"), MODEL.id);
    await userEvent.click(within(office).getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("session.create", {
        workspaceId: "w1",
        agentId: "a-1",
        modelId: "m-1",
      }),
    );
  });

  it("saves a role-only edit when the stored model was deleted", async () => {
    // The kernel only validates a model when `engineId`/`modelRef` is present; re-sending the whole
    // profile would fail here and lose the role edit.
    const orphaned: AgentView = { ...AGENT, modelRef: "m-deleted" };
    const request = makeRequest({
      "agent.list": () => ({ agents: [orphaned] }),
      "agent.update": (params) => ({ ...orphaned, ...(params as Partial<AgentView>) }),
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const inspector = config();
    const roleInput = within(inspector).getByLabelText("Role");
    await userEvent.clear(roleInput);
    await userEvent.type(roleInput, "Reviewer");
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.update", { id: "a-1", role: "Reviewer" }),
    );
    expect(within(inspector).queryByRole("alert")).toBeNull();
  });

  it("sends modelRef null when the default model is cleared", async () => {
    const withModel: AgentView = { ...AGENT, modelRef: MODEL.id };
    const request = makeRequest({
      "agent.list": () => ({ agents: [withModel] }),
      "model.list": () => ({ models: [MODEL] }),
      "agent.update": (params) => ({ ...withModel, ...(params as Partial<AgentView>) }),
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const inspector = config();
    await userEvent.selectOptions(within(inspector).getByLabelText("Default model"), "");
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.update", { id: "a-1", modelRef: null }),
    );
  });

  it("shows a not-found update error inline", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "model.list": () => ({ models: [MODEL] }),
      "agent.update": () => {
        throw new Error("Model not found: m-1");
      },
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const inspector = config();
    await userEvent.selectOptions(within(inspector).getByLabelText("Default model"), MODEL.id);
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(inspector).getByRole("alert").textContent).toContain("Model not found: m-1"),
    );
  });

  it("distinguishes needs-you rows from error rows", async () => {
    const second: AgentView = { ...AGENT, id: "a-2", name: "Builder" };
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT, second] }),
      "agent.roster": () => ({
        agents: [
          { ...ROSTER, status: "needs_you", activeToolKind: null, usage: null },
          { ...ROSTER, agentId: "a-2", name: "Builder", status: "error", activeToolKind: null, usage: null },
        ],
        generatedAt: 1,
      }),
    });
    renderAgents(request);

    const needsYou = await within(roster()).findByText("Needs you");
    const failed = within(roster()).getByText("Error");
    expect(needsYou).not.toBe(failed);
    expect(needsYou.getAttribute("data-status")).toBe("needs_you");
    expect(failed.getAttribute("data-status")).toBe("error");
  });

  it("shows the active tool and context share on a working row", async () => {
    const working: AgentRosterEntry = { ...ROSTER, usage: { used: 62_000, size: 100_000 } };
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [working], generatedAt: 1 }),
    });
    renderAgents(request);

    const meta = await within(roster()).findByText(/context/);
    expect(meta.textContent).toContain("Tool: read");
    expect(meta.textContent).toContain("62% context");
  });

  it("coalesces a broadcast burst into one roster refresh and ignores unrelated events", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [ROSTER], generatedAt: 1 }),
    });
    renderAgents(request);
    await waitFor(() => expect(rosterCalls(request)).toBe(1));

    const listener = appApi.connect.mock.calls.at(-1)?.[0] as ((event: AgentEvent) => void) | undefined;
    expect(listener).toBeTypeOf("function");
    act(() => {
      for (const type of [
        "session.status",
        "turn.started",
        "tool.started",
        "permission.requested",
        "usage.updated",
      ] as const) {
        listener?.(frame(type));
      }
    });

    await waitFor(() => expect(rosterCalls(request)).toBe(2));

    // A message delta cannot change the roster, so it must not schedule a fetch either.
    act(() => listener?.(frame("message.delta")));
    const settled = Promise.withResolvers<void>();
    setTimeout(settled.resolve, 350);
    await settled.promise;
    expect(rosterCalls(request)).toBe(2);
  });

  it("keeps the newest roster snapshot when a slow full load answers after a refresh", async () => {
    const loadRoster = Promise.withResolvers<{ agents: AgentRosterEntry[]; generatedAt: number }>();
    let rosterCall = 0;
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => {
        rosterCall += 1;
        return rosterCall === 1
          ? loadRoster.promise
          : { agents: [{ ...ROSTER, status: "needs_you" }], generatedAt: 2 };
      },
    });
    renderAgents(request);
    await waitFor(() => expect(rosterCalls(request)).toBe(1));

    const listener = appApi.connect.mock.calls.at(-1)?.[0] as ((event: AgentEvent) => void) | undefined;
    act(() => listener?.(frame("permission.requested")));
    await waitFor(() => expect(rosterCalls(request)).toBe(2), { timeout: 2000 });

    // The refresh applied its newer snapshot while the mount batch was still pending; the older
    // answer arriving late must not roll the row (and its `needs_you` bubble) back.
    await act(async () => {
      loadRoster.resolve({ agents: [{ ...ROSTER, status: "idle", activeToolKind: null }], generatedAt: 1 });
    });

    expect(await within(roster()).findByText("Needs you")).toBeTruthy();
    expect(within(roster()).queryByText("Idle")).toBeNull();
  });

  it("keeps an unsaved draft when focus moves to another roster row", async () => {
    const second: AgentView = { ...AGENT, id: "a-2", name: "Builder" };
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT, second] }),
      "agent.roster": () => ({
        agents: [ROSTER, { ...ROSTER, agentId: "a-2", name: "Builder" }],
        generatedAt: 1,
      }),
    });
    renderAgents(request);

    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Scout" }));
    const name = within(config()).getByLabelText("Name") as HTMLInputElement;
    await userEvent.type(name, " Edited");
    expect(name.value).toBe("Scout Edited");

    act(() => within(roster()).getByRole("button", { name: "Select Builder" }).focus());

    // Focus highlights Builder's character without moving the inspector, so the Scout draft stays.
    expect((within(config()).getByLabelText("Name") as HTMLInputElement).value).toBe("Scout Edited");
    expect(screen.getByTestId("agent-office").getAttribute("data-selected")).toBe("a-2");
  });

  it("keeps the roster and office selection in sync in both directions", async () => {
    const second: AgentView = { ...AGENT, id: "a-2", name: "Builder" };
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT, second] }),
      "agent.roster": () => ({
        agents: [ROSTER, { ...ROSTER, agentId: "a-2", name: "Builder", activeSessionId: "s-2" }],
        generatedAt: 1,
      }),
    });
    renderAgents(request);

    const office = await screen.findByTestId("agent-office");
    await userEvent.click(await within(roster()).findByRole("button", { name: "Select Builder" }));
    expect(office.getAttribute("data-selected")).toBe("a-2");

    await userEvent.click(within(office).getByRole("button", { name: "Select first character" }));
    expect(within(roster()).getByRole("button", { name: "Select Scout" }).getAttribute("aria-pressed")).toBe("true");
    expect(office.getAttribute("data-selected")).toBe("a-1");
  });

  it("opens the active chat with Enter on a roster row", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [ROSTER], generatedAt: 1 }),
    });
    const onOpenChat = vi.fn();
    renderAgents(request, onOpenChat);

    const row = await within(roster()).findByRole("button", { name: "Select Scout" });
    act(() => row.focus());
    await userEvent.keyboard("{Enter}");

    expect(onOpenChat).toHaveBeenCalledWith({ id: "s-1" });
  });

  it("shows the approval title in the office bubble and the roster row", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({
        agents: [
          {
            ...ROSTER,
            status: "needs_you",
            pendingApproval: { approvalId: "ap-1", title: "Run rm -rf build", category: "shell" },
          },
        ],
        generatedAt: 1,
      }),
    });
    renderAgents(request);

    const bubble = await screen.findByTestId("office-bubble");
    expect(bubble.textContent).toBe("Run rm -rf build");
    // The roster is the accessible copy: the bubble must never be the only place this text lives.
    expect(within(roster()).getByText("Run rm -rf build")).toBeTruthy();
    expect(within(roster()).getByText("Needs you").getAttribute("data-status")).toBe("needs_you");
  });

  it("renders the HUD context bar and opens the active chat", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({
        agents: [{ ...ROSTER, usage: { used: 62_000, size: 100_000 } }],
        generatedAt: 1,
      }),
    });
    const onOpenChat = vi.fn();
    renderAgents(request, onOpenChat);

    const office = screen.getByRole("region", { name: "Office" });
    const bar = await within(office).findByRole("progressbar", { name: "Context usage" });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(within(office).getByText(/Context 62/)).toBeTruthy();

    await userEvent.click(within(office).getByRole("button", { name: "Open chat" }));
    expect(onOpenChat).toHaveBeenCalledWith({ id: "s-1" });
  });

  it("focuses the inspector from the Configure button", async () => {
    const request = makeRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.roster": () => ({ agents: [ROSTER], generatedAt: 1 }),
    });
    renderAgents(request);

    const office = screen.getByRole("region", { name: "Office" });
    await userEvent.click(await within(office).findByRole("button", { name: "Configure" }));
    expect(document.activeElement).toBe(config());
  });
});

describe("App agents rail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function stubAppRequests(roster: AgentRosterEntry[] = []): void {
    appApi.request.mockReset();
    appApi.request.mockImplementation(async (method: string): Promise<unknown> => {
      switch (method) {
        case "system.health":
          return { status: "ok", pid: 1, engineDir: "engine" };
        case "project.list":
          return { projects: [] };
        case "workspace.list":
          return { workspaces: [WORKSPACE] };
        case "model.list":
          return { models: [] };
        case "session.list":
          return { sessions: [] };
        case "agent.list":
          return { agents: [AGENT] };
        case "agent.roster":
          return { agents: roster, generatedAt: 1 };
        case "skill.list":
          return { skills: [], shadowed: [], warnings: [] };
        case "mcp.list":
          return { servers: [] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
  }

  it("keeps Agents between Chats and Skills and reachable with no model", async () => {
    stubAppRequests();

    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const names = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names.slice(0, 3)).toEqual(["Chats", "Agents", "Skills"]);

    await userEvent.click(within(nav).getByRole("button", { name: "Agents" }));
    // The setup redirect used to swallow every view while `model.list` was empty; an agent with no
    // model must still be configurable, so the rail button must land on the roster.
    expect(await screen.findByRole("region", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Office" })).toBeTruthy();
  });

  it("focuses the agent inspector with C, but never while typing in the form", async () => {
    stubAppRequests([ROSTER]);
    render(<App />);

    const nav = screen.getByRole("navigation", { name: "Main" });
    await userEvent.click(within(nav).getByRole("button", { name: "Agents" }));
    const inspector = await screen.findByRole("region", { name: "Agent config" });

    await userEvent.keyboard("c");
    expect(document.activeElement).toBe(inspector);

    const name = within(inspector).getByLabelText("Name") as HTMLInputElement;
    await userEvent.click(name);
    await userEvent.keyboard("c");
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("Scoutc");
  });
});
