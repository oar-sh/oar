import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Restart web relay must say what happened to the request: a refusal is an
// error with the relay's reason, never "Relay restart requested". The relay
// is never restarted here; the restart request is answered by page.route.

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.confirmRestartWebRelay === "function");
}

// What the modal's "Restart web relay" button runs. Not awaited: an alert
// holds the page until the test dismisses it.
async function confirmRestart(page) {
  await page.evaluate(() => { void window.confirmRestartWebRelay(); });
}

test("a refused restart shows the relay's reason instead of success", async ({ page }) => {
  await page.route("**/api/relay/shutdown", (route) => route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({ error: "Refused by the proxy in front of the relay" }),
  }));
  await loadApp(page);
  const dialog = page.waitForEvent("dialog");
  await confirmRestart(page);
  const shown = await dialog;
  expect(shown.message()).toBe("The relay refused the restart: Refused by the proxy in front of the relay");
  await shown.dismiss();
  await expect(page.locator("#relay-toast")).not.toContainText("Relay restart requested");
});

test("a restart that gets no answer says so and does not claim success", async ({ page }) => {
  await page.route("**/api/relay/shutdown", (route) => route.abort("connectionreset"));
  await loadApp(page);
  let dialogs = 0;
  page.on("dialog", (dialog) => { dialogs += 1; void dialog.dismiss(); });
  await confirmRestart(page);
  const toast = page.locator("#relay-toast");
  await expect(toast).toContainText("could not be reached");
  await expect(toast).toContainText("If it took the restart");
  await expect(toast).not.toContainText("Relay restart requested");
  expect(dialogs).toBe(0);
});

test("an accepted restart still reports the queued restart", async ({ page }) => {
  await page.route("**/api/relay/shutdown", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, accepted: true, status: "queued", queue: { pendingCount: 2, processingCount: 1 } }),
  }));
  await loadApp(page);
  await confirmRestart(page);
  await expect(page.locator("#relay-toast")).toContainText("Relay restart queued (pending=2, processing=1).");
});
