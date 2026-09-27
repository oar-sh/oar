import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { startRelayServer } from "./relay-server-harness.mjs";

// Deferred host suspend (docs/plans/2026-09-27-deferred-host-suspend.md): the
// modal peeks at what is running, a confirm queues the request, every client
// shows the banner with a countdown, and Cancel withdraws it. Every e2e relay
// runs with OAR_HOST_SUSPEND_DRY_RUN=1 so a fired suspend only logs.
//
// This spec boots its OWN relay. "Idle" is a property of the whole relay, and
// the shared one is never idle in a full run: earlier specs leave turns queued
// that no CLI will ever answer, so the modal (correctly) lists them as
// blockers and nothing here would see the idle countdown.

let relay = null;

test.beforeAll(async () => {
  relay = await startRelayServer({ token: randomUUID() });
});

test.afterAll(async () => {
  if (relay) await relay.stop();
  relay = null;
});

async function loadApp(page) {
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSuspendHostConfirmation === "function");
}

// Through the API fixture, not the page: a test skipped before loadApp()
// leaves the page on about:blank, where a relative fetch cannot resolve and the
// cleanup used to turn every skip into a failure.
test.afterEach(async ({ request }) => {
  if (!relay) return;
  await request.post(`${relay.baseUrl}/api/host/suspend/cancel`, {
    headers: { Authorization: `Bearer ${relay.token}` },
    data: { requestedBy: "e2e-cleanup" },
  }).catch(() => {});
});

test("off Windows the modal explains that host suspend needs a Windows relay host", async ({ page }) => {
  test.skip(process.platform === "win32", "a Windows relay offers the suspend instead"); // host-platform: the relay refuses host suspend everywhere else
  await loadApp(page);
  await page.evaluate(() => window.openSuspendHostConfirmation());
  const body = page.locator("#summary-modal-body");
  await expect(body).toContainText(/only available when the relay runs on Windows/i);
  await expect(body.locator("button", { hasText: "Suspend host" })).toHaveCount(0);
  await page.evaluate(() => window.closeSummaryModal());
});

test("the modal reports an idle relay and explains the 30 second countdown", async ({ page }) => {
  test.skip(process.platform !== "win32", "host suspend is only available on a Windows relay host"); // host-platform: the relay refuses host suspend elsewhere (previous test)
  await loadApp(page);
  await page.evaluate(() => window.openSuspendHostConfirmation());
  const modal = page.locator("#summary-modal");
  await expect(modal).toHaveClass(/visible/);
  const body = page.locator("#summary-modal-body");
  await expect(body).toContainText(/suspends.*30 seconds/i);
  await expect(body.locator("button", { hasText: "Suspend host" })).toBeVisible();
  await page.evaluate(() => window.closeSummaryModal());
});

test("confirming queues the suspend, shows the banner on another client, and Cancel clears it", async ({ page, browser }) => {
  test.skip(process.platform !== "win32", "host suspend is only available on a Windows relay host"); // host-platform: the relay refuses to queue elsewhere
  await loadApp(page);
  await page.evaluate(() => window.openSuspendHostConfirmation());
  await page.locator("#summary-modal-body button", { hasText: "Suspend host" }).click();

  const banner = page.locator("#pending-action-banner");
  await expect(banner).toHaveClass(/visible/);
  await expect(banner).toContainText(/suspending host in 0:[0-3]\d/);
  await expect(page.locator("#chat-menu-suspend-host")).toHaveText("💤 Suspend pending…");

  // A second, independent client sees the same banner from its connect payload.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await loadApp(other);
    await expect(other.locator("#pending-action-banner")).toHaveClass(/visible/);
    await expect(other.locator("#pending-action-banner")).toContainText(/suspending host in/);

    await other.locator("#pending-action-banner .pending-action-cancel").click();
    await expect(other.locator("#pending-action-banner")).not.toHaveClass(/visible/);
    // …and the first client is told too.
    await expect(banner).not.toHaveClass(/visible/);
    await expect(page.locator("#chat-menu-suspend-host")).toHaveText("💤 Suspend host");
  } finally {
    await otherContext.close();
  }
});

test("reopening the modal while queued offers to cancel instead of confirming", async ({ page }) => {
  test.skip(process.platform !== "win32", "host suspend is only available on a Windows relay host"); // host-platform: the relay refuses to queue elsewhere
  await loadApp(page);
  await page.evaluate(async () => {
    await fetch("/api/host/suspend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedBy: "e2e" }),
    });
  });
  await page.evaluate(() => window.openSuspendHostConfirmation());
  const body = page.locator("#summary-modal-body");
  await expect(body).toContainText(/suspends in|already queued/i);
  await body.locator("button", { hasText: "Cancel queued suspend" }).click();
  await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
  await expect(page.locator("#pending-action-banner")).not.toHaveClass(/visible/);
});
