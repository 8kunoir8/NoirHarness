import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { MockProvider } from "./mock-provider.js";

export interface Harness {
  dataDir: string;
  workspacePath: string;
}

export function createDirs(prefix = "noir "): Harness {
  // Spaces (and, for the chat suite, non-ASCII characters) prove the profile writer, the ACP
  // `--session-dir` and the terminal `cwd` all survive paths that need quoting/encoding.
  const dataDir = mkdtempSync(join(tmpdir(), `${prefix}data `));
  const workspacePath = mkdtempSync(join(tmpdir(), `${prefix}workspace `));
  return { dataDir, workspacePath };
}

export function launchApp(harness: Harness): Promise<ElectronApplication> {
  // Chromium keeps localStorage (restored tabs, read state) in the profile, not under NOIR_DATA_DIR:
  // without its own `--user-data-dir` every spec would inherit the tabs left by the previous one.
  return electron.launch({
    args: [".", `--user-data-dir=${join(harness.dataDir, "electron")}`],
    env: { ...process.env, NOIR_DATA_DIR: harness.dataDir },
  });
}

/** Registers provider, model, project and workspace, then creates the chat from the list pane. */
export async function bootstrap(
  page: Page,
  mock: MockProvider,
  workspacePath: string,
  view = "Chats",
): Promise<void> {
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

  // Setup is its own page; chat, project and session controls live behind the chat view.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: view }).click();

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
