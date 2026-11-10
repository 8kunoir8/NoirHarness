import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, waitForKernelExit } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

interface SkillManifest {
  version: 1;
  skills: { name: string; scope: string; hash: string; description: string }[];
}

function manifestEntries(path: string): { name: string; scope: string }[] {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as SkillManifest;
    return manifest.skills.map(({ name, scope }) => ({ name, scope }));
  } catch {
    return [];
  }
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("lists a project skill, toggles it, and shows its body", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir skills ");
  try {
    // Guarded by the outer finally: even a failure here still removes the two temp dirs.
    mkdirSync(join(harness.workspacePath, ".noir", "skills", "demo"), { recursive: true });
    writeFileSync(
      join(harness.workspacePath, ".noir", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: e2e demo skill\n---\n\nDEMO_SKILL_BODY\n",
    );

    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);

      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Skills" }).click();
      const project = page.getByRole("region", { name: "Project skills" });
      await expect(project).toContainText("demo", { timeout: 20_000 });
      await expect(project).toContainText("e2e demo skill");
      await project.getByRole("button", { name: "View demo" }).click();
      const body = page.getByRole("region", { name: "Skill body" });
      await expect(body).toContainText("DEMO_SKILL_BODY");

      // The first turn spawns the engine, which materializes the enabled set on disk. The list row
      // alone does not prove that, so assert the copy and the manifest before toggling anything.
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Chats" }).click();
      await sendPrompt(page, "stream");
      await expect(
        page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." }),
      ).toBeVisible({ timeout: 20_000 });

      const skillDir = join(harness.workspacePath, ".noir", "skills-engine", "demo");
      const manifestPath = join(harness.workspacePath, ".noir", "skills-engine.json");
      await expect.poll(() => existsSync(join(skillDir, "SKILL.md")), { timeout: 10_000 }).toBe(true);
      await expect
        .poll(() => manifestEntries(manifestPath), { timeout: 10_000 })
        .toContainEqual({ name: "demo", scope: "project" });

      // The toggle reaches the kernel's materialization, not just the row: setEnabled rewrites the
      // manifest and drops the disabled skill from the directory the engine reads.
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Skills" }).click();
      const projectAfterTurn = page.getByRole("region", { name: "Project skills" });
      await projectAfterTurn.getByRole("button", { name: "View demo" }).click();
      await expect(body).toContainText("DEMO_SKILL_BODY");
      await projectAfterTurn.getByRole("button", { name: "Disable demo" }).click();
      await expect(projectAfterTurn.getByRole("button", { name: "Enable demo" })).toBeVisible();
      // The viewer re-reads the source after the toggle; a failed re-read would surface an error.
      await expect(body).toContainText("DEMO_SKILL_BODY");
      await expect(page.getByRole("status")).toHaveCount(0);

      await expect
        .poll(() => manifestEntries(manifestPath).map((entry) => entry.name), { timeout: 10_000 })
        .not.toContain("demo");
      await expect.poll(() => existsSync(skillDir), { timeout: 10_000 }).toBe(false);
    } finally {
      if (app !== undefined) {
        await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      }
      await app?.close().catch(() => undefined);
      await mock.close().catch(() => undefined);
    }
  } finally {
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
