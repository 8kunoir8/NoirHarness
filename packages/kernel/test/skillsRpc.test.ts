import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { ErrorCodes, SkillListResult, SkillReadResult, SkillSetEnabledResult } from "@noir/protocol";
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

it("lists, disables, and reads a project skill", async () => {
  const projectRoot = tempDir("noir skills rpc ");
  const dataDir = tempDir("noir skills data ");
  mkdirSync(join(projectRoot, ".noir", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".noir", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\n\nDEMO_BODY\n",
  );
  const kernel = await startKernel({ dataDir });
  try {
    const project = await call(kernel.port, kernel.token, "project.add", { path: projectRoot });
    const workspace = await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id });
    const workspaceId = workspace.result.id as string;

    const listed = SkillListResult.parse(
      (await call(kernel.port, kernel.token, "skill.list", { workspaceId })).result,
    );
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]).toMatchObject({
      scope: "project",
      name: "demo",
      description: "demo skill",
      enabled: true,
    });
    expect(listed.skills[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    const toggled = await call(kernel.port, kernel.token, "skill.setEnabled", {
      workspaceId,
      scope: "project",
      name: "demo",
      enabled: false,
    });
    expect(SkillSetEnabledResult.parse(toggled.result)).toEqual({ ok: true });
    const relisted = SkillListResult.parse(
      (await call(kernel.port, kernel.token, "skill.list", { workspaceId })).result,
    );
    expect(relisted.skills[0]?.enabled).toBe(false);

    const read = SkillReadResult.parse(
      (await call(kernel.port, kernel.token, "skill.read", { workspaceId, scope: "project", name: "demo" })).result,
    );
    expect(read.content).toContain("DEMO_BODY");
    expect(read.truncated).toBe(false);

    const missing = await call(kernel.port, kernel.token, "skill.read", {
      workspaceId,
      scope: "project",
      name: "missing",
    });
    expect(missing.error.message).toMatch(/not found/i);
  } finally {
    await kernel.close();
  }
});

it("lists global skills without a workspace", async () => {
  const dataDir = tempDir("noir skills global ");
  mkdirSync(join(dataDir, "skills", "shared"), { recursive: true });
  writeFileSync(
    join(dataDir, "skills", "shared", "SKILL.md"),
    "---\nname: shared\ndescription: global skill\n---\n\nSHARED_BODY\n",
  );
  const kernel = await startKernel({ dataDir });
  try {
    const listed = SkillListResult.parse((await call(kernel.port, kernel.token, "skill.list")).result);
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0]).toMatchObject({ scope: "global", name: "shared", enabled: true });

    const read = SkillReadResult.parse(
      (await call(kernel.port, kernel.token, "skill.read", { scope: "global", name: "shared" })).result,
    );
    expect(read.content).toContain("SHARED_BODY");
  } finally {
    await kernel.close();
  }
});

it("rejects an unknown workspace and an empty workspaceId on setEnabled", async () => {
  const projectRoot = tempDir("noir skills rpc unknown ");
  const dataDir = tempDir("noir skills data unknown ");
  mkdirSync(join(projectRoot, ".noir", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".noir", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\n\nDEMO_BODY\n",
  );
  const kernel = await startKernel({ dataDir });
  try {
    const project = await call(kernel.port, kernel.token, "project.add", { path: projectRoot });
    const workspace = await call(kernel.port, kernel.token, "workspace.create", { projectId: project.result.id });
    const workspaceId = workspace.result.id as string;

    const unknown = await call(kernel.port, kernel.token, "skill.list", { workspaceId: "does-not-exist" });
    expect(unknown.result).toBeUndefined();
    expect(unknown.error.code).toBe(ErrorCodes.notFound);

    const empty = await call(kernel.port, kernel.token, "skill.setEnabled", {
      workspaceId: "",
      scope: "project",
      name: "demo",
      enabled: false,
    });
    expect(empty.result).toBeUndefined();
    expect(empty.error.code).toBe(ErrorCodes.invalidParams);

    const relisted = SkillListResult.parse(
      (await call(kernel.port, kernel.token, "skill.list", { workspaceId })).result,
    );
    expect(relisted.skills[0]?.enabled).toBe(true);
  } finally {
    await kernel.close();
  }
});

it("toggles a global skill without a workspace", async () => {
  const dataDir = tempDir("noir skills global toggle ");
  mkdirSync(join(dataDir, "skills", "shared"), { recursive: true });
  writeFileSync(
    join(dataDir, "skills", "shared", "SKILL.md"),
    "---\nname: shared\ndescription: global skill\n---\n\nSHARED_BODY\n",
  );
  const kernel = await startKernel({ dataDir });
  try {
    const toggled = await call(kernel.port, kernel.token, "skill.setEnabled", {
      scope: "global",
      name: "shared",
      enabled: false,
    });
    expect(toggled.error).toBeUndefined();
    expect(SkillSetEnabledResult.parse(toggled.result)).toEqual({ ok: true });

    const listed = SkillListResult.parse((await call(kernel.port, kernel.token, "skill.list")).result);
    expect(listed.skills[0]).toMatchObject({ scope: "global", name: "shared", enabled: false });
  } finally {
    await kernel.close();
  }
});
