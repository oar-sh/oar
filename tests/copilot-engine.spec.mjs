import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayDbPath, relayToken } from "./e2e-env.mjs";
import { buildCopilotPlanCard } from "../server/services/plan-usage-copilot.mjs";

/**
 * What is left of the Copilot settings, and the SDK worker's usage snapshot.
 *
 *  1. Settings → Providers → Copilot has no engine choice: the SDK worker is
 *     the only engine. GET /api/settings/copilot stays for paired relays on an
 *     older version, and it needs the relay token.
 *  2. The usage snapshot, end to end: the worker's POST → the relay's
 *     normalise/store → the card builder → the rendered detail section. The one
 *     seam is /api/usage itself: the Copilot card needs a GitHub quota snapshot
 *     the isolated relay has no token to fetch, so the card is built in-process
 *     from the payload the relay really stored and handed to the real client
 *     renderer through a route stub.
 *
 * Turn-level SDK worker behaviour is not covered here: it lives in the unit
 * suites that drive the worker against a fake SDK client
 * (server/copilot-worker/*.test.mjs). See docs/plans/copilot-sdk-worker.md §4c.
 */

function authHeaders(token = relayToken()) {
  return { Authorization: `Bearer ${token}` };
}

test.describe("Copilot settings", () => {
  test("the Copilot panel offers no engine choice, and the GET answers the SDK engine", async ({ page, request }) => {
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    // networkidle can fire before the app modules finish binding their globals.
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "copilot"));
    await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
    const panel = page.locator("#settings-provider-panel-copilot");
    await expect(panel).toBeVisible();
    await expect(panel.locator("#cli-copilot-section")).toBeVisible();
    await expect(panel.locator("select")).toHaveCount(0);
    await expect(page.locator("#copilot-engine-select, #copilot-save-btn, #copilot-settings-status")).toHaveCount(0);

    const response = await request.get("/api/settings/copilot", { headers: authHeaders() });
    expect(response.status()).toBe(200);
    expect((await response.json()).engine).toBe("sdk");
  });

  test("the GET requires the relay token", async ({ request }) => {
    const anonymous = await request.get("/api/settings/copilot");
    expect(anonymous.status()).toBe(401);
  });
});

test.describe.serial("Copilot SDK worker usage snapshot", () => {
  const stamp = Date.now();
  const conversations = [];

  function withDb(fn) {
    const db = new DatabaseSync(relayDbPath());
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function bindRuntimeSession(conversationId, providerType) {
    withDb((db) => {
      const now = new Date().toISOString();
      const id = `rs-copilot-engine-${randomUUID()}`;
      db.prepare(`
        INSERT OR REPLACE INTO runtime_sessions (
          id, conversation_id, strategy, runtime_key, model, provider_type, status, created_at, last_used_at, sdk_session_id
        ) VALUES (?, ?, 'isolated', ?, NULL, ?, 'active', ?, ?, NULL)
      `).run(id, conversationId, id, providerType, now, now);
    });
  }

  function readStoredSnapshot() {
    return withDb((db) => db
      .prepare("SELECT payload_json, source FROM provider_usage_snapshots WHERE provider = ?")
      .get("copilot-sdk") || null);
  }

  async function seedConversation(request, label) {
    const queued = await request.post("/api/message", {
      headers: authHeaders(),
      data: { text: `copilot-engine-${label}-${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    const conversationId = String(body?.conversationId || "").trim();
    expect(conversationId).toBeTruthy();
    conversations.push(conversationId);
    return { conversationId, messageId: String(body?.messageId || "").trim() };
  }

  test.afterAll(async () => {
    for (const conversationId of conversations) {
      await fetch(`${relayBaseUrl()}/api/conversation/${conversationId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }).catch(() => {});
    }
    // The snapshot row is a per-relay singleton; leaving one behind would put a
    // "last SDK worker turn" section on the Copilot card of every later spec.
    withDb((db) => db.prepare("DELETE FROM provider_usage_snapshots WHERE provider = ?").run("copilot-sdk"));
  });

  test("only accepts a snapshot for a Copilot-bound conversation", async ({ request }) => {
    const usage = { usage: { totalNanoAiu: 1_000_000 } };

    // The conversation must exist AND be bound: `github` is the default
    // binding, so a row-shaped fallback would let any authenticated poster
    // overwrite the snapshot the whole relay reads.
    const unknown = await request.post("/api/copilot-plan-usage", {
      headers: authHeaders(),
      data: { conversationId: `missing-${stamp}`, ...usage },
    });
    expect(unknown.status()).toBe(404);

    const { conversationId } = await seedConversation(request, "cursor-bound");
    bindRuntimeSession(conversationId, "cursor");
    const wrongProvider = await request.post("/api/copilot-plan-usage", {
      headers: authHeaders(),
      data: { conversationId, ...usage },
    });
    expect(wrongProvider.status()).toBe(409);
    expect((await wrongProvider.json()).error).toMatch(/not bound to the Copilot provider/);

    expect(readStoredSnapshot()).toBeNull();
  });

  test("stores the turn snapshot and renders it as the card's last-turn section", async ({ page, request }) => {
    const { conversationId, messageId } = await seedConversation(request, "usage");
    bindRuntimeSession(conversationId, "github");

    const capturedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const posted = await request.post("/api/copilot-plan-usage", {
      headers: authHeaders(),
      data: {
        conversationId,
        messageId,
        model: "gpt-5.4-mini",
        capturedAt,
        usage: {
          totalNanoAiu: 1_230_000_000,
          inputTokens: 4321,
          outputTokens: 765,
          modelCalls: 3,
          quotaSnapshots: { cfi_overage: 2 },
        },
        contextUsage: { currentTokens: 51_234 },
      },
    });
    expect(posted.status()).toBe(200);

    const stored = readStoredSnapshot();
    expect(stored).not.toBeNull();
    expect(stored.source).toBe("worker");
    const payload = JSON.parse(stored.payload_json);
    // The worker's own clock is what ages the section, so it has to survive the
    // round trip verbatim — the row's captured_at column is the relay's
    // receive time and cannot stand in for it.
    expect(payload.capturedAt).toBe(capturedAt);
    expect(payload.model).toBe("gpt-5.4-mini");
    expect(payload.contextTokens).toBe(51_234);
    expect(payload.cfiOverage).toBe(2);

    await renderUsageModal(page, payload);

    const section = page.locator('#summary-modal-body [data-section-id="copilot-sdk-last-turn"]');
    await expect(section).toBeVisible();
    await expect(section.locator("summary")).toHaveText("Last SDK worker turn");
    await section.locator("summary").click();
    // Which turn, and how long ago — an undated row of counts under live meters
    // reads as though it were live too.
    await expect(section.locator(".plan-usage-detail-note")).toHaveText("Model gpt-5.4-mini · as of 3 hours ago");
    await expect(section).toContainText("AI credits");
    await expect(section).toContainText("Context tokens");
  });

  test("drops a last-turn section older than the seven-day cutoff", async ({ page, request }) => {
    const { conversationId, messageId } = await seedConversation(request, "stale-usage");
    bindRuntimeSession(conversationId, "github");

    const capturedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const posted = await request.post("/api/copilot-plan-usage", {
      headers: authHeaders(),
      data: {
        conversationId,
        messageId,
        model: "gpt-5.4-mini",
        capturedAt,
        usage: { totalNanoAiu: 1_230_000_000, inputTokens: 4321 },
      },
    });
    expect(posted.status()).toBe(200);

    const payload = JSON.parse(readStoredSnapshot().payload_json);
    expect(payload.capturedAt).toBe(capturedAt);

    await renderUsageModal(page, payload);

    // The card still renders — only the aged section is withheld, because after
    // a week nothing will ever replace those numbers.
    await expect(page.locator('#summary-modal-body [data-provider="github"]')).toBeVisible();
    await expect(page.locator('#summary-modal-body [data-section-id="copilot-sdk-last-turn"]')).toHaveCount(0);
  });

  /**
   * Opens the plan-usage modal over a Copilot card built from `payload`.
   *
   * /api/usage is stubbed because the isolated relay has no GitHub token, so
   * its own Copilot card is always the "quota unavailable" variant, which
   * carries no detail sections. The card handed to the browser is still the
   * real server-side builder run over the payload the relay really stored, so
   * the only thing faked is the quota fetch.
   */
  async function renderUsageModal(page, workerUsage) {
    const card = buildCopilotPlanCard({
      summary: {
        resetDate: "2026-09-01",
        chat: { unlimited: true },
        premiumInteractions: { remaining: 300, entitlement: 1500, percentRemaining: 20 },
      },
      workerUsage,
    });
    await page.route(/\/api\/usage(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ generatedAt: new Date().toISOString(), providers: [card] }),
      });
    });

    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.showUsage === "function");
    await page.evaluate(() => window.showUsage());
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    await expect(page.locator("#summary-modal-title")).toHaveText("Plan usage");
  }
});
