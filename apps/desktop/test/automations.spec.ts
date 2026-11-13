import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closeWindow, createDirs, launchApp, setupWorkspace } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel, withKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

/** The titles main says it showed, in order. A half-written line is simply not read yet. */
function notificationTitles(path: string): string[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const title = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "title") : undefined;
        return typeof title === "string" ? [title] : [];
      } catch {
        return [];
      }
    });
}

function rail(page: Page) {
  return page.getByRole("navigation", { name: "Main" });
}

/** Creates an agent on the mock model with the bootstrapped workspace as its default. */
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

/**
 * The automation loop end to end, which nothing else covers: a real kernel timer fires a real
 * schedule, which opens a real session, which spawns a real engine and answers through the mock
 * provider. The panel is the only observer — it is not clicked between the schedule's creation and
 * the run appearing, so the run's presence also proves the pane re-reads on its own.
 *
 * The cadence is retimed to one minute over the kernel socket because the editor offers 15 minutes
 * as its shortest option; the timer, not the UI, is what is under test.
 */
test("fires a schedule into a real agent and shows the run without a remount", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir automations ");
  const notifyLog = join(harness.dataDir, "notify.log");
  const mock = await startMockProvider();
  let app: ElectronApplication | undefined;
  try {
    // Main reports a finished run through its own socket; the log is how a spec sees it.
    app = await launchApp(harness, { NOIR_NOTIFY_LOG: notifyLog });
    const page = await app.firstWindow();
    await setupWorkspace(page, mock, harness.workspacePath);
    await rail(page).getByRole("button", { name: "Agents" }).click();
    await createAgent(page, "Nightly", harness.workspacePath);

    // Create through the panel, so the write path is the user's, not the socket's.
    await rail(page).getByRole("button", { name: "Automations" }).click();
    const editor = page.getByRole("region", { name: "Schedule editor" });
    const schedules = page.getByRole("region", { name: "Schedules" });
    await page.getByRole("button", { name: "New schedule" }).click();
    await editor.getByLabel("Name", { exact: true }).fill("Nightly");
    await editor.getByLabel("Prompt", { exact: true }).fill("automation tick");
    await editor.getByLabel("Cadence", { exact: true }).selectOption("15");
    await editor.getByRole("button", { name: "Save schedule" }).click();
    await expect(schedules).toContainText("Nightly", { timeout: 20_000 });
    await expect(schedules).toContainText("every 15 min");

    // Select the row: its history is the surface a fire would otherwise leave stale.
    await schedules.getByRole("button", { name: /Nightly/ }).first().click();
    const runs = page.getByRole("region", { name: "Run history" });
    await expect(runs).toContainText("No runs yet.");

    // Retime to a minute over the socket. `schedule.update` re-arms the timer, so this is also the
    // regression test for a schedule written after the scheduler started.
    const nextRunAt = await withKernel(harness.dataDir, async (request) => {
      const workspaces = (await request("workspace.list")) as { workspaces: { id: string }[] };
      const workspaceId = workspaces.workspaces[0]?.id;
      if (workspaceId === undefined) throw new Error("no workspace to scope the schedule to");
      const listed = (await request("schedule.list", { workspaceId })) as { schedules: { id: string; name: string }[] };
      const schedule = listed.schedules.find((candidate) => candidate.name === "Nightly");
      if (schedule === undefined) throw new Error("the panel's schedule never reached the kernel");
      const updated = (await request("schedule.update", { id: schedule.id, intervalMinutes: 1 })) as {
        nextRunAt: number;
      };
      return updated.nextRunAt;
    });
    // The fire is due at the next minute boundary; the poll that must reveal it is 15 s later.
    expect(nextRunAt - Date.now()).toBeLessThanOrEqual(60_000);

    await expect(runs).toContainText("fired", { timeout: 120_000 });
    await runs.getByRole("button", { name: "Open chat" }).click();
    await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 30_000,
    });
    expect(mock.prompts()).toContain("automation tick");

    // The session the schedule opened is an ordinary chat, tagged so the list explains it.
    await expect(page.getByRole("region", { name: "Sessions" })).toContainText("scheduled");

    // The app noticed the run end even though the renderer only ever displayed it.
    await expect
      .poll(() => notificationTitles(notifyLog), { timeout: 30_000 })
      .toContain("Scheduled run finished");
  } finally {
    if (app !== undefined) {
      await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    }
    await closeWindow(app);
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
