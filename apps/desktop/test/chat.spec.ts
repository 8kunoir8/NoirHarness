import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import {
  deleteProviderThroughKernel,
  removeDir,
  snapshotProfileAgentDir,
  waitForKernelExit,
} from "./helpers.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

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

function launchApp(harness: Harness): Promise<ElectronApplication> {
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

/** Runs one chat against the mock. Teardown removes the keyring entry, the mock, and the profile. */
async function runChat(
  body: (page: Page, mock: MockProvider, harness: Harness) => Promise<void>,
): Promise<void> {
  test.setTimeout(120_000);
  const harness = createDirs();
  const snapshot = snapshotProfileAgentDir();
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
      await app?.close().catch(() => undefined);
      await mock.close().catch(() => undefined);
    }
  } finally {
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    try {
      await snapshot.restore();
    } finally {
      await removeDir(harness.dataDir);
      await removeDir(harness.workspacePath);
    }
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
