import { expect, test, type ElectronApplication } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, killKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

test("recovers a crashed session to error and resumes on the next prompt", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir recovery ");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    let page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath);
    await page.getByLabel("Prompt", { exact: true }).fill("slow");
    await page.getByRole("button", { exact: true, name: "Send" }).click();
    // `starting` also reports `streaming`, so wait for the engine to actually reach the provider:
    // the mock writes its first delta the moment it receives the prompt.
    await expect.poll(() => mock.prompts(), { timeout: 30_000 }).toContain("slow");

    // The kernel dies mid-turn, exactly as a crash would: no shutdown, no status update.
    await killKernel(harness.dataDir);
    try {
      await closeWindow(app);
      app = undefined;
    } catch {
      // Leave `app` set so the finally block retries the close.
    }
    await stopKernel(harness.dataDir).catch(() => undefined);

    app = await launchApp(harness);
    page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

    // The boot sweep turns the crashed row into an error; the title may be auto-generated from the prompt.
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    const row = sessions.locator("button.session-row").filter({ hasText: "Error" });
    await expect(row).toContainText("Error", { timeout: 20_000 });

    const banner = page.locator("p.session-stopped");
    // The shell restores the previous tab, so the crashed chat is often already open.
    if (!(await banner.isVisible())) await row.click();
    await expect(banner).toContainText("Send a prompt to resume.");

    await page.getByLabel("Prompt", { exact: true }).fill("stream");
    await page.getByRole("button", { exact: true, name: "Send" }).click();
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 20_000,
    });

    // Clear the keyring entry while the kernel is still up; a spec must not leave a credential behind.
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    try {
      await closeWindow(app);
      app = undefined;
    } catch {
      // Leave `app` set so the finally block retries the close.
    }
  } finally {
    if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
