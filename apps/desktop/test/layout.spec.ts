import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** One launched app per test, torn down the way the chat specs do it. */
async function runShell(body: (page: Page) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir layout ");
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

test("collapses both left columns and keeps them collapsed", async () => {
  await runShell(async (page) => {
    const projects = page.getByRole("region", { name: "Projects", exact: true });
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    const main = page.getByRole("main");
    await expect(projects).toBeVisible();
    await expect(sessions).toBeVisible();
    const before = (await main.boundingBox())?.width ?? 0;

    await page.getByRole("button", { name: "Projects column" }).click();
    await expect(projects).toBeHidden();
    // Width, not just visibility: a zeroed track is what gives the space to the chat.
    await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeGreaterThan(before);

    await page.getByRole("button", { name: "Chats column" }).click();
    await expect(sessions).toBeHidden();
    await expect(page.getByRole("button", { name: "Projects column" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Chats column" })).toHaveAttribute("aria-pressed", "false");
    // The chat itself does not collapse with the columns around it.
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();

    // The choice is remembered: the profile, not this render, holds it.
    await page.reload();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Projects", exact: true })).toBeHidden();
    await expect(page.getByRole("region", { name: "Sessions", exact: true })).toBeHidden();

    await page.getByRole("button", { name: "Projects column" }).click();
    await expect(page.getByRole("region", { name: "Projects", exact: true })).toBeVisible();
  });
});
