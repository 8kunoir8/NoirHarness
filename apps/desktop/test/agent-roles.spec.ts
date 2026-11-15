import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp, setupWorkspace } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** One launched app per test, torn down the way the chat specs do it. */
async function runAgents(body: (page: Page, workspacePath: string) => Promise<void>): Promise<void> {
  test.setTimeout(180_000);
  const harness = createDirs("noir roles ");
  try {
    const mock = await startMockProvider();
    let app: ElectronApplication | undefined;
    try {
      app = await launchApp(harness);
      const page = await app.firstWindow();
      await setupWorkspace(page, mock, harness.workspacePath);
      await body(page, harness.workspacePath);
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

test("staffs chats as Noir and derives the role catalog from the workspace", async () => {
  await runAgents(async (page, workspacePath) => {
    const picker = page.getByLabel("New chat agent", { exact: true });
    await expect(picker).toHaveValue("default");
    await expect(picker.locator("option:checked")).toHaveText("Noir (default)");

    // A role exists only because a skill backs it: this one carries the review vocabulary.
    mkdirSync(join(workspacePath, ".noir", "skills", "code-review"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".noir", "skills", "code-review", "SKILL.md"),
      "---\nname: code-review\ndescription: Review a diff for bugs before it ships\n---\n",
    );

    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    await sessions.getByLabel("New chat model", { exact: true }).selectOption({ label: "mock-1" });
    await sessions.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible({ timeout: 20_000 });

    // A second chat picks no agent again: it must reuse Noir, not invent a row per chat.
    await sessions.getByRole("button", { name: "New chat" }).click();
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Agents", exact: true }).click();
    const roster = page.getByRole("region", { name: "Agents", exact: true });
    await expect(roster.getByRole("button", { name: "Select Noir", exact: true })).toBeVisible();
    await expect(roster.locator("li")).toHaveCount(1);

    await roster.getByRole("button", { name: "Select Noir", exact: true }).click();
    const config = page.getByRole("region", { name: "Agent config", exact: true });
    await expect(config.getByLabel("Role", { exact: true })).toHaveValue("Generalist");

    // The catalog lists what this workspace can staff and explains the pick it makes.
    await config.getByLabel("Role", { exact: true }).selectOption({ label: "Engineer" });
    await expect(config.getByText("Skills this role is for: code-review")).toBeVisible();
    await config.getByRole("button", { name: "Save" }).click();
    await expect(config.getByRole("alert")).toHaveCount(0);

    // The row a chat falls back to cannot be archived away: the kernel refuses and the form says why.
    await config.getByRole("button", { name: "Archive" }).click();
    await expect(config.getByRole("alert")).toContainText("default agent");
  });
});

test("bootstraps the first chat without a second agent row", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir roles boot ");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    const page = await app.firstWindow();
    // `bootstrap` creates the first chat without naming an agent, the path a new install takes.
    await bootstrap(page, mock, harness.workspacePath);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Agents", exact: true }).click();
    const roster = page.getByRole("region", { name: "Agents", exact: true });
    await expect(roster.getByRole("button", { name: "Select Noir", exact: true })).toBeVisible();
    await expect(roster.locator("li")).toHaveCount(1);
  } finally {
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await mock.close().catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
