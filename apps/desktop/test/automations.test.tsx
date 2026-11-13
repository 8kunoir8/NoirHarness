import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { Automations } from "../src/renderer/Automations.js";

const schedule = {
  id: "s-1",
  workspaceId: "ws-1",
  agentId: "ag-1",
  name: "Nightly",
  prompt: "summarize the diff",
  intervalMinutes: 1440,
  anchorMinutes: 540,
  enabled: true,
  nextRunAt: Date.UTC(2026, 2, 11, 9, 0),
  lastRunAt: null,
  createdAt: Date.UTC(2026, 2, 10, 10, 0),
  running: false,
};

const agent = {
  id: "ag-1",
  name: "Nightly",
  role: "Coder",
  engineId: "acp",
  modelRef: null,
  permissionPolicy: {},
  defaultWorkspaceId: "ws-1",
  mcpServerIds: [],
  archivedAt: null,
  createdAt: Date.UTC(2026, 2, 10, 9, 0),
};

function requestWith(overrides: Record<string, (params: unknown) => unknown> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handler = async (method: string, params?: unknown): Promise<unknown> => {
    calls.push({ method, params });
    const override = overrides[method];
    if (override !== undefined) return override(params);
    if (method === "schedule.list") return { schedules: [schedule] };
    if (method === "agent.list") return { agents: [agent] };
    if (method === "schedule.runs") return { runs: [], nextBefore: null };
    throw new Error(method);
  };
  // The panel only needs the generic call shape; the concrete handler cannot be generic itself.
  const request = vi.fn(handler) as unknown as RequestFn;
  return { request, calls };
}

describe("Automations", () => {
  it("lists a schedule with its cadence and state", async () => {
    const { request } = requestWith();
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
    const list = screen.getByRole("region", { name: "Schedules" });
    await waitFor(() => expect(list.textContent).toContain("Nightly"));
    expect(list.textContent).toContain("daily at 09:00");
    expect(list.textContent).toContain("Enabled");
  });

  it("creates a schedule from the editor and re-lists", async () => {
    const { request, calls } = requestWith({
      "schedule.create": () => ({ ...schedule, id: "s-2", name: "Morning" }),
    });
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Schedules" }).textContent).toContain("Nightly"));
    await userEvent.click(screen.getByRole("button", { name: "New schedule" }));
    await userEvent.type(screen.getByLabelText("Name"), "Morning");
    await userEvent.type(screen.getByLabelText("Prompt"), "check the build");
    await userEvent.selectOptions(screen.getByLabelText("Cadence"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "schedule.create",
        params: {
          workspaceId: "ws-1",
          agentId: "ag-1",
          name: "Morning",
          prompt: "check the build",
          intervalMinutes: 60,
          anchorMinutes: 0,
          enabled: true,
        },
      }),
    );
    await waitFor(() => expect(calls.filter((call) => call.method === "schedule.list")).toHaveLength(2));
  });

  it("runs a schedule now and opens the session", async () => {
    const opened: string[] = [];
    const { request } = requestWith({
      "schedule.runNow": () => ({
        run: {
          id: "r-1",
          scheduleId: "s-1",
          status: "fired",
          dueAt: 1,
          startedAt: 1,
          sessionId: "sess-1",
          reason: null,
        },
      }),
    });
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={(id) => opened.push(id)} />);
    const list = screen.getByRole("region", { name: "Schedules" });
    await waitFor(() => expect(list.textContent).toContain("Nightly"));
    await userEvent.click(within(list).getByRole("button", { name: "Run Nightly now" }));
    await waitFor(() => expect(opened).toEqual(["sess-1"]));
  });

  it("pauses a schedule", async () => {
    const { request, calls } = requestWith({ "schedule.update": () => ({ ...schedule, enabled: false }) });
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Schedules" }).textContent).toContain("Nightly"));
    await userEvent.click(screen.getByRole("button", { name: "Disable Nightly" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "schedule.update", params: { id: "s-1", enabled: false } }),
    );
  });
});
