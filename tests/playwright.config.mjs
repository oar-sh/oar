import { defineConfig } from "@playwright/test";

const baseURL = String(process.env.PLAYWRIGHT_BASE_URL || "").trim();
if (!baseURL) {
  // Never fall back to the live relay on :3333. Specs run against the isolated
  // server that tests/run-e2e.mjs spawns; it sets PLAYWRIGHT_BASE_URL.
  throw new Error("PLAYWRIGHT_BASE_URL is not set — run e2e specs via `npm run test:e2e`.");
}

export default defineConfig({
  testDir: ".",
  // Playwright's default testMatch also matches *.test.mjs, which would drag every
  // node:test unit file into the browser suite. E2E specs are *.spec.mjs only.
  testMatch: "**/*.spec.mjs",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  // A spec that fails gets the relay's output of its run printed after it
  // (relay-log-reporter.mjs; run-e2e.mjs adds it to a --reporter list too).
  reporter: [[process.env.CI ? "dot" : "list"], ["./relay-log-reporter.mjs"]],
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
