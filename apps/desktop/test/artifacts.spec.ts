import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { bootstrap, closeWindow, createDirs, launchApp } from "./app-harness.js";
import { writeArtifactFixtures } from "./fixtures/artifacts/build.mjs";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";
import { startMockProvider, type MockProvider } from "./mock-provider.js";

async function showFiles(page: Page): Promise<void> {
  await page.getByRole("group", { exact: true, name: "List pane" }).getByRole("button", { exact: true, name: "File list" }).click();
  await expect(page.getByRole("treeitem").filter({ hasText: "notes.md" })).toBeVisible();
}

async function preview(page: Page, path: string): Promise<void> {
  await page.getByRole("button", { name: `Preview ${path}`, exact: true }).click();
  await expect(page.getByRole("region", { name: `Preview ${path}`, exact: true })).toBeVisible();
}

test("previews markdown, CSV, and PDF artifacts, then restores and reports a deleted file", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir artifacts ");
  // Generated inside the temp workspace: no fixture bytes (and no 32 MiB PDF) enter the repo.
  writeArtifactFixtures(harness.workspacePath);

  let mock: MockProvider | undefined;
  let app: ElectronApplication | undefined;
  try {
    mock = await startMockProvider();
    app = await launchApp(harness);
    const page = await app.firstWindow();
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await bootstrap(page, mock, harness.workspacePath);
    await showFiles(page);

    // The row's own click opens the source in the editor; only the trailing control previews. A
    // stretched control used to sit under the middle of the row and quietly win that click.
    await page.getByRole("treeitem").filter({ hasText: "notes.md" }).click();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("# Artifact notes", { timeout: 20_000 });
    await expect(page.locator(".artifact-preview")).toHaveCount(0);
    // Close it again: the restore below asserts one tab per artifact name.
    await page.keyboard.press("ControlOrMeta+w");

    // Markdown: GFM table renders, and every hostile construct is inert rather than executed.
    await preview(page, "notes.md");
    const markdown = page.getByRole("region", { name: "Preview notes.md", exact: true });
    await expect(markdown.getByRole("heading", { exact: true, name: "Artifact notes", level: 1 })).toBeVisible();
    await expect(markdown.getByRole("cell", { name: "table", exact: true })).toBeVisible();
    await expect(markdown.locator("script")).toHaveCount(0);
    await expect(markdown.locator("img")).toHaveCount(0);
    await expect(markdown.getByRole("link", { exact: true, name: "hostile link" })).toHaveCount(0);

    // CSV: the quoted comma stays one cell and the embedded newline stays inside it.
    await preview(page, "data.csv");
    const csv = page.getByRole("region", { name: "Preview data.csv", exact: true });
    const cells = csv.locator(".artifact-csv-table td");
    await expect(cells.filter({ hasText: "x,1" })).toHaveCount(1);
    const multiline = cells.filter({ hasText: "line one" });
    await expect(multiline).toHaveCount(1);
    expect(await multiline.textContent()).toContain("line one\nline two");

    // PDF: a real canvas, scaled by pdf.js, and the real page count.
    await preview(page, "small.pdf");
    const pdf = page.getByRole("region", { name: "Preview small.pdf", exact: true });
    await expect(pdf.locator("canvas.pdf-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(pdf.locator(".pdf-page")).toHaveText("1 / 1", { timeout: 30_000 });
    const painted = async (): Promise<boolean> =>
      pdf.locator("canvas.pdf-canvas").evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d");
        if (context === null || canvas.width === 0 || canvas.height === 0) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let index = 0; index < data.length; index += 4) {
          // A transparent pixel has no colour to inspect; the stroke's pixels are opaque.
          if ((data[index + 3] ?? 0) === 0) continue;
          const red = data[index] ?? 0;
          const green = data[index + 1] ?? 0;
          const blue = data[index + 2] ?? 0;
          // build.mjs strokes a red 180×180 square: a rendered page has such a pixel.
          if (red > 150 && red - Math.max(green, blue) > 80) return true;
        }
        return false;
      });
    await expect.poll(painted, { timeout: 30_000 }).toBe(true);

    // Oversized PDFs are refused by the kernel instead of silently truncated.
    await preview(page, "huge.pdf");
    await expect(
      page.getByRole("region", { name: "Preview huge.pdf", exact: true }).getByRole("alert"),
    ).toHaveText("Artifact is larger than 32 MB");

    expect(dialogs).toEqual([]);

    await closeWindow(app);
    app = undefined;
    await stopKernel(harness.dataDir);

    // Cold start: the v3 tab set restores, the workspace re-selects, and each preview re-reads.
    app = await launchApp(harness);
    const restarted = await app.firstWindow();
    await expect(restarted.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    for (const name of ["notes.md", "data.csv", "small.pdf", "huge.pdf"]) {
      await expect(restarted.getByRole("tab", { name, exact: true })).toBeVisible();
    }
    await restarted.getByRole("tab", { name: "notes.md", exact: true }).click();
    const restored = restarted.getByRole("region", { name: "Preview notes.md", exact: true });
    await expect(restored.getByRole("heading", { exact: true, name: "Artifact notes", level: 1 })).toBeVisible({
      timeout: 20_000,
    });

    // A file deleted behind the app's back surfaces the kernel's message, not a blank pane.
    rmSync(join(harness.workspacePath, "notes.md"));
    await restored.getByRole("button", { exact: true, name: "Reload" }).click();
    await expect(restored.getByRole("alert")).toHaveText("File not found: notes.md");
  } finally {
    if (app !== undefined) await deleteProviderThroughKernel(harness.dataDir, "Mock").catch(() => undefined);
    await closeWindow(app);
    await mock?.close().catch(() => undefined);
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
