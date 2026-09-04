import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The Features tab renders entirely from the server's flag registry
// (GET /api/settings/features): one toggle row + description per flag,
// env-pinned flags locked, and a restart notice whenever a stored value
// differs from the boot snapshot. The harness pins the two session-worker
// routing flags off via COPILOT_REMOTE_* env, which doubles as a regression
// test for the env-over-database precedence the isolation contract relies on.

const FLAG_TOGGLE_IDS = {
  routing: "feature-toggle-session_worker_routing_enabled",
  continuation: "feature-toggle-session_worker_continuation_routing_enabled",
  fallbackRestart: "feature-toggle-session_worker_fallback_restart_enabled",
  imageContinuity: "feature-toggle-image_conversation_continuity_enabled",
};

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openFeaturesTab(page) {
  await page.evaluate(() => window.openSettingsModal("features"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-panel-features")).toBeVisible();
}

test.describe("features settings tab", () => {
  test("renders every registry flag as a described toggle", async ({ page }) => {
    await loadApp(page);
    await openFeaturesTab(page);

    for (const toggleId of Object.values(FLAG_TOGGLE_IDS)) {
      await expect(page.locator(`#${toggleId}`)).toBeAttached();
    }
    await expect(page.locator("#features-flag-list .settings-row")).toHaveCount(4);

    // Every row carries a non-trivial user-facing description.
    const helpTexts = await page.locator("#features-flag-list .settings-help").allTextContents();
    expect(helpTexts).toHaveLength(4);
    for (const text of helpTexts) {
      expect(text.trim().length).toBeGreaterThan(40);
    }

    // The reserved flag is honest about being inert.
    await expect(page.locator(`label[for="${FLAG_TOGGLE_IDS.fallbackRestart}"]`)).toContainText("reserved");
  });

  test("env-pinned flags are locked and reported as pinned", async ({ page }) => {
    await loadApp(page);
    await openFeaturesTab(page);

    // The harness pins both session-worker flags off in the environment; the
    // registry default is on, so an unlocked toggle here would mean the
    // database or defaults outranked the env pin.
    for (const toggleId of [FLAG_TOGGLE_IDS.routing, FLAG_TOGGLE_IDS.continuation]) {
      const toggle = page.locator(`#${toggleId}`);
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
    }
    await expect(page.locator("#features-flag-list")).toContainText(
      "Pinned off by COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED",
    );

    // Unpinned flags stay interactive.
    await expect(page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`)).toBeEnabled();
  });

  test("toggling a flag shows the restart notice until the change is reverted", async ({ page }) => {
    await loadApp(page);
    await openFeaturesTab(page);

    const toggle = page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`);
    const notice = page.locator("#features-restart-notice");
    await expect(toggle).toBeChecked();
    await expect(notice).toBeHidden();

    // Off: stored value now differs from the boot snapshot.
    await toggle.click();
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Restart relay");
    await expect(page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`)).not.toBeChecked();

    // The stored change survives a reload — it lives in app_settings, and the
    // running snapshot still differs, so the notice comes back too.
    await page.reload();
    await loadApp(page);
    await openFeaturesTab(page);
    await expect(page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`)).not.toBeChecked();
    await expect(page.locator("#features-restart-notice")).toBeVisible();

    // Back on: stored matches the snapshot again and the notice clears.
    // (Never click the restart button — it would take down the test server.)
    await page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`).click();
    await expect(page.locator("#features-restart-notice")).toBeHidden();
    await expect(page.locator(`#${FLAG_TOGGLE_IDS.imageContinuity}`)).toBeChecked();
  });
});
