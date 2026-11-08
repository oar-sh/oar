import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { estimateOpenAIImageCost, priceOpenAIImageUsage } from "../shared/openai-image-prices.mjs";
import { formatOpenAIImageUsd } from "../shared/openai-image-spend.mjs";
import { createApiClient } from "../shared/worker-runtime/api-client.mjs";
import { runDirectOpenAIImageTurn, shouldUseDirectOpenAIImageApi } from "../shared/worker-runtime/direct-openai-image.mjs";
import { closeComposerSettings, composerControl, selectComposerOption } from "./composer-settings-helpers.mjs";
import { FAKE_IMAGE_USAGE, FAKE_OPENAI_KEY, startFakeOpenAIImages } from "./fake-openai-images.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * What OpenAI image turns cost, end to end: a low daily cap in Settings →
 * Providers → OpenAI, one image turn that books its cost and so reaches the
 * cap, the next send refused (409, the draft kept, the image chat's banner),
 * "Allow for today" letting the same send through, the booked amount on the
 * Check Usage card, and a preset saved from the composer that a later send
 * (picked in the composer, and named alone by an API send) carries to OpenAI.
 *
 * OpenAI is a fake on a loopback port (tests/fake-openai-images.mjs), set as
 * the provider's Base URL; every completed image reports FAKE_IMAGE_USAGE,
 * which the relay prices from its table (shared/openai-image-prices.mjs).
 *
 * The relay is this file's own (one relay and one fake, the steps in order;
 * its state root goes with it, so the cap and the override touch no other
 * spec). It runs no worker: the spec takes each image turn off the queue as a
 * session worker does (GET /api/pending) and runs it with the workers' own
 * image path (shared/worker-runtime/direct-openai-image.mjs). No turn reaches
 * a model.
 */

// --- Selectors (one place to adjust) ------------------------------------
const SEL = Object.freeze({
  // Settings → Providers → OpenAI
  openaiPanel: "#settings-provider-panel-openai",
  openaiKey: "#openai-api-key-input",
  openaiBaseUrl: "#openai-base-url-input",
  openaiSave: "#openai-save-btn",
  openaiStatus: "#openai-settings-status",
  // … its image cap section
  capInput: "#openai-image-cap-input",
  capSave: "#openai-image-cap-save-btn",
  allowToday: "#openai-image-allow-today-btn",
  stopAllowing: "#openai-image-stop-allowing-btn",
  spendLine: "#openai-image-spend-line",
  spendError: "#openai-image-spend-error",
  spendStatus: "#openai-image-spend-status",
  presetsList: "#openai-image-presets-list",
  // New Chat
  newChatButton: "#new-conv-btn",
  newChatModal: "#new-conversation-model-modal",
  newChatProvider: "#new-conversation-provider-select",
  newChatModel: "#new-conversation-model-select",
  newChatConfirm: "#new-conversation-model-confirm",
  // The composer (the ⚙ panel holds the selects)
  composerModel: "#model-select",
  quality: "#reasoning-effort-select",
  size: "#context-tier-select",
  format: "#image-format-select",
  presetField: "#image-preset-field",
  presetSelect: "#image-preset-select",
  presetSave: "#image-preset-save-btn",
  presetNote: "#image-preset-note",
  messageInput: "#msg-input",
  send: "#send-btn",
  // Where a refused send says why.
  modelBanner: "#model-banner",
  // The image chat's banner (data-kind warning | reached).
  spendBanner: "#openai-image-spend-banner",
  // The reply's image (the live bubble is a `.msg.assistant` too).
  replyMessage: ".msg.assistant:not(#thinking-indicator)",
  replyImage: ".msg-attachment-image img",
  // Check Usage
  usageTab: '[data-usage-tab="openai"]',
  usagePanel: '[data-usage-panel="openai"]',
  usageMeter: '[data-testid="openai-image-usage-meter"]',
  usageToday: '[data-testid="openai-image-usage-today"]',
  usageReached: '[data-testid="openai-image-usage-reached"]',
  usageAllowed: '[data-testid="openai-image-usage-allowed"]',
});

// The image default of a relay whose OpenAI list has it.
const IMAGE_MODEL = "gpt-image-2.5-flare";
const FAKE_DELAY_MS = 250;
const TURN_TIMEOUT_MS = 45_000;

// What one turn books: the fake's usage (50 text input tokens, 1250 image
// output tokens) at gpt-image-2.5's rates (USD 5 per 1M text input, 30 per 1M
// image output) = (50 * 5 + 1250 * 30) / 1e6 = 0.03775.
const BOOKED_PER_TURN = priceOpenAIImageUsage({ model: IMAGE_MODEL, usage: FAKE_IMAGE_USAGE });
const BOOKED_PER_TURN_USD = BOOKED_PER_TURN?.costUsd ?? 0;
// What a try reserves before it is sent (low, 1024x1024, one image, no
// partials yet): 196 output tokens at 30 per 1M plus 500 prompt tokens at 5
// per 1M = 0.00838.
const TURN_ESTIMATE_USD = estimateOpenAIImageCost({ model: IMAGE_MODEL, size: "1024x1024", quality: "low", count: 1 }).costUsd;
// Above the estimate (the first try may go) and below what it books (the
// second send finds the cap reached).
const CAP_USD = 0.02;

const PRESET_NAME = "Poster wide";

// The relay takes OpenAI's key and Base URL from its own settings only (no
// OPENAI_* is read); an OPENAI_* of the shell that runs the suite is cleared
// for its process all the same, so no key or endpoint of the host can reach
// the relay under test.
const OPENAI_ENV_CLEARED = Object.freeze(Object.fromEntries(
  [...new Set([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT_ID",
    ...Object.keys(process.env).filter((name) => /^OPENAI_/i.test(name)),
  ])].map((name) => [name, ""]),
));

const isPath = (response, pathname, method) => new URL(response.url()).pathname === pathname
  && response.request().method() === method;

test.describe("OpenAI image spend: the daily cap, Allow for today, Check Usage and presets", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let fake = null;
  let relay = null;
  // The image chat the steps share.
  let conversationId = "";
  // The relay mode the composer sends with (the API send uses the same).
  let composerRelayMode = "";

  async function api(route, { method = "GET", body } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  const imageUsage = async () => {
    const answer = await api("/api/image-usage");
    expect(answer.status, JSON.stringify(answer.payload)).toBe(200);
    return answer.payload;
  };

  // What a session worker uses to talk to its relay.
  const workerApi = () => createApiClient({ serverUrl: relay.baseUrl, token: relay.token });

  /** The chat's next queued image row, taken and run as a session worker runs it. */
  async function takeImageTurn({ timeoutMs = TURN_TIMEOUT_MS } = {}) {
    const worker = workerApi();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { message } = await worker("GET", "/api/pending");
      if (message) {
        if (String(message.conversationId) !== conversationId) {
          throw new Error(`Another conversation's row was handed out: ${String(message.conversationId).slice(0, 8)}`);
        }
        if (!shouldUseDirectOpenAIImageApi(message)) {
          throw new Error(`Not an image turn: provider ${message.providerType}, model ${message.providerModel || message.model}`);
        }
        const result = await runDirectOpenAIImageTurn({ api: worker, message, requestOptions: { longCall: true } });
        return { message, result };
      }
      await sleep(150);
    }
    throw new Error("No image turn was handed out");
  }

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function"
      && typeof window.openConversation === "function"
      && typeof window.showUsage === "function");
  }

  /** A fresh page on the shared image chat. */
  async function openImageChat(page) {
    await loadApp(page);
    await page.evaluate((id) => window.openConversation(id), conversationId);
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);
    await expect(page.locator(SEL.composerModel)).toHaveValue(IMAGE_MODEL);
  }

  /** Settings → Providers → OpenAI, after its state was read. */
  async function openOpenAISettings(page) {
    const loaded = page.waitForResponse((response) => isPath(response, "/api/settings/openai", "GET"));
    await page.evaluate(() => window.openSettingsModal("providers", "openai"));
    await loaded;
    await expect(page.locator(SEL.openaiPanel)).toBeVisible();
  }

  /** Quality, Size and Format in the ⚙ panel (a fresh page starts from the defaults). */
  async function pickImageOptions(page, { size, format }) {
    await selectComposerOption(page, SEL.quality, "low");
    await selectComposerOption(page, SEL.size, size);
    await selectComposerOption(page, SEL.format, format);
    await expect(page.locator(SEL.quality)).toHaveValue("low");
    await expect(page.locator(SEL.size)).toHaveValue(size);
    await expect(page.locator(SEL.format)).toHaveValue(format);
    await closeComposerSettings(page);
  }

  /** Clicks Send on what the composer holds: the POST, its body and its answer. */
  async function sendFromComposer(page) {
    const posted = page.waitForResponse((response) => isPath(response, "/api/message", "POST"));
    await expect(page.locator(SEL.send)).toBeEnabled();
    await page.locator(SEL.send).click();
    const response = await posted;
    return {
      status: response.status(),
      body: response.request().postDataJSON(),
      result: await response.json().catch(() => null),
    };
  }

  /** The image replies on the page reach `count`. */
  async function expectReplies(page, count) {
    const replies = page.locator(SEL.replyMessage).filter({ has: page.locator(SEL.replyImage) });
    await expect(replies).toHaveCount(count, { timeout: TURN_TIMEOUT_MS });
  }

  test.beforeAll(async () => {
    fake = await startFakeOpenAIImages({ delayMs: FAKE_DELAY_MS });
    relay = await startRelayServer({ token: randomUUID(), overrides: OPENAI_ENV_CLEARED });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (fake) await fake.close();
    fake = null;
  });

  test("Settings takes the key, the fake's Base URL and a low daily cap", async ({ page }) => {
    // The amounts the steps rely on: one try may start under the cap, and
    // what it books reaches it.
    expect(BOOKED_PER_TURN).toEqual(expect.objectContaining({ costUnknown: false, inputTokens: 50, outputTokens: 1250 }));
    expect(BOOKED_PER_TURN_USD).toBeCloseTo(0.03775, 9);
    expect(TURN_ESTIMATE_USD).toBeCloseTo(0.00838, 9);
    expect(TURN_ESTIMATE_USD).toBeLessThan(CAP_USD);
    expect(BOOKED_PER_TURN_USD).toBeGreaterThanOrEqual(CAP_USD);

    // Nothing of the host's OpenAI setup: no key, the default endpoint, the
    // default cap.
    const before = await api("/api/settings/openai");
    expect(before.status).toBe(200);
    expect(before.payload).toEqual(expect.objectContaining({
      configured: false,
      baseUrl: "https://api.openai.com/v1",
      imageDailyCapUsd: 5,
      imagesAllowedToday: false,
    }));

    await loadApp(page);
    await openOpenAISettings(page);
    await expect(page.locator(SEL.openaiStatus)).toHaveAttribute("data-state", "unconfigured");
    expect(fake.seen).toHaveLength(0);

    await page.locator(SEL.openaiKey).fill(FAKE_OPENAI_KEY);
    await page.locator(SEL.openaiBaseUrl).fill(fake.baseUrl);
    const saved = page.waitForResponse((response) => isPath(response, "/api/settings/openai", "POST"));
    await page.locator(SEL.openaiSave).click();
    const savedBody = await (await saved).json();
    expect(savedBody.ok, JSON.stringify(savedBody)).toBe(true);
    expect(savedBody.baseUrl).toBe(fake.baseUrl);
    expect(savedBody.models).toEqual(expect.arrayContaining([IMAGE_MODEL]));
    await expect(page.locator(SEL.openaiStatus)).toHaveAttribute("data-state", "active");
    // The section shows the default cap until it is changed.
    await expect(page.locator(SEL.capInput)).toHaveValue("5");

    // The cap, typed after the provider's answer (which sets the field).
    await page.locator(SEL.capInput).fill(String(CAP_USD));
    const capSaved = page.waitForResponse((response) => isPath(response, "/api/settings/openai", "POST"));
    await page.locator(SEL.capSave).click();
    const capResponse = await capSaved;
    expect(capResponse.request().postDataJSON()).toEqual({ imageDailyCapUsd: CAP_USD });
    const capBody = await capResponse.json();
    expect(capBody.ok, JSON.stringify(capBody)).toBe(true);
    expect(capBody.imageDailyCapUsd).toBe(CAP_USD);
    expect(capBody.imagesAllowedToday).toBe(false);
    await expect(page.locator(SEL.spendError)).toBeHidden();
    await expect(page.locator(SEL.spendStatus)).toHaveText(`Daily image cap saved: ${formatOpenAIImageUsd(CAP_USD)}.`);
    await expect(page.locator(SEL.capInput)).toHaveValue(String(CAP_USD));
    // Nothing spent yet; the override is offered, not on.
    await expect(page.locator(SEL.spendLine)).toContainText(`Today ${formatOpenAIImageUsd(0)} of ${CAP_USD.toFixed(2)}`);
    await expect(page.locator(SEL.allowToday)).toBeVisible();
    await expect(page.locator(SEL.allowToday)).toHaveText("Allow past the cap for today");
    await expect(page.locator(SEL.stopAllowing)).toBeHidden();

    const settings = await api("/api/settings/openai");
    expect(settings.payload).toEqual(expect.objectContaining({
      configured: true,
      enabled: true,
      baseUrl: fake.baseUrl,
      imageDailyCapUsd: CAP_USD,
      imagesAllowedToday: false,
      imagesAllowedAt: null,
    }));
    expect(JSON.stringify(settings.payload)).not.toContain(FAKE_OPENAI_KEY);
    const usage = await imageUsage();
    expect(usage).toEqual(expect.objectContaining({
      capUsd: CAP_USD,
      spentUsd: 0,
      reservedUsd: 0,
      reached: false,
      warning: false,
      allowedToday: false,
    }));
    // Model discovery only; no image went out.
    expect(fake.imageRequests()).toHaveLength(0);
    expect(fake.seen.every((call) => call.knownKey)).toBe(true);
  });

  test("one image turn books its cost from the reported usage and reaches the cap", async ({ page }) => {
    let bootstrapResponse = null;
    // A relay that cannot start a worker answers a valid bootstrap 409 after
    // it committed the conversation; the success payload a real relay sends
    // is restored for the client (as in image-session.spec.mjs).
    await page.route("**/api/conversation/bootstrap", async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try { bootstrapResponse = JSON.parse(text); } catch { bootstrapResponse = null; }
      if (response.status() === 409 && bootstrapResponse?.conversationCreated) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...bootstrapResponse, ok: true }) });
      }
      return route.fulfill({ response, body: text });
    });
    await loadApp(page);

    await expect(page.locator(SEL.newChatButton)).toBeEnabled();
    await page.locator(SEL.newChatButton).click();
    await expect(page.locator(SEL.newChatModal)).toHaveClass(/visible/);
    await page.locator(SEL.newChatProvider).selectOption("openai-image");
    await expect(page.locator(SEL.newChatModel)).toHaveValue(IMAGE_MODEL);
    await page.locator(SEL.newChatConfirm).click();
    await expect.poll(() => bootstrapResponse !== null).toBe(true);
    expect(bootstrapResponse?.selectedModel).toBe(IMAGE_MODEL);
    conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);
    await expect(page.locator(SEL.composerModel)).toHaveValue(IMAGE_MODEL);

    // Below the warning mark: no banner yet.
    await expect(page.locator(SEL.spendBanner)).toBeHidden();

    await pickImageOptions(page, { size: "1024x1024", format: "png" });
    await page.locator(SEL.messageInput).fill("A paper boat on a puddle, flat colours");
    const sent = await sendFromComposer(page);
    expect(sent.status, JSON.stringify(sent.result)).toBe(200);
    expect(sent.body).toEqual(expect.objectContaining({ model: IMAGE_MODEL, reasoningEffort: "low", contextTier: "1024x1024" }));
    composerRelayMode = String(sent.body.relayMode || "");

    const ran = await takeImageTurn();
    expect(ran.message.id).toBe(String(sent.result?.messageId || ""));
    expect(ran.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));
    await expectReplies(page, 1);

    const requests = fake.imageRequests("/images/generations");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(expect.objectContaining({
      knownKey: true,
      status: 200,
      model: IMAGE_MODEL,
      size: "1024x1024",
      quality: "low",
      n: 1,
    }));
    expect(requests[0].events.at(-1)).toBe("image_generation.completed");

    // The try is booked at the usage's price; nothing is in flight; the cap
    // is reached.
    await expect.poll(async () => (await imageUsage()).spentUsd).toBeCloseTo(BOOKED_PER_TURN_USD, 6);
    const usage = await imageUsage();
    expect(usage).toEqual(expect.objectContaining({
      capUsd: CAP_USD,
      reservedUsd: 0,
      estimatedUsd: 0,
      unknownPriceUsd: 0,
      reached: true,
      warning: true,
      allowedToday: false,
    }));
    expect(usage.monthUsd).toBeCloseTo(BOOKED_PER_TURN_USD, 6);
    const chat = await api(`/api/image-usage?conversationId=${encodeURIComponent(conversationId)}`);
    expect(chat.status).toBe(200);
    expect(chat.payload.conversation).toEqual(expect.objectContaining({ images: 1, tries: 1, estimatedUsd: 0 }));
    expect(chat.payload.conversation.costUsd).toBeCloseTo(BOOKED_PER_TURN_USD, 6);

    // The chat on screen learns it from the relay's event.
    await expect(page.locator(SEL.spendBanner)).toBeVisible();
    await expect(page.locator(SEL.spendBanner)).toHaveAttribute("data-kind", "reached");
  });

  test("at the cap a send is refused with the draft kept; Allow for today lets the same send through", async ({ page }) => {
    expect(conversationId, "the image chat of the step before").toBeTruthy();
    await openImageChat(page);
    await expect(page.locator(SEL.spendBanner)).toHaveAttribute("data-kind", "reached");
    await expect(page.locator(SEL.spendBanner)).toContainText("Daily image cap reached");

    await pickImageOptions(page, { size: "1024x1024", format: "png" });
    const prompt = "A kite over a hill at noon, flat colours";
    await page.locator(SEL.messageInput).fill(prompt);
    // The model banner is shared (a catalog refresh may clear it again): what
    // it was set to is recorded.
    await page.evaluate((selector) => {
      const banner = document.querySelector(selector);
      window.__modelBannerTexts = [];
      new MutationObserver(() => {
        const text = String(banner?.textContent || "");
        if (text) window.__modelBannerTexts.push(text);
      }).observe(banner, { childList: true, characterData: true, subtree: true });
    }, SEL.modelBanner);
    const refused = await sendFromComposer(page);
    expect(refused.status, JSON.stringify(refused.result)).toBe(409);
    expect(refused.result?.code).toBe("OPENAI_IMAGE_DAILY_CAP_REACHED");
    expect(String(refused.result?.error || "")).toContain("has reached the daily cap");
    // The draft stays, the relay's words show, the banner says why.
    await expect(page.locator(SEL.messageInput)).toHaveValue(prompt);
    await expect.poll(() => page.evaluate(() => (window.__modelBannerTexts || []).join("\n")))
      .toContain("has reached the daily cap");
    await expect(page.locator(SEL.spendBanner)).toBeVisible();
    await expect(page.locator(SEL.spendBanner)).toHaveAttribute("data-kind", "reached");
    // Nothing was queued, nothing went to OpenAI.
    const pending = await workerApi()("GET", "/api/pending");
    expect(pending?.message ?? null).toBeNull();
    expect(fake.imageRequests()).toHaveLength(1);
    await expectReplies(page, 1);

    // Allow for today, in Settings.
    await openOpenAISettings(page);
    await expect(page.locator(SEL.spendLine)).toContainText("cap reached");
    await expect(page.locator(SEL.allowToday)).toBeVisible();
    await expect(page.locator(SEL.allowToday)).toHaveText("Allow for today");
    const allowed = page.waitForResponse((response) => isPath(response, "/api/settings/openai", "POST"));
    await page.locator(SEL.allowToday).click();
    const allowResponse = await allowed;
    expect(allowResponse.request().postDataJSON()).toEqual({ allowImagesToday: true });
    const allowBody = await allowResponse.json();
    expect(allowBody.ok, JSON.stringify(allowBody)).toBe(true);
    expect(allowBody.imagesAllowedToday).toBe(true);
    expect(typeof allowBody.imagesAllowedAt).toBe("string");
    // The cap stays as it was.
    expect(allowBody.imageDailyCapUsd).toBe(CAP_USD);
    await expect(page.locator(SEL.stopAllowing)).toBeVisible();
    await expect(page.locator(SEL.allowToday)).toBeHidden();
    await expect(page.locator(SEL.spendLine)).toContainText("allowed past the cap today");
    const usage = await imageUsage();
    expect(usage).toEqual(expect.objectContaining({ reached: true, allowedToday: true, capUsd: CAP_USD }));
    expect(typeof usage.allowedAt).toBe("string");
    await page.evaluate(() => window.closeSettingsModal());

    // The banner turns into the figures; the draft is still there.
    await expect(page.locator(SEL.spendBanner)).toHaveAttribute("data-kind", "warning");
    await expect(page.locator(SEL.spendBanner)).toContainText("allowed past the cap today");
    await expect(page.locator(SEL.messageInput)).toHaveValue(prompt);

    const sent = await sendFromComposer(page);
    expect(sent.status, JSON.stringify(sent.result)).toBe(200);
    expect(sent.body.text).toBe(prompt);
    const ran = await takeImageTurn();
    expect(ran.message.id).toBe(String(sent.result?.messageId || ""));
    expect(ran.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));
    await expectReplies(page, 2);

    const requests = fake.imageRequests("/images/generations");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(expect.objectContaining({ knownKey: true, status: 200, model: IMAGE_MODEL, size: "1024x1024", quality: "low" }));
    expect(requests[1].prompt).toContain(prompt);
    await expect.poll(async () => (await imageUsage()).spentUsd).toBeCloseTo(2 * BOOKED_PER_TURN_USD, 6);
  });

  test("Check Usage shows the booked amount on the OpenAI images card", async ({ page }) => {
    expect(conversationId, "the image chat of the steps before").toBeTruthy();
    const usage = await imageUsage();
    expect(usage.spentUsd).toBeCloseTo(2 * BOOKED_PER_TURN_USD, 6);
    expect(usage.reservedUsd).toBe(0);
    const today = formatOpenAIImageUsd(usage.spentUsd + usage.reservedUsd);

    // The card in the relay's report carries the same state (no live read of
    // another provider is asked for: the card comes from the booking).
    const report = await api("/api/usage?providers=openai");
    expect(report.status).toBe(200);
    const card = (report.payload?.providers || []).find((entry) => entry?.provider === "openai");
    expect(card, JSON.stringify((report.payload?.providers || []).map((entry) => entry?.provider))).toBeTruthy();
    expect(card.label).toBe("OpenAI images");
    expect(card.imageSpend.spentUsd).toBeCloseTo(usage.spentUsd, 6);

    await openImageChat(page);
    await page.evaluate(() => { window.showUsage(); });
    const tab = page.locator(SEL.usageTab);
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();
    const panel = page.locator(SEL.usagePanel);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("OpenAI images");
    await expect(panel.locator(SEL.usageMeter)).toBeVisible();
    await expect(panel.locator(SEL.usageToday)).toContainText(`${today} of ${CAP_USD.toFixed(2)}`);
    // Past the cap, allowed for today.
    await expect(panel.locator(SEL.usageAllowed)).toBeVisible();
    await expect(panel.locator(SEL.usageReached)).toHaveCount(0);
    await expect(panel).toContainText(formatOpenAIImageUsd(CAP_USD));
    await expect(panel).toContainText(formatOpenAIImageUsd(usage.monthUsd));
  });

  test("a preset saved from the composer goes out with a later send, picked or named alone", async ({ page }) => {
    expect(conversationId, "the image chat of the steps before").toBeTruthy();
    await openImageChat(page);

    // Save as preset… keeps what the selects show.
    await pickImageOptions(page, { size: "1536x1024", format: "webp" });
    const saveButton = await composerControl(page, SEL.presetSave);
    await expect(page.locator(SEL.presetField)).toBeVisible();
    await expect(page.locator(SEL.presetSelect)).toHaveValue("");
    const asked = [];
    page.once("dialog", async (dialog) => {
      asked.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept(PRESET_NAME);
    });
    const put = page.waitForResponse((response) => isPath(response, "/api/openai-image-presets", "PUT"));
    await saveButton.click();
    const putResponse = await put;
    expect(asked).toEqual([{ type: "prompt", message: "Name of the image preset" }]);
    expect(putResponse.status()).toBe(200);
    expect(putResponse.request().postDataJSON().preset).toEqual(expect.objectContaining({
      name: PRESET_NAME,
      size: "1536x1024",
      quality: "low",
      output_format: "webp",
    }));
    await expect(page.locator(SEL.presetNote)).toHaveText(`Saved as preset "${PRESET_NAME}".`);
    await expect(page.locator(SEL.presetSelect)).toHaveValue(PRESET_NAME);
    const presets = await api("/api/openai-image-presets");
    expect(presets.status).toBe(200);
    expect(presets.payload.presets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: PRESET_NAME, size: "1536x1024", output_format: "webp", builtIn: false }),
    ]));

    // Settings lists it among the own presets.
    await openOpenAISettings(page);
    await expect(page.locator(`${SEL.presetsList} [data-preset-name="${PRESET_NAME}"]`)).toBeVisible();
    await page.evaluate(() => window.closeSettingsModal());

    // Back to other values, then the preset picked: the selects show it.
    await selectComposerOption(page, SEL.presetSelect, { label: "None" });
    await expect(page.locator(SEL.presetSelect)).toHaveValue("");
    await selectComposerOption(page, SEL.size, "1024x1024");
    await selectComposerOption(page, SEL.format, "png");
    await expect(page.locator(SEL.size)).toHaveValue("1024x1024");
    await expect(page.locator(SEL.format)).toHaveValue("png");
    await selectComposerOption(page, SEL.presetSelect, PRESET_NAME);
    await expect(page.locator(SEL.size)).toHaveValue("1536x1024");
    await expect(page.locator(SEL.format)).toHaveValue("webp");
    await expect(page.locator(SEL.presetNote)).toContainText(PRESET_NAME);
    await expect(page.locator(SEL.presetNote)).toContainText("1536x1024");
    await closeComposerSettings(page);

    await page.locator(SEL.messageInput).fill("A lighthouse banner for the harbour fair");
    const sent = await sendFromComposer(page);
    expect(sent.status, JSON.stringify(sent.result)).toBe(200);
    expect(sent.body.contextTier).toBe("1536x1024");
    expect(sent.body.image).toEqual(expect.objectContaining({ preset: PRESET_NAME, size: "1536x1024", output_format: "webp" }));
    const picked = await takeImageTurn();
    expect(picked.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));
    expect(picked.message.imageOptions).toEqual(expect.objectContaining({ size: "1536x1024", quality: "low", output_format: "webp" }));
    await expectReplies(page, 3);
    let requests = fake.imageRequests("/images/generations");
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(expect.objectContaining({
      knownKey: true,
      status: 200,
      model: IMAGE_MODEL,
      size: "1536x1024",
      quality: "low",
      outputFormat: "webp",
    }));

    // A send that names the preset alone: the relay fills in its values.
    expect(composerRelayMode).toBeTruthy();
    const named = await api("/api/message", {
      method: "POST",
      body: {
        conversationId,
        text: "The same banner, a second take",
        model: IMAGE_MODEL,
        relayMode: composerRelayMode,
        image: { preset: PRESET_NAME },
      },
    });
    expect(named.status, JSON.stringify(named.payload)).toBe(200);
    const byName = await takeImageTurn();
    expect(byName.message.id).toBe(String(named.payload?.messageId || ""));
    expect(byName.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));
    expect(byName.message.imageOptions).toEqual(expect.objectContaining({ size: "1536x1024", quality: "low", output_format: "webp" }));
    requests = fake.imageRequests("/images/generations");
    expect(requests).toHaveLength(4);
    expect(requests[3]).toEqual(expect.objectContaining({
      knownKey: true,
      status: 200,
      model: IMAGE_MODEL,
      size: "1536x1024",
      quality: "low",
      outputFormat: "webp",
    }));
    await expectReplies(page, 4);

    // Every turn booked at the usage's price; only the fake was asked.
    await expect.poll(async () => (await imageUsage()).spentUsd).toBeCloseTo(4 * BOOKED_PER_TURN_USD, 6);
    expect(fake.imageRequests()).toHaveLength(4);
    expect(fake.seen.every((call) => call.knownKey)).toBe(true);
  });
});
