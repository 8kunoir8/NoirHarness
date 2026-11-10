import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { deleteProviderThroughKernel, removeDir, waitForKernelExit } from "./helpers.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

interface Harness {
  dataDir: string;
  workspacePath: string;
}

function createDirs(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "noir shell "));
  const workspacePath = mkdtempSync(join(tmpdir(), "noir shell ws "));
  return { dataDir, workspacePath };
}

function launchApp(harness: Harness): Promise<ElectronApplication> {
  return electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: harness.dataDir } });
}

/** Registers provider, model, project and workspace, then creates the chat from the list pane. */
async function bootstrap(page: Page, mock: MockProvider, workspacePath: string): Promise<void> {
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

  const providers = page.getByRole("region", { name: "Providers", exact: true });
  await providers.getByLabel("Name", { exact: true }).fill("Mock");
  await providers.getByLabel("Base URL", { exact: true }).fill(mock.url);
  await providers.getByLabel("API key", { exact: true }).fill("sk-test");
  await providers.getByRole("button", { name: "Add provider" }).click();
  await expect(providers.locator("li").filter({ hasText: "Mock" })).toBeVisible();

  const models = page.getByRole("region", { name: "Models", exact: true });
  await models.getByLabel("Provider", { exact: true }).selectOption({ label: "Mock" });
  await models.getByLabel("Model id", { exact: true }).fill("mock-1");
  await models.getByLabel("Context window", { exact: true }).fill("200000");
  await models.getByRole("button", { name: "Add model" }).click();
  await expect(models.locator("li").filter({ hasText: "mock-1" })).toBeVisible();

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Chats" }).click();

  const projects = page.getByRole("region", { name: "Projects", exact: true });
  await projects.getByLabel("Project path", { exact: true }).fill(workspacePath);
  await projects.getByRole("button", { name: "Add project" }).click();
  await projects.getByLabel("Project", { exact: true }).selectOption({ label: basename(workspacePath) });
  await projects.getByRole("button", { name: "Create workspace" }).click();
  await projects.getByLabel("Workspace", { exact: true }).selectOption({ label: workspacePath });

  // Create the chat from the rail list, not from a tab: that is the path the shell owns.
  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  await sessions.getByLabel("New chat model", { exact: true }).selectOption({ label: "mock-1" });
  await sessions.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("queues a second prompt, interrupts the first, and replays after restart", async () => {
  test.setTimeout(180_000);
  const harness = createDirs();
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

    await app.close();
    app = undefined;
    await waitForKernelExit(harness.dataDir);

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
    await app?.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
