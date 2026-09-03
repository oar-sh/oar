import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The settings modal was split from one long scrolling column into four tab
// panels (General | Providers | Previews | Notifications) with per-provider
// sub-tabs. settings-modal.js still looks every control up by ID, so the
// restructure is only safe as long as each legacy ID survives the move — that
// is what the bulk of this spec pins down.

// Every element ID that lived inside #settings-modal before the tab
// restructure, extracted from the pre-change markup. Any of these going
// missing (or turning up twice after a copy/paste) silently breaks the
// ID-based sync code, so they are asserted verbatim.
const LEGACY_SETTINGS_IDS = [
  "settings-modal",
  "settings-modal-title",
  // General
  "theme-select",
  "font-scale-select",
  "show-suspend-host-toggle",
  "turn-ceiling-value",
  "turn-ceiling-slider",
  "background-task-timeout-value",
  "background-task-timeout-slider",
  "windows-autostart-setting",
  // The autostart checkbox became a radio group (name="windows-autostart-mode",
  // no per-radio IDs) plus these status/fallback elements in e5a9579.
  "windows-autostart-status",
  "windows-autostart-manual",
  "windows-autostart-manual-command",
  "pwa-app-name-input",
  "default-session-workspace-root-input",
  // Providers → OpenAI
  "openai-enabled-toggle",
  "openai-api-key-input",
  "openai-model-input",
  "openai-base-url-input",
  "openai-settings-status",
  "openai-save-btn",
  "openai-remove-btn",
  // Providers → Claude
  "claude-enabled-toggle",
  "claude-model-input",
  "claude-settings-status",
  "claude-save-btn",
  // Providers → Grok
  "grok-enabled-toggle",
  "grok-model-input",
  "grok-settings-status",
  "grok-save-btn",
  "grok-allowance-monthly-input",
  "grok-allowance-reset-day-input",
  "grok-allowance-status",
  "grok-allowance-save-btn",
  "grok-allowance-reset-btn",
  // Providers → Cursor
  "cursor-enabled-toggle",
  "cursor-api-key-input",
  "cursor-model-input",
  "cursor-settings-status",
  "cursor-save-btn",
  "cursor-remove-btn",
  "cursor-allowance-cursor-models-input",
  "cursor-allowance-other-models-input",
  "cursor-allowance-reset-day-input",
  "cursor-allowance-status",
  "cursor-allowance-save-btn",
  "cursor-allowance-reset-btn",
  "cursor-dashboard-token-input",
  "cursor-dashboard-token-status",
  "cursor-dashboard-token-save-btn",
  "cursor-dashboard-token-remove-btn",
  // Previews
  "previews-settings-section",
  "settings-previews-list",
  "settings-previews-empty",
  // Notifications
  "push-settings-section",
  "push-enabled-toggle",
  "push-settings-status",
  "push-include-title-toggle",
  "push-preview-select",
  "push-preview-chars-input",
  "push-event-question-toggle",
  "push-event-turn-complete-toggle",
  "push-event-turn-failed-toggle",
  "push-event-board-toggle",
  "push-event-cli-offline-toggle",
  "push-device-list",
];

const TABS = ["general", "providers", "previews", "notifications"];
// Copilot leads, matching the DOM order in index.html: it is the default
// provider, so its panel is the one a first-time visitor lands on.
const PROVIDER_TABS = ["copilot", "openai", "claude", "grok", "cursor"];

async function loadApp(page) {
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
  // networkidle can fire before the app modules finish binding their globals.
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openSettings(page, tab, providerTab) {
  await page.evaluate(
    ([wanted, wantedProvider]) => window.openSettingsModal(wanted, wantedProvider),
    [tab ?? undefined, providerTab ?? undefined],
  );
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
}

function panel(page, tab) {
  return page.locator(`#settings-panel-${tab}`);
}

function providerPanel(page, providerTab) {
  return page.locator(`#settings-provider-panel-${providerTab}`);
}

async function expectActiveTab(page, tab) {
  for (const candidate of TABS) {
    await expect(page.locator(`#settings-tab-${candidate}`)).toHaveAttribute(
      "aria-selected",
      candidate === tab ? "true" : "false",
    );
    if (candidate === tab) await expect(panel(page, candidate)).toBeVisible();
    else await expect(panel(page, candidate)).toBeHidden();
  }
}

async function expectActiveProviderTab(page, providerTab) {
  for (const candidate of PROVIDER_TABS) {
    await expect(page.locator(`#settings-provider-tab-${candidate}`)).toHaveAttribute(
      "aria-selected",
      candidate === providerTab ? "true" : "false",
    );
    if (candidate === providerTab) await expect(providerPanel(page, candidate)).toBeVisible();
    else await expect(providerPanel(page, candidate)).toBeHidden();
  }
}

test.describe("tabbed settings modal", () => {
  test("renders four top-level tabs with one panel visible at a time", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    await expect(page.locator("#settings-modal .settings-tab-strip[role=tablist]").first()).toBeVisible();
    await expect(page.locator("#settings-modal [data-settings-tab]")).toHaveCount(TABS.length);
    await expectActiveTab(page, "general");

    // A control from the visible panel is reachable; one from a hidden panel is not.
    await expect(page.locator("#theme-select")).toBeVisible();
    await expect(page.locator("#push-enabled-toggle")).toBeHidden();

    for (const tab of TABS) {
      await page.locator(`#settings-tab-${tab}`).click();
      await expectActiveTab(page, tab);
    }
  });

  test("every legacy settings control survives the restructure exactly once", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    const report = await page.evaluate((ids) => {
      const modal = document.getElementById("settings-modal");
      return ids.map((id) => ({
        id,
        // Document-wide count: a stray duplicate anywhere breaks getElementById.
        count: document.querySelectorAll(`[id="${id}"]`).length,
        inModal: id === "settings-modal"
          ? true
          : !!(modal && modal.querySelector(`[id="${id}"]`)),
      }));
    }, LEGACY_SETTINGS_IDS);

    expect(report.filter((entry) => entry.count !== 1)).toEqual([]);
    expect(report.filter((entry) => !entry.inModal)).toEqual([]);
    expect(report).toHaveLength(LEGACY_SETTINGS_IDS.length);
  });

  test("the Providers tab exposes provider sub-tabs that switch panels", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    await page.locator("#settings-tab-providers").click();
    await expectActiveTab(page, "providers");
    await expect(page.locator("#settings-modal [data-settings-provider-tab]")).toHaveCount(
      PROVIDER_TABS.length,
    );

    for (const providerTab of PROVIDER_TABS) {
      await page.locator(`#settings-provider-tab-${providerTab}`).click();
      await expectActiveProviderTab(page, providerTab);
    }

    // Sub-panels carry their own provider controls, which are only reachable
    // while their sub-tab is selected.
    await page.locator("#settings-provider-tab-claude").click();
    await expect(page.locator("#claude-model-input")).toBeVisible();
    await expect(page.locator("#grok-model-input")).toBeHidden();
  });

  test("the last tab and provider sub-tab are restored on reopen", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    await page.locator("#settings-tab-providers").click();
    await page.locator("#settings-provider-tab-grok").click();
    await expectActiveProviderTab(page, "grok");

    await page.evaluate(() => window.closeSettingsModal());
    await expect(page.locator("#settings-modal")).not.toHaveClass(/visible/);

    // Reopened without arguments: the persisted selection wins over the default.
    await openSettings(page);
    await expectActiveTab(page, "providers");
    await expectActiveProviderTab(page, "grok");

    expect(
      await page.evaluate(() => [
        localStorage.getItem("copilot_settings_tab"),
        localStorage.getItem("copilot_settings_provider_tab"),
      ]),
    ).toEqual(["providers", "grok"]);

    // Persistence outlives the page, not just the modal.
    await loadApp(page);
    await openSettings(page);
    await expectActiveTab(page, "providers");
    await expectActiveProviderTab(page, "grok");
  });

  test("deep-linking lands on the Claude provider panel", async ({ page }) => {
    await loadApp(page);
    // Park the persisted selection somewhere else so the deep link is what
    // moves the modal, not leftover state.
    await openSettings(page, "notifications");
    await expectActiveTab(page, "notifications");
    await page.evaluate(() => window.closeSettingsModal());

    // The CTA the Claude auth-failure error renders.
    await openSettings(page, "providers", "claude");
    await expectActiveTab(page, "providers");
    await expectActiveProviderTab(page, "claude");
    await expect(page.locator("#claude-auth-relogin-btn")).toBeVisible();

    // Unknown values fall back to the persisted selection instead of throwing.
    await page.evaluate(() => window.closeSettingsModal());
    await openSettings(page, "nonsense", "nonsense");
    await expectActiveTab(page, "providers");
    await expectActiveProviderTab(page, "claude");
  });
});
