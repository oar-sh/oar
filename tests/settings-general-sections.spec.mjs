import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Settings › General in headed sections: the six titles show in order on a
// phone and a desktop, and Models holds its controls. With OAR_E2E_SCREENSHOT_DIR set, the panel is shot at
// its top and with "This relay" scrolled up, dark and light.

const SECTIONS = ["Appearance", "Reading", "Turns and tasks", "Models", "This relay", "Updates"];
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];

async function openGeneral(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  await page.evaluate(() => window.openSettingsModal("general"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-panel-general")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`General shows its six section titles in order (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openGeneral(page);
    const titles = page.locator("#settings-panel-general > .settings-section > .settings-section-title");
    await expect(titles).toHaveText(SECTIONS);
    for (const id of ["theme-select", "scroll-on-send-toggle", "turn-ceiling-slider", "model-refresh-auto-toggle", "pwa-app-name-input", "update-auto-check-toggle"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeVisible();
    }

    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();
    if (!shotDir) return;
    for (const theme of ["dark", "light"]) {
      await page.locator("#theme-select").scrollIntoViewIfNeeded();
      await page.locator("#theme-select").selectOption(theme);
      await page.locator("#settings-section-appearance-title").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/general-${viewport.name}-${theme}-top.png` });
      await page.evaluate(() => document.getElementById("settings-section-relay-title").scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shotDir}/general-${viewport.name}-${theme}-relay.png` });
    }
  });
}

test("Models holds the check switch, its interval and one row per provider", async ({ page }) => {
  // The section reads the relay's value as Settings opens: asserted after it.
  const loaded = page.waitForResponse((response) => response.url().endsWith("/api/model-refresh-settings")
    && response.request().method() === "GET");
  await openGeneral(page);
  const settings = await (await loaded).json();
  const section = page.locator("#settings-section-models");
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator(".settings-section-title")).toHaveText("Models");

  const toggle = section.locator("#model-refresh-auto-toggle");
  await expect(toggle).toBeVisible();
  await expect(page.locator('label[for="model-refresh-auto-toggle"]')).toHaveText("Check for new models");
  if (settings.auto) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();

  const interval = section.locator("#model-refresh-interval-select");
  await expect(interval).toBeVisible();
  await expect(interval).toHaveValue(String(settings.intervalHours));
  await expect(interval.locator("option")).toHaveText(["Every 6 h", "Every 12 h", "Every 24 h", "Every 3 days", "Every 7 days"]);
  if (settings.auto) await expect(interval).toBeEnabled();
  else await expect(interval).toBeDisabled();

  // One "Check <provider>" row per provider the relay lists, ticked unless excluded.
  const rows = section.locator("#model-refresh-providers .model-refresh-provider-row");
  await expect(rows).toHaveCount(settings.providers.length);
  for (const provider of settings.providers) {
    const box = section.locator(`#model-refresh-providers input[data-model-refresh-provider="${provider.id}"]`);
    await expect(box).toHaveAccessibleName(`Check ${provider.label} for new models`);
    if (settings.excluded.includes(provider.id)) await expect(box).not.toBeChecked();
    else await expect(box).toBeChecked();
  }
  await expect(section.locator(".settings-help").last()).toContainText("A setting of this relay.");
});
