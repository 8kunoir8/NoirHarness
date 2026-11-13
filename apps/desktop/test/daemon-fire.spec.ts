import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { closeWindow, createDirs, launchApp, setupWorkspace } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel, withKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/**
 * The point of the daemon: a schedule fires with no window and no app. The app is closed before the
 * fire is due, the run is observed over the kernel socket alone, and the window is opened afterwards
 * to prove the run reached the panel.
 */
test("fires a schedule after the window closes", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir daemon fire ");
  const mock = await startMockProvider();
  try {
    const app = await launchApp(harness);
    const page: Page = await app.firstWindow();
    await setupWorkspace(page, mock, harness.workspacePath);
    await agentNeededBySchedule(page, harness.workspacePath);

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Automations" }).click();
    await page.getByRole("button", { name: "New schedule" }).click();
    const editor = page.getByRole("region", { name: "Schedule editor" });
    await editor.getByLabel("Name", { exact: true }).fill("Headless");
    await editor.getByLabel("Prompt", { exact: true }).fill("headless tick");
    await editor.getByLabel("Cadence", { exact: true }).selectOption("15");
    await editor.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByRole("region", { name: "Schedules" })).toContainText("Headless", { timeout: 20_000 });

    // Retime to a minute over the socket: the editor's shortest cadence is fifteen.
    const scheduleId = await withKernel(harness.dataDir, async (request) => {
      const workspaces = (await request("workspace.list")) as { workspaces: { id: string }[] };
      const workspaceId = workspaces.workspaces[0]?.id;
      if (workspaceId === undefined) throw new Error("no workspace");
      const listed = (await request("schedule.list", { workspaceId })) as { schedules: { id: string; name: string }[] };
      const schedule = listed.schedules.find((candidate) => candidate.name === "Headless");
      if (schedule === undefined) throw new Error("schedule never reached the kernel");
      await request("schedule.update", { id: schedule.id, intervalMinutes: 1 });
      return schedule.id;
    });
    await closeWindow(app);

    // No window from here on: the kernel socket is the only observer.
    // The run row is written before the turn reaches the provider, so both have to be true: a
    // loaded machine can take a while between the fire and the first byte afield.
    const deadline = Date.now() + 150_000;
    let fired = false;
    while (Date.now() < deadline) {
      fired = await withKernel(harness.dataDir, async (request) => {
        const runs = (await request("schedule.runs", { id: scheduleId })) as { runs: { status: string }[] };
        return runs.runs.some((run) => run.status === "fired");
      });
      if (fired && mock.prompts().includes("headless tick")) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(fired).toBe(true);
    expect(mock.prompts()).toContain("headless tick");

    const reopened = await launchApp(harness);
    try {
      const page2 = await reopened.firstWindow();
      await page2.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Automations" }).click();
      const schedules = page2.getByRole("region", { name: "Schedules" });
      await schedules.getByRole("button", { name: /Headless/ }).first().click();
      await expect(page2.getByRole("region", { name: "Run history" })).toContainText("fired", { timeout: 20_000 });
    } finally {
      await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
      await closeWindow(reopened);
    }
  } finally {
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});

/** A schedule fires into an agent; the setup leaves agent selection on the default one. */
async function agentNeededBySchedule(page: Page, workspacePath: string): Promise<void> {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Agents" }).click();
  await page.getByRole("button", { name: "Create agent" }).click();
  const config = page.getByRole("region", { name: "Agent config", exact: true });
  await config.getByLabel("Name", { exact: true }).fill("Headless");
  await config.getByLabel("Default model", { exact: true }).selectOption({ label: "mock-1" });
  await config
    .getByLabel("Default workspace", { exact: true })
    .selectOption({ label: basename(workspacePath) });
  await config.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Select Headless" })).toBeVisible();
}
