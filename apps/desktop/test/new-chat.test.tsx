import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appApi = vi.hoisted(() => ({
  connect: vi.fn(async (_listener?: unknown) => undefined),
  kernelInfo: vi.fn(async () => ({ port: 1, token: "t", buildMatches: true, daemon: true })),
  reportArmed: vi.fn(),
  offEvent: vi.fn((_listener?: unknown) => undefined),
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
    throw new Error("unmocked request");
  }),
}));
vi.mock("../src/renderer/api.js", () => appApi);

import { App } from "../src/renderer/App.js";

const MODEL = {
  id: "m1",
  providerId: "pr1",
  modelId: "mock-1",
  displayName: "Mock",
  contextWindow: 200_000,
  maxTokens: null,
  enabled: true,
  createdAt: 1,
  engine: "acp",
};

const NOIR = {
  id: "default",
  name: "Noir",
  role: "Generalist",
  engineId: "acp",
  modelRef: null,
  permissionPolicy: {},
  defaultWorkspaceId: null,
  mcpServerIds: [],
  archivedAt: null,
  createdAt: 1,
};

const SCOUT = { ...NOIR, id: "a-2", name: "Scout", role: "Engineer", createdAt: 2 };

function stubApp(): void {
  appApi.request.mockReset();
  appApi.request.mockImplementation(async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "system.health":
        return { status: "ok", pid: 1, engineDir: "engine", version: "0.1.0" };
      case "project.list":
        return { projects: [] };
      case "workspace.list":
        return { workspaces: [{ id: "w1", projectId: "p1", path: "C:/ws", branch: null, kind: "git", status: "clean" }] };
      case "model.list":
        return { models: [MODEL] };
      case "agent.list":
        return { agents: [NOIR, SCOUT], defaultAgentId: "default" };
      case "agent.roster":
        return { agents: [], generatedAt: 1 };
      case "session.list":
        return { sessions: [], total: 0, nextCursor: null };
      case "session.create": {
        const agentId = typeof params === "object" && params !== null && "agentId" in params ? params.agentId : null;
        return {
          id: `s-${String(agentId)}`,
          workspaceId: "w1",
          agentId,
          engine: "acp",
          title: "",
          status: "starting",
          modelId: MODEL.id,
          scheduleId: null,
          createdAt: 1,
          lastEventSeq: 0,
          lastEventAt: 1,
          pendingApproval: false,
        };
      }
      case "session.subscribe":
        return { events: [], lastSeq: 0 };
      case "git.status":
        return { branch: "main", ahead: 0, behind: 0, files: [] };
      default:
        throw new Error(method);
    }
  });
}

describe("new chat agent picker", () => {
  beforeEach(() => {
    localStorage.clear();
    stubApp();
  });

  it("names the default agent and sends the one the user picks", async () => {
    render(<App />);

    const picker = (await screen.findByLabelText("New chat agent")) as HTMLSelectElement;
    // The kernel created the default profile at startup, so the picker never starts on a blank name.
    await waitFor(() => expect(picker.value).toBe("default"));
    expect(picker.selectedOptions[0]?.textContent).toBe("Noir (default)");

    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(appApi.request).toHaveBeenCalledWith("session.create", {
        workspaceId: "w1",
        modelId: MODEL.id,
        agentId: "default",
      }),
    );

    await userEvent.selectOptions(picker, "a-2");
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(appApi.request).toHaveBeenCalledWith("session.create", {
        workspaceId: "w1",
        modelId: MODEL.id,
        agentId: "a-2",
      }),
    );
  });
});
