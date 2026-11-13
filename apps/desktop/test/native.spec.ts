import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * The native engine against the OpenAI-shaped mock: a cold-start turn whose tool arguments arrive
 * split across two frames, a real approval click, the follow-up reply, usage reaching the meter,
 * and a second turn that reconstructs the first one's history after a kernel restart.
 */
test("drives the native tool loop and reconstructs history after a restart", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir native ");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    let page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath, "Chats", "native");

    await sendPrompt(page, "ntool");

    // Cold start sends the system prompt and exactly one user message: no duplicated prompt and
    // no stale history. This is the guard for the whole history-reconstruction path.
    await expect.poll(() => mock.requestMessages().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const firstRequest = mock.requestMessages()[0] ?? [];
    expect(firstRequest.map((message) => message.role)).toEqual(["system", "user"]);
    expect(firstRequest[1]?.content).toBe("ntool");

    // The scripted call only becomes executable if both argument fragments were reassembled.
    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("tool-card")).toBeVisible();
    await permission.getByRole("button", { name: "Allow once" }).click();

    await expect(page.getByTestId("tool-card").locator("pre")).toContainText("hi", { timeout: 20_000 });
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "native tool finished" }),
    ).toBeVisible({ timeout: 20_000 });
    // The tool result went back to the provider as a `tool` message.
    expect(mock.toolMessageSeen()).toBe(true);

    // `usage.updated` reached the renderer: the meter prints its percentage of the model's real
    // 200,000-token window, not of a zero-sized context.
    const meter = page.getByTestId("usage-meter");
    await expect(meter).toBeVisible({ timeout: 20_000 });
    await expect(meter).toContainText(/^\d+% of 200k\b/);

    await closeWindow(app);
    app = undefined;
    await stopKernel(harness.dataDir);

    app = await launchApp(harness);
    page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

    // The shell restores the previous tab; if it did not, open the chat from the rail.
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    const row = sessions.locator("button.session-row").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    if (!(await page.getByLabel("Prompt", { exact: true }).isVisible())) await row.click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();

    await sendPrompt(page, "hello");
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." }),
    ).toBeVisible({ timeout: 30_000 });

    // The cold kernel rebuilt the turn from events. The whole transcript goes back in wire order:
    // the assistant message that owns `call_native_1`, its tool result, then the closing assistant
    // text. Dropping the call but keeping the result would leave the provider an orphaned tool
    // message, so the exact sequence is the guard.
    const rebuilt = mock.requestMessages().at(-1) ?? [];
    expect(rebuilt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(rebuilt[1]?.content).toBe("ntool");
    expect(rebuilt[4]?.content).toBe("native tool finished");
    expect(rebuilt[5]?.content).toBe("hello");

    // Clear the keyring entry while the kernel is still up; a spec must not leave a credential.
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
