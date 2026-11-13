import { expect, test } from "@playwright/test";
import { closeWindow, createDirs, launchApp } from "./app-harness.js";
import { closeApp, removeDir, runtimePid } from "./helpers.js";

test("the kernel outlives the window and reattaches on relaunch", async () => {
  test.setTimeout(120_000);
  const harness = createDirs("noir daemon ");
  try {
    const first = await launchApp(harness);
    const page = await first.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    const pid = runtimePid(harness.dataDir);
    expect(pid).toBeGreaterThan(0);
    await closeWindow(first);

    // The window is gone; the process is not.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(runtimePid(harness.dataDir)).toBe(pid);
    expect(() => process.kill(pid as number, 0)).not.toThrow();

    const second = await launchApp(harness);
    try {
      const reopened = await second.firstWindow();
      await expect(reopened.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
      expect(runtimePid(harness.dataDir)).toBe(pid);
    } finally {
      await closeApp(second, harness.dataDir);
    }
  } finally {
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
