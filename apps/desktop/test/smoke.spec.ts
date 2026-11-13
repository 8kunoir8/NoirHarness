import { expect, test } from "@playwright/test";
import { closeWindow, createDirs, launchApp } from "./app-harness.js";
import { deleteProviderThroughKernel, removeDir, stopKernel } from "./helpers.js";

test("boots, spawns the kernel, and reaches health", async () => {
  const harness = createDirs("noir e2e ");
  try {
    const app = await launchApp(harness);
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    } finally {
      await closeWindow(app);
    }
  } finally {
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});

test("a provider survives an app restart", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir persist ");
  try {
    const first = await launchApp(harness);
    try {
      const page = await first.firstWindow();
      await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
      const providersRegion = page.getByRole("region", { name: "Providers", exact: true });
      await providersRegion.getByLabel("Name", { exact: true }).fill("Persisted");
      await providersRegion.getByLabel("Base URL", { exact: true }).fill("http://localhost:11434/v1");
      await providersRegion.getByLabel("API key", { exact: true }).fill("k");
      await providersRegion.getByRole("button", { name: "Add provider" }).click();
      await expect(providersRegion.getByText("Persisted")).toBeVisible();
    } finally {
      await closeWindow(first);
    }

    await stopKernel(harness.dataDir);

    const second = await launchApp(harness);
    try {
      const page = await second.firstWindow();
      const providers = page.getByRole("region", { name: "Providers", exact: true });
      await expect(providers.getByText("Persisted")).toBeVisible({ timeout: 20_000 });
    } finally {
      // Through the kernel socket, so the host keyring entry does not outlive the spec.
      await deleteProviderThroughKernel(harness.dataDir, "Persisted").catch(() => undefined);
      await closeWindow(second);
    }
  } finally {
    await stopKernel(harness.dataDir).catch(() => undefined);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
