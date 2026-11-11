// `Agents` opens the broadcast socket in an effect; jsdom has no preload bridge, so the module is
// replaced the same way `agents-ui.test.tsx` does it.
vi.mock("../src/renderer/api.js", () => ({
  connect: vi.fn(async () => undefined),
  offEvent: vi.fn(),
  request: vi.fn(),
}));

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentView, McpServerView, PermissionPolicy } from "@noir/protocol";
import type { RequestFn } from "../src/renderer/api.js";
import { Agents } from "../src/renderer/Agents.js";
import { Setup } from "../src/renderer/Setup.js";

type RequestMock = Mock<(method: string, params?: unknown) => Promise<unknown>>;

// A previous tree can leave scheduled React work behind; flushing it keeps the next render's effects
// from being starved of a scheduler tick (the selection effect of `Agents` is the observable victim).
beforeEach(async () => {
  await act(async () => {});
});

const CALC: McpServerView = {
  id: "mcp-1",
  name: "calc",
  command: "node",
  args: ["server.js"],
  env: { MODE: "fast" },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const DISABLED: McpServerView = { ...CALC, id: "mcp-2", name: "offline", enabled: false };

function setupRequest(overrides: Partial<Record<string, (params?: unknown) => unknown>> = {}): RequestMock {
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const override = overrides[method];
    if (override !== undefined) return override(params);
    switch (method) {
      case "provider.list":
        return { providers: [] };
      case "model.list":
        return { models: [] };
      case "system.health":
        return { status: "ok", pid: 1, engineDir: "C:/data/engine" };
      case "mcp.list":
        return { servers: [] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return request as unknown as RequestMock;
}

function agentRequest(overrides: Partial<Record<string, (params?: unknown) => unknown>> = {}): RequestMock {
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
        return { servers: [CALC, DISABLED] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return request as unknown as RequestMock;
}

function calls(request: RequestMock, method: string): unknown[][] {
  return request.mock.calls.filter(([name]) => name === method);
}

describe("Setup MCP panel", () => {
  it("lists configured servers, adds one from the form, and probes it", async () => {
    const request = setupRequest({
      "mcp.create": (params) => {
        expect(params).toEqual({
          name: "calc",
          command: "node",
          args: ["server.js", "--stdio"],
          env: { MODE: "fast", EMPTY: "" },
          enabled: true,
        });
        return CALC;
      },
      "mcp.test": () => ({ ok: true, tools: [{ name: "add" }, { name: "subtract" }] }),
      "mcp.list": () => ({ servers: [CALC] }),
    });
    render(<Setup request={request as unknown as RequestFn} onOpenChat={() => undefined} />);

    const panel = await screen.findByRole("region", { name: "MCP Servers" });
    expect(await within(panel).findByText("calc")).toBeTruthy();
    expect(within(panel).getByText("node server.js")).toBeTruthy();

    await userEvent.type(within(panel).getByLabelText("Server name"), "calc");
    await userEvent.type(within(panel).getByLabelText("Server command"), "node");
    await userEvent.type(within(panel).getByLabelText("Arguments"), "server.js --stdio");
    await userEvent.type(within(panel).getByLabelText("Environment"), "MODE=fast{enter}EMPTY=");
    await userEvent.click(within(panel).getByRole("button", { name: "Add MCP server" }));

    await waitFor(() => expect(calls(request, "mcp.create")).toHaveLength(1));
    expect(calls(request, "mcp.create")[0]?.[1]).toMatchObject({ name: "calc" });

    const testButton = within(panel).getByRole("button", { name: "Test calc" });
    await userEvent.click(testButton);
    expect(calls(request, "mcp.test")[0]?.[1]).toEqual({
      command: "node",
      args: ["server.js"],
      env: { MODE: "fast" },
    });
    expect(await within(panel).findByText("2 tools")).toBeTruthy();
  });

  it("shows the probe failure instead of a tool count and keeps the row", async () => {
    const request = setupRequest({
      "mcp.list": () => ({ servers: [CALC] }),
      "mcp.test": () => ({ ok: false, tools: [], error: "spawn ENOENT" }),
    });
    render(<Setup request={request as unknown as RequestFn} onOpenChat={() => undefined} />);

    const panel = await screen.findByRole("region", { name: "MCP Servers" });
    await userEvent.click(within(panel).getByRole("button", { name: "Test calc" }));
    expect(await within(panel).findByText("spawn ENOENT")).toBeTruthy();
    expect(within(panel).queryByText(/tools$/)).toBeNull();
  });

  it("toggles and deletes a server through mcp.update and mcp.delete", async () => {
    const request = setupRequest({
      "mcp.list": () => ({ servers: [CALC] }),
      "mcp.update": () => ({ ...CALC, enabled: false }),
      "mcp.delete": () => ({ deleted: true }),
    });
    render(<Setup request={request as unknown as RequestFn} onOpenChat={() => undefined} />);

    const panel = await screen.findByRole("region", { name: "MCP Servers" });
    await userEvent.click(within(panel).getByLabelText("Enabled calc"));
    await waitFor(() => expect(calls(request, "mcp.update")).toHaveLength(1));
    expect(calls(request, "mcp.update")[0]?.[1]).toEqual({ id: "mcp-1", enabled: false });

    await userEvent.click(within(panel).getByRole("button", { name: "Remove calc" }));
    await waitFor(() => expect(calls(request, "mcp.delete")).toHaveLength(1));
    expect(calls(request, "mcp.delete")[0]?.[1]).toEqual({ id: "mcp-1" });
  });

  it("rejects a name that cannot become a tool namespace", async () => {
    const request = setupRequest();
    render(<Setup request={request as unknown as RequestFn} onOpenChat={() => undefined} />);

    const panel = await screen.findByRole("region", { name: "MCP Servers" });
    await userEvent.type(within(panel).getByLabelText("Server name"), "Calc Server");
    await userEvent.type(within(panel).getByLabelText("Server command"), "node");
    await userEvent.click(within(panel).getByRole("button", { name: "Add MCP server" }));

    expect(await within(panel).findByText(/lowercase letters, digits, _ or -/i)).toBeTruthy();
    expect(calls(request, "mcp.create")).toHaveLength(0);
  });
});

const AGENT: AgentView = {
  id: "a-1",
  name: "Scout",
  role: "Coder",
  engineId: "acp",
  modelRef: null,
  permissionPolicy: { mcp: "ask" },
  defaultWorkspaceId: null,
  mcpServerIds: ["mcp-1"],
  archivedAt: null,
  createdAt: 1,
};

describe("Agent inspector MCP settings", () => {
  it("renders an MCP permission row and the configured servers as checkboxes", async () => {
    const request = agentRequest({ "agent.list": () => ({ agents: [AGENT] }) });
    render(
      <Agents workspaceId="w1" request={request as unknown as RequestFn} onOpenChat={() => undefined} />,
    );

    const policyRow = await screen.findByRole("group", { name: "MCP tools" });
    expect(within(policyRow).getByRole("radio", { name: "Ask" })).toBeTruthy();

    const servers = screen.getByRole("group", { name: "MCP servers" });
    expect((within(servers).getByRole("checkbox", { name: /calc/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(servers).getByRole("checkbox", { name: /offline/ }) as HTMLInputElement).checked).toBe(false);
    // A disabled server cannot be bound to a running engine.
    expect((within(servers).getByRole("checkbox", { name: /offline/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("saves a changed server binding and a changed policy through agent.update", async () => {
    const request = agentRequest({
      "agent.list": () => ({ agents: [AGENT] }),
      "agent.update": () => AGENT,
    });
    render(
      <Agents workspaceId="w1" request={request as unknown as RequestFn} onOpenChat={() => undefined} />,
    );

    const servers = await screen.findByRole("group", { name: "MCP servers" });
    await userEvent.click(within(servers).getByRole("checkbox", { name: /calc/ }));
    const policyRow = screen.getByRole("group", { name: "MCP tools" });
    await userEvent.click(within(policyRow).getByRole("radio", { name: "Allow" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls(request, "agent.update")).toHaveLength(1));
    const update = calls(request, "agent.update")[0]?.[1] as {
      mcpServerIds?: string[];
      permissionPolicy?: PermissionPolicy;
    };
    expect(update.mcpServerIds).toEqual([]);
    expect(update.permissionPolicy?.mcp).toBe("allow");
  });

  it("sends the selected servers when creating an agent", async () => {
    const request = agentRequest({
      "agent.create": () => ({ ...AGENT, id: "a-2", mcpServerIds: ["mcp-1"] }),
    });
    render(
      <Agents workspaceId="w1" request={request as unknown as RequestFn} onOpenChat={() => undefined} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "Builder");
    const servers = screen.getByRole("group", { name: "MCP servers" });
    await userEvent.click(within(servers).getByRole("checkbox", { name: /calc/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls(request, "agent.create")).toHaveLength(1));
    expect(calls(request, "agent.create")[0]?.[1]).toMatchObject({
      name: "Builder",
      mcpServerIds: ["mcp-1"],
    });
  });
});
