import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import {
  deleteProviderThroughKernel,
  removeDir,
  snapshotProfileAgentDir,
  waitForKernelExit,
} from "./helpers.js";

test("boots, spawns the kernel, and reaches health", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "noir e2e "));
  const snapshot = snapshotProfileAgentDir();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
  } finally {
    await app?.close().catch(() => undefined);
    await waitForKernelExit(dataDir).catch(() => undefined);
    try {
      await snapshot.restore();
    } finally {
      await removeDir(dataDir);
    }
  }
});

test("a provider survives an app restart", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "noir persist "));
  const snapshot = snapshotProfileAgentDir();
  const launch = () => electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });

  try {
    const first = await launch();
    try {
      const page = await first.firstWindow();
      await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
      await page.getByLabel("Name").fill("Persisted");
      await page.getByLabel("Base URL").fill("http://localhost:11434/v1");
      await page.getByLabel("API key").fill("k");
      await page.getByRole("button", { name: "Add provider" }).click();
      const providers = page.locator("section").filter({ has: page.getByRole("heading", { name: "Providers", exact: true }) });
      await expect(providers.getByText("Persisted")).toBeVisible();
    } finally {
      await first.close().catch(() => undefined);
    }

    await waitForKernelExit(dataDir);

    const second = await launch();
    try {
      const page = await second.firstWindow();
      const providers = page.locator("section").filter({ has: page.getByRole("heading", { name: "Providers", exact: true }) });
      await expect(providers.getByText("Persisted")).toBeVisible({ timeout: 20_000 });
      await deleteProviderThroughKernel(dataDir, "Persisted");
    } finally {
      await second.close().catch(() => undefined);
    }
    await waitForKernelExit(dataDir);
  } finally {
    try {
      await snapshot.restore();
    } finally {
      await removeDir(dataDir);
    }
  }
});
