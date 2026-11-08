import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createApiClient } from "../shared/worker-runtime/api-client.mjs";
import { runDirectOpenAIImageTurn, shouldUseDirectOpenAIImageApi } from "../shared/worker-runtime/direct-openai-image.mjs";
import { closeComposerSettings, composerControl, selectComposerOption } from "./composer-settings-helpers.mjs";
import { FAKE_OPENAI_KEY, readPngSize, solidPng, startFakeOpenAIImages } from "./fake-openai-images.mjs";
import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * OpenAI image sessions end to end: the key and Base URL in Settings →
 * Providers → OpenAI, an image chat from New Chat, a custom size in the
 * composer, the placeholder with its timer and the partial previews while the
 * image is made, then the image in the reply; and an agent that starts an
 * image session through relay_tool with an image of its own and gets the
 * result back by path.
 *
 * OpenAI is a fake on a loopback port (tests/fake-openai-images.mjs), set as
 * the provider's Base URL; it streams two partial images, then the final one,
 * FAKE_DELAY_MS apart so the browser can show each preview.
 *
 * The relay is its own (one relay and one fake for the file, the steps in
 * order). It runs no worker: the spec takes each image turn off the queue as
 * a session worker does (GET /api/pending) and runs it with the workers' own
 * image path (shared/worker-runtime/direct-openai-image.mjs), which hands it
 * to the relay's execute route; the relay sends the request to the fake and
 * the previews to the page. For the agent, the spec calls the relay_tool
 * route as a worker's tool adapter does and plays the user on the approval
 * card. No turn reaches a model.
 */

// --- Selectors (one place to adjust) ------------------------------------
const SEL = Object.freeze({
  // Settings → Providers → OpenAI
  openaiPanel: "#settings-provider-panel-openai",
  openaiKey: "#openai-api-key-input",
  openaiBaseUrl: "#openai-base-url-input",
  openaiSave: "#openai-save-btn",
  openaiStatus: "#openai-settings-status",
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
  sizeCustomRow: "#image-size-custom-row",
  sizeCustomInput: "#image-size-custom-input",
  sizeCustomError: "#image-size-custom-error",
  imageOptionsRow: "#image-options-row",
  count: "#image-count-select",
  format: "#image-format-select",
  messageInput: "#msg-input",
  send: "#send-btn",
  // The running turn: the placeholder lives in the live bubble.
  liveBubble: "#thinking-indicator",
  placeholder: "[data-image-placeholder]",
  placeholderTimer: "[data-image-placeholder-timer]",
  placeholderDetails: "[data-image-placeholder-details]",
  placeholderPreview: "img[data-image-placeholder-preview]",
  // The reply's image (the live bubble is a `.msg.assistant` too).
  replyMessage: ".msg.assistant:not(#thinking-indicator)",
  replyImage: ".msg-attachment-image img",
});
// The Size select's "Custom…" entry.
const SIZE_CUSTOM_VALUE = "__custom__";

// The image default of a relay whose OpenAI list has it (New Chat and an
// agent's create_session without a model both pick it).
const IMAGE_MODEL = "gpt-image-2.5-flare";
// The pause before each event of the fake's stream: two partials and the
// final image take three of them.
const FAKE_DELAY_MS = 2000;
const TURN_TIMEOUT_MS = 45_000;

test.describe("OpenAI image sessions", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let fake = null;
  let relay = null;

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  }

  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });

  // What a session worker uses to talk to its relay.
  const workerApi = () => createApiClient({ serverUrl: relay.baseUrl, token: relay.token });

  /**
   * One queued image row, taken and run as a session worker runs it. With
   * `conversationId` the row must be that conversation's; `onIdle` is asked
   * between polls (it may throw to give up).
   */
  async function takeImageTurn({ conversationId = "", onIdle = null, timeoutMs = TURN_TIMEOUT_MS } = {}) {
    const worker = workerApi();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { message } = await worker("GET", "/api/pending");
      if (message) {
        if (conversationId && String(message.conversationId) !== conversationId) {
          throw new Error(`Another conversation's row was handed out: ${String(message.conversationId).slice(0, 8)}`);
        }
        if (!shouldUseDirectOpenAIImageApi(message)) {
          throw new Error(`Not an image turn: provider ${message.providerType}, model ${message.providerModel || message.model}`);
        }
        const result = await runDirectOpenAIImageTurn({ api: worker, message, requestOptions: { longCall: true } });
        return { message, result };
      }
      if (onIdle) await onIdle();
      await sleep(150);
    }
    throw new Error("No image turn was handed out");
  }

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  }

  test.beforeAll(async () => {
    fake = await startFakeOpenAIImages({ delayMs: FAKE_DELAY_MS });
    relay = await startRelayServer({ token: randomUUID() });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
    if (fake) await fake.close();
    fake = null;
  });

  test("the OpenAI tab takes the key and the fake's Base URL, and the relay lists its image models", async ({ page }) => {
    await loadApp(page);
    // The tab reads its state on open: a value typed before that answer
    // lands could be undone by it.
    const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/openai"
      && response.request().method() === "GET");
    await page.evaluate(() => window.openSettingsModal("providers", "openai"));
    await loaded;
    await expect(page.locator(SEL.openaiPanel)).toBeVisible();
    await expect(page.locator(SEL.openaiStatus)).toHaveAttribute("data-state", "unconfigured");
    expect(fake.seen).toHaveLength(0);

    await page.locator(SEL.openaiKey).fill(FAKE_OPENAI_KEY);
    await page.locator(SEL.openaiBaseUrl).fill(fake.baseUrl);
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/openai"
      && response.request().method() === "POST");
    await page.locator(SEL.openaiSave).click();
    const savedBody = await (await saved).json();
    expect(savedBody.ok, JSON.stringify(savedBody)).toBe(true);
    expect(savedBody.enabled).toBe(true);
    expect(savedBody.baseUrl).toBe(fake.baseUrl);
    // Discovery went through: the fake's OpenAI ids, not dall-e-3 (no id the
    // relay takes for an OpenAI model).
    expect(savedBody.warning ?? null).toBeNull();
    expect(savedBody.models).toEqual(expect.arrayContaining([IMAGE_MODEL, "gpt-image-2", "gpt-4o"]));
    expect(savedBody.models).not.toContain("dall-e-3");
    await expect(page.locator(SEL.openaiStatus)).toHaveAttribute("data-state", "active");
    await expect(page.locator(SEL.openaiKey)).toHaveValue("");

    // The models were read from the fake, with the key.
    const modelCalls = fake.seen.filter((call) => call.method === "GET" && call.path === "/models");
    expect(modelCalls.length).toBeGreaterThanOrEqual(1);
    expect(modelCalls.every((call) => call.knownKey && call.status === 200)).toBe(true);

    const settings = await api("/api/settings/openai");
    expect(settings.status).toBe(200);
    expect(settings.payload).toEqual(expect.objectContaining({
      configured: true,
      enabled: true,
      baseUrl: fake.baseUrl,
      imageDefaultModel: IMAGE_MODEL,
    }));
    expect(JSON.stringify(settings.payload)).not.toContain(FAKE_OPENAI_KEY);
    await expect.poll(async () => (await api("/api/models")).payload?.models || [])
      .toEqual(expect.arrayContaining([IMAGE_MODEL, "gpt-image-2"]));
    expect(await page.content()).not.toContain(FAKE_OPENAI_KEY);
  });

  test("New Chat starts an image chat; a custom size goes out, previews show while it runs, then the image", async ({ page }) => {
    let bootstrapResponse = null;
    // A relay that cannot start a worker answers a valid bootstrap 409 after
    // it committed the conversation; the success payload a real relay sends
    // is restored for the client (as in deepseek-provider.spec.mjs).
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

    // New Chat → OpenAI Image: only image models, the relay's image default first.
    await expect(page.locator(SEL.newChatButton)).toBeEnabled();
    await page.locator(SEL.newChatButton).click();
    await expect(page.locator(SEL.newChatModal)).toHaveClass(/visible/);
    await page.locator(SEL.newChatProvider).selectOption("openai-image");
    await expect(page.locator(SEL.newChatModel)).toHaveValue(IMAGE_MODEL);
    const offered = await page.locator(`${SEL.newChatModel} option`).evaluateAll((options) => options.map((option) => option.value));
    expect(offered).toEqual(expect.arrayContaining([IMAGE_MODEL, "gpt-image-2"]));
    expect(offered.every((model) => model.startsWith("gpt-image-") || model.startsWith("dall-e-")), offered.join(", ")).toBe(true);
    await page.locator(SEL.newChatConfirm).click();
    await expect.poll(() => bootstrapResponse !== null).toBe(true);
    expect(bootstrapResponse?.selectedProviderType).toBe("openai");
    expect(bootstrapResponse?.selectedModel).toBe(IMAGE_MODEL);
    const conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);
    await expect(page.locator(SEL.composerModel)).toHaveValue(IMAGE_MODEL);

    // Quality low, Size Custom…: a size that is no multiple of 16 is refused
    // where it is typed.
    await selectComposerOption(page, SEL.quality, "low");
    await selectComposerOption(page, SEL.size, SIZE_CUSTOM_VALUE);
    await expect(page.locator(SEL.sizeCustomRow)).toBeVisible();
    const customInput = await composerControl(page, SEL.sizeCustomInput);
    await customInput.fill("1000x1000");
    await expect(page.locator(SEL.sizeCustomError)).toBeVisible();
    await expect(page.locator(SEL.sizeCustomError)).toContainText("multiples of 16");
    await expect(page.locator(SEL.size)).toHaveValue(SIZE_CUSTOM_VALUE);
    // gpt-image: one image, PNG, unless the owner picks otherwise.
    await expect(page.locator(SEL.imageOptionsRow)).toBeAttached();
    await expect(page.locator(SEL.count)).toHaveValue("1");
    await expect(page.locator(SEL.format)).toHaveValue("png");
    await closeComposerSettings(page);

    // A send with that size is refused before anything goes out, and the
    // draft stays.
    const prompt = "A lighthouse on a cliff at dusk, flat colours, wide banner";
    const sends = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/message") sends.push(request);
    });
    await page.locator(SEL.messageInput).fill(prompt);
    await expect(page.locator(SEL.send)).toBeEnabled();
    await page.locator(SEL.send).click();
    await expect(page.locator(SEL.sizeCustomError)).toContainText("multiples of 16");
    await page.waitForTimeout(750);
    expect(sends).toHaveLength(0);
    await expect(page.locator(SEL.messageInput)).toHaveValue(prompt);

    // A valid custom size: the select takes it.
    const input = await composerControl(page, SEL.sizeCustomInput);
    await input.fill("1536x512");
    await expect(page.locator(SEL.sizeCustomError)).toBeHidden();
    await expect(page.locator(SEL.size)).toHaveValue("1536x512");
    await closeComposerSettings(page);

    const posted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/message"
      && response.request().method() === "POST");
    // The browser loads at least one partial while the turn runs.
    const previewLoaded = page.waitForResponse((response) => new URL(response.url()).pathname.includes("/partials/")
      && response.status() === 200, { timeout: TURN_TIMEOUT_MS }).then(() => "loaded", (error) => String(error?.message || error));
    await page.locator(SEL.send).click();
    const sendResponse = await posted;
    const sentBody = sendResponse.request().postDataJSON();
    const sendResult = await sendResponse.json().catch(() => null);
    expect(sendResponse.ok(), JSON.stringify(sendResult)).toBe(true);
    expect(sentBody.model).toBe(IMAGE_MODEL);
    expect(sentBody.contextTier).toBe("1536x512");
    const messageId = String(sendResult?.messageId || "");
    expect(messageId).toBeTruthy();

    // The spec runs the turn in a worker's place, beside the page.
    const turn = takeImageTurn({ conversationId }).then((value) => ({ value }), (error) => ({ error }));

    // The placeholder: in the live bubble, a running timer, the size.
    const placeholder = page.locator(`${SEL.liveBubble} ${SEL.placeholder}[data-message-id="${messageId}"]`);
    await expect(placeholder).toBeVisible({ timeout: TURN_TIMEOUT_MS });
    await expect(placeholder.locator(SEL.placeholderTimer)).toHaveText(/^\d+:\d{2}$/);
    await expect(placeholder.locator(SEL.placeholderDetails)).toContainText("1536x512");
    await expect(placeholder.locator(SEL.placeholderDetails)).toContainText(IMAGE_MODEL);
    // Then a partial in it, served from the turn's partials.
    const preview = placeholder.locator(SEL.placeholderPreview).first();
    await expect(preview).toHaveAttribute("src", /\/partials\//, { timeout: TURN_TIMEOUT_MS });
    const previewSrc = String(await preview.getAttribute("src"));
    expect(await previewLoaded).toBe("loaded");

    // Then the image in the reply, at the size asked for, and the placeholder gone.
    const reply = page.locator(SEL.replyMessage).filter({ has: page.locator(SEL.replyImage) });
    await expect(reply).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
    const replyImage = reply.locator(SEL.replyImage);
    await expect.poll(() => replyImage.evaluate((img) => (img.complete && img.naturalWidth ? `${img.naturalWidth}x${img.naturalHeight}` : "")))
      .toBe("1536x512");
    await expect(reply).toContainText(`1 image · 1536x512 · ${IMAGE_MODEL}`);
    await expect(page.locator(SEL.placeholder)).toHaveCount(0);

    const ran = await turn;
    if (ran.error) throw ran.error;
    expect(ran.value.message.id).toBe(messageId);
    expect(ran.value.message.imageOperationId).toBeTruthy();
    expect(ran.value.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));

    // What OpenAI was asked: one streamed generation with the custom size.
    const requests = fake.imageRequests("/images/generations");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(expect.objectContaining({
      knownKey: true,
      status: 200,
      encoding: "json",
      model: IMAGE_MODEL,
      size: "1536x512",
      quality: "low",
      n: 1,
      stream: true,
      partialImages: 2,
    }));
    expect(requests[0].prompt).toContain(prompt);
    expect(requests[0].idempotencyKey).toBeTruthy();
    expect(requests[0].events).toEqual([
      "image_generation.partial_image",
      "image_generation.partial_image",
      "image_generation.completed",
    ]);

    // The partials went with the turn.
    const gone = await fetch(new URL(previewSrc, relay.baseUrl), { headers: { Authorization: `Bearer ${relay.token}` } });
    expect(gone.status).toBe(404);
  });

  test("an agent starts an image session with an image of its own and gets the result back by path", async () => {
    const enabled = await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } });
    expect(enabled.status, JSON.stringify(enabled.payload)).toBe(200);

    // The conversation the agent runs in, with its turn taken by a "worker":
    // the approval card sits on that turn. Nothing else is queued now.
    const queued = await api("/api/message", {
      method: "POST",
      body: { text: "plan the posters for the spring fair", relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const orchestrator = String(queued.payload.conversationId);
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: orchestrator, conversation_id: orchestrator },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    const dequeueHeaders = queued.payload.ownerSessionId ? { "x-relay-session-id": String(queued.payload.ownerSessionId) } : {};
    let orchestratorRunning = false;
    for (let attempt = 0; attempt < 40 && !orchestratorRunning; attempt += 1) {
      const dequeued = await api("/api/pending", { headers: dequeueHeaders });
      orchestratorRunning = String(dequeued.payload?.message?.id || "") === String(queued.payload.messageId);
      if (!orchestratorRunning) await sleep(250);
    }
    expect(orchestratorRunning, "the orchestrating conversation's message was handed out").toBe(true);

    // The image the agent attaches, in the new session's folder.
    const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(relay.stateRoot, "poster-work-")));
    const sketchPath = path.join(workDir, "fair-sketch.png");
    fs.writeFileSync(sketchPath, solidPng(256, 256, [180, 120, 220]));

    let settled = null;
    const call = tool(orchestrator, "create_session", {
      relay: "this",
      provider: "openai",
      cwd: workDir,
      title: "spring fair poster",
      text: "Turn the sketch into a tall poster for the spring fair",
      images: [sketchPath],
      image: { size: "1024x1536", quality: "low" },
      wait_seconds: 90,
    }).catch((error) => ({ status: 0, payload: { error: String(error?.message || error) } })).then((result) => {
      settled = result;
      return result;
    });

    // Play the user (Allow on the approval card, if one shows) and the
    // worker (the new session's image row), until the row is taken.
    let approved = false;
    const ran = await takeImageTurn({
      onIdle: async () => {
        if (settled) throw new Error(`create_session ended before its turn ran: ${settled.status} ${JSON.stringify(settled.payload)}`);
        if (approved) return;
        const cards = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(orchestrator)}`);
        const card = (cards.payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
        if (!card) return;
        expect(card.choices).toContain("Allow");
        const answered = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
          method: "POST",
          body: { answer: "Allow", ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
        });
        expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
        approved = true;
      },
    });
    expect(ran.result).toEqual(expect.objectContaining({ via: "operation", outcome: "completed" }));

    const result = await call;
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    const payload = result.payload;
    expect(payload).toEqual(expect.objectContaining({ ok: true, status: "done", provider: "openai", model: IMAGE_MODEL }));
    expect(ran.message.conversationId).toBe(payload.session);
    expect(ran.message.imageOptions).toEqual(expect.objectContaining({ size: "1024x1536", quality: "low" }));

    // The reply: the line on what came back, and the image by its path on this relay.
    expect(payload.reply.text).toContain(`1 image · 1024x1536 · ${IMAGE_MODEL}`);
    expect(payload.reply.images).toEqual([{ path: expect.any(String), width: 1024, height: 1536, mime: "image/png" }]);
    const imagePath = payload.reply.images[0].path;
    expect(path.isAbsolute(imagePath)).toBe(true);
    expect(readPngSize(fs.readFileSync(imagePath))).toEqual({ width: 1024, height: 1536 });
    // Agents never see previews.
    expect(JSON.stringify(payload)).not.toContain("/partials/");

    // What OpenAI was asked: one streamed edit, the sketch as its one image.
    const edits = fake.imageRequests("/images/edits");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual(expect.objectContaining({
      knownKey: true,
      status: 200,
      encoding: "multipart",
      model: IMAGE_MODEL,
      size: "1024x1536",
      quality: "low",
      stream: true,
      partialImages: 2,
      imageParts: 1,
    }));
    expect(edits[0].images[0]).toEqual(expect.objectContaining({ field: "image[]", type: "image/png", png: { width: 256, height: 256 } }));
    expect(edits[0].events).toEqual(["image_edit.partial_image", "image_edit.partial_image", "image_edit.completed"]);
    // The UI turn's generation stays the only other image request.
    expect(fake.imageRequests()).toHaveLength(2);
  });
});
