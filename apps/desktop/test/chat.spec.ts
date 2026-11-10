import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

/** Retries because Windows keeps handles on the kernel's SQLite and omp's session files briefly. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(100);
    }
  }
}

interface Harness {
  dataDir: string;
  workspacePath: string;
}

function createDirs(): Harness {
  // Spaces and non-ASCII characters prove the profile writer, the ACP `--session-dir` and the
  // terminal `cwd` all survive paths that need quoting/encoding.
  const dataDir = mkdtempSync(join(tmpdir(), "noir chat "));
  const workspacePath = mkdtempSync(join(tmpdir(), "noir wörkspace "));
  return { dataDir, workspacePath };
}

function launchApp(harness: Harness) {
  return electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: harness.dataDir } });
}

/** Registers a provider, a model, a project, its workspace and a chat over the given mock. */
async function bootstrap(page: Page, mock: MockProvider, workspacePath: string): Promise<void> {
  await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

  const providers = page.locator("section").filter({ has: page.getByRole("heading", { name: "Providers", exact: true }) });
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

  const projects = page.getByRole("region", { name: "Projects", exact: true });
  await projects.getByLabel("Project path", { exact: true }).fill(workspacePath);
  await projects.getByRole("button", { name: "Add project" }).click();
  await projects.getByLabel("Project", { exact: true }).selectOption({ label: basename(workspacePath) });
  await projects.getByRole("button", { name: "Create workspace" }).click();
  await projects.getByLabel("Workspace", { exact: true }).selectOption({ label: workspacePath });

  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  await sessions.getByLabel("New chat model", { exact: true }).selectOption({ label: "mock-1" });
  await sessions.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("streams an assistant reply through the mock provider", async () => {
  test.setTimeout(120_000);
  const harness = createDirs();
  const mock = await startMockProvider();
  const app = await launchApp(harness);
  try {
    const page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath);

    await sendPrompt(page, "stream");
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 20_000,
    });
    expect(mock.requests).toContain("/v1/chat/completions");
  } finally {
    await app.close();
    await mock.close();
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});

test("allows a tool once and streams the follow-up reply", async () => {
  test.setTimeout(120_000);
  const harness = createDirs();
  const mock = await startMockProvider();
  const app = await launchApp(harness);
  try {
    const page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath);

    await sendPrompt(page, "tool");
    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 20_000 });
    await permission.getByRole("button", { name: "Allow once" }).click();

    await expect(page.getByTestId("tool-card")).toContainText("hi", { timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").filter({ hasText: "tool finished" })).toBeVisible({
      timeout: 20_000,
    });
    expect(mock.toolMessageSeen()).toBe(true);
  } finally {
    await app.close();
    await mock.close();
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
