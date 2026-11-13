import { chromium, expect, test, type Browser } from "@playwright/test";
import { createDirs, launchApp } from "./app-harness.js";
import { closeApp, removeDir, withKernel } from "./helpers.js";

/**
 * The whole point of M4.2 in one test: no Electron window is driving the browser. It pairs with a
 * one-time code, gets a cookie, and runs the harness over a socket the kernel did not give it a
 * token for. Revocation is the same story backwards.
 */
test("a paired browser runs the harness, and losing the device ends it", async () => {
  test.setTimeout(180_000);
  const harness = createDirs("noir remote ");
  const app = await launchApp(harness);
  let browser: Browser | undefined;
  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 20_000 });

    const enabled = (await withKernel(harness.dataDir, (request) => request("remote.enable"))) as {
      port: number | null;
      url: string | null;
      fingerprint: string | null;
    };
    const port = enabled.port ?? 0;
    expect(port).toBeGreaterThan(0);
    expect(enabled.url ?? "").toMatch(/^https:\/\//);
    expect(enabled.fingerprint ?? "").toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const pair = (await withKernel(harness.dataDir, (request) => request("remote.pair"))) as {
      code: string;
      url: string;
    };
    expect(pair.url).toContain(`#${pair.code}`);

    browser = await chromium.launch();
    // The one click a person makes once: trust the certificate this kernel signed for itself.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const redeemed = await context.request.post(`https://127.0.0.1:${port}/pair/redeem`, { data: { code: pair.code } });
    expect(redeemed.status()).toBe(200);
    const device = (await context.cookies(`https://127.0.0.1:${port}`)).find((cookie) => cookie.name === "noir_device");
    expect(device).toBeDefined();
    expect(device?.secure).toBe(true);

    const tab = await context.newPage();
    await tab.goto(`https://127.0.0.1:${port}/`);

    // The same status line the Electron window shows, reached through a cookie instead of a token.
    await expect(tab.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 30_000 });

    const deviceId = await withKernel(harness.dataDir, async (request) => {
      const listed = (await request("remote.devices")) as { devices: { id: string; connected: boolean }[] };
      expect(listed.devices).toHaveLength(1);
      expect(listed.devices[0]?.connected).toBe(true);
      return listed.devices[0]?.id ?? "";
    });
    expect(deviceId).not.toBe("");

    await withKernel(harness.dataDir, (request) => request("remote.revoke", { id: deviceId }));

    // The cookie is not merely refused at the next handshake: the page it already loaded is dead.
    await tab.reload();
    await expect(tab.getByTestId("kernel-status")).toHaveText("kernel error", { timeout: 30_000 });
  } finally {
    await browser?.close();
    await closeApp(app, harness.dataDir);
    await removeDir(harness.dataDir);
    await removeDir(harness.workspacePath);
  }
});
