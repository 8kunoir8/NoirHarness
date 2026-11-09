import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, expect, test } from "@playwright/test";

async function removeDataDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await delay(100);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

/**
 * Waits until the kernel recorded in `<dataDir>/runtime/kernel.json` is gone or dead.
 * Without this the relaunch can be refused with "Kernel is starting" because the previous
 * daemon's ownership claim is still live.
 */
async function waitForKernelExit(dataDir: string, timeoutMs = 20_000): Promise<void> {
  const runtimeFile = join(dataDir, "runtime", "kernel.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(runtimeFile)) return;
    let pid: number | undefined;
    try {
      const runtime: unknown = JSON.parse(readFileSync(runtimeFile, "utf8"));
      pid = typeof runtime === "object" && runtime !== null && "pid" in runtime && typeof runtime.pid === "number"
        ? runtime.pid
        : undefined;
    } catch {
      pid = undefined;
    }
    if (typeof pid !== "number" || !isProcessAlive(pid)) return;
    await delay(100);
  }
  throw new Error(`kernel process recorded in ${runtimeFile} did not exit before relaunch`);
}

test("boots, spawns the kernel, and reaches health", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "noir e2e "));
  const app = await electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("a provider survives an app restart", async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), "noir persist "));
  const launch = () => electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });

  const first = await launch();
  try {
    const page = await first.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
    await page.getByLabel("Name").fill("Persisted");
    await page.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await page.getByLabel("API key").fill("k");
    await page.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByText("Persisted")).toBeVisible();
  } finally {
    await first.close();
  }

  await waitForKernelExit(dataDir);

  const second = await launch();
  try {
    const page = await second.firstWindow();
    await expect(page.getByText("Persisted")).toBeVisible({ timeout: 20_000 });
  } finally {
    await second.close();
    await waitForKernelExit(dataDir);
    await removeDataDir(dataDir);
  }
});
