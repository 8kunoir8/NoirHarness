import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { appVersion, deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/**
 * A remote with two tags: one older than the app's own version and one newer. A local bare repo is
 * the honest stand-in — `git ls-remote --tags` reads it exactly as it reads a real origin, and the
 * spec needs no network.
 */
function seedRemote(dir: string): string {
  const work = join(dir, "work");
  const bare = join(dir, "remote.git");
  mkdirSync(work);
  execFileSync("git", ["init", "-q", "--template="], { cwd: work });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: work });
  execFileSync("git", ["config", "user.name", "e2e"], { cwd: work });
  execFileSync("git", ["commit", "-q", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "init"], { cwd: work });
  execFileSync("git", ["tag", "v0.1.0"], { cwd: work });
  execFileSync("git", ["tag", "v9.9.9"], { cwd: work });
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { cwd: dir });
  return bare;
}

/** One launched app, with the update channel pointed at the throwaway remote. */
async function runUpdate(body: (page: Page) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir update ");
  const remoteDir = mkdtempSync(join(tmpdir(), "noir remote "));
  try {
    const remote = seedRemote(remoteDir);
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      // The daemon inherits this: `UpdateService` reads it instead of the real repository.
      app = await launchApp(harness, { NOIR_UPDATE_URL: remote });
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);
      await body(page);
    } finally {
      if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      await closeWindow(app);
      await mock.close().catch(() => undefined);
    }
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
}

test("badges Help and shows one toast for a newer tag, and remembers a dismissal", async () => {
  await runUpdate(async (page) => {
    const toast = page.getByTestId("update-toast");
    await expect(toast).toContainText("v9.9.9 is available", { timeout: 30_000 });

    // The badge sits on Help, not on a page nobody opens. It is a sibling of the button, so it is
    // addressed from the button rather than through the nav item that wraps both.
    const nav = page.getByRole("navigation", { exact: true, name: "Main" });
    const help = nav.getByRole("button", { name: "Help", exact: true });
    const badge = help.locator("xpath=following-sibling::span[contains(@class,'nav-count')]");
    await expect(badge).toHaveText("●");

    await help.click();
    const row = page.getByTestId("update-row");
    await expect(row).toContainText(appVersion());
    await expect(row).toContainText("v9.9.9");

    // A dismissal is the kernel's, so it survives the window: no toast, no badge, after a reload.
    await row.getByRole("button", { exact: true, name: "Dismiss" }).click();
    await expect(toast).toBeHidden();
    await expect(badge).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    await page.getByRole("navigation", { exact: true, name: "Main" }).getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByTestId("update-row")).toContainText("v9.9.9", { timeout: 20_000 });
    await expect(page.getByTestId("update-toast")).toHaveCount(0);
  });
});
