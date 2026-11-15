import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { Automations, REFRESH_MS } from "../src/renderer/Automations.js";

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
    if (method === "agent.list") return { agents: [agent], defaultAgentId: agent.id };
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

  it("creates an hourly schedule on a chosen minute", async () => {
    const hourly = { ...schedule, id: "s-3", name: "Quarter past", intervalMinutes: 60, anchorMinutes: 15 };
    let created = false;
    const { request, calls } = requestWith({
      "schedule.create": () => {
        created = true;
        return hourly;
      },
      "schedule.list": () => ({ schedules: created ? [hourly] : [schedule] }),
    });
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
    const list = screen.getByRole("region", { name: "Schedules" });
    await waitFor(() => expect(list.textContent).toContain("Nightly"));
    await userEvent.click(screen.getByRole("button", { name: "New schedule" }));
    await userEvent.type(screen.getByLabelText("Name"), "Quarter past");
    await userEvent.type(screen.getByLabelText("Prompt"), "check the build");
    await userEvent.selectOptions(screen.getByLabelText("Cadence"), "60");
    await userEvent.selectOptions(screen.getByLabelText("Minute"), "15");
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "schedule.create",
        params: {
          workspaceId: "ws-1",
          agentId: "ag-1",
          name: "Quarter past",
          prompt: "check the build",
          intervalMinutes: 60,
          anchorMinutes: 15,
          enabled: true,
        },
      }),
    );
    // The row reads back the minute it will actually fire on.
    await waitFor(() => expect(list.textContent).toContain("hourly at :15"));
  });

  it("retimes a daily schedule without carrying its wall clock into the cadence", async () => {
    const { request, calls } = requestWith({
      "schedule.update": () => ({ ...schedule, intervalMinutes: 60, anchorMinutes: 0 }),
    });
    render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
    const list = screen.getByRole("region", { name: "Schedules" });
    await waitFor(() => expect(list.textContent).toContain("Nightly"));
    await userEvent.click(within(list).getByText("Nightly"));
    await userEvent.selectOptions(screen.getByLabelText("Cadence"), "60");
    // 09:00 is a wall clock, not a phase: hourly means "on the hour", never ":540".
    expect(screen.getByLabelText("Minute")).toHaveProperty("value", "0");
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "schedule.update",
        params: { id: "s-1", intervalMinutes: 60, anchorMinutes: 0 },
      }),
    );
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

  it("re-reads the list while it is open, so a fire shows up without a remount", async () => {
    // The kernel broadcasts no schedule event: `AgentEvent` requires a `sessionId` and
    // `events.session_id` is NOT NULL, so a fire has nothing to travel in. The pane polls instead.
    vi.useFakeTimers();
    try {
      let running = false;
      const handler = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "agent.list") return { agents: [agent], defaultAgentId: agent.id };
        if (method === "schedule.list") {
          return { schedules: [{ ...schedule, running, nextRunAt: schedule.nextRunAt + (running ? 86_400_000 : 0) }] };
        }
        if (method === "schedule.runs") return { runs: [], nextBefore: null };
        throw new Error(method);
      });
      const request = handler as unknown as RequestFn;
      render(<Automations workspaceId="ws-1" request={request} onOpenSession={() => undefined} />);
      const list = screen.getByRole("region", { name: "Schedules" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(list.textContent).toContain("Nightly");
      expect(list.textContent).not.toContain("Running now");

      // The app sat open past a fire: the row is now working and its next run moved a day out.
      running = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_MS);
      });
      expect(list.textContent).toContain("Running now");
      expect(handler.mock.calls.filter(([method]) => method === "schedule.list").length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
