import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { ErrorCodes, ScheduleListResult, ScheduleRunView, ScheduleView } from "@noir/protocol";
import { startKernel } from "./support.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function sendFrame(port: number, token: string, frame: Record<string, unknown> & { id: number }): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await once(ws, "open");
  // The socket also carries broadcasts: a fire emits session events before the command replies,
  // so the answer is the frame carrying this request's id, not merely the next frame.
  const { promise, resolve } = Promise.withResolvers<any>();
  ws.on("message", (data) => {
    const parsed = JSON.parse(String(data));
    if (parsed.id === frame.id) resolve(parsed);
  });
  ws.send(JSON.stringify(frame));
  const parsed = await promise;
  ws.close();
  return parsed;
}

it("creates, lists, updates, runs, pages, and deletes a schedule", async () => {
  const root = tempDir("noir sched rpc ");
  const dataDir = tempDir("noir sched data ");
  const kernel = await startKernel({ dataDir });
  try {
    const call = async (method: string, params?: unknown): Promise<any> =>
      sendFrame(kernel.port, kernel.token, { jsonrpc: "2.0", id: 1, method, params });

    const project = await call("project.add", { path: root });
    const workspace = await call("workspace.create", { projectId: project.result.id });
    const agent = await call("agent.create", { name: "Nightly", role: "default" });

    const created = await call("schedule.create", {
      workspaceId: workspace.result.id,
      agentId: agent.result.id,
      name: "Nightly",
      prompt: "summarize the diff",
      intervalMinutes: 15,
      anchorMinutes: 0,
      // Disabled so the kernel's scheduler does not fire an engine while the assertions run.
      enabled: false,
    });
    const schedule = ScheduleView.parse(created.result);
    expect(schedule.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(schedule.running).toBe(false);

    const listed = ScheduleListResult.parse(
      (await call("schedule.list", { workspaceId: workspace.result.id })).result,
    );
    expect(listed.schedules.map((row) => row.id)).toEqual([schedule.id]);

    const renamed = ScheduleView.parse((await call("schedule.update", { id: schedule.id, name: "Renamed" })).result);
    expect(renamed.name).toBe("Renamed");

    const fired = ScheduleRunView.parse((await call("schedule.runNow", { id: schedule.id })).result.run);
    expect(fired.status).toBe("fired");
    expect(fired.sessionId).toEqual(expect.any(String));

    const runs = (await call("schedule.runs", { id: schedule.id, limit: 1 })).result;
    expect(runs.runs.map((run: { status: string }) => run.status)).toEqual(["fired"]);
    expect(runs.nextBefore).toBeNull();

    const session = (await call("session.list")).result.sessions.find(
      (row: { id: string }) => row.id === fired.sessionId,
    );
    expect(session.scheduleId).toBe(schedule.id);

    expect((await call("schedule.delete", { id: schedule.id })).result).toEqual({ ok: true });
    expect((await call("schedule.list", {})).result.schedules).toEqual([]);
    const kept = (await call("session.list")).result.sessions.find(
      (row: { id: string }) => row.id === fired.sessionId,
    );
    expect(kept).toBeDefined();

    expect(kept.scheduleId).toBeNull();
  } finally {
    await kernel.close();
  }
});

it("rejects a duplicate name and an unknown id", async () => {
  const root = tempDir("noir sched conflict ");
  const dataDir = tempDir("noir sched conflict data ");
  const kernel = await startKernel({ dataDir });
  try {
    const call = async (method: string, params?: unknown): Promise<any> =>
      sendFrame(kernel.port, kernel.token, { jsonrpc: "2.0", id: 1, method, params });
    const project = await call("project.add", { path: root });
    const workspace = await call("workspace.create", { projectId: project.result.id });
    const agent = await call("agent.create", { name: "Nightly", role: "default" });
    const params = {
      workspaceId: workspace.result.id,
      agentId: agent.result.id,
      name: "Nightly",
      prompt: "p",
      intervalMinutes: 15,
      enabled: false,
    };

    await call("schedule.create", params);
    expect((await call("schedule.create", params)).error.code).toBe(ErrorCodes.conflict);
    expect((await call("schedule.update", { id: "nope", name: "x" })).error.code).toBe(ErrorCodes.notFound);
  } finally {
    await kernel.close();
  }
});
