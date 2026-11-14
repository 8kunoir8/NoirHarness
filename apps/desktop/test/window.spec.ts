import { setTimeout as delay } from "node:timers/promises";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createDirs, launchApp } from "./app-harness.js";
import { removeDir, stopKernel } from "./helpers.js";

/**
 * The window is frameless, so the page owns the caption. These assert the contract the page relies
 * on: the glyph is a function of the real window state, not of the click that asked for it.
 */
const windowFlags = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) throw new Error("no window");
    return { maximized: win.isMaximized(), minimized: win.isMinimized() };
  });

const eventually = async (app: ElectronApplication, want: { maximized: boolean; minimized: boolean }): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const now = await windowFlags(app);
    if (now.maximized === want.maximized && now.minimized === want.minimized) return;
    await delay(100);
  }
  throw new Error(`window never reached ${JSON.stringify(want)}: ${JSON.stringify(await windowFlags(app))}`);
};

const caption = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Every spec here owns a data dir. Quit, wait for the process to actually leave, then delete. */
async function cleanup(app: ElectronApplication | undefined, harness: { dataDir: string; workspacePath: string }): Promise<void> {
  const child = app?.process();
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => {
        resolve(true);
      });
    });
    await app?.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    if ((await Promise.race([exited, delay(20_000).then(() => false)])) === false) child.kill();
    await Promise.race([exited, delay(5_000)]);
  }
  await stopKernel(harness.dataDir).catch(() => undefined);
  await removeDir(harness.dataDir);
  await removeDir(harness.workspacePath);
}

test("the maximize and minimize buttons drive the real window", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir window ");
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

    // Maximize: the glyph follows `window:changed`, which the main process emits on the window's own
    // `maximize` event — so this also proves the main→renderer channel, not just the click.
    await caption(page, "Maximize").click();
    await eventually(app, { maximized: true, minimized: false });
    await expect(caption(page, "Restore")).toBeVisible();
    await expect(page.locator(".window-controls")).toHaveAttribute("data-maximized", "true");

    // Restore, from the same button: one verb, two meanings, and the state decides which.
    await caption(page, "Restore").click();
    await eventually(app, { maximized: false, minimized: false });
    await expect(caption(page, "Maximize")).toBeVisible();

    // A maximize the page did not ask for (snap, Win+Up, a taskbar gesture) must still flip the glyph,
    // and the button must then mean Restore, not Maximize-again.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
    await expect(caption(page, "Restore")).toBeVisible();
    await caption(page, "Restore").click();
    await eventually(app, { maximized: false, minimized: false });

    await caption(page, "Minimize").click();
    await eventually(app, { maximized: false, minimized: true });
  } finally {
    await cleanup(app, harness);
  }
});

/**
 * Separate launch on purpose: minimizing first leaves the window mid-transition and, in one run,
 * swallowed the Close click. It also keeps `NOIR_NO_TRAY=1`'s close-means-quit assertion — the only
 * way to prove `window:close` calls `close()` and not `hide()` — off the other test's critical path.
 *
 * The budget is generous because a full run serialises twenty app launches and this is the last of
 * them; the assertion is still "the process leaves", and the failure message says which half of that
 * did not happen.
 */
test("the close button quits, because the harness has no tray", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir window close ");
  const app = await launchApp(harness);
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 120_000 });
    const child = app.process();
    // The click tears the page down mid-action, so Playwright reports its own target vanishing. That
    // rejection is expected and must not be read as "the click was lost", so keep it and print it.
    const clickError = await caption(page, "Close window")
      .click({ timeout: 10_000 })
      .then(
        () => "none",
        (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? "unknown") : String(error)),
      );
    let exited = child.exitCode !== null;
    for (let attempt = 0; attempt < 600 && !exited; attempt += 1) {
      await delay(100);
      exited = child.exitCode !== null;
    }
    // Still alive here means `window:close` never reached the main process, or reached it and the
    // window refused to go. Both diagnoses are worth more than a bare boolean.
    const windows = exited
      ? "exited"
      : await app
          .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({ destroyed: win.isDestroyed(), visible: win.isVisible() })))
          .catch(() => "driver gone");
    expect({ exited, clickError, windows }).toEqual({ exited: true, clickError, windows: "exited" });
  } finally {
    await cleanup(app, harness);
  }
});
