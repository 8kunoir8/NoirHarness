import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider } from "./mock-provider.js";

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByLabel("Prompt", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * The whole of a rewind against the shipped UI: a native turn captured before it ran, the files it
 * stood in for changing, the restore that puts them back, the marker that replaces the abandoned
 * turn, and a retry whose history no longer contains what was rewound away.
 */
test("rewinds the workspace and the conversation to before a prompt", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir rewind ");
  let app: ElectronApplication | undefined;
  const mock = await startMockProvider();
  try {
    writeFileSync(join(harness.workspacePath, "seed.txt"), "before\n");
    app = await launchApp(harness);
    const page = await app.firstWindow();
    // The native engine keeps its history in the kernel, which is what a rewind resets.
    await bootstrap(page, mock, harness.workspacePath, "Chats", "native");

    await sendPrompt(page, "stream");
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("message-user")).toHaveCount(1);

    // Stand in for the edit a turn would have made, so the restore has something to undo.
    writeFileSync(join(harness.workspacePath, "seed.txt"), "after\n");
    writeFileSync(join(harness.workspacePath, "created.txt"), "new\n");

    await page
      .getByTestId("message-user")
      .getByRole("button", { name: "Rewind to before this prompt" })
      .click();
    const dialog = page.getByTestId("rewind-dialog");
    await expect(dialog).toBeVisible();
    // The dialog opens while the plan is still being computed; `Rewind` is disabled until then.
    // One file comes back (`seed.txt`) and none was deleted. The created count is a floor, not a
    // constant: the engine spawn writes `.noir/skills-engine.json` after the checkpoint, so the
    // restore takes that away too — the kernel's own scratch file, re-materialized on the retry.
    await expect(page.getByTestId("rewind-counts")).toHaveText(
      /^1 file restored · 0 deleted files · \d+ created files? removed$/,
      { timeout: 20_000 },
    );
    const confirm = dialog.getByRole("button", { name: "Rewind" });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByTestId("rewind-dialog")).toBeHidden({ timeout: 30_000 });
    // The transcript is rebuilt from the kernel's replay, so the marker and the vanished prompt
    // arrive together and neither is on screen at the instant the dialog closes.
    await expect(page.getByTestId("rewind-marker")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("message-user")).toHaveCount(0, { timeout: 30_000 });
    expect(readFileSync(join(harness.workspacePath, "seed.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(harness.workspacePath, "created.txt"))).toBe(false);

    // The retried prompt must reach the engine without the abandoned turn in its history.
    await sendPrompt(page, "again");
    await expect(page.getByTestId("message-assistant").filter({ hasText: "Hello from mock." })).toBeVisible({
      timeout: 30_000,
    });
    const last = mock.requestMessages().at(-1) ?? [];
    expect(last.map((message) => message.role)).toEqual(["system", "user"]);
    expect(last.at(-1)?.content).toBe("again");
  } finally {
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});

/**
 * The refusal: a restore is a workspace-wide write, so a turn that is still running there must stop
 * it before anything moves — the dialog reports it, the turn lands, and the transcript keeps both
 * the prompt it was asked about and no marker.
 */
test("refuses a rewind while the workspace is mid-turn", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir rewind busy ");
  let app: ElectronApplication | undefined;
  const mock = await startMockProvider();
  try {
    app = await launchApp(harness);
    const page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath, "Chats", "native");

    // `ntool` parks the turn on an approval, so the workspace stays mid-turn until this test
    // answers it — a stable window, where a timed stream would race the click.
    await sendPrompt(page, "ntool");
    await expect(page.getByTestId("permission-card")).toBeVisible({ timeout: 30_000 });

    await page
      .getByTestId("message-user")
      .getByRole("button", { name: "Rewind to before this prompt" })
      .click();
    const dialog = page.getByTestId("rewind-dialog");
    await expect(page.getByTestId("rewind-counts")).toBeVisible({ timeout: 20_000 });
    const confirm = dialog.getByRole("button", { name: "Rewind" });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(dialog.getByRole("alert")).toContainText("A turn is running in this workspace");

    // Nothing moved: close the dialog, let the turn settle, and the transcript still holds the
    // prompt it was asked about and no marker.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await page.getByTestId("permission-card").getByRole("button", { name: "Allow once" }).click();
    await expect(
      page.getByTestId("message-assistant").filter({ hasText: "native tool finished" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("message-user")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("rewind-marker")).toHaveCount(0);
  } finally {
    await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
