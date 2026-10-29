import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * Check Usage opens on what it showed last time and reads only the open
 * tab's provider live.
 *
 * The relay's /api/usage is intercepted in the page: each answer is the same
 * two-card report with the `live` and `fetchedAt` fields the relay sends, so
 * the spec can see which providers the page asked for and how many times.
 * The first open (nothing kept) asks once for the session's provider; the
 * second open renders the kept cards before the (delayed) answer arrives;
 * switching to a tab older than a minute asks for that provider; Refresh
 * asks for the open tab only.
 */

const COPILOT_CARD = {
  provider: "github",
  label: "GitHub Copilot",
  status: "ok",
  source: "live",
  planName: "Sample plan",
  capturedAt: "2031-01-01T10:00:00.000Z",
  meters: [{ id: "premium", label: "Premium requests", used: 300, limit: 1500, unit: "requests", utilization: 20 }],
  details: [],
  notes: [],
  links: [],
};
const CLAUDE_CARD = {
  provider: "claude",
  label: "Claude",
  status: "ok",
  source: "live",
  capturedAt: "2031-01-01T10:00:00.000Z",
  meters: [{ id: "five_hour", label: "5-hour window", utilization: 42, resetAt: "2031-01-01T15:00:00.000Z" }],
  details: [],
  notes: [],
  links: [],
};

function reportFor(liveIds, stamp) {
  // Cards served from the relay's cache carry an old read time: stale for the page.
  const fetchedAt = { github: "2020-01-01T10:00:00.000Z", claude: "2020-01-01T10:00:00.000Z" };
  for (const id of liveIds) fetchedAt[id] = new Date().toISOString();
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      { ...COPILOT_CARD, meters: [{ ...COPILOT_CARD.meters[0], used: liveIds.includes("github") ? stamp : 300 }] },
      { ...CLAUDE_CARD, planName: liveIds.includes("claude") ? `Live ${stamp}` : "" },
    ],
    live: liveIds,
    fetchedAt,
  };
}

test("Check Usage shows the kept cards at once and reads only the open tab live", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const asked = [];
  let delayMs = 0;
  let conversationId = "";

  await page.route(/\/api\/usage(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const providers = String(url.searchParams.get("providers") || "all").split(",");
    asked.push(providers.join(","));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(reportFor(providers.includes("all") ? ["github", "claude"] : providers, asked.length)),
    });
  });

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `usage-cache-seed-${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "").trim();
    const messageId = String(queuedBody?.messageId || "").trim();
    expect(conversationId).toBeTruthy();
    const responded = await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: "usage cache reply", model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(responded.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate(async (id) => { await window.openConversation(id); }, conversationId);
    // Nothing from an earlier test run.
    await page.evaluate(() => sessionStorage.removeItem("oar.usage.lastReport.v1"));

    // First open: one request, for the session's provider only.
    await page.evaluate(() => window.showUsage());
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    const copilotPanel = page.locator('[data-usage-panel="github"]');
    await expect(copilotPanel).toBeVisible();
    expect(asked).toEqual(["github"]);
    await expect(page.locator("#summary-modal-subtitle")).not.toContainText("updating");
    await page.evaluate(() => window.closeSummaryModal());

    // Second open: the kept cards are on screen before the answer arrives.
    delayMs = 1500;
    const opened = page.evaluate(() => window.showUsage());
    await expect(copilotPanel).toBeVisible({ timeout: 1000 });
    await expect(page.locator("#summary-modal-subtitle")).toContainText("updating");
    await expect(copilotPanel).toHaveAttribute("data-updating", "");
    await opened;
    await expect(page.locator("#summary-modal-subtitle")).not.toContainText("updating");
    await expect(copilotPanel).not.toHaveAttribute("data-updating", "");
    expect(asked).toEqual(["github", "github"]);
    // The live answer replaced the card: the meter carries the request number.
    await expect(copilotPanel).toContainText("2");
    delayMs = 0;

    // The Claude card was only ever served from the relay's cache (an old read
    // time): showing its tab reads it live.
    await page.locator('[data-usage-tab="claude"]').click();
    const claudePanel = page.locator('[data-usage-panel="claude"]');
    await expect(claudePanel).toBeVisible();
    await expect.poll(() => asked.at(-1)).toBe("claude");
    await expect(claudePanel).toContainText(`Live ${asked.length}`);
    // Back and forth within a minute: no new request.
    await page.locator('[data-usage-tab="github"]').click();
    await page.locator('[data-usage-tab="claude"]').click();
    const before = asked.length;
    await page.waitForTimeout(300);
    expect(asked.length).toBe(before);

    // Refresh: the open tab only.
    await page.locator("#summary-modal-refresh").click();
    await expect.poll(() => asked.length).toBe(before + 1);
    expect(asked.at(-1)).toBe("claude");
    await expect(claudePanel).toBeVisible();
    await expect(copilotPanel).toBeHidden();
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

/**
 * The Claude API card: this month's estimated spend on the key, in the
 * relay's time zone, with the monthly cap as a bar; tokens without a price
 * read "estimate incomplete", never $0; at the cap a switch to the key and a
 * new Claude API chat are refused.
 *
 * Its own relay, in a zone far from UTC (UTC+14), so a UTC date would put
 * the turns on the wrong day: the key, the cap and the booked days are
 * written into its database, as the settings tab and the booking leave them,
 * and no request leaves the host (the key is never used: no turn runs).
 */
const CLAUDE_API_ZONE = "Pacific/Kiritimati";
// Invented; not shaped like a Console key.
const CLAUDE_API_TEST_KEY = "test-claude-api-key-0000000000";

function localDayIn(timeZone, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function previousMonthDay(day) {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 1 ? `${year - 1}-12-15` : `${year}-${String(month - 1).padStart(2, "0")}-15`;
}

test.describe("Claude API usage card", () => {
  let relay = null;
  const subscriptionChat = `claude-api-usage-sub-${Date.now()}`;
  const keyChat = `claude-api-usage-key-${Date.now()}`;
  const headers = () => ({ Authorization: `Bearer ${relay.token}` });
  const withDb = (fn) => {
    const db = new DatabaseSync(path.join(relay.dataDir, "oar.db"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const setCap = (value) => withDb((db) => {
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('claude_api_monthly_cap_usd', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(value), new Date().toISOString());
  });

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID(), overrides: { TZ: CLAUDE_API_ZONE } });
    const today = localDayIn(CLAUDE_API_ZONE);
    const now = new Date().toISOString();
    withDb((db) => {
      const setting = db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
      setting.run("claude_api_key", CLAUDE_API_TEST_KEY, now);
      setting.run("claude_api_enabled", "true", now);
      setting.run("claude_api_monthly_cap_usd", "1", now);
      const day = db.prepare(`
        INSERT INTO claude_api_usage_totals (day, model, hit_tokens, miss_tokens, output_tokens, cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);
      day.run(today, "claude-sonnet-5-5", 900_000, 100_000, 20_000, 0.75, 0, now, now, now);
      day.run(today, "claude-new-model", 0, 400, 40, 0, 440, now, now, now);
      // Last month's spend is no part of this month's cap.
      day.run(previousMonthDay(today), "claude-sonnet-5-5", 0, 1_000_000, 0, 9, 0, now, now, now);
      const conversation = db.prepare(`INSERT INTO conversations (id, title, archived, status, created_at, updated_at) VALUES (?, ?, 0, 'active', ?, ?)`);
      const runtime = db.prepare(`
        INSERT INTO runtime_sessions (id, conversation_id, runtime_key, provider_type, provider_model, created_at, last_used_at)
        VALUES (?, ?, ?, ?, 'claude-sonnet-5-5', ?, ?)
      `);
      conversation.run(subscriptionChat, "Claude subscription chat", now, now);
      runtime.run(`rs-${subscriptionChat}`, subscriptionChat, `rs-${subscriptionChat}`, "claude", now, now);
      conversation.run(keyChat, "Claude API chat", now, now);
      runtime.run(`rs-${keyChat}`, keyChat, `rs-${keyChat}`, "claude-api", now, now);
    });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("the card shows today and this month in relay time, the cap bar, and what has no price", async ({ page, request }, testInfo) => {
    setCap(1);
    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=claude-api`, { headers: headers() })).json();
    expect(usage.live).toEqual(["claude-api"]);
    const card = usage.providers.find((entry) => entry.provider === "claude-api");
    expect(card).toBeTruthy();
    expect(card.label).toBe("Claude API");
    const notes = Object.fromEntries(card.notes.map((note) => [note.id, note]));
    expect(notes["claude-api-spend-today"].value).toBe("$0.75 (estimate incomplete)");
    expect(notes["claude-api-spend-month"].value).toBe("$0.75 (estimate incomplete)");
    expect(notes["claude-api-spend-month"].text).toMatch(/440 tokens had no known price/);
    expect(notes["claude-api-estimate"].text).toContain(CLAUDE_API_ZONE);
    const meter = card.meters.find((entry) => entry.id === "claude-api-monthly-cap");
    expect(meter).toMatchObject({ unit: "usd", used: 0.75, allowance: 1, remaining: 0.25, estimated: true });
    // The cap starts over at the zone's own midnight on the 1st.
    expect(meter.resetAt).toMatch(/T10:00:00\.000Z$/);
    expect(card.links.map((link) => link.url)).toContain("https://platform.claude.com/settings/billing");
    expect(JSON.stringify(card)).not.toMatch(/\d+ turns?\b/);

    // Opened from a chat on the key, Check Usage lands on the Claude API tab.
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/status")).status), { timeout: 30_000 }).toBe(200);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.showUsage === "function");
    await page.evaluate(() => sessionStorage.removeItem("oar.usage.lastReport.v1"));
    await page.evaluate(async (id) => { await window.openConversation(id); }, keyChat);
    await page.evaluate(() => window.showUsage());
    const panel = page.locator('[data-usage-panel="claude-api"]');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-usage-tab="claude-api"]')).toHaveText("Claude API");
    await expect(panel.locator('[data-meter-id="claude-api-monthly-cap"]')).toBeVisible();
    await expect(panel).toContainText("estimate incomplete");
    await expect(panel).toContainText("no price known");
    await expect(panel).not.toContainText("$9.");

    // For the rendered check: phone widths, both themes. The screenshots go
    // to the test's output folder, or to OAR_E2E_SCREENSHOT_DIR when set.
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    for (const viewport of [{ name: "phone-390", width: 390, height: 844 }, { name: "phone-320", width: 320, height: 640 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow, `${viewport.name} ${theme}: the card is wider than its box`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: path.join(shotDir, `claude-api-card-${viewport.name}-${theme}.png`) });
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  test("at the cap: the card says so, a switch to the key and a new Claude API chat are refused", async ({ page, request }, testInfo) => {
    setCap(0.5);
    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=claude-api`, { headers: headers() })).json();
    const card = usage.providers.find((entry) => entry.provider === "claude-api");
    expect(card.message).toMatch(/reached the cap: new Claude API turns, agents' new Claude API sessions and switches to the API key are refused/);
    expect(card.meters.find((entry) => entry.id === "claude-api-monthly-cap").utilization).toBe(100);

    const switched = await request.post(`${relay.baseUrl}/api/conversation/${subscriptionChat}/billing`, {
      headers: headers(),
      data: { to: "claude-api" },
    });
    expect(switched.status()).toBe(409);
    const switchBody = await switched.json();
    expect(switchBody.code).toBe("CLAUDE_API_CAP_REACHED");
    expect(switchBody.error).toMatch(/\$0\.75, has reached the monthly cap of \$0\.50/);

    const created = await request.post(`${relay.baseUrl}/api/conversation/bootstrap`, {
      headers: headers(),
      data: { providerType: "claude-api", title: "over the cap" },
    });
    expect(created.status()).toBe(409);
    expect((await created.json()).code).toBe("CLAUDE_API_CAP_REACHED");

    // The page shows the reached cap.
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/status")).status), { timeout: 30_000 }).toBe(200);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.showUsage === "function");
    await page.evaluate(() => sessionStorage.removeItem("oar.usage.lastReport.v1"));
    await page.evaluate(async (id) => { await window.openConversation(id); }, keyChat);
    await page.evaluate(() => window.showUsage());
    const panel = page.locator('[data-usage-panel="claude-api"]');
    await expect(panel).toContainText("reached the cap");
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    for (const viewport of [{ name: "phone-390", width: 390, height: 844 }, { name: "phone-320", width: 320, height: 640 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        await page.screenshot({ path: path.join(shotDir, `claude-api-card-at-cap-${viewport.name}-${theme}.png`) });
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  // The token booking: the card's own tokens-by-model section is
  // replaced by the Tokens sections every tab gets, cache writes apart, and
  // the days copied at the upgrade say their input includes cache writes.
  // A chat on the user's own OpenAI key books under the Copilot tab, as a
  // group of its own. Counts are made up; no turn runs.
  test("the Tokens sections: periods and models with cache writes apart, the copied days' note, an own key's group", async ({ page, request }) => {
    const byokChat = `token-usage-byok-${Date.now()}`;
    const today = localDayIn(CLAUDE_API_ZONE);
    withDb((db) => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO token_usage_days (day, provider, billing, model, source, input_tokens, output_tokens, cache_read_tokens, cost_usd, turn_count, first_seen_at, last_seen_at, updated_at)
        VALUES (?, 'claude-api', '', 'claude-sonnet-5-5', 'backfill', 100000, 20000, 900000, 0.75, 1, ?, ?, ?)
      `).run(previousMonthDay(today), now, now, now);
      db.prepare(`INSERT INTO conversations (id, title, archived, status, created_at, updated_at) VALUES (?, ?, 0, 'active', ?, ?)`).run(byokChat, "Own key chat", now, now);
      db.prepare(`
        INSERT INTO runtime_sessions (id, conversation_id, runtime_key, provider_type, provider_model, created_at, last_used_at)
        VALUES (?, ?, ?, 'openai', 'gpt-5.4-mini', ?, ?)
      `).run(`rs-${byokChat}`, byokChat, `rs-${byokChat}`, now, now);
    });
    const post = async (data) => {
      const answer = await request.post(`${relay.baseUrl}/api/turn-token-usage`, { headers: headers(), data });
      expect(answer.status(), JSON.stringify(await answer.json())).toBe(200);
      return answer.json();
    };
    const booked = await post({
      conversationId: keyChat,
      turnId: `turn-${Date.now()}`,
      runId: "run-1",
      models: [{ model: "claude-sonnet-5-5", inputTokens: 1_200, outputTokens: 300, cacheWriteTokens: 4_000, cacheReadTokens: 45_000, costUsd: 0.05, costSource: "claude-code" }],
    });
    expect(booked.provider).toBe("claude-api");
    const own = await post({
      conversationId: byokChat,
      turnId: `turn-byok-${Date.now()}`,
      runId: "run-1",
      models: [{ model: "gpt-5.4-mini", inputTokens: 800, outputTokens: 90, cacheReadTokens: 2_000 }],
    });
    expect(own).toMatchObject({ provider: "github", billing: "byok-openai" });

    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=claude-api`, { headers: headers() })).json();
    const card = usage.providers.find((entry) => entry.provider === "claude-api");
    const ids = card.details.map((section) => section.id);
    expect(ids).not.toContain("claude-api-tokens-by-model");
    expect(ids).toEqual(expect.arrayContaining(["claude-api-token-usage", "claude-api-token-usage-by-model"]));
    const tokens = card.details.find((section) => section.id === "claude-api-token-usage");
    expect(tokens.rows.map((row) => row.label)).toEqual(["Today", "This month", "All time"]);
    expect(tokens.rows[0].value).toBe("in 1.2k · out 300 · cache w 4k · cache r 45k");
    expect(tokens.rows[2].value).toBe("in 101.2k · out 20.3k · cache w 4k · cache r 945k");
    expect(tokens.note).toMatch(/input includes cache writes\./);
    // Named as the tab's spend rows name it, not by the raw id.
    const byModel = card.details.find((section) => section.id === "claude-api-token-usage-by-model");
    expect(byModel.rows.map((row) => row.label)).toEqual(["Claude Sonnet 5.5"]);
    const copilot = usage.providers.find((entry) => entry.provider === "github");
    const byok = copilot.details.find((section) => section.id === "github-token-usage-byok-openai");
    expect(byok.label).toBe("Tokens — own OpenAI key");
    expect(byok.rows[0].value).toBe("in 800 · out 90 · cache w — · cache r 2k");
    expect(byok.note).toMatch(/OpenAI does not report cache writes\./);

    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/status")).status), { timeout: 30_000 }).toBe(200);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.showUsage === "function");
    await page.evaluate(() => sessionStorage.removeItem("oar.usage.lastReport.v1"));
    await page.evaluate(async (id) => { await window.openConversation(id); }, keyChat);
    await page.evaluate(() => window.showUsage());
    const panel = page.locator('[data-usage-panel="claude-api"]');
    await expect(panel.locator('[data-section-id="claude-api-token-usage"]')).toBeVisible();
    await expect(panel.locator('[data-section-id="claude-api-token-usage"] summary')).toHaveText("Tokens");
    await expect(panel.locator('[data-section-id="claude-api-tokens-by-model"]')).toHaveCount(0);
  });

  // The Claude tab's Tokens sections open expanded, and a dated and an
  // undated id of one model are one row with the ids in its title. Counts
  // are made up; no turn runs. Frames for the rendered check: 1280 and 390
  // px, both themes, and the merged row's tooltip.
  test("the Claude tab's Tokens sections open expanded; ids with one name are one row, the ids in its tooltip", async ({ page, request }, testInfo) => {
    const answer = await request.post(`${relay.baseUrl}/api/turn-token-usage`, {
      headers: headers(),
      data: {
        conversationId: subscriptionChat,
        turnId: `turn-claude-${Date.now()}`,
        runId: "run-1",
        models: [
          { model: "claude-opus-5-5", inputTokens: 12_400, outputTokens: 3_100, cacheWriteTokens: 18_000, cacheReadTokens: 410_000 },
          { model: "claude-opus-5-5-20260601", inputTokens: 2_600, outputTokens: 900, cacheWriteTokens: 2_000, cacheReadTokens: 90_000 },
          { model: "claude-haiku-4-5", inputTokens: 800, outputTokens: 120, cacheWriteTokens: 0, cacheReadTokens: 6_000 },
        ],
      },
    });
    expect(answer.status(), JSON.stringify(await answer.json())).toBe(200);
    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=claude`, { headers: headers() })).json();
    const card = usage.providers.find((entry) => entry.provider === "claude");
    const byModel = card.details.find((section) => section.id === "claude-token-usage-by-model");
    expect(byModel.open).toBe(true);
    expect(card.details.find((section) => section.id === "claude-token-usage").open).toBe(true);
    expect(byModel.rows.map((row) => [row.label, row.value, row.title || null])).toEqual([
      ["Claude Haiku 4.5", "in 800 · out 120 · cache w 0 · cache r 6k", null],
      ["Claude Opus 5.5", "in 15k · out 4k · cache w 20k · cache r 500k", "Model ids: claude-opus-5-5, claude-opus-5-5-20260601"],
    ]);

    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/status")).status), { timeout: 30_000 }).toBe(200);
    await page.waitForFunction(() => typeof window.openConversation === "function" && typeof window.showUsage === "function");
    await page.evaluate(() => sessionStorage.removeItem("oar.usage.lastReport.v1"));
    await page.evaluate(async (id) => { await window.openConversation(id); }, subscriptionChat);
    await page.evaluate(() => window.showUsage());
    const panel = page.locator('[data-usage-panel="claude"]');
    await expect(panel).toBeVisible();
    const tokens = panel.locator('[data-section-id="claude-token-usage"]');
    const models = panel.locator('[data-section-id="claude-token-usage-by-model"]');
    // Open without a click.
    await expect(tokens).toHaveAttribute("open", "");
    await expect(models).toHaveAttribute("open", "");
    await expect(tokens.locator("table")).toBeVisible();
    const merged = models.locator("tr", { hasText: "Claude Opus 5.5" });
    await expect(merged).toHaveAttribute("title", "Model ids: claude-opus-5-5, claude-opus-5-5-20260601");
    await expect(models.locator("tr")).toHaveCount(2);

    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    // The chat header names the test relay's working folder, a path of the
    // host running the suite: hidden in every frame (a mask would paint over
    // the modal too).
    await page.addStyleTag({ content: "#chat-title-cwd { visibility: hidden !important; }" });
    const shot = (name) => page.screenshot({ path: path.join(shotDir, name) });
    const setTheme = (theme) => page.evaluate((value) => {
      if (value === "light") document.documentElement.setAttribute("data-theme", "light");
      else document.documentElement.removeAttribute("data-theme");
    }, theme);
    for (const viewport of [{ name: "1280", width: 1280, height: 900 }, { name: "phone-390", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await setTheme(theme);
        const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow, `${viewport.name} ${theme}: the card is wider than its box`).toBeLessThanOrEqual(0);
        await tokens.scrollIntoViewIfNeeded();
        await shot(`claude-tokens-${viewport.name}-${theme}.png`);
      }
    }

    // The tooltip: a headless screenshot never shows the browser's own, so
    // the frame draws a stand-in from the row's title where the pointer is.
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTheme("dark");
    // Back from the phone width the sidebar (a drawer there) slides back in:
    // a frame taken during that shows it shifted and clipped. Wait until
    // nothing moves, and nothing is scrolled sideways.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    await page.evaluate(() => window.scrollTo(0, window.scrollY));
    expect(await page.locator("#sidebar").evaluate((node) => Math.round(node.getBoundingClientRect().left))).toBe(0);
    await merged.scrollIntoViewIfNeeded();
    await merged.hover();
    const box = await merged.locator("td").first().boundingBox();
    await page.evaluate(({ x, y, text }) => {
      const tip = document.createElement("div");
      tip.id = "e2e-tooltip-stand-in";
      tip.textContent = text;
      Object.assign(tip.style, {
        position: "fixed", left: `${x}px`, top: `${y}px`, zIndex: "2147483647", padding: "3px 7px",
        background: "#f7f7f7", color: "#111", border: "1px solid #767676", font: "12px system-ui, sans-serif",
        boxShadow: "1px 2px 4px rgba(0,0,0,.35)", whiteSpace: "nowrap", pointerEvents: "none",
      });
      document.body.appendChild(tip);
    }, { x: box.x + 24, y: box.y + box.height + 4, text: await merged.getAttribute("title") });
    await shot("claude-tokens-merged-row-tooltip-1280-dark.png");
    await page.evaluate(() => document.getElementById("e2e-tooltip-stand-in")?.remove());
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });
});
