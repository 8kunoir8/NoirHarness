import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { MockProvider } from "./mock-provider.js";

export interface Harness {
  dataDir: string;
  workspacePath: string;
}

/**
 * Two throwaway dirs per spec: `<prefix><random>` for the kernel data and `<prefix>ws <random>` for the
 * workspace, so each suite's historical names survive and a leftover is attributable. Spaces (and, for
 * the chat suite, non-ASCII characters) prove the profile writer, the ACP `--session-dir` and the
 * terminal `cwd` all survive paths that need quoting/encoding.
 */
export function createDirs(prefix = "noir "): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const workspacePath = mkdtempSync(join(tmpdir(), `${prefix}ws `));
  return { dataDir, workspacePath };
}

export function launchApp(harness: Harness): Promise<ElectronApplication> {
  // Chromium keeps localStorage (restored tabs, read state) in the profile, not under NOIR_DATA_DIR:
  // without its own `--user-data-dir` every spec would inherit the tabs left by the previous one.
  return electron.launch({
    args: [".", `--user-data-dir=${join(harness.dataDir, "electron")}`],
    // NOIR_NO_TRAY keeps the window's close meaning quit: with a tray it means hide, and
    // Playwright's own window close would then never complete. The tray is unit-tested instead.
    env: { ...process.env, NOIR_DATA_DIR: harness.dataDir, NOIR_NO_TRAY: "1" },
  });
}

/**
 * Ends the app the way the tray's `Quit` does — asks it to quit and waits for the process to leave.
 *
 * `ElectronApplication.close()` cannot be used: it quits the app and then waits for its stdio to end,
 * and Windows hands a detached child a copy of its parent's handles, so the daemon holds that pipe
 * open for as long as it runs. The wait would never finish. This quits through the app's own path and
 * watches the process instead. Callers that also want the driver connection gone stop the daemon
 * first — `closeApp` in `helpers.ts`.
 */
export async function closeWindow(app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) return;
  // A connection already closed by a previous close throws here; nothing is left to quit.
  const child = await Promise.resolve()
    .then(() => app.process())
    .catch(() => undefined);
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  if ((await Promise.race([exited.then(() => true), delay(20_000).then(() => false)])) === false) child.kill();
  await Promise.race([exited, delay(5_000)]);
}

/**
 * Registers provider, model, project and workspace, then lands on `view`. It stops short of
 * creating a chat because `session.create` without an agent also inserts an "Agent" profile:
 * a spec that counts the roster must own every agent it expects.
 */
export async function setupWorkspace(
  page: Page,
  mock: MockProvider,
  workspacePath: string,
  view = "Chats",
  engine: "acp" | "native" = "acp",
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
  // The default is ACP; only a spec that drives the native loop touches this control.
  if (engine !== "acp") await models.getByLabel("Engine", { exact: true }).selectOption(engine);
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
}

/** `setupWorkspace` plus one chat created from the rail list: the path the shell owns. */
export async function bootstrap(
  page: Page,
  mock: MockProvider,
  workspacePath: string,
  view = "Chats",
  engine: "acp" | "native" = "acp",
): Promise<void> {
  await setupWorkspace(page, mock, workspacePath, view, engine);
  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  await sessions.getByLabel("New chat model", { exact: true }).selectOption({ label: "mock-1" });
  await sessions.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
}
