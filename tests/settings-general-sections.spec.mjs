import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Settings › General in headed sections: the five titles show in order on a
// phone and a desktop. With OAR_E2E_SCREENSHOT_DIR set, the panel is shot at
// its top and with "This relay" scrolled up, dark and light.

const SECTIONS = ["Appearance", "Reading", "Turns and tasks", "This relay", "Updates"];
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
  test(`General shows its five section titles in order (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openGeneral(page);
    const titles = page.locator("#settings-panel-general > .settings-section > .settings-section-title");
    await expect(titles).toHaveText(SECTIONS);
    for (const id of ["theme-select", "scroll-on-send-toggle", "turn-ceiling-slider", "pwa-app-name-input", "update-auto-check-toggle"]) {
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
