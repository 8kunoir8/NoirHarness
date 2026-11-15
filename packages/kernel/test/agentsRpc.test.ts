import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentArchiveResult, AgentListResult, AgentRolesResult, AgentRosterResult, AgentView, ErrorCodes } from "@noir/protocol";
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
    expect(listed.agents.map((a) => a.id)).toEqual([agent.id, listed.defaultAgentId]);
    // The default profile exists before the first chat, so the picker can always name it.
    expect(listed.agents.find((a) => a.id === listed.defaultAgentId)?.name).toBe("Noir");

    const updated = AgentView.parse(
      (await call(kernel.port, kernel.token, "agent.update", { id: agent.id, role: "Review" })).result,
    );
    expect(updated.role).toBe("Review");
    expect(updated.name).toBe("Desk");

    const archived = await call(kernel.port, kernel.token, "agent.archive", { id: agent.id, archived: true });
    expect(AgentArchiveResult.parse(archived.result)).toEqual({ ok: true });
    expect(
      AgentListResult.parse((await call(kernel.port, kernel.token, "agent.list", {})).result).agents.map((a) => a.id),
    ).toEqual([listed.defaultAgentId]);

    const all = AgentListResult.parse(
      (await call(kernel.port, kernel.token, "agent.list", { includeArchived: true })).result,
    );
    expect(all.agents.map((a) => a.id)).toEqual([agent.id, listed.defaultAgentId]);
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
    // A fresh kernel has exactly one profile: the default a chat that names no agent runs as.
    const roster = AgentRosterResult.parse((await call(kernel.port, kernel.token, "agent.roster", {})).result);
    expect(roster.agents).toMatchObject([{ agentId: "default", name: "Noir", role: "Generalist", status: "idle" }]);
    expect(roster.generatedAt).toEqual(expect.any(Number));

    const typed = await call(kernel.port, kernel.token, "agent.roster", { includeArchived: true });
    expect(typed.error.code).toBe(ErrorCodes.invalidParams);
  } finally {
    await kernel.close();
  }
});

it("derives the role catalog from the workspace's skills and MCP servers", async () => {
  const projectRoot = tempDir("noir roles project ");
  const skills: ReadonlyArray<readonly [string, string]> = [
    ["release-notes", "Write the changelog entry for a release"],
    ["wobble", "Balance the wobble in a folk dance"],
  ];
  for (const [name, description] of skills) {
    mkdirSync(join(projectRoot, ".noir", "skills", name), { recursive: true });
    writeFileSync(join(projectRoot, ".noir", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  }
  const kernel = await startKernel({ dataDir: tempDir("noir agents rpc ") });
  try {
    const project = await call(kernel.port, kernel.token, "project.add", { path: projectRoot });
    const workspaceId = (await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id }))
      .result.id as string;
    await call(kernel.port, kernel.token, "mcp.create", { name: "postgres", command: "npx meow-postgres-mcp" });

    const { roles } = AgentRolesResult.parse((await call(kernel.port, kernel.token, "agent.roles", { workspaceId })).result);
    expect(roles[0]?.id).toBe("generalist");
    expect(roles.find((role) => role.id === "writer")?.skills).toEqual(["release-notes"]);
    expect(roles.find((role) => role.id === "analyst")?.mcpServerIds).toHaveLength(1);
    // A skill no vocabulary claims still shows up, named after itself.
    expect(roles.find((role) => role.id === "derived:skill:wobble")).toMatchObject({
      name: "Wobble",
      skills: ["wobble"],
      derived: true,
    });
  } finally {
    await kernel.close();
  }
});

it("refuses to archive the default agent a chat falls back to", async () => {
  const kernel = await startKernel({ dataDir: tempDir("noir agents rpc ") });
  try {
    const archived = await call(kernel.port, kernel.token, "agent.archive", { id: "default", archived: true });
    expect(archived.error.code).toBe(ErrorCodes.conflict);
    expect(archived.error.message).toMatch(/default agent/);
  } finally {
    await kernel.close();
  }
});
