import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bootstrap, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, waitForKernelExit } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

test("edits a file, saves it, and opens the diff from the inspector", async () => {
  test.setTimeout(120_000);
  const harness = createDirs();
  mkdirSync(join(harness.workspacePath, "src"));
  writeFileSync(join(harness.workspacePath, "src/main.ts"), "export const a = 1;\n");
  // The identity is local to this throwaway repo: the spec must not read the developer's config.
  execFileSync("git", ["init", "-q"], { cwd: harness.workspacePath });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: harness.workspacePath });
  execFileSync("git", ["config", "user.name", "e2e"], { cwd: harness.workspacePath });
  execFileSync("git", ["add", "."], { cwd: harness.workspacePath });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: harness.workspacePath });

  const app = await launchApp(harness);
  const mock = await startMockProvider();
  const page = await app.firstWindow();
  try {
    await bootstrap(page, mock, harness.workspacePath);

    await page.getByRole("button", { name: "File list" }).click();
    await page.getByRole("treeitem", { name: /src/ }).click();
    await page.getByRole("treeitem", { name: /main\.ts/ }).click();

    const editor = page.locator(".monaco-editor .view-lines");
    await expect(editor).toContainText("export const a = 1;", { timeout: 20_000 });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("export const b = 2;");
    await page.keyboard.press("ControlOrMeta+s");

    // The disk is the contract: the save goes through the kernel to the real file.
    await expect
      .poll(() => readFileSync(join(harness.workspacePath, "src/main.ts"), "utf8"), { timeout: 10_000 })
      .toBe("export const b = 2;");

    // The header's stats only mount with the chat tab, and the save left the editor active.
    await page.getByRole("tab").first().click();
    await expect(page.locator('[aria-label="Diff stats"]')).toContainText("+1");

    // The toggle lives in the top bar and the list it opens reflects the whole workspace, so the
    // chat tab stays the active one throughout.
    await page.getByRole("banner").getByRole("button", { name: "Inspector" }).click();
    const changed = page.getByRole("region", { name: "Changed files" });
    // The git scan is asynchronous; the assertion's timeout waits for it instead of a fixed sleep.
    await expect(changed).toContainText("src/main.ts", { timeout: 20_000 });
    await expect(changed).toContainText("+1");

    await changed.getByRole("button", { name: "Show diff" }).click();
    const diff = page.getByRole("region", { name: "Diff" });
    await expect(diff).toContainText("+export const b = 2;");
  } finally {
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await app.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
