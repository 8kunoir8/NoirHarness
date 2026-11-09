import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("boots, spawns the kernel, and reaches health", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "noir e2e "));
  const app = await electron.launch({ args: ["."], env: { ...process.env, NOIR_DATA_DIR: dataDir } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
