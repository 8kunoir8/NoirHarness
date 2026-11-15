import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { appVersion, deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** One launched app, torn down the way the chat specs do it. */
async function runShell(body: (page: Page) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir help ");
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

test("reaches Help by nav and by F1, and lists the keys this build dispatches", async () => {
  await runShell(async (page) => {
    await page.getByRole("navigation", { exact: true, name: "Main" }).getByRole("button", { name: "Help", exact: true }).click();
    const help = page.getByRole("region", { name: "Help", exact: true });
    await expect(help).toBeVisible();

    // The running build, from `system.health`, not from a workspace file.
    await expect(help.getByRole("region", { exact: true, name: "Running this build" })).toContainText(appVersion());

    // The table is generated from the command registry, so a key that moves moves here with it.
    const keys = help.getByRole("region", { exact: true, name: "Keyboard" });
    await expect(keys).toContainText("Open source control");
    await expect(keys.getByRole("row", { name: /Open source control/ })).toContainText("Ctrl+Shift+G");
    await expect(keys.getByRole("row", { name: /Open help/ })).toContainText("F1");

    // F1 is the shortcut the page advertises, so the page has to answer it from anywhere.
    await page.getByRole("navigation", { exact: true, name: "Main" }).getByRole("button", { name: "Chats", exact: true }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
    await page.keyboard.press("F1");
    await expect(page.getByRole("region", { name: "Help", exact: true })).toBeVisible();
  });
});
