import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp, type Harness } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/** Runs one chat against the mock. Teardown removes the keyring entry, the mock, and the data dir. */
async function runChat(
  body: (page: Page, mock: MockProvider, harness: Harness) => Promise<void>,
): Promise<void> {
  test.setTimeout(120_000);
  const harness = createDirs("noir wörkspace ");
  try {
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      await body(await app.firstWindow(), mock, harness);
    } finally {
      if (app !== undefined) {
        // Through the kernel socket, so both the SQLite row and the host keyring entry go away.
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
}

test("streams an assistant reply through the mock provider", async () => {
  await runChat(async (page, mock, harness) => {
    await bootstrap(page, mock, harness.workspacePath);

    await sendPrompt(page, "stream");
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 20_000,
    });
    expect(mock.requests).toContain("/v1/chat/completions");
  });
});

test("allows a tool once and streams the follow-up reply", async () => {
  await runChat(async (page, mock, harness) => {
    await bootstrap(page, mock, harness.workspacePath);

    await sendPrompt(page, "tool");
    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 20_000 });
    await permission.getByRole("button", { name: "Allow once" }).click();

    // Only `tool.output` fills the card's <pre>; without it the element never renders.
    await expect(page.getByTestId("tool-card").locator("pre")).toContainText("hi", { timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").filter({ hasText: "tool finished" })).toBeVisible({
      timeout: 20_000,
    });
    expect(mock.toolMessageSeen()).toBe(true);
  });
});
