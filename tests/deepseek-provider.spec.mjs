import http from "node:http";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// The DeepSeek provider end to end in the browser: saving a key in its own
// settings tab discovers the models from a fake DeepSeek API on a loopback
// port (the base URL the tab allows for exactly this), New Chat offers
// DeepSeek with its models and efforts, and the composer of a DeepSeek chat
// is locked to DeepSeek. No turn is sent: the isolated server spawns no
// workers, and nothing here reaches DeepSeek.

const TEST_KEY = "sk-test-e2e-fake-key";
const DISCOVERED = ["deepseek-flash", "deepseek-v4-pro", "deepseek-v5-preview"];

function startFakeDeepSeek() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorized: req.headers.authorization === `Bearer ${TEST_KEY}` });
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: DISCOVERED.map((id) => ({ id, object: "model" })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test.describe("DeepSeek provider", () => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let fake = null;
  let bootstrapResponse = null;

  test.beforeAll(async () => {
    fake = await startFakeDeepSeek();
  });

  test.afterAll(async () => {
    // The shared server keeps running for other specs: take the provider out
    // again (its conversations block a key removal, so the rows go directly).
    const db = new Database(relayDbPath());
    db.prepare(`DELETE FROM app_settings WHERE key LIKE 'deepseek\\_%' ESCAPE '\\'`).run();
    db.close();
    await new Promise((resolve) => fake?.server.close(resolve));
  });

  test.beforeEach(async ({ page }) => {
    bootstrapResponse = null;
    // The isolated server cannot spawn workers, so a valid bootstrap 409s
    // after committing the conversation; the success payload a real relay
    // returns is restored for the client (as in new-chat-model-reasoning).
    await page.route("**/api/conversation/bootstrap", async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      try { bootstrapResponse = JSON.parse(text); } catch { bootstrapResponse = null; }
      if (response.status() === 409 && bootstrapResponse?.conversationCreated) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...bootstrapResponse, ok: true }) });
      }
      return route.fulfill({ response, body: text });
    });
    await page.addInitScript(() => {
      localStorage.removeItem("copilot_selected_reasoning_effort");
      localStorage.removeItem("copilot_new_chat_cwd");
    });
  });

  test("a saved key discovers the models, and the key never comes back", async ({ page, request }) => {
    const saved = await request.post("/api/settings/deepseek", {
      headers,
      data: { apiKey: TEST_KEY, baseUrl: fake.baseUrl },
    });
    expect(saved.ok()).toBeTruthy();
    const body = await saved.json();
    expect(body.configured).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.availableModels).toEqual(DISCOVERED);
    expect(JSON.stringify(body)).not.toContain(TEST_KEY);
    expect(fake.seen.some((call) => call.path === "/models" && call.authorized)).toBe(true);

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    const panel = page.locator("#settings-provider-panel-deepseek");
    await expect(panel).toBeVisible();
    await expect(page.locator("#deepseek-settings-status")).toHaveAttribute("data-state", "active");
    await expect(page.locator("#deepseek-enabled-toggle")).toBeChecked();
    await expect(page.locator("#deepseek-api-key-input")).toHaveValue("");
    await expect(page.locator("#deepseek-api-key-input")).toHaveAttribute("placeholder", /Saved API key/);
    await expect(page.locator("#deepseek-model-select option")).toHaveText(DISCOVERED);
    await expect(page.locator("#deepseek-base-url-input")).toHaveValue(fake.baseUrl);
    expect(await page.content()).not.toContain(TEST_KEY);
  });

  test("New Chat starts a DeepSeek chat whose composer is locked to DeepSeek", async ({ page }) => {
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#new-conv-btn")).toBeEnabled();
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);
    await page.locator("#new-conversation-provider-select").selectOption("deepseek");
    await expect(page.locator("#new-conversation-provider-help")).toContainText("DeepSeek");
    await expect(page.locator("#new-conversation-model-select")).toHaveValue("deepseek-flash");
    // DeepSeek's levels, starting at its own default.
    await expect(page.locator("#new-conversation-reasoning-select option")).toHaveText(["low", "high", "max"]);
    await expect(page.locator("#new-conversation-reasoning-select")).toHaveValue("high");
    await page.locator("#new-conversation-model-confirm").click();
    await expect.poll(() => bootstrapResponse !== null).toBe(true);
    expect(bootstrapResponse?.selectedProviderType).toBe("deepseek");
    expect(bootstrapResponse?.selectedModel).toBe("deepseek-flash");
    expect(bootstrapResponse?.preferredReasoningEffort).toBe("high");
    const conversationId = String(bootstrapResponse?.conversationId || "");
    await expect(page.locator(`.conv-item.active[onclick*="${conversationId}"]`)).toHaveCount(1);

    await expect(page.locator("#model-lock-note")).toHaveText("🔒 Session locked to DeepSeek models.");
    await expect(page.locator("#model-lock-note")).toHaveAttribute("data-provider", "deepseek");
    await expect(page.locator("#msg-input")).toHaveAttribute("placeholder", "Message DeepSeek…");
    await expect(page.locator("#model-select")).toHaveValue("deepseek-flash");
    // Only DeepSeek's models besides Auto, and the switch between them stays open.
    const models = await page.locator("#model-select option").evaluateAll((options) => options.map((option) => option.value));
    expect(models.filter((model) => model !== "auto")).toEqual(DISCOVERED);
    await expect(page.locator("#reasoning-effort-select")).toHaveValue("high");
  });
});
