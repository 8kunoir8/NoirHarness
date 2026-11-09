import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  // Vitest unit tests (*.test.tsx) live beside the e2e specs; only load Playwright specs here.
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
