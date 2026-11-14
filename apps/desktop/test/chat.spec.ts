import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** A one-pixel PNG: enough to prove the bytes reached an `<img>` and decoded. */
const PNG_ONE_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("renders a markdown table and shows a workspace image in the reply", async () => {
  await runChat(async (page, mock, harness) => {
    writeFileSync(join(harness.workspacePath, "chart.png"), Buffer.from(PNG_ONE_PIXEL, "base64"));
    await bootstrap(page, mock, harness.workspacePath);

    await sendPrompt(page, "rich");
    const message = page.getByTestId("message-assistant").filter({ hasText: "Here is the report:" });
    // The table is laid out, not printed as pipes.
    await expect(message.locator("table")).toBeVisible({ timeout: 20_000 });
    await expect(message.locator("th").first()).toHaveText("step");
    await expect(message.locator("td").filter({ hasText: "build" })).toBeVisible();

    const image = message.locator("img");
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/, { timeout: 20_000 });
    // The attribute alone would pass for a broken data URL; a decoded picture has a width.
    await expect
      .poll(async () => image.evaluate((node: HTMLImageElement) => node.naturalWidth), { timeout: 20_000 })
      .toBeGreaterThan(0);
  });
});

test("deletes a chat from the list and closes its tab", async () => {
  await runChat(async (page, mock, harness) => {
    await bootstrap(page, mock, harness.workspacePath);
    await sendPrompt(page, "stream");
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 20_000,
    });

    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    // The first click only arms the row: the chat is still there and still open.
    await sessions.getByRole("button", { name: /^Delete / }).first().click();
    await expect(sessions.getByRole("button", { name: /^Confirm delete / }).first()).toBeVisible();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();

    await sessions.getByRole("button", { name: /^Confirm delete / }).first().click();
    await expect(sessions.getByText("No chats yet. Create one to start talking to the agent.")).toBeVisible();
    // Deleting took the tab with it, so nothing is left pointing at the removed session.
    await expect(page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab")).toHaveCount(0);
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveCount(0);
  });
});

test("sends the first prompt of a new chat on Enter", async () => {
  await runChat(async (page, mock, harness) => {
    // `bootstrap` has just created the chat, which the kernel reports as `starting`: the status the
    // composer used to read as "a turn is streaming" and swallow the first Enter.
    await bootstrap(page, mock, harness.workspacePath);
    await page.getByLabel("Prompt", { exact: true }).fill("first turn");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-user").filter({ hasText: "first turn" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 20_000,
    });
  });
});
