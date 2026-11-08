import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { FAKE_ANTHROPIC_KEY, FAKE_ANTHROPIC_MODEL_PAGES, startFakeAnthropicApi } from "./fake-anthropic-api.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * New models in Select Models, end to end in the browser.
 *
 * The Claude API provider lists a fake Anthropic API's models (on a loopback
 * port, OAR_ANTHROPIC_API_BASE_URL). After the first list has been seen, the
 * fake offers one more model and the relay's model refresh finds it: the ︙
 * entry gets its dot, the Claude API tab shows the "Turn new models on
 * automatically" switch on top and tags the new row "New", and opening the
 * modal clears the dot. With the switch off, the next new model starts off,
 * and the toast of that refresh opens the tab. A model found while the page
 * is open lights the dot without a reload, and Settings › General › Models
 * saves an unticked provider as excluded.
 *
 * The relay is its own; it spawns no worker and sends no turn. The key and the
 * added model names are invented (see fake-anthropic-api.mjs).
 */

const ADDED_ON = "claude-sonnet-6-0";
const ADDED_OFF = "claude-haiku-6-0";
const ADDED_LIVE = "claude-opus-6-0";

function fakeModel(id, displayName) {
  return { id, display_name: displayName, max_input_tokens: 200000, max_tokens: 64000, capabilities: { effort: { supported: false } } };
}

test.describe("Select Models: new models", () => {
  test.describe.configure({ mode: "serial" });

  // The fake reads its pages on every request: a model pushed here is offered
  // from the next discovery on.
  const pages = FAKE_ANTHROPIC_MODEL_PAGES.map((page) => ({ ...page, data: [...page.data] }));
  let fake = null;
  let relay = null;
  let headers = null;
  const api = (path) => `${relay.baseUrl}${path}`;

  async function call(method, path, body) {
    const response = await fetch(api(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path} answered ${response.status}`).toBe(true);
    return response.json();
  }

  async function claudeApiBlock() {
    return (await call("GET", "/api/model-variants")).claudeApiModels;
  }

  test.beforeAll(async () => {
    // The boot discovery below may take its full time.
    test.setTimeout(180_000);
    fake = await startFakeAnthropicApi({ pages });
    relay = await startRelayServer({
      token: randomUUID(),
      overrides: { OAR_ANTHROPIC_API_BASE_URL: fake.baseUrl },
    });
    headers = { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" };
    // A key lists the fake's models; that first list is then seen.
    await call("POST", "/api/settings/claude-api", { apiKey: FAKE_ANTHROPIC_KEY, enabled: true });
    await expect.poll(async () => (await claudeApiBlock())?.availableModels?.length || 0).toBeGreaterThan(0);
    // A host whose Copilot CLI this relay can still reach runs the boot
    // discovery: once it lands (or Copilot says it is not set up), the models
    // it adds are seen too, so a late landing cannot bring the menu dot back
    // during the tests.
    await expect.poll(async () => {
      const settings = await call("GET", "/api/model-refresh-settings");
      const copilot = settings.providers.find((provider) => provider.id === "github");
      // Not set up (no CLI this relay can reach): there is no boot discovery.
      return !copilot || copilot.setUp === false || !!copilot.last;
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    await call("POST", "/api/model-variants/seen");
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (fake) await fake.close();
    fake = null;
  });

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  }

  async function openMenu(page) {
    await page.locator("#chat-actions-menu-btn").click();
    await expect(page.locator("#chat-actions-menu")).toBeVisible();
  }

  async function openClaudeApiTab(page) {
    await openMenu(page);
    const seen = page.waitForResponse((response) => response.url().endsWith("/api/model-variants/seen")
      && response.request().method() === "POST");
    await page.locator("#chat-menu-select-models").click();
    await seen;
    const tab = page.locator('[data-model-provider-tab="claude-api"]');
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveClass(/active/);
  }

  const rowOf = (page, id) => page.locator(".model-variant-row", {
    has: page.locator(`.model-variant-checkbox[data-claude-api-model="${id}"]`),
  });

  test("a model found later is on, tagged New under the switch row, and the menu dot clears", async ({ page }) => {
    pages.at(-1).data.push(fakeModel(ADDED_ON, "Claude Sonnet 6.0"));
    await call("POST", "/api/model-variants/refresh");
    const block = await claudeApiBlock();
    expect(block.availableModels).toContain(ADDED_ON);
    expect(block.autoEnableNew).toBe(true);
    expect(block.unseen).toContain(ADDED_ON);
    expect((await call("GET", "/api/models")).unseenNewModelCount).toBeGreaterThan(0);

    await loadApp(page);
    await openMenu(page);
    await expect(page.locator("#chat-menu-select-models-dot")).toBeVisible();
    await expect(page.locator("#chat-menu-select-models")).toHaveAttribute("aria-label", "Select Models (new models)");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-actions-menu")).toBeHidden();

    await openClaudeApiTab(page);
    const toggle = page.locator('.model-auto-enable-toggle[data-auto-enable-tab="claude-api"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect(page.locator(".model-auto-enable-row")).toContainText("Turn new models on automatically");

    await expect(page.locator(`.model-variant-checkbox[data-claude-api-model="${ADDED_ON}"]`)).toBeChecked();
    await expect(rowOf(page, ADDED_ON).locator(".model-reasoning-chip-new")).toHaveText("New");
    await expect(rowOf(page, "claude-opus-5-5").locator(".model-reasoning-chip-new")).toHaveCount(0);

    // Seen on the relay; this modal keeps its tag until it is opened again.
    await expect.poll(async () => (await call("GET", "/api/models")).unseenNewModelCount).toBe(0);
    expect((await claudeApiBlock()).unseen).not.toContain(ADDED_ON);
    await expect(rowOf(page, ADDED_ON).locator(".model-reasoning-chip-new")).toHaveText("New");

    await page.evaluate(() => window.closeSummaryModal());
    await openMenu(page);
    await expect(page.locator("#chat-menu-select-models-dot")).toBeHidden();
    await expect(page.locator("#chat-menu-select-models")).not.toHaveAttribute("aria-label", /new models/);
  });

  test("with the switch off, the next new model starts off and its toast opens the tab", async ({ page }) => {
    await loadApp(page);
    await openClaudeApiTab(page);
    const toggle = page.locator('.model-auto-enable-toggle[data-auto-enable-tab="claude-api"]');
    await toggle.uncheck();
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings/claude-api")
      && response.request().method() === "POST");
    await page.locator("#summary-modal-save-models").click();
    const body = (await saved).request().postDataJSON();
    expect(body).toMatchObject({ autoEnableNew: false });
    // The save names the rows the tab showed, the default model's among them.
    expect(body.shownModels).toEqual(expect.arrayContaining(["claude-opus-5-5", ADDED_ON]));
    expect(body.shownModels).not.toContain(ADDED_OFF);
    await expect.poll(async () => (await claudeApiBlock()).autoEnableNew).toBe(false);
    // The earlier model stays on.
    expect((await claudeApiBlock()).enabledModels).toContain(ADDED_ON);
    await page.evaluate(() => window.closeSummaryModal());

    pages.at(-1).data.push(fakeModel(ADDED_OFF, "Claude Haiku 6.0"));
    await call("POST", "/api/model-variants/refresh");
    const block = await claudeApiBlock();
    expect(block.availableModels).toContain(ADDED_OFF);
    expect(block.enabledModels).not.toContain(ADDED_OFF);

    const toast = page.locator("#relay-toast");
    await expect(toast).toContainText("1 new Claude API model (off)");
    const seen = page.waitForResponse((response) => response.url().endsWith("/api/model-variants/seen")
      && response.request().method() === "POST");
    await toast.locator(".relay-toast-action").click();
    await seen;
    await expect(page.locator('[data-model-provider-tab="claude-api"]')).toHaveClass(/active/);
    await expect(page.locator('.model-auto-enable-toggle[data-auto-enable-tab="claude-api"]')).not.toBeChecked();
    await expect(page.locator(`.model-variant-checkbox[data-claude-api-model="${ADDED_OFF}"]`)).not.toBeChecked();
    await expect(rowOf(page, ADDED_OFF).locator(".model-reasoning-chip-new")).toHaveText("New");
    await expect(rowOf(page, ADDED_ON).locator(".model-reasoning-chip-new")).toHaveCount(0);
  });

  test("a refresh that finds a model while the page is open lights the menu dot without a reload", async ({ page }) => {
    await loadApp(page);
    await expect.poll(async () => (await call("GET", "/api/models")).unseenNewModelCount).toBe(0);
    await openMenu(page);
    await expect(page.locator("#chat-menu-select-models-dot")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-actions-menu")).toBeHidden();

    pages.at(-1).data.push(fakeModel(ADDED_LIVE, "Claude Opus 6.0"));
    await call("POST", "/api/model-variants/refresh");
    expect((await claudeApiBlock()).unseen).toContain(ADDED_LIVE);

    // models_updated carries the count: the open page shows the dot as it is.
    await openMenu(page);
    await expect(page.locator("#chat-menu-select-models-dot")).toBeVisible();
    await expect(page.locator("#chat-menu-select-models")).toHaveAttribute("aria-label", "Select Models (new models)");
    await page.keyboard.press("Escape");
  });

  test("Settings › General › Models: unticking a provider saves it as excluded", async ({ page }) => {
    await loadApp(page);
    const loaded = page.waitForResponse((response) => response.url().endsWith("/api/model-refresh-settings")
      && response.request().method() === "GET");
    await page.evaluate(() => window.openSettingsModal("general"));
    await expect(page.locator("#settings-panel-general")).toBeVisible();
    const before = await (await loaded).json();
    expect(before.excluded).not.toContain("claude-api");

    const box = page.locator('#model-refresh-providers input[data-model-refresh-provider="claude-api"]');
    await box.scrollIntoViewIfNeeded();
    await expect(box).toBeChecked();
    const posted = page.waitForResponse((response) => response.url().endsWith("/api/model-refresh-settings")
      && response.request().method() === "POST");
    await box.uncheck();
    const response = await posted;
    expect(response.request().postDataJSON().excluded).toContain("claude-api");
    expect(response.ok()).toBe(true);
    await expect(box).not.toBeChecked();
    expect((await call("GET", "/api/model-refresh-settings")).excluded).toContain("claude-api");

    // Ticked again, it is checked again.
    const restored = page.waitForResponse((response) => response.url().endsWith("/api/model-refresh-settings")
      && response.request().method() === "POST");
    await box.check();
    expect((await restored).request().postDataJSON().excluded).not.toContain("claude-api");
    expect((await call("GET", "/api/model-refresh-settings")).excluded).not.toContain("claude-api");
  });
});
