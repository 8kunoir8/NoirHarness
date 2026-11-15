import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/**
 * Adding a folder is one action: project, workspace, and selection together. The kernel keys a
 * workspace by its path, so a second add of the same folder has to select rather than conflict.
 */
test("projects: one action per folder, and a re-add selects", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir projects ");
  const second = mkdtempSync(join(tmpdir(), "noir projects two "));
  try {
    const mock = await startMockProvider();
    const app = await launchApp(harness);
    try {
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);

      const projects = page.getByRole("region", { name: "Projects", exact: true });
      const first = projects.getByRole("button", { name: harness.workspacePath, exact: true });
      await expect(first).toHaveAttribute("aria-current", "true");

      // A second folder takes the selection with it, and leaves the first row unselected.
      await projects.getByRole("button", { exact: true, name: "New project" }).click();
      await projects.getByLabel("Project path", { exact: true }).fill(second);
      await projects.getByRole("button", { exact: true, name: "Add project" }).click();
      const secondRow = projects.getByRole("button", { name: second, exact: true });
      await expect(secondRow).toHaveAttribute("aria-current", "true");
      await expect(first).not.toHaveAttribute("aria-current", "true");

      // Re-picking an existing folder selects it instead of raising the kernel's conflict.
      await projects.getByRole("button", { exact: true, name: "New project" }).click();
      await projects.getByLabel("Project path", { exact: true }).fill(harness.workspacePath);
      await projects.getByRole("button", { exact: true, name: "Add project" }).click();
      await expect(first).toHaveAttribute("aria-current", "true");
      await expect(projects.getByRole("alert")).toHaveCount(0);

      // The kernel allows one workspace per path, so a project's `+` is spent once it has one.
      await expect(projects.getByRole("button", { name: /^New workspace in/ }).first()).toBeDisabled();

      // Collapsing a project hides its workspace row and leaves the other project alone.
      await projects.getByRole("button", { name: /^noir projects ws/ }).first().click();
      await expect(first).toHaveCount(0);
      await expect(secondRow).toBeVisible();
    } finally {
      await closeWindow(app);
    }
  } finally {
    await stopKernel(harness.dataDir);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
    await removeDir(second);
  }
});
