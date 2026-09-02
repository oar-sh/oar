import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayDbPath, relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";
import { buildCopilotPlanCard } from "../server/services/plan-usage-copilot.mjs";

/**
 * The Copilot engine toggle (Settings → Providers → Copilot) and the SDK
 * worker's usage snapshot.
 *
 * Three things are pinned here, each against the relay that can actually
 * express it:
 *
 *  1. The panel itself, and the *refusal* path, on the shared e2e relay. That
 *     relay pins session-worker routing off (see relay-server-harness.mjs), so
 *     an SDK save there can only ever be refused — which is worth asserting
 *     precisely, because the reason string is the entire UX of the refusal.
 *  2. The *accept* path, on a throwaway relay this spec boots with routing on
 *     and a stub COPILOT_SDK_PATH. Stubbing the response in the browser would
 *     only prove the client renders what it is handed; booting a second relay
 *     proves the relay's own precondition check, the persistence and the
 *     reload. Nothing is ever spawned on it — no conversation is created there
 *     — so routing-on is inert beyond the setting it unlocks.
 *  3. The usage snapshot, end to end: the worker's POST → the relay's
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

const EXTENSION_STATUS = "New Copilot conversations run on the Copilot CLI with the web-relay extension (current default).";
const SDK_STATUS = "New Copilot conversations run on the experimental headless SDK worker. No tmux inspector for these sessions.";

function authHeaders(token = relayToken()) {
  return { Authorization: `Bearer ${token}` };
}

async function loadApp(page, { baseUrl = "", token = relayToken() } = {}) {
  await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  // networkidle can fire before the app modules finish binding their globals.
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
}

async function openCopilotSettings(page) {
  await page.evaluate(() => window.openSettingsModal("providers", "copilot"));
  await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  await expect(page.locator("#settings-provider-panel-copilot")).toBeVisible();
}

const engineSelect = (page) => page.locator("#copilot-engine-select");
const engineStatus = (page) => page.locator("#copilot-settings-status");

async function readEngine(request, { baseUrl = "", token = relayToken() } = {}) {
  const response = await request.get(`${baseUrl}/api/settings/copilot`, { headers: authHeaders(token) });
  expect(response.status()).toBe(200);
  return response.json();
}

/** Saves through the panel exactly as a user would, alert and all. */
async function saveEngineFromPanel(page, engine) {
  await engineSelect(page).selectOption(engine);
  await page.click("#copilot-save-btn");
  // The save re-enables its controls in a `finally`, so this settles for both
  // the accepted and the refused path.
  await expect(page.locator("#copilot-save-btn")).toBeEnabled();
}

test.describe.serial("Copilot engine panel on a relay without session-worker routing", () => {
  test.beforeEach(async ({ page }) => {
    // A refused save raises a native alert; an unhandled dialog would hang the
    // click that opened it.
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
  });

  // Plain fetch, not the `request` fixture: only worker-scoped fixtures are
  // available in afterAll.
  test.afterAll(async () => {
    await fetch(`${relayBaseUrl()}/api/settings/copilot`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ engine: "extension" }),
    }).catch(() => {});
  });

  test("renders the engine choice with Extension active and describes both engines", async ({ page }) => {
    await loadApp(page);
    await openCopilotSettings(page);

    await expect(engineSelect(page)).toHaveValue("extension");
    await expect(engineSelect(page).locator("option")).toHaveText([
      "Extension — current",
      "SDK — experimental",
    ]);
    expect(await engineSelect(page).locator("option").evaluateAll(
      (options) => options.map((option) => option.value),
    )).toEqual(["extension", "sdk"]);

    // The default engine is not an error state and not a configured-extra one.
    await expect(engineStatus(page)).toHaveAttribute("data-state", "unconfigured");
    await expect(engineStatus(page)).toHaveText(EXTENSION_STATUS);

    // The two losses a user must know about before switching, and the fact that
    // switching does not disturb a running session.
    const panel = page.locator("#settings-provider-panel-copilot");
    await expect(panel).toContainText("no tmux inspector for those sessions");
    await expect(panel).toContainText("Applies to newly started conversations");
  });

  test("refuses the SDK engine in place, with the relay's reason", async ({ page, request }) => {
    await loadApp(page);
    await openCopilotSettings(page);
    await saveEngineFromPanel(page, "sdk");

    // The reason replaces the engine description rather than only flashing in
    // the alert, which is gone as soon as it is dismissed.
    await expect(engineStatus(page)).toHaveAttribute("data-state", "error");
    await expect(engineStatus(page)).toContainText("SESSION_WORKER_ROUTING_ENABLED");
    // The select snaps back to what the relay actually runs — leaving "SDK"
    // selected would read as though the switch had happened.
    await expect(engineSelect(page)).toHaveValue("extension");

    expect((await readEngine(request)).engine).toBe("extension");
  });

  test("answers the refused save with 409 and leaves the stored engine alone", async ({ request }) => {
    const refused = await request.post("/api/settings/copilot", {
      headers: authHeaders(),
      data: { engine: "sdk" },
    });
    // 409, not 400: the request is well formed, the relay is not in a state to
    // honour it.
    expect(refused.status()).toBe(409);
    const body = await refused.json();
    expect(body.error).toMatch(/SESSION_WORKER_ROUTING_ENABLED/);
    expect(body.error).toMatch(/no SDK worker is ever spawned/);
    expect((await readEngine(request)).engine).toBe("extension");
  });

  test("accepts the Extension engine and reflects it on the GET", async ({ request }) => {
    const saved = await request.post("/api/settings/copilot", {
      headers: authHeaders(),
      data: { engine: "extension" },
    });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toEqual({
      ok: true,
      engine: "extension",
      engines: ["extension", "sdk"],
    });
    expect(await readEngine(request)).toEqual({ engine: "extension", engines: ["extension", "sdk"] });
  });

  test("requires the relay token", async ({ request }) => {
    const anonymous = await request.post(`${relayBaseUrl()}/api/settings/copilot`, {
      data: { engine: "sdk" },
    });
    expect(anonymous.status()).toBe(401);
  });
});

test.describe.serial("Copilot engine panel on an SDK-capable relay", () => {
  // Booting a relay costs a few seconds on top of the page work.
  test.describe.configure({ timeout: 120_000 });

  let relay = null;

  test.beforeAll(async () => {
    relay = await startRelayServer({
      token: randomUUID(),
      // The only difference from the shared harness server. COPILOT_SDK_PATH is
      // already pinned to a stub directory for every e2e relay, so this is the
      // one remaining precondition the engine setting checks.
      overrides: { COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1" },
    });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("saves the SDK engine from the panel and keeps it across a reload", async ({ page, request }) => {
    page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });

    await loadApp(page, { baseUrl: relay.baseUrl, token: relay.token });
    await openCopilotSettings(page);
    await expect(engineSelect(page)).toHaveValue("extension");

    await saveEngineFromPanel(page, "sdk");
    await expect(engineStatus(page)).toHaveAttribute("data-state", "active");
    await expect(engineStatus(page)).toHaveText(SDK_STATUS);
    await expect(engineSelect(page)).toHaveValue("sdk");

    // Persistence is the point of the setting: a worker spawned after a relay
    // restart has to pick the same engine.
    expect(await readEngine(request, { baseUrl: relay.baseUrl, token: relay.token }))
      .toEqual({ engine: "sdk", engines: ["extension", "sdk"] });

    await loadApp(page, { baseUrl: relay.baseUrl, token: relay.token });
    await openCopilotSettings(page);
    await expect(engineSelect(page)).toHaveValue("sdk");
    await expect(engineStatus(page)).toHaveAttribute("data-state", "active");

    // And back, so the panel is not a one-way door.
    await saveEngineFromPanel(page, "extension");
    await expect(engineStatus(page)).toHaveAttribute("data-state", "unconfigured");
    expect((await readEngine(request, { baseUrl: relay.baseUrl, token: relay.token })).engine)
      .toBe("extension");
  });

  test("names the missing SDK path, distinctly from the routing refusal", async ({ request }) => {
    const routingRefusal = await request.post("/api/settings/copilot", {
      headers: authHeaders(),
      data: { engine: "sdk" },
    });
    expect(routingRefusal.status()).toBe(409);
    const routingReason = (await routingRefusal.json()).error;

    // Routing on, SDK path deliberately unresolvable: blanking the derivation
    // inputs matters because the relay otherwise falls back to whatever Copilot
    // CLI the host has installed. HOME already points at the temp state root,
    // so the CLI-cache scan finds nothing.
    const bare = await startRelayServer({
      token: randomUUID(),
      overrides: {
        COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1",
        COPILOT_SDK_PATH: "",
        COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH: "",
        COPILOT_EXTENSION_BOOTSTRAP_PATH: "",
        COPILOT_CLI_DIST_DIR: "",
      },
    });
    try {
      const refused = await request.post(`${bare.baseUrl}/api/settings/copilot`, {
        headers: authHeaders(bare.token),
        data: { engine: "sdk" },
      });
      expect(refused.status()).toBe(409);
      const sdkReason = (await refused.json()).error;
      expect(sdkReason).toMatch(/COPILOT_SDK_PATH did not resolve/);
      // The env is snapshotted at boot, so "install the CLI" alone is not
      // actionable advice — the restart is the part users miss.
      expect(sdkReason).toMatch(/restart the relay/);

      // Two causes, two answers: a single generic "SDK unavailable" would send
      // the user looking in the wrong place.
      expect(sdkReason).not.toBe(routingReason);
      expect((await readEngine(request, { baseUrl: bare.baseUrl, token: bare.token })).engine)
        .toBe("extension");
    } finally {
      await bare.stop();
    }
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
    // a week (or a switch back to the extension engine) nothing will ever
    // replace those numbers.
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
    await page.route("**/api/usage", async (route) => {
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
