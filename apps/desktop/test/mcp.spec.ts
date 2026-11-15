import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { closeWindow, createDirs, launchApp, setupWorkspace } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp/mock-server.mjs", import.meta.url)).replace(/\\/g, "/");

/** The Setup panel owns server registration; it is its own page, like the provider forms. */
async function addMcpServer(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Setup" }).click();
  const panel = page.getByRole("region", { name: "MCP Servers" });
  await panel.getByLabel("Server name", { exact: true }).fill("calc");
  await panel.getByLabel("Server command", { exact: true }).fill("node");
  await panel.getByLabel("Arguments", { exact: true }).fill(FIXTURE);
  await panel.getByRole("button", { name: "Add MCP server" }).click();
  await expect(panel.getByText("calc", { exact: true })).toBeVisible();
}

/** One roster row by its agent name: the default profile is always present, so `.first()` is a guess. */
function rosterRow(page: Page, name: string) {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `Select ${name}`, exact: true }) });
}

/**
 * Setup → MCP server → agent binding → native turn: the probe proves the process speaks MCP, and the
 * turn proves the broker routes the provider's `mcp__calc__add` through the approval card and back.
 */
test("brokers an MCP tool call from a bound agent through the approval card", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir mcp ");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    const page = await app.firstWindow();
    await setupWorkspace(page, mock, harness.workspacePath, "Chats", "native");
    await addMcpServer(page);

    // The probe starts the real process: one tool is the fixture's whole surface.
    const panel = page.getByRole("region", { name: "MCP Servers" });
    await panel.getByRole("button", { name: "Test calc" }).click();
    await expect(panel.getByText("1 tool")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: "Create agent" }).click();
    const inspector = page.getByRole("region", { name: "Agent config" });
    await inspector.getByLabel("Name", { exact: true }).fill("Broker");
    await inspector.getByLabel("Engine", { exact: true }).selectOption("native");
    await inspector.getByLabel("Default model", { exact: true }).selectOption({ label: "mock-1" });
    await inspector
      .getByLabel("Default workspace", { exact: true })
      .selectOption({ label: basename(harness.workspacePath) });
    const servers = inspector.getByRole("group", { name: "MCP servers" });
    await servers.getByRole("checkbox", { name: /calc/ }).check();
    // The policy row stays on `ask`, so the turn must stop at the approval card.
    await inspector.getByRole("button", { name: "Save" }).click();

    // The roster is sorted by name, so a bare `.first()` would start `Broker` or the default `Noir`
    // depending on the sort: name the row this turn belongs to.
    await rosterRow(page, "Broker").getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Prompt", { exact: true }).fill("mtool");
    await page.getByRole("button", { name: "Send" }).click();

    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 30_000 });
    await expect(permission).toContainText("mcp__calc__add");
    await permission.getByRole("button", { name: "Allow once" }).click();

    await expect(page.getByTestId("tool-card").locator("pre")).toContainText("9", { timeout: 20_000 });
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "mcp tool finished" }),
    ).toBeVisible({ timeout: 20_000 });

    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
  } finally {
    if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
