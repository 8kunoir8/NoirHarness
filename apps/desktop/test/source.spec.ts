import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp, type Harness } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** A throwaway repository with one commit, so `git.status` has something to compare against. */
function seedRepo(root: string): void {
  writeFileSync(join(root, "a.txt"), "one\n");
  execFileSync("git", ["init", "-q", "--template="], { cwd: root });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "e2e"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "init"], { cwd: root });
}

/** One launched app on a real repository, torn down the way the editor spec does it. */
async function runSource(body: (page: Page, harness: Harness) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir source ");
  try {
    seedRepo(harness.workspacePath);
    writeFileSync(join(harness.workspacePath, "a.txt"), "one\ntwo\n");
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await bootstrap(page, mock, harness.workspacePath);
      await body(page, harness);
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

test("stages a file, commits it, and reports the new commit", async () => {
  await runSource(async (page, harness) => {
    // The topbar's branch chip is one of the three doors; its accessible name is the branch itself.
    await page.locator(".topbar-branch").click();
    const source = page.getByRole("region", { name: "Source", exact: true });
    await expect(source).toBeVisible();

    const unstaged = source.getByRole("region", { name: "Unstaged", exact: true });
    await expect(unstaged).toContainText("a.txt", { timeout: 20_000 });
    // Nothing is staged yet, so the button explains itself rather than doing nothing.
    const commit = source.getByRole("button", { name: "Commit", exact: true });
    await expect(commit).toBeDisabled();
    await expect(commit).toHaveAttribute("title", "Write a commit message");

    // A controlled checkbox follows the RPC's answer, not the click, so the click is the assertion.
    await source.getByRole("checkbox", { name: "Stage a.txt" }).click();
    const staged = source.getByRole("region", { name: "Staged", exact: true });
    await expect(staged).toContainText("a.txt", { timeout: 20_000 });

    await source.getByLabel("Commit message").fill("wip");
    await expect(commit).toBeEnabled();
    await commit.click();
    await expect(source.getByRole("status").filter({ hasText: "Committed" })).toBeVisible({ timeout: 20_000 });

    // The disk is the contract: the commit is real, not a rendered echo.
    expect(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: harness.workspacePath, encoding: "utf8" })).toBe(
      "wip\n",
    );
    await expect(staged).toContainText("Nothing staged", { timeout: 20_000 });
  });
});

test("opens the diff from the source list and from the chat header's stats", async () => {
  await runSource(async (page) => {
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Source", exact: true }).click();
    const source = page.getByRole("region", { name: "Source", exact: true });
    await expect(source.getByRole("region", { name: "Unstaged" })).toContainText("a.txt", { timeout: 20_000 });

    // A path is the diff: the page is about what changed, so the file name carries the patch.
    await source.getByRole("button", { name: "a.txt" }).click();
    await expect(page.getByRole("region", { name: "Diff" })).toContainText("+two", { timeout: 20_000 });

    // The chat header's stats are the second door: the same page, from the conversation.
    await page.getByRole("tab").first().click();
    await page.locator('[aria-label="Diff stats"]').click();
    await expect(page.getByRole("region", { name: "Source", exact: true })).toBeVisible();
  });
});
