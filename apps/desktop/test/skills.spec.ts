import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bootstrap, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, waitForKernelExit } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

test("lists a project skill, toggles it, and shows its body", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir skills ");
  mkdirSync(join(harness.workspacePath, ".noir", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(harness.workspacePath, ".noir", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: e2e demo skill\n---\n\nDEMO_SKILL_BODY\n",
  );
  const mock = await startMockProvider();
  const app = await launchApp(harness);
  try {
    const page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Skills" }).click();

    const project = page.getByRole("region", { name: "Project skills" });
    await expect(project).toContainText("demo", { timeout: 20_000 });
    await expect(project).toContainText("e2e demo skill");

    await project.getByRole("button", { name: "View demo" }).click();
    await expect(page.getByRole("region", { name: "Skill body" })).toContainText("DEMO_SKILL_BODY");

    await project.getByRole("button", { name: "Disable demo" }).click();
    await expect(project.getByRole("button", { name: "Enable demo" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Skill body" })).toContainText("DEMO_SKILL_BODY");

    // The toggle reaches the kernel's materialization, not just the row: setEnabled rewrites the
    // manifest and drops the disabled skill from the directory the engine reads.
    const manifestPath = join(harness.workspacePath, ".noir", "skills-engine.json");
    await expect.poll(() => existsSync(manifestPath), { timeout: 10_000 }).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills: Array<{ name: string }> };
    expect(manifest.skills.map((skill) => skill.name)).not.toContain("demo");
    expect(existsSync(join(harness.workspacePath, ".noir", "skills-engine", "demo"))).toBe(false);
  } finally {
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await app.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
