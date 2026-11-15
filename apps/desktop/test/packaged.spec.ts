import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs } from "./app-harness.js";
import { writeArtifactFixtures } from "./fixtures/artifacts/build.mjs";
import { appVersion, deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

const EXE = join(process.cwd(), "..", "..", "release", "win-unpacked", "NoirHarness.exe");

/**
 * The built app, not the checkout. `app.asar` is a different world for three things the dev run
 * never exercises: the pdf.js worker loads from inside the archive, the Phaser chunk is a separate
 * file the bundler split out, and the office's PNG atlases are fetched over `file://`. A path that
 * resolves from `apps/desktop/dist` can still 404 from a packaged `resources/`.
 *
 * Skipped when the tree has not been packaged: building the installer is a release step, not
 * something `pnpm test:e2e` should do. `pnpm --filter @noir/desktop package:dir` produces it.
 */
test.skip(!existsSync(EXE), "release/win-unpacked is absent; run `pnpm --filter @noir/desktop package:dir`");

async function launchPackaged(dataDir: string): Promise<ElectronApplication> {
  // A packaged app has no project dir to load, so `args` carries only the profile: without it the
  // restored tab set lands in the real `%APPDATA%\NoirHarness` and outlives the spec.
  const profile = join(dataDir, "electron");
  mkdirSync(profile, { recursive: true });
  return electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, NOIR_DATA_DIR: dataDir, NOIR_NO_TRAY: "1" },
  });
}

async function showFiles(page: Page): Promise<void> {
  await page.getByRole("group", { exact: true, name: "List pane" }).getByRole("button", { exact: true, name: "File list" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: "small.pdf" })).toBeVisible();
}

test("renders a PDF page and the office out of app.asar", async () => {
  test.setTimeout(240_000);
  const harness = createDirs("noir packaged ");
  writeArtifactFixtures(harness.workspacePath);

  let mock: MockProvider | undefined;
  let app: ElectronApplication | undefined;
  try {
    mock = await startMockProvider();
    app = await launchPackaged(harness.dataDir);

    // The version the window reports comes from the packaged manifest, so a stale `dist` shows here.
    expect(await app.evaluate(({ app: packaged }) => packaged.getVersion())).toBe(appVersion());

    const page = await app.firstWindow();
    await bootstrap(page, mock, harness.workspacePath);
    await showFiles(page);

    await page.getByRole("button", { name: "Preview small.pdf", exact: true }).click();
    const pdf = page.getByRole("region", { name: "Preview small.pdf", exact: true });
    await expect(pdf.locator("canvas.pdf-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(pdf.locator(".pdf-page")).toHaveText("1 / 1", { timeout: 30_000 });
    // A canvas that exists is not a page that rendered: read the pixels the fixture's red square painted.
    const painted = await pdf.locator("canvas.pdf-canvas").evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (context === null || canvas.width === 0 || canvas.height === 0) return false;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 100 && (data[i + 1] ?? 255) < 160 && (data[i + 2] ?? 255) < 160) return true;
      }
      return false;
    });
    expect(painted).toBe(true);

    // The office boots Phaser from the split chunk and paints the atlas: `ready` means the first
    // roster paint landed, so the atlases and the font resolved from inside the archive.
    await page.getByRole("navigation", { exact: true, name: "Main" }).getByRole("button", { exact: true, name: "Agents" }).click();
    const canvas = page.locator(".office-canvas");
    await expect(canvas).toHaveAttribute("data-office-ready", "true", { timeout: 30_000 });
    await expect(page.getByText("Office unavailable")).toHaveCount(0);
    // The kernel's default profile is staffed at startup; a zero count would mean the atlas loaded
    // and the roster did not.
    expect(Number(await canvas.getAttribute("data-office-count"))).toBeGreaterThan(0);
  } finally {
    if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock?.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
