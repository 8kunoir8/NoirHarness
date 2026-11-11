import { basename } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createDirs, launchApp, setupWorkspace } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, waitForKernelExit } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

async function showAgents(page: Page): Promise<void> {
  await rail(page).getByRole("button", { name: "Agents" }).click();
}

/**
 * Creates an agent through the inspector: a name, the mock model, and the bootstrapped workspace
 * as its default, so the start form is ready without a second selection.
 */
async function createAgent(page: Page, name: string, workspacePath: string): Promise<void> {
  await page.getByRole("button", { name: "Create agent" }).click();
  const config = page.getByRole("region", { name: "Agent config", exact: true });
  await config.getByLabel("Name", { exact: true }).fill(name);
  await config.getByLabel("Default model", { exact: true }).selectOption({ label: "mock-1" });
  await config
    .getByLabel("Default workspace", { exact: true })
    .selectOption({ label: basename(workspacePath) });
  await config.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: `Select ${name}` })).toBeVisible();
}

/** Starts the selected agent's session from the office pane; the shell opens its chat tab. */
async function startSession(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible({ timeout: 20_000 });
}

function rosterRow(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `Select ${name}`, exact: true }) });
}

/**
 * The office end to end: two real ACP sessions in the mock provider paint two characters, a real
 * approval surfaces on the roster and clears, desk assignment survives a cold start, the List view
 * keeps the roster reachable, and Enter on a focused row opens the chat without a pointer.
 */
test("paints two agents, surfaces an approval, restores desks, and opens chat from the keyboard", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir office ");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    let page = await app.firstWindow();
    // No chat from the harness: `session.create` without an agent inserts its own "Agent" row and
    // the office would paint three characters.
    await setupWorkspace(page, mock, harness.workspacePath);

    // Alpha: a real session on the mock provider, streaming long enough to be working on screen.
    await showAgents(page);
    await createAgent(page, "Alpha", harness.workspacePath);
    await startSession(page);
    await sendPrompt(page, "slow");

    // Beta: the same path in a second workspace session, so the office has to paint two characters.
    await showAgents(page);
    await createAgent(page, "Beta", harness.workspacePath);
    await startSession(page);
    await sendPrompt(page, "slow");

    await showAgents(page);
    const canvas = page.locator(".office-canvas");
    await expect(canvas).toHaveAttribute("data-office-ready", "true", { timeout: 30_000 });
    await expect(canvas).toHaveAttribute("data-office-count", "2");
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByText("Office unavailable")).toHaveCount(0);

    // Approval leg: Alpha's turn asks for a shell command; the request reaches the roster before
    // anyone answers it, and the bubble carries the same title the chat's card shows.
    await page.getByRole("button", { name: "Select Alpha", exact: true }).click();
    await page.getByRole("button", { name: "Open chat" }).click();
    await sendPrompt(page, "tool");
    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 20_000 });
    const approvalTitle = (await permission.locator("p").first().innerText()).trim();
    expect(approvalTitle).not.toBe("");

    await showAgents(page);
    const alphaRow = rosterRow(page, "Alpha");
    await expect(alphaRow.locator(".agents-status")).toHaveText("Needs you", { timeout: 20_000 });
    await expect(alphaRow.locator(".agents-row-bubble")).toHaveText(approvalTitle);

    // Answering from the reopened chat clears the roster bubble through the kernel's events.
    await page.getByRole("button", { name: "Select Alpha", exact: true }).click();
    await page.getByRole("button", { name: "Open chat" }).click();
    await permission.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByTestId("tool-card").locator("pre")).toContainText("hi", { timeout: 20_000 });
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "tool finished" }),
    ).toBeVisible({ timeout: 20_000 });

    await showAgents(page);
    await expect(rosterRow(page, "Alpha").locator(".agents-row-bubble")).toHaveCount(0);

    // Desk assignment is a pure hash of the agent id, so a cold start must seat both agents at the
    // exact desks they had before. The hook is the scene's own view of that assignment, and this
    // Agents view is a fresh mount: wait for its boot rather than reading a half-rendered wrapper.
    await expect(canvas).toHaveAttribute("data-office-ready", "true", { timeout: 30_000 });
    const desksBefore = await canvas.getAttribute("data-office-desks");
    expect(desksBefore).not.toBeNull();
    expect(Object.keys(JSON.parse(desksBefore ?? "{}"))).toHaveLength(2);

    await app.close();
    app = undefined;
    await waitForKernelExit(harness.dataDir);

    app = await launchApp(harness);
    page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    await showAgents(page);
    const restoredCanvas = page.locator(".office-canvas");
    await expect(restoredCanvas).toHaveAttribute("data-office-ready", "true", { timeout: 30_000 });
    await expect(restoredCanvas).toHaveAttribute("data-office-count", "2");
    await expect(restoredCanvas).toHaveAttribute("data-office-desks", desksBefore ?? "");

    // List view: the canvas leaves the DOM, every roster row stays operable.
    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.locator(".office-canvas")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Select Alpha", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select Beta", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Office view" }).click();
    await expect(page.locator(".office-canvas")).toHaveAttribute("data-office-ready", "true", {
      timeout: 30_000,
    });

    // Keyboard: a focused row's Enter opens its session's chat tab with no pointer involved. Only
    // Alpha's transcript carries the tool turn, so finding it proves the tab belongs to Alpha.
    await page.getByRole("button", { name: "Select Alpha", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tablist", { name: "Open tabs" })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "tool finished" }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await app?.close().catch(() => undefined);
    await mock.close().catch(() => undefined);
    await waitForKernelExit(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
