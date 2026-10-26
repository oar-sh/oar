import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_SECOND_KEY, startFakeAnthropicApi } from "./fake-anthropic-api.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * Settings → Providers → Claude API, end to end in the browser.
 *
 * A key typed into the tab is saved, the relay lists the key's models from a
 * fake Anthropic API on a loopback port (OAR_ANTHROPIC_API_BASE_URL, which the
 * relay takes for a loopback address only), and the key never comes back: not
 * in an answer, not in the page. The Select Models → Claude API tab narrows
 * the list, the cap is stored, and the switch takes Claude API out of New Chat.
 *
 * The relay is its own (the shared one points the Anthropic URL at a dead
 * port); it spawns no worker and sends no turn. The keys are invented: they
 * carry the Anthropic prefix the tab requires (sk-ant-) and stay too short
 * to read as a real key (scripts/hygiene-patterns.mjs).
 */

const TEST_KEY = FAKE_ANTHROPIC_KEY;
const SECOND_KEY = FAKE_ANTHROPIC_SECOND_KEY;

// The fake's two pages of models (has_more / last_id are followed). The
// default model is the first Sonnet; a model with a 1M window gets its "[1m]"
// id beside it.
const DISCOVERED = ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-opus-5-5", "claude-haiku-4-5-20251001"];

test.describe("Claude API settings", () => {
  // One relay and one fake for the file, the steps in order.
  test.describe.configure({ mode: "serial" });

  let fake = null;
  let relay = null;
  let headers = null;
  const api = (path) => `${relay.baseUrl}${path}`;

  test.beforeAll(async () => {
    fake = await startFakeAnthropicApi();
    relay = await startRelayServer({
      token: randomUUID(),
      overrides: { OAR_ANTHROPIC_API_BASE_URL: fake.baseUrl },
    });
    headers = { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" };
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (fake) {
      await fake.close();
    }
    fake = null;
  });

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  }

  async function openTab(page) {
    // The modal reads the tab's state on open: a press before that answer
    // lands could be undone by it.
    const loaded = page.waitForResponse((response) => response.url().endsWith("/api/settings/claude-api")
      && response.request().method() === "GET");
    await page.evaluate(() => window.openSettingsModal("providers", "claude-api"));
    await loaded;
    await expect(page.locator("#settings-provider-panel-claude-api")).toBeVisible();
  }

  async function readSettings() {
    const response = await fetch(api("/api/settings/claude-api"), { headers });
    expect(response.ok).toBe(true);
    return response.json();
  }

  test("an unconfigured tab asks for a key and offers nothing to switch", async ({ page }) => {
    await loadApp(page);
    await openTab(page);
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "unconfigured");
    await expect(page.locator("#claude-api-enabled-toggle")).toBeDisabled();
    await expect(page.locator("#claude-api-remove-btn")).toBeDisabled();
    await expect(page.locator("#claude-api-refresh-btn")).toBeDisabled();
    await expect(page.locator("#claude-api-key-input")).toHaveAttribute("type", "password");
    await expect(page.locator("#claude-api-key-input")).toHaveAttribute("placeholder", "Claude Console API key…");
    expect(fake.seen).toHaveLength(0);
  });

  test("a key typed into the tab lists the key's models, and never comes back", async ({ page }) => {
    await loadApp(page);
    await openTab(page);
    await page.locator("#claude-api-key-input").fill(TEST_KEY);
    await page.locator("#claude-api-monthly-cap-input").fill("25");
    await page.locator("#claude-api-save-btn").click();

    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "active");
    await expect(page.locator("#claude-api-enabled-toggle")).toBeChecked();
    await expect(page.locator("#claude-api-key-input")).toHaveValue("");
    await expect(page.locator("#claude-api-key-input")).toHaveAttribute("placeholder", /Saved API key/);
    await expect(page.locator("#claude-api-model-select option")).toHaveText(DISCOVERED);
    await expect(page.locator("#claude-api-model-select")).toHaveValue("claude-sonnet-5-5");
    await expect(page.locator("#claude-api-monthly-cap-input")).toHaveValue("25");
    await expect(page.locator("#claude-api-models-status")).toBeHidden();

    // Both pages were read, with the key and the API version, from the fake only.
    const modelCalls = fake.seen.filter((call) => call.path === "/v1/models");
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    expect(modelCalls.every((call) => call.key === TEST_KEY && call.version === "2023-06-01")).toBe(true);
    expect(modelCalls.some((call) => call.afterId === "claude-opus-5-5")).toBe(true);

    const settings = await readSettings();
    expect(settings.configured).toBe(true);
    expect(settings.monthlyCapUsd).toBe(25);
    expect(JSON.stringify(settings)).not.toContain(TEST_KEY);
    expect(await page.content()).not.toContain(TEST_KEY);

    // After a reload too: the field is empty, the key only "saved".
    await loadApp(page);
    await openTab(page);
    await expect(page.locator("#claude-api-key-input")).toHaveValue("");
    expect(await page.content()).not.toContain(TEST_KEY);
  });

  test("Refresh models asks Anthropic again and keeps the list", async ({ page }) => {
    await loadApp(page);
    await openTab(page);
    const before = fake.seen.length;
    await page.locator("#claude-api-refresh-btn").click();
    await expect.poll(() => fake.seen.length).toBeGreaterThan(before);
    await expect(page.locator("#claude-api-model-select option")).toHaveText(DISCOVERED);
  });

  test("the default model and the cap are saved; an emptied cap is no cap", async ({ page }) => {
    await loadApp(page);
    await openTab(page);
    await page.locator("#claude-api-model-select").selectOption("claude-opus-5-5");
    await page.locator("#claude-api-monthly-cap-input").fill("");
    await page.locator("#claude-api-save-btn").click();
    await expect.poll(async () => (await readSettings()).model).toBe("claude-opus-5-5");
    expect((await readSettings()).monthlyCapUsd).toBeNull();
    await expect(page.locator("#claude-api-monthly-cap-input")).toHaveValue("");
    await expect(page.locator("#claude-api-monthly-cap-input")).toHaveAttribute("placeholder", "No cap");
  });

  test("Select Models has a Claude API tab whose choice narrows the key's list", async ({ page }) => {
    await loadApp(page);
    await page.locator("#chat-actions-menu-btn").click();
    await expect(page.locator("#chat-actions-menu")).toBeVisible();
    await page.locator("#chat-menu-select-models").click();
    const tab = page.locator('[data-model-provider-tab="claude-api"]');
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveClass(/active/);
    const rows = page.locator(".model-variant-checkbox[data-claude-api-model]");
    await expect(rows).toHaveCount(DISCOVERED.length);
    // The default model stays on and cannot be turned off.
    await expect(page.locator('.model-variant-checkbox[data-claude-api-model="claude-opus-5-5"]')).toBeDisabled();
    await page.locator('.model-variant-checkbox[data-claude-api-model="claude-haiku-4-5-20251001"]').uncheck();
    await page.locator("#summary-modal-save-models").click();
    await expect.poll(async () => (await readSettings()).models).not.toContain("claude-haiku-4-5-20251001");
    expect((await readSettings()).models).toContain("claude-opus-5-5");
  });

  test("New Chat offers Claude API with the narrowed list while it is on", async ({ page }) => {
    await loadApp(page);
    await expect(page.locator("#new-conv-btn")).toBeEnabled();
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    await page.locator("#new-conversation-provider-select").selectOption("claude-api");
    const models = await page.locator("#new-conversation-model-select option").evaluateAll(
      (options) => options.map((option) => option.value),
    );
    expect(models).toContain("claude-opus-5-5");
    expect(models).not.toContain("claude-haiku-4-5-20251001");
    await page.locator("#new-conversation-model-modal button:has-text('Cancel')").click();

    // Switched off in the tab: gone from New Chat, the key still saved.
    await openTab(page);
    await page.locator("#claude-api-enabled-toggle").uncheck();
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "saved");
    await page.evaluate(() => window.closeSettingsModal());
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    await expect(page.locator('#new-conversation-provider-select option[value="claude-api"]')).toHaveCount(0);
    await page.locator("#new-conversation-model-modal button:has-text('Cancel')").click();
    expect((await readSettings()).configured).toBe(true);
  });

  test("a new key replaces the old one and lists again; Remove takes it out", async ({ page }) => {
    await loadApp(page);
    await openTab(page);
    // The step before left Claude API off, and a new key does not switch it
    // on by itself (nor list models while it is off): on first.
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "saved");
    await page.locator("#claude-api-enabled-toggle").check();
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "active");
    const before = fake.seen.length;
    await page.locator("#claude-api-key-input").fill(SECOND_KEY);
    await page.locator("#claude-api-save-btn").click();
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "active");
    await expect.poll(() => fake.seen.slice(before).some((call) => call.key === SECOND_KEY)).toBe(true);
    expect(await page.content()).not.toContain(SECOND_KEY);

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#claude-api-remove-btn").click();
    await expect(page.locator("#claude-api-settings-status")).toHaveAttribute("data-state", "unconfigured");
    expect((await readSettings()).configured).toBe(false);
  });
});
