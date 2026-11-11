import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentRosterEntry, AgentView, ModelView, SessionView, SkillView } from "@noir/protocol";
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
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return request as unknown as RequestMock;
}

function renderAgents(request: RequestMock, onOpenChat = vi.fn()): void {
  render(<Agents workspaceId="w1" request={request as unknown as RequestFn} onOpenChat={onOpenChat} />);
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
    await userEvent.type(within(inspector).getByLabelText("Name"), "Scout");
    await userEvent.click(within(inspector).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(inspector).getByRole("alert").textContent).toContain("Agent name already exists: Scout"),
    );
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
});

describe("App agents rail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps Agents between Chats and Skills and reachable with no model", async () => {
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
          return { agents: [], generatedAt: 1 };
        case "skill.list":
          return { skills: [], shadowed: [], warnings: [] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    });

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
});
