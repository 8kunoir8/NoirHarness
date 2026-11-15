import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { closeWindow, bootstrap, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

test("edits a file, saves it, and opens the diff from the inspector", async () => {
  test.setTimeout(120_000);
  const harness = createDirs();
  try {
    // A throwaway repo must not inherit the developer's git setup: no init template (and so no
    // hooks), no hook execution, no signing. Only the identity is set, locally.
    mkdirSync(join(harness.workspacePath, "src"));
    writeFileSync(join(harness.workspacePath, "src/main.ts"), "export const a = 1;\n");
    execFileSync("git", ["init", "-q", "--template="], { cwd: harness.workspacePath });
    execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: harness.workspacePath });
    execFileSync("git", ["config", "user.name", "e2e"], { cwd: harness.workspacePath });
    execFileSync("git", ["add", "."], { cwd: harness.workspacePath });
    execFileSync("git", ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "init"], {
      cwd: harness.workspacePath,
    });

    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);

      await page.getByRole("button", { exact: true, name: "File list" }).click();
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
        .poll(() => readFileSync(join(harness.workspacePath, "src/main.ts"), "utf8"), { timeout: 20_000 })
        .toBe("export const b = 2;");

      // Tabs append in creation order, so the chat tab bootstrap opened is the first one; the save
      // left the editor tab active and the header's stats only mount with the chat tab.
      await page.getByRole("tab").first().click();
      await expect(page.locator('[aria-label="Diff stats"]')).toContainText("+1", { timeout: 20_000 });

      // The toggle lives in the top bar and the list it opens reflects the whole workspace, so the
      // chat tab stays the active one throughout.
      await page.getByRole("banner").getByRole("button", { exact: true, name: "Inspector" }).click();
      const changed = page.getByRole("region", { exact: true, name: "Changed files" });
      // The git scan is asynchronous; the assertion's timeout waits for it instead of a fixed sleep.
      await expect(changed).toContainText("src/main.ts", { timeout: 20_000 });
      await expect(changed).toContainText("+1");

      // The button's accessible name is its `aria-label`, not the visible "Show diff".
      await changed.getByRole("button", { exact: true, name: "Show diff for src/main.ts" }).click();
      const diff = page.getByRole("region", { exact: true, name: "Diff" });
      await expect(diff).toContainText("+export const b = 2;");
    } finally {
      if (app !== undefined) {
        await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      }
      await closeWindow(app);
      await mock.close().catch(() => undefined);
    }
  } finally {
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});

test("refuses to open a file larger than the read cap", async () => {
  test.setTimeout(120_000);
  const harness = createDirs();
  const bigPath = join(harness.workspacePath, "huge.txt");
  // One byte over the kernel's 2 MiB cap: the read returns a prefix instead of the whole file.
  const content = "a".repeat(2 * 1024 * 1024 + 1);
  writeFileSync(bigPath, content);
  try {
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);

      await page.getByRole("button", { exact: true, name: "File list" }).click();
      await page.getByRole("treeitem", { name: /huge\.txt/ }).click();

      // A truncated read is refused before a buffer exists: no editor, an explicit alert, and the
      // file on disk is untouched (nothing could save the prefix back over it).
      await expect(page.getByRole("alert")).toContainText(
        "huge.txt is larger than 2 MiB; not opened for editing",
        { timeout: 20_000 },
      );
      await expect(page.locator(".monaco-editor")).toHaveCount(0);
      expect(readFileSync(bigPath, "utf8")).toBe(content);
    } finally {
      if (app !== undefined) {
        await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      }
      await closeWindow(app);
      await mock.close().catch(() => undefined);
    }
  } finally {
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
