import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentArchiveResult, AgentListResult, AgentRosterResult, AgentView, ErrorCodes } from "@noir/protocol";
import { startKernel } from "../src/index.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function call(port: number, token: string, method: string, params?: unknown): Promise<any> {
  return sendFrame(port, token, { jsonrpc: "2.0", id: 1, method, params });
}

async function sendFrame(port: number, token: string, frame: unknown): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await once(ws, "open");
  const reply = once(ws, "message");
  ws.send(JSON.stringify(frame));
  const [data] = await reply;
  ws.close();
  return JSON.parse(String(data));
}

it("creates, lists, updates, and archives an agent over the socket", async () => {
  const kernel = await startKernel({ dataDir: tempDir("noir agents rpc ") });
  try {
    const created = await call(kernel.port, kernel.token, "agent.create", { name: "Desk", role: "Ops" });
    const agent = AgentView.parse(created.result);
    expect(agent).toMatchObject({
      name: "Desk",
      role: "Ops",
      engineId: "acp",
      modelRef: null,
      permissionPolicy: {},
      defaultWorkspaceId: null,
      archivedAt: null,
    });

    const duplicate = await call(kernel.port, kernel.token, "agent.create", { name: "desk" });
    expect(duplicate.error.code).toBe(ErrorCodes.conflict);

    const listed = AgentListResult.parse((await call(kernel.port, kernel.token, "agent.list", {})).result);
    expect(listed.agents.map((a) => a.id)).toEqual([agent.id]);

    const updated = AgentView.parse(
      (await call(kernel.port, kernel.token, "agent.update", { id: agent.id, role: "Review" })).result,
    );
    expect(updated.role).toBe("Review");
    expect(updated.name).toBe("Desk");

    const archived = await call(kernel.port, kernel.token, "agent.archive", { id: agent.id, archived: true });
    expect(AgentArchiveResult.parse(archived.result)).toEqual({ ok: true });
    expect(AgentListResult.parse((await call(kernel.port, kernel.token, "agent.list", {})).result).agents).toEqual([]);

    const all = AgentListResult.parse(
      (await call(kernel.port, kernel.token, "agent.list", { includeArchived: true })).result,
    );
    expect(all.agents.map((a) => a.id)).toEqual([agent.id]);
    expect(all.agents[0]?.archivedAt).toEqual(expect.any(Number));
  } finally {
    await kernel.close();
  }
});

it("rejects an unknown policy key and a non-string id with invalidParams", async () => {
  const kernel = await startKernel({ dataDir: tempDir("noir agents rpc ") });
  try {
    const policy = await call(kernel.port, kernel.token, "agent.create", {
      name: "Typo",
      permissionPolicy: { shells: "allow" },
    });
    expect(policy.error.code).toBe(ErrorCodes.invalidParams);
    expect(policy.error.message).toMatch(/permissionPolicy/);

    const agent = AgentView.parse((await call(kernel.port, kernel.token, "agent.create", { name: "Typo" })).result);
    const badId = await call(kernel.port, kernel.token, "agent.update", { id: 7, role: "Review" });
    expect(badId.error.code).toBe(ErrorCodes.invalidParams);
    expect(badId.error.message).toMatch(/id/);
    // The rejected update never touched the row.
    const listed = AgentListResult.parse((await call(kernel.port, kernel.token, "agent.list", {})).result);
    expect(listed.agents.find((a) => a.id === agent.id)?.role).toBe("Coder");
  } finally {
    await kernel.close();
  }
});

it("serves a roster snapshot and rejects unknown params", async () => {
  const kernel = await startKernel({ dataDir: tempDir("noir agents rpc ") });
  try {
    const roster = AgentRosterResult.parse((await call(kernel.port, kernel.token, "agent.roster", {})).result);
    expect(roster.agents).toEqual([]);
    expect(roster.generatedAt).toEqual(expect.any(Number));

    const typed = await call(kernel.port, kernel.token, "agent.roster", { includeArchived: true });
    expect(typed.error.code).toBe(ErrorCodes.invalidParams);
  } finally {
    await kernel.close();
  }
});
