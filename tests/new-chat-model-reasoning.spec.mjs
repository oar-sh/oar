import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// Golden regression for the reported bug: New Chat -> Cursor -> grok-4.5 ->
// reasoning "high" came back as a composer showing Opus 5 / low.
//
// The Cursor provider is seeded directly into the isolated test server's
// settings (no real API key is ever used — nothing calls Cursor, because the
// spec never sends a turn). The bootstrap POST runs against the real server, so
// provider resolution, preference persistence and the composer restore path are
// all covered end to end.
//
// The isolated server runs with COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1, so a
// valid bootstrap still 409s at the worker-spawn step *after* the conversation
// and its preferences are committed. That is exactly the recovery path the
// client is expected to handle, so it is asserted rather than stubbed away.

const CURSOR_SETTINGS = {
  cursor_api_key: "e2e-cursor-key",
  cursor_enabled: "true",
  cursor_model: "composer-2.5",
  cursor_models: JSON.stringify(["composer-2.5", "grok-4.5"]),
  cursor_model_efforts: JSON.stringify({
    "composer-2.5": ["none"],
    "grok-4.5": ["low", "medium", "high"],
  }),
  cursor_model_reasoning_off: JSON.stringify({
    "composer-2.5": true,
    "grok-4.5": false,
  }),
};

test.describe("New Chat model and reasoning survive into the composer", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let db = null;
  let bootstrapResponse = null;
  let convertWorkerFailureToSuccess = false;

  test.beforeAll(() => {
    db = new Database(relayDbPath());
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(CURSOR_SETTINGS)) upsert.run(key, value, now);
  });

  test.afterAll(() => {
    if (!db) return;
    const remove = db.prepare(`DELETE FROM app_settings WHERE key = ?`);
    for (const key of Object.keys(CURSOR_SETTINGS)) remove.run(key);
    db.close();
    db = null;
  });

  test.beforeEach(async ({ page }) => {
    bootstrapResponse = null;
    convertWorkerFailureToSuccess = false;
    await page.route("**/api/conversation/bootstrap", async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try {
        bootstrapResponse = JSON.parse(text);
      } catch {
        bootstrapResponse = null;
      }
      // The isolated server cannot spawn workers, so every valid bootstrap 409s
      // after committing the conversation. Converting that into the payload a
      // real relay returns is the only way to exercise the success branch of
      // createNewConversation; tests that want the recovery branch leave the
      // conversion off.
      if (
        convertWorkerFailureToSuccess
        && response.status() === 409
        && bootstrapResponse?.conversationCreated
      ) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...bootstrapResponse, ok: true }),
        });
      }
      return route.fulfill({ response, body: text });
    });
    // The precondition from the bug report: the previous chat left a Claude
    // model and a low effort in storage.
    await page.addInitScript(() => {
      localStorage.setItem("copilot_selected_model", "claude-opus-5");
      localStorage.setItem("copilot_selected_reasoning_effort", "low");
      localStorage.removeItem("copilot_new_chat_cwd");
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
  });

  // New Chat ignores clicks while a previous one is still opening its
  // conversation, and the button reports that by disabling itself. Waiting for
  // it to come back is what makes the click land.
  async function openNewChatModal(page) {
    await expect(page.locator("#new-conv-btn")).toBeEnabled();
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
  }

  async function startConversation(page, { provider, model, reasoning = "" }) {
    bootstrapResponse = null;
    await openNewChatModal(page);
    await page.locator("#new-conversation-provider-select").selectOption(provider);
    await expect(page.locator("#new-conversation-model-select")).toHaveValue(/.+/);
    await page.locator("#new-conversation-model-select").selectOption(model);
    if (reasoning) await page.locator("#new-conversation-reasoning-select").selectOption(reasoning);
    await page.locator("#new-conversation-model-confirm").click();
    await expect.poll(() => bootstrapResponse !== null).toBe(true);
    const conversationId = String(bootstrapResponse?.conversationId || "");
    expect(conversationId).toBeTruthy();
    // The bootstrap response only means the row exists. Anything the composer
    // does (mode, model, effort) is bound to the *open* conversation, so wait
    // for the sidebar to mark it active before touching those controls.
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);
    return conversationId;
  }

  function startCursorGrokConversation(page) {
    return startConversation(page, { provider: "cursor", model: "grok-4.5", reasoning: "high" });
  }

  test("the composer shows the model and effort the modal asked for", async ({ page, request }) => {
    convertWorkerFailureToSuccess = true;
    // Start from a Copilot chat so the composer's model options are scoped to a
    // different provider than the one the new chat uses: the clamp has to run
    // against the rebuilt Cursor options, not the ones left over here.
    await startConversation(page, { provider: "github", model: "auto" });
    await expect(page.locator("#model-select")).toHaveValue("auto");

    const conversationId = await startCursorGrokConversation(page);
    expect(bootstrapResponse?.selectedModel).toBe("grok-4.5");
    expect(bootstrapResponse?.selectedProviderType).toBe("cursor");
    expect(bootstrapResponse?.preferredReasoningEffort).toBe("high");

    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    await expect(page.locator("#model-select")).toHaveValue("grok-4.5");
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("high");

    const stored = await request.get(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers });
    expect(stored.ok()).toBeTruthy();
    const state = await stored.json();
    expect(state.preferredModel).toBe("grok-4.5");
    expect(state.preferredReasoningEffort).toBe("high");
  });

  test("a conversation whose worker cannot start is still opened", async ({ page }) => {
    // No conversion here: the raw 409 is what a failed worker prestart looks
    // like, and the conversation is already committed behind it. The prestart
    // only exists under session-worker routing (RELAY_E2E_ROUTING=1) — without
    // routing, bootstrap succeeds outright and there is no failure to recover
    // from, so the scenario cannot be exercised.
    const conversationId = await startCursorGrokConversation(page);
    test.skip(bootstrapResponse?.ok === true, "worker prestart requires session-worker routing");
    expect(bootstrapResponse?.ok).toBe(false);
    expect(bootstrapResponse?.conversationCreated).toBe(true);

    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);
    await expect(page.locator("#model-select")).toHaveValue("grok-4.5");
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("high");
    expect(conversationId).toBeTruthy();
  });

  test("the selection survives a reload", async ({ page }) => {
    convertWorkerFailureToSuccess = true;
    await startCursorGrokConversation(page);
    await expect(page.locator("#model-select")).toHaveValue("grok-4.5");

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.locator("#model-select")).toHaveValue("grok-4.5");
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("high");
  });

  test("a new chat keeps the relay mode the composer is in", async ({ page, request }) => {
    convertWorkerFailureToSuccess = true;
    const firstConversationId = await startConversation(page, { provider: "github", model: "auto" });
    await page.locator("#mode-select").selectOption("plan");
    // The composer polls the conversation, so a GET that started before the
    // preference PATCH landed can still show the previous mode. Wait for the
    // server to have it before moving on.
    await expect.poll(async () => {
      const stored = await request.get(`/api/conversation/${encodeURIComponent(firstConversationId)}`, { headers });
      return (await stored.json()).preferredRelayMode;
    }).toBe("plan");
    await expect(page.locator("#mode-select")).toHaveValue("plan");

    // Bootstrap writes the new conversation's preferences, so a mode it does
    // not know about would come back as the default and reset the composer.
    const conversationId = await startCursorGrokConversation(page);
    await expect(page.locator("#mode-select")).toHaveValue("plan");

    const stored = await request.get(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers });
    expect((await stored.json()).preferredRelayMode).toBe("plan");
  });

  test("an abandoned new chat does not change the open conversation", async ({ page }) => {
    convertWorkerFailureToSuccess = true;
    await startConversation(page, { provider: "cursor", model: "grok-4.5", reasoning: "medium" });
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("medium");

    await openNewChatModal(page);
    await page.locator("#new-conversation-provider-select").selectOption("cursor");
    await page.locator("#new-conversation-model-select").selectOption("grok-4.5");
    await page.locator("#new-conversation-reasoning-select").selectOption("high");
    await page.locator("#new-conversation-model-modal button:has-text('Cancel')").click();
    await expect(page.locator("#new-conversation-model-modal")).not.toHaveClass(/visible/);

    // The composer polls the open conversation, so a leaked effort surfaces
    // within a second rather than immediately.
    await page.waitForTimeout(1500);
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("medium");
    expect(await page.evaluate(() => localStorage.getItem("copilot_selected_reasoning_effort"))).toBe("medium");
  });

  test("a model that cannot turn reasoning off labels none as the provider default", async ({ page }) => {
    await openNewChatModal(page);
    await page.locator("#new-conversation-provider-select").selectOption("cursor");
    await page.locator("#new-conversation-model-select").selectOption("grok-4.5");

    const reasoning = page.locator("#new-conversation-reasoning-select");
    // grok-4.5 has an effort parameter with no 'none' value, so 'none' means
    // "whatever the model does by default".
    await expect(reasoning.locator("option[value='none']")).toHaveText("default");
    await expect(reasoning.locator("option[value='high']")).toHaveText("high");
  });
});
