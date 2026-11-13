import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("queues a second prompt, interrupts the first, and replays after restart", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir shell ");
  try {
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);

      // One tool turn first: the tool card must survive the restart.
      await send(page, "tool");
      const permission = page.getByTestId("permission-card");
      await expect(permission).toBeVisible({ timeout: 20_000 });
      await permission.getByRole("button", { name: "Allow once" }).click();
      await expect(page.getByTestId("tool-card").locator("pre")).toContainText("hi", { timeout: 20_000 });
      await expect(page.getByTestId("message-assistant").filter({ hasText: "tool finished" })).toBeVisible({
        timeout: 20_000,
      });

      // A slow turn that gets a queued follow-up, then an interrupt.
      await send(page, "slow turn");
      await expect(page.getByTestId("session-status")).toHaveText("running", { timeout: 20_000 });
      await page.getByLabel("Prompt", { exact: true }).fill("queued follow-up");
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect(page.getByRole("button", { name: /Queued — runs after this turn/ })).toBeVisible();

      await page.getByRole("button", { name: "Interrupt" }).click();

      // The queued prompt still runs once the interrupted turn settles.
      await expect(page.getByTestId("message-assistant").filter({ hasText: "queued reply." })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("button", { name: /Queued — runs after this turn/ })).toHaveCount(0);
      expect(mock.prompts().some((prompt) => prompt.includes("queued follow-up"))).toBe(true);

      await closeWindow(app);
      app = undefined;
      await stopKernel(harness.dataDir);

      // Restart: the restored tab replays the whole transcript from the kernel.
      app = await launchApp(harness);
      const restarted = await app.firstWindow();
      await expect(restarted.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
      await restarted.getByRole("region", { name: "Sessions", exact: true }).locator("li").first().click();

      await expect(restarted.getByTestId("message-assistant").filter({ hasText: "tool finished" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(restarted.getByTestId("message-assistant").filter({ hasText: "queued reply." })).toBeVisible();
      await expect(restarted.getByTestId("tool-card").locator("pre")).toContainText("hi");
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
});
