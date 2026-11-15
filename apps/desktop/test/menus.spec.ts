import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** One launched app, torn down the way the chat specs do it. */
async function runShell(body: (page: Page) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir menus ");
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

test("opens a chat row's menu with the pointer and with the menu key", async () => {
  await runShell(async (page) => {
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    const row = sessions.getByRole("button", { name: /^Untitled chat/ });

    await row.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Rename", "Copy title", "Delete chat"]);

    // Escape closes the innermost surface and nothing else.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The same items, from the focused row: a menu is never mouse-only.
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Rename", "Copy title", "Delete chat"]);

    // The first item is focused on open, so Enter renames without a pointer. The pencil button
    // carries the same label, so the field is addressed by role.
    const field = sessions.getByRole("textbox", { exact: true, name: "Rename Untitled chat" });
    await page.keyboard.press("Enter");
    await expect(field).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
  });
});

test("quotes a message into the composer and closes a tab from its menu", async () => {
  await runShell(async (page) => {
    await page.getByLabel("Prompt", { exact: true }).fill("stream");
    await page.getByRole("button", { exact: true, name: "Send" }).click();
    const message = page.getByTestId("message-user").first();
    await expect(message).toContainText("stream", { timeout: 20_000 });

    await message.click({ button: "right" });
    const items = page.getByRole("menuitem");
    await expect(items.filter({ hasText: "Quote in composer" })).toBeVisible();
    await page.getByRole("menuitem", { exact: true, name: "Quote in composer" }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(/```/);

    // A tab's menu is about the tab strip, and the effect reaches the strip itself.
    const tabs = page.getByRole("tablist", { exact: true, name: "Open tabs" });
    await tabs.getByRole("tab").first().click({ button: "right" });
    await expect(page.getByRole("menuitem", { exact: true, name: "Close others" })).toBeVisible();
    await page.getByRole("menuitem", { exact: true, name: "Close others" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
  });
});
