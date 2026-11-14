import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** One launched app, torn down the way the chat specs do it. */
async function runRename(body: (page: Page) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir rename ");
  try {
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);
      await body(page);
    } finally {
      if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      await closeWindow(app);
      await mock.close().catch(() => undefined);
    }
  } finally {
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
}

test("renames a chat from its row and from the header", async () => {
  await runRename(async (page) => {
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });

    await sessions.getByRole("button", { name: "Rename Untitled chat" }).click();
    await sessions.getByLabel("Rename Untitled chat").fill("Kernel audit");
    await page.keyboard.press("Enter");
    await expect(sessions.getByRole("button", { name: /Kernel audit/ }).first()).toBeVisible({ timeout: 20_000 });
    // The tab carries the same name, so the rename reached the session, not just the list row.
    await expect(page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab")).toContainText("Kernel audit");

    await page.getByRole("button", { name: "Rename chat" }).click();
    await page.getByLabel("Chat title").fill("Release notes");
    await page.keyboard.press("Enter");
    await expect(sessions.getByRole("button", { name: /Release notes/ }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Rename chat" })).toHaveText("Release notes");
  });
});
