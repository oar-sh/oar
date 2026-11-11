import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// The settings modal was split from one long scrolling column into tab
// panels (General | Appearance | Providers | … ) with per-provider
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
  // Providers → Claude API (claude-api-settings-ui.js looks these up by ID)
  "claude-api-enabled-toggle",
  "claude-api-key-input",
  "claude-api-model-select",
  "claude-api-models-status",
  "claude-api-monthly-cap-input",
  "claude-api-monthly-cap-error",
  "claude-api-settings-status",
  "claude-api-save-btn",
  "claude-api-refresh-btn",
  "claude-api-remove-btn",
  "claude-api-open-claude-tab-btn",
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
  // Providers → DeepSeek
  "deepseek-enabled-toggle",
  "deepseek-api-key-input",
  "deepseek-model-select",
  "deepseek-attribution-select",
  "deepseek-base-url-input",
  "deepseek-settings-status",
  "deepseek-save-btn",
  "deepseek-remove-btn",
  "deepseek-usage-amount-input",
  "deepseek-usage-cost-input",
  "deepseek-usage-import-btn",
  "deepseek-usage-import-status",
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
  // Features
  "settings-panel-features",
  "features-flag-list",
  "features-restart-notice",
  "features-restart-btn",
  "features-settings-status",
  // Updates
  "update-auto-check-toggle",
  "update-check-now-btn",
  "update-last-checked",
  "update-available-card",
  "update-available-text",
  "update-notes-link",
  "update-apply-btn",
  "update-dismiss-btn",
  "update-git-hint",
  "update-cancel-btn",
  "update-install-log",
  "update-install-status",
  "update-outcome",
  "update-outcome-dismiss-btn",
  // Relays (remote relays, added with the tab — settings-modal.js and
  // remote-relays-settings.js look these up by ID too)
  // remote-relays-self-name, a read-only copy of the relay name, went when
  // the name field itself (pwa-app-name-input, above) moved to this tab.
  "settings-panel-relays",
  "remote-relays-public-url-input",
  "remote-relays-self-status",
  "remote-relays-inbound-toggle",
  "remote-relays-list",
  "remote-relays-empty",
  "remote-relays-status",
  "remote-relays-add-url-input",
  "remote-relays-add-token-row",
  "remote-relays-add-token-input",
  "remote-relays-use-token-btn",
  "remote-relays-pair-back-toggle",
  "remote-relays-add-btn",
  "remote-relays-add-status",
  // Sharing (added with the tab; shared-conversations-settings.js looks these
  // up by ID)
  "settings-panel-shares",
  "shares-settings-sections",
  "settings-shares-list",
  "settings-shares-empty",
  "settings-shares-store-ip",
  "settings-shares-status",
];

const TABS = ["general", "appearance", "providers", "relays", "previews", "shares", "notifications", "features"];
// Copilot leads, matching the DOM order in index.html: it is the default
// provider, so its panel is the one a first-time visitor lands on.
const PROVIDER_TABS = ["copilot", "openai", "claude", "claude-api", "claude-cloud", "grok", "cursor", "deepseek"];

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
  test("renders eight top-level tabs with one panel visible at a time", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    await expect(page.locator("#settings-modal .settings-tab-strip[role=tablist]").first()).toBeVisible();
    await expect(page.locator("#settings-modal [data-settings-tab]")).toHaveCount(TABS.length);
    await expectActiveTab(page, "general");

    // A control from the visible panel is reachable; one from a hidden panel is not.
    await expect(page.locator("#scroll-on-send-toggle")).toBeVisible();
    await expect(page.locator("#theme-select")).toBeHidden();
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

  test("a browser that last had General open still opens there, with Appearance one tab along", async ({ page }) => {
    await loadApp(page);
    // The remembered tab from before Appearance had a tab of its own.
    await page.evaluate(() => localStorage.setItem("copilot_settings_tab", "general"));
    await loadApp(page);
    await openSettings(page);
    await expectActiveTab(page, "general");
    await expect(page.locator("#settings-tab-appearance")).toHaveText("Appearance");

    await page.locator("#settings-tab-appearance").click();
    await expectActiveTab(page, "appearance");
    await expect(page.locator("#appearance-browser-note")).toBeVisible();
    for (const id of ["theme-select", "font-scale-select", "thoughts-expanded-toggle", "live-activity-cap-slider", "stream-view-toggle", "show-suspend-host-toggle"]) {
      await expect(page.locator(`#settings-panel-appearance #${id}`)).toBeVisible();
    }
    expect(await page.evaluate(() => localStorage.getItem("copilot_settings_tab"))).toBe("appearance");

    // The relay's own name and restart settings: at the top of Relays.
    await openSettings(page, "relays");
    for (const id of ["pwa-app-name-input", "restart-resume-toggle", "relay-restart-max-wait-select"]) {
      await expect(page.locator(`#settings-panel-relays #${id}`)).toBeVisible();
    }
    // An old deep link to General lands on General.
    await page.evaluate(() => window.closeSettingsModal());
    await openSettings(page, "general");
    await expectActiveTab(page, "general");
  });

  test("Settings takes the focus on open; Escape closes it and reaches nothing under it", async ({ page }) => {
    await loadApp(page);
    await page.locator("#new-conv-btn").focus();
    await openSettings(page, "general");
    // The selected tab has the focus, so the arrows and Escape work at once.
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("settings-tab-general");
    await page.keyboard.press("ArrowRight");
    await expectActiveTab(page, "appearance");

    // What lies underneath listens on the document; none of it hears this Escape.
    await page.evaluate(() => {
      window.__escapesBelow = 0;
      const count = (event) => { if (event.key === "Escape") window.__escapesBelow += 1; };
      document.addEventListener("keydown", count, true);
      document.addEventListener("keydown", count);
    });
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-modal")).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => window.__escapesBelow)).toBe(0);
    // The focus goes back where it was.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("new-conv-btn");
    // Closed, Settings leaves Escape alone.
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.__escapesBelow)).toBe(2);
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

  test("the Claude API refusal buttons deep-link to its panel, which points back to the Claude tab", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "notifications");
    await page.evaluate(() => window.closeSettingsModal());

    // The CTA a Claude API refusal renders (relay-error-ctas.mjs).
    await openSettings(page, "providers", "claude-api");
    await expectActiveTab(page, "providers");
    await expectActiveProviderTab(page, "claude-api");
    await expect(page.locator("#claude-api-key-input")).toBeVisible();
    await expect(page.locator("#claude-api-key-input")).toHaveAttribute("type", "password");
    await expect(providerPanel(page, "claude-api")).toContainText("set on the Claude tab");

    // The shared settings live on the Claude tab, one press away.
    await page.locator("#claude-api-open-claude-tab-btn").click();
    await expectActiveProviderTab(page, "claude");
    await expect(page.locator("#claude-background-command-limit-slider")).toBeVisible();
  });

  test("the Claude background command limit slider saves and survives a reload", async ({ page }) => {
    const authorization = { Authorization: `Bearer ${relayToken()}` };
    const readLimit = async () => {
      const response = await page.request.get("/api/settings/claude", { headers: authorization });
      expect(response.ok()).toBe(true);
      return (await response.json()).backgroundCommandLimitMinutes;
    };
    const writeLimit = (minutes) => page.request.post("/api/settings/claude", {
      headers: authorization,
      data: { backgroundCommandLimitMinutes: minutes },
    });

    try {
      expect((await writeLimit(120)).ok()).toBe(true);
      await loadApp(page);
      await openSettings(page, "providers", "claude");
      const slider = page.locator("#claude-background-command-limit-slider");
      const value = page.locator("#claude-background-command-limit-value");
      await expect(slider).toBeVisible();
      await expect(slider).toHaveValue("120");
      await expect(value).toHaveText("2 h");
      await expect(providerPanel(page, "claude")).toContainText("Applies to Claude sessions started after you save");

      await slider.fill("240");
      await expect(value).toHaveText("4 h");
      await page.locator("#claude-save-btn").click();
      await expect.poll(readLimit).toBe(240);

      await loadApp(page);
      await openSettings(page, "providers", "claude");
      await expect(slider).toHaveValue("240");
      await expect(value).toHaveText("4 h");

      // The relay clamps to 30 min … 8 h on 30-minute steps.
      const clamped = await writeLimit(1000);
      expect((await clamped.json()).backgroundCommandLimitMinutes).toBe(480);
      expect((await (await writeLimit(100)).json()).backgroundCommandLimitMinutes).toBe(90);
      expect((await writeLimit("soon")).status()).toBe(400);
    } finally {
      await writeLimit(120);
    }
  });
});

// The strip scrolls sideways on a phone, with no scrollbar: the side with
// more tabs fades (tab-strip-fade.mjs marks it as data-fade), and the
// selected tab is scrolled whole into view, clear of the fade.
test.describe("the tab strip on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const TOP_STRIP = "#settings-modal .settings-tab-strip:not(.settings-subtab-strip)";

  // The strip's state, and where `tabId` sits in it.
  function readStrip(page, selector, tabId) {
    return page.evaluate(([stripSelector, id]) => {
      const strip = document.querySelector(stripSelector);
      const tab = document.getElementById(id);
      const box = strip.getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      const style = getComputedStyle(strip);
      return {
        fade: strip.getAttribute("data-fade"),
        mask: style.maskImage || style.webkitMaskImage || "none",
        fadeWidth: parseFloat(style.scrollPaddingLeft) || 0,
        scrollLeft: strip.scrollLeft,
        room: strip.scrollWidth - strip.clientWidth,
        tabLeft: tabBox.left - box.left,
        tabRight: box.right - tabBox.right,
      };
    }, [selector, tabId]);
  }

  // Whole, and clear of a fade on either side that has one.
  function expectClear(state) {
    const leftFade = state.fade === "left" || state.fade === "both";
    const rightFade = state.fade === "right" || state.fade === "both";
    expect(state.tabLeft).toBeGreaterThanOrEqual((leftFade ? state.fadeWidth : 0) - 1);
    expect(state.tabRight).toBeGreaterThanOrEqual((rightFade ? state.fadeWidth : 0) - 1);
  }

  async function scrollStrip(page, selector, where) {
    await page.evaluate(([stripSelector, to]) => {
      const strip = document.querySelector(stripSelector);
      const room = strip.scrollWidth - strip.clientWidth;
      strip.scrollLeft = to === "end" ? room : to === "middle" ? Math.round(room / 2) : 0;
    }, [selector, where]);
  }

  test("Features shows whole when chosen, and the strip's end has no fade", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");

    // At the start: more to the right, so the right edge fades.
    let state = await readStrip(page, TOP_STRIP, "settings-tab-general");
    expect(state.room).toBeGreaterThan(0);
    expect(state.scrollLeft).toBe(0);
    expect(state.fade).toBe("right");
    expect(state.mask).not.toBe("none");
    expect(state.fadeWidth).toBeGreaterThan(0);

    // In the middle both edges fade; at the end only the left.
    await scrollStrip(page, TOP_STRIP, "middle");
    await expect.poll(async () => (await readStrip(page, TOP_STRIP, "settings-tab-general")).fade).toBe("both");
    await scrollStrip(page, TOP_STRIP, "end");
    await expect.poll(async () => (await readStrip(page, TOP_STRIP, "settings-tab-general")).fade).toBe("left");
    await scrollStrip(page, TOP_STRIP, "start");
    await expect.poll(async () => (await readStrip(page, TOP_STRIP, "settings-tab-general")).fade).toBe("right");

    // Features, the last tab: the strip goes to its end, where nothing fades
    // on the right. Clicked without Playwright's own scroll into view: the
    // app has to bring it in.
    await page.locator("#settings-tab-features").dispatchEvent("click");
    await expectActiveTab(page, "features");
    await expect.poll(async () => (await readStrip(page, TOP_STRIP, "settings-tab-features")).fade).toBe("left");
    state = await readStrip(page, TOP_STRIP, "settings-tab-features");
    expect(state.scrollLeft).toBeGreaterThanOrEqual(state.room - 1);
    expect(state.mask).toContain("to right");
    expectClear(state);

    // Opened again on Features (from the start): scrolled to it at once.
    await page.evaluate(() => window.closeSettingsModal());
    await scrollStrip(page, TOP_STRIP, "start");
    await openSettings(page);
    state = await readStrip(page, TOP_STRIP, "settings-tab-features");
    expect(state.fade).toBe("left");
    expectClear(state);

    // A tab in the middle, chosen: whole and clear of both fades.
    await page.locator("#settings-tab-previews").dispatchEvent("click");
    state = await readStrip(page, TOP_STRIP, "settings-tab-previews");
    expectClear(state);
  });

  test("the provider tabs do the same", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "providers", "copilot");
    const SUB_STRIP = "#settings-modal .settings-subtab-strip";
    let state = await readStrip(page, SUB_STRIP, "settings-provider-tab-copilot");
    expect(state.room).toBeGreaterThan(0);
    expect(state.fade).toBe("right");

    await page.locator("#settings-provider-tab-deepseek").dispatchEvent("click");
    await expectActiveProviderTab(page, "deepseek");
    state = await readStrip(page, SUB_STRIP, "settings-provider-tab-deepseek");
    expect(state.fade).toBe("left");
    expect(state.scrollLeft).toBeGreaterThanOrEqual(state.room - 1);
    expectClear(state);
  });

  test("Plan usage's provider strip fades the same way", async ({ page }) => {
    // Every provider with a card and two more, so the strip runs past 390.
    const report = {
      providers: ["github", "claude", "claude-cloud", "cursor", "grok", "deepseek", "openai", "claude-api"].map((provider) => ({
        provider,
        label: { openai: "OpenAI", "claude-api": "Claude API" }[provider],
        meters: [],
        notes: ["Nothing used this period."],
      })),
    };
    await page.route("**/api/usage**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report) }));
    await loadApp(page);
    await page.waitForFunction(() => typeof window.showUsage === "function");
    await page.evaluate(() => { void window.showUsage(); });
    const STRIP = ".plan-usage-tab-strip";
    await expect(page.locator(`${STRIP} [data-usage-tab]`)).toHaveCount(8);

    const fade = async () => (await readStrip(page, STRIP, "plan-usage-tab-github")).fade;
    await scrollStrip(page, STRIP, "start");
    await expect.poll(fade).toBe("right");
    await scrollStrip(page, STRIP, "middle");
    await expect.poll(fade).toBe("both");
    await scrollStrip(page, STRIP, "end");
    await expect.poll(fade).toBe("left");
    const state = await readStrip(page, STRIP, "plan-usage-tab-github");
    expect(state.room).toBeGreaterThan(0);
    expect(state.mask).not.toBe("none");
  });
});
