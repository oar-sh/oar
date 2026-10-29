import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * The DeepSeek card in Check Usage, against a loopback fake of DeepSeek's
 * `GET /models` and `GET /user/balance`: the balance read with the saved key,
 * the spend a DeepSeek worker's per-turn report adds, the balance and budget
 * bars with the daily and cost-share charts, and what a refused balance read
 * shows. No request leaves the host.
 *
 * This spec boots its own relay: saving a DeepSeek key switches the provider
 * on for the whole relay, which the shared server's other specs must not see.
 */

const TEST_KEY = "sk-test-0000000000000000";
// A key of the fixture export (tests/fixtures/deepseek-usage-export), with
// its fingerprint sk-4e5f6…7a8b; invented, and built here so no key-shaped
// text is in the source.
const IMPORT_KEY = `sk-4e5f6${"x".repeat(23)}7a8b`;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "deepseek-usage-export");

function startFakeDeepSeek() {
  const state = { balance: null, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, authorization: req.headers.authorization || "" });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (![`Bearer ${TEST_KEY}`, `Bearer ${IMPORT_KEY}`].includes(req.headers.authorization)) return send(401, { error: { message: "Authentication Fails" } });
    if (req.url === "/models") return send(200, { object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    if (req.url === "/user/balance") {
      return send(200, state.balance);
    }
    return send(404, { error: { message: "not found" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/**
 * For a screenshot of all of `locator`: the height caps (and scrolling) of
 * the windows around it lifted, on a screen tall enough to hold it, or to
 * hold `whole` (an element around it) when given. A window centred on the
 * screen moves down as the screen grows, so the screen grows until the
 * element's last line is on it, with a margin.
 */
async function liftHeightCaps(page, locator, viewport, whole = locator) {
  await locator.evaluate((node) => {
    for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
      element.dataset.shotStyle = element.getAttribute("style") || "";
      Object.assign(element.style, { maxHeight: "none", height: "auto", overflow: "visible" });
    }
  });
  const margin = 16;
  let height = viewport.height;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const box = await whole.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const short = Math.max(0, box.bottom + margin - height) + Math.max(0, margin - box.top);
    if (short <= 0 && attempt > 0) break;
    // Grown by twice what is missing: a centred window takes half of it.
    height = Math.max(height, Math.ceil(height + 2 * short));
    await page.setViewportSize({ width: viewport.width, height });
  }
}

async function restoreHeightCaps(page, locator, viewport) {
  await locator.evaluate((node) => {
    for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
      element.setAttribute("style", element.dataset.shotStyle || "");
      delete element.dataset.shotStyle;
    }
  });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
}

/**
 * Opens the app with the relay's token and waits until the page is signed
 * in: the app trades the URL's token for its cookie only after a first
 * status read without one, and its functions (showUsage, openSettingsModal)
 * exist before that. On a busy host "networkidle" can come in between, and
 * a window opened then reads 401.
 */
async function openApp(page, relay) {
  await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.evaluate(async () => (await fetch("/api/status")).status), { timeout: 30_000 }).toBe(200);
}

// A relay with a fake DeepSeek holding a CNY balance, and a conversation
// bound to DeepSeek, as a New Chat on DeepSeek leaves it.
async function startDeepSeekRelay(conversationId) {
  const fake = await startFakeDeepSeek();
  fake.state.balance = {
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
  };
  const relay = await startRelayServer({ token: randomUUID() });
  const db = new DatabaseSync(path.join(relay.dataDir, "oar.db"));
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversations (id, title, archived, status, created_at, updated_at)
      VALUES (?, ?, 0, 'active', ?, ?)
    `).run(conversationId, "DeepSeek usage", now, now);
    db.prepare(`
      INSERT INTO runtime_sessions (id, conversation_id, runtime_key, provider_type, provider_model, created_at, last_used_at)
      VALUES (?, ?, ?, 'deepseek', 'deepseek-flash', ?, ?)
    `).run(`rs-${conversationId}`, conversationId, `rs-${conversationId}`, now, now);
  } finally {
    db.close();
  }
  return { relay, fake };
}

test.describe("DeepSeek usage card", () => {
  let relay = null;
  let fake = null;
  const conversationId = `deepseek-usage-${Date.now()}`;

  const headers = () => ({ Authorization: `Bearer ${relay.token}` });

  test.beforeAll(async () => {
    ({ relay, fake } = await startDeepSeekRelay(conversationId));
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    if (fake) await fake.close();
    relay = null;
    fake = null;
  });

  test("the card shows the balance and the spend of a reported turn", async ({ page, request }) => {
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20 },
    });
    expect(saved.status()).toBe(200);
    const settings = await saved.json();
    expect(settings.enabled).toBe(true);
    expect(settings.monthlyBudget).toBe(20);

    // What the worker posts after a turn, the CLI session's running totals:
    // Wednesday 02:00 UTC is peak.
    const reported = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-1",
        at: "2026-10-21T02:00:00.000Z",
        totals: [{ model: "deepseek-flash", hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
      },
    });
    expect(reported.status()).toBe(200);
    // A second session an hour ago, so the daily chart has a recent day
    // whatever today's date; a thousand misses are under a fen and change
    // no rounded sum.
    const recent = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-2",
        at: new Date(Date.now() - 3_600_000).toISOString(),
        totals: [{ model: "deepseek-flash", missTokens: 1_000 }],
      },
    });
    expect(recent.status()).toBe(200);
    const wrong = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: { conversationId: "no-such-conversation", claudeNativeSessionId: "native-1", totals: [{ model: "deepseek-flash", missTokens: 1 }] },
    });
    expect(wrong.status()).toBe(404);

    // The token booking: the turn's tokens, cache writes apart.
    const tokens = await request.post(`${relay.baseUrl}/api/turn-token-usage`, {
      headers: headers(),
      data: {
        conversationId,
        turnId: "deepseek-turn-1",
        runId: "run-1",
        models: [{ model: "deepseek-flash", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 }],
      },
    });
    expect(tokens.status()).toBe(200);

    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=deepseek`, { headers: headers() })).json();
    expect(usage.live).toEqual(["deepseek"]);
    const card = usage.providers.find((entry) => entry.provider === "deepseek");
    expect(card.status).toBe("ok");
    // The tab's own tokens section (with the imported actuals) stays beside the new ones.
    const sectionIds = card.details.map((section) => section.id);
    expect(sectionIds).toEqual(expect.arrayContaining(["deepseek-tokens-by-model", "deepseek-token-usage", "deepseek-token-usage-by-model"]));
    expect(card.details.find((section) => section.id === "deepseek-token-usage").rows[2].value).toBe("in 1M · out 1M · cache w 0 · cache r 1M");
    // The card's own section keeps its id under its new title; the new one names models as the card does.
    expect(card.details.find((section) => section.id === "deepseek-tokens-by-model").label).toBe("Priced tokens by model");
    expect(card.details.find((section) => section.id === "deepseek-token-usage-by-model").rows.map((row) => row.label)).toEqual(["DeepSeek Flash"]);
    const notes = Object.fromEntries(card.notes.map((note) => [note.id, note.text]));
    expect(notes["deepseek-balance-cny"]).toBe("Balance (CNY): ¥110.00 (topped up ¥100.00, granted ¥10.00)");
    // Peak flash: ¥0.04 + ¥2 + ¥8 per 1M.
    expect(notes["deepseek-spend"]).toBe("Estimated spend on this relay: ¥10.04 since 2026-10-21");
    expect(fake.state.requests.filter((entry) => entry.url === "/user/balance").length).toBe(1);
    // The first balance read is the reference: nothing spent against it yet.
    const meters = Object.fromEntries(card.meters.map((meter) => [meter.id, meter]));
    expect(meters["deepseek-balance-cny"]).toMatchObject({ unit: "cny", used: 0, allowance: 110, remaining: 110, utilization: 0, emphasis: "primary" });
    expect(meters["deepseek-monthly-budget"]).toMatchObject({ unit: "cny", allowance: 20, estimated: true });
    expect(meters["deepseek-monthly-budget"].used).toBeGreaterThan(0);
    const charts = Object.fromEntries(card.charts.map((chart) => [chart.id, chart]));
    expect(charts["deepseek-daily-spend"]).toMatchObject({ kind: "columns", unit: "cny", series: [{ key: "deepseek-flash", label: "DeepSeek Flash" }] });
    expect(charts["deepseek-daily-spend"].items.length).toBe(30);
    expect(charts["deepseek-daily-spend"].items.some((item) => item.values["deepseek-flash"] > 0)).toBe(true);
    expect(charts["deepseek-daily-spend"].note).toMatch(/^Daily history on this relay starts /);
    // 1M hits at the miss price would be ¥2.00; they cost ¥0.04.
    expect(charts["deepseek-spend-shares"]).toMatchObject({ kind: "bars", unit: "cny", summary: "Cache saved about ¥1.96" });
    expect(charts["deepseek-spend-shares"].series.map((entry) => entry.key)).toEqual(["hit", "miss", "output"]);

    await openApp(page, relay);
    await page.waitForFunction(() => typeof window.showUsage === "function");
    await page.evaluate(() => { window.showUsage(); });
    const tab = page.locator('[data-usage-tab="deepseek"]');
    await expect(tab).toHaveText("DeepSeek");
    await tab.click();
    const panel = page.locator('[data-usage-panel="deepseek"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-note-id="deepseek-balance-cny"]')).toContainText("¥110.00");
    await expect(panel.locator('[data-note-id="deepseek-spend"]')).toContainText("¥10.04");
    await expect(panel.locator('a[href="https://platform.deepseek.com/usage"]')).toBeVisible();

    // The bars and charts render, with their text equivalents.
    const balanceBar = panel.locator('[data-meter-id="deepseek-balance-cny"]');
    await expect(balanceBar).toContainText("¥0.00 of ¥110.00 used · ¥110.00 left");
    await expect(panel.locator('[data-meter-id="deepseek-monthly-budget"]')).toContainText("of ¥20.00 used");
    const daily = panel.locator('[data-chart-id="deepseek-daily-spend"]');
    await expect(daily).toBeVisible();
    await expect(daily).toHaveAttribute("aria-label", "Daily spend, last 30 days");
    expect(await daily.locator(".plan-usage-chart-col").count()).toBe(30);
    expect(await daily.locator(".plan-usage-chart-col:not(.plan-usage-chart-col-empty)").count()).toBeGreaterThan(0);
    expect(await daily.locator(".plan-usage-chart-seg").count()).toBeGreaterThan(0);
    await expect(daily.locator(".plan-usage-chart-table summary")).toHaveText("As a table");
    const shares = panel.locator('[data-chart-id="deepseek-spend-shares"]');
    await expect(shares.locator(".plan-usage-chart-summary")).toHaveText("Cache saved about ¥1.96");
    expect(await shares.locator(".plan-usage-chart-legend li").count()).toBe(3);
    await expect(shares.locator(".plan-usage-chart-row").first()).toHaveAttribute("aria-label", /^DeepSeek Flash: ¥10\.04 \(Cache hit ¥0\.04 \(0%\), Cache miss ¥2\.00 \(20%\), Output ¥8\.00 \(80%\)\)$/);
    // The segments are painted in both themes, each with its own colours.
    const segmentColor = () => shares.locator(".plan-usage-chart-seg").first().evaluate((node) => getComputedStyle(node).backgroundColor);
    const dark = await segmentColor();
    expect(dark).not.toBe("rgba(0, 0, 0, 0)");
    await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "light"); });
    const light = await segmentColor();
    expect(light).not.toBe("rgba(0, 0, 0, 0)");
    expect(light).not.toBe(dark);
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  test("the charts keep their layout on a phone in portrait and landscape and on a desktop, in both themes", async ({ page, request }, testInfo) => {
    // The key, the budget and a reported turn, as the test above leaves them
    // (saved again here for a retry on a fresh relay; the same totals once
    // more book nothing). The screenshots go to the test's output folder, or
    // to OAR_E2E_SCREENSHOT_DIR when set.
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20 },
    });
    expect(saved.status()).toBe(200);
    const reported = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-1",
        at: "2026-10-21T02:00:00.000Z",
        totals: [{ model: "deepseek-flash", hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
      },
    });
    expect(reported.status()).toBe(200);
    // A few web searches before DeepSeek charges for them: a "Search" row
    // in the spend by model, priced at nothing.
    const searched = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-3",
        at: "2026-10-21T02:00:00.000Z",
        totals: [],
        requests: [{ model: "deepseek-flash", searchRequests: 3, fetchRequests: 0 }],
      },
    });
    expect(searched.status()).toBe(200);
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    const viewports = [
      { name: "phone-small", width: 320, height: 640 },
      { name: "phone-412", width: 412, height: 915 },
      { name: "phone-portrait", width: 390, height: 844 },
      { name: "phone-landscape", width: 844, height: 390 },
      { name: "desktop", width: 1280, height: 900 },
    ];
    await page.setViewportSize({ width: viewports[0].width, height: viewports[0].height });
    await openApp(page, relay);
    await page.waitForFunction(() => typeof window.showUsage === "function");
    await page.evaluate(() => { window.showUsage(); });
    await page.locator('[data-usage-tab="deepseek"]').click();
    const panel = page.locator('[data-usage-panel="deepseek"]');
    await expect(panel.locator('[data-chart-id="deepseek-spend-shares"]')).toBeVisible();
    await page.waitForLoadState("networkidle");
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        // Each figure lays its parts out top to bottom across its whole
        // width; the plot alone is a grid (one column per day) or rows.
        for (const id of ["deepseek-daily-spend", "deepseek-spend-shares"]) {
          const layout = await panel.locator(`[data-chart-id="${id}"]`).evaluate((figure) => {
            const box = figure.getBoundingClientRect();
            const parts = [...figure.children].filter((node) => getComputedStyle(node).display !== "none");
            return {
              display: getComputedStyle(figure).display,
              width: box.width,
              parts: parts.map((node) => {
                const rect = node.getBoundingClientRect();
                return { name: node.className || node.tagName, left: rect.left - box.left, width: rect.width, top: rect.top, bottom: rect.bottom };
              }),
            };
          });
          const label = `${viewport.name} ${theme} ${id}`;
          expect(layout.display, label).toBe("block");
          for (const part of layout.parts) {
            expect(part.left, `${label}: ${part.name}`).toBeLessThan(1);
            expect(part.width, `${label}: ${part.name}`).toBeGreaterThan(layout.width - 2);
          }
          for (let index = 1; index < layout.parts.length; index += 1) {
            expect(layout.parts[index].top, `${label}: ${layout.parts[index].name} under ${layout.parts[index - 1].name}`)
              .toBeGreaterThanOrEqual(layout.parts[index - 1].bottom - 1);
          }
        }
        const columnWidth = await panel.locator('[data-chart-id="deepseek-daily-spend"] .plan-usage-chart-col').first().evaluate((node) => node.getBoundingClientRect().width);
        expect(columnWidth, `${viewport.name} ${theme}: a day's column`).toBeGreaterThan(3);
        // Every figure is on show (the balance and spend rows, both tables
        // open), and the card fits the screen's width.
        await expect(panel.locator('[data-note-id="deepseek-spend"] dd')).toBeVisible();
        await expect(panel.locator('[data-section-id="deepseek-tokens-by-model"] table')).toBeVisible();
        // A model's name in "Where the money goes" is shown whole, wrapped
        // if need be, never cut.
        const shares = panel.locator('[data-chart-id="deepseek-spend-shares"]');
        const label = await shares.locator(".plan-usage-chart-row-label").first().evaluate((node) => ({
          text: node.textContent,
          cut: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
        }));
        expect(label, `${viewport.name} ${theme}: the model's name`).toEqual({ text: "DeepSeek Flash", cut: false });
        // The window keeps its title beside its buttons, at every width.
        const usageTitle = await page.locator("#summary-modal-title").evaluate((node) => ({ text: node.textContent.trim(), width: node.getBoundingClientRect().width }));
        expect(usageTitle.text, `${viewport.name} ${theme}`).toBe("Plan usage");
        expect(usageTitle.width, `${viewport.name} ${theme}: the window's title`).toBeGreaterThan(60);
        // Each table row's dividing line is one straight line: both cells
        // end at the same height, the Search row's too.
        const spendTable = panel.locator('[data-section-id="deepseek-spend-by-model"]');
        await expect(spendTable.locator("td", { hasText: /^Search3 searches$/ })).toBeVisible();
        const steps = await spendTable.locator("tr").evaluateAll((rows) => rows.map((row) => {
          const bottoms = [...row.cells].map((cell) => cell.getBoundingClientRect().bottom);
          return Math.max(...bottoms) - Math.min(...bottoms);
        }));
        for (const step of steps) expect(step, `${viewport.name} ${theme}: a row's divider steps`).toBeLessThan(0.5);
        // Every cell of the tables is a table cell: a cell laid out as a flex
        // box does not stretch to its row in every browser, and its border
        // then steps against the next cell's.
        const cellDisplays = await panel.locator(".plan-usage-details td").evaluateAll((cells) => [...new Set(cells.map((cell) => getComputedStyle(cell).display))]);
        expect(cellDisplays, `${viewport.name} ${theme}: the tables' cells`).toEqual(["table-cell"]);
        const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow, `${viewport.name} ${theme}: the card is wider than its box`).toBeLessThanOrEqual(0);
        const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(pageOverflow, `${viewport.name} ${theme}: the page scrolls sideways`).toBeLessThanOrEqual(0);
        // What the screen shows, then the whole card: the modal's height cap
        // lifted for the shot, on a screen as wide and tall enough to hold it.
        await page.screenshot({ path: path.join(shotDir, `deepseek-card-${viewport.name}-${theme}-screen.png`) });
        await liftHeightCaps(page, panel, viewport);
        await panel.screenshot({ path: path.join(shotDir, `deepseek-card-${viewport.name}-${theme}.png`) });
        // The chart alone, with a margin so no edge glyph is shaved off.
        const box = await shares.boundingBox();
        await page.screenshot({
          path: path.join(shotDir, `deepseek-shares-${viewport.name}-${theme}.png`),
          clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 },
        });
        await restoreHeightCaps(page, panel, viewport);
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  test("the monthly budget and starting balance fields look like the tab's other inputs, and the bar measures from the starting balance", async ({ page, request }, testInfo) => {
    // A starting balance above what the relay has seen (¥110): the bar
    // measures what is left against it.
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20, startingBalance: 150 },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).startingBalance).toBe(150);
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    const viewports = [
      { name: "phone-small", width: 320, height: 640 },
      { name: "phone-portrait", width: 390, height: 844 },
      { name: "phone-landscape", width: 844, height: 390 },
      { name: "desktop", width: 1280, height: 900 },
    ];
    await page.setViewportSize({ width: viewports[0].width, height: viewports[0].height });
    await openApp(page, relay);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    const panel = page.locator("#settings-provider-panel-deepseek");
    const budget = page.locator("#deepseek-monthly-budget-input");
    await expect(budget).toHaveValue("20");
    const starting = page.locator("#deepseek-starting-balance-input");
    await expect(starting).toHaveValue("150");
    await expect(page.locator("#deepseek-starting-balance-status")).toBeHidden();
    const look = (selector) => page.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, radius: style.borderTopLeftRadius };
    });
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        const label = `${viewport.name} ${theme}`;
        const settingsTitle = await page.locator("#settings-modal-title").evaluate((node) => node.getBoundingClientRect().width);
        expect(settingsTitle, `${label}: the window's title`).toBeGreaterThan(40);
        expect(await look("#deepseek-monthly-budget-input"), label).toEqual(await look("#deepseek-api-key-input"));
        expect(await look("#deepseek-starting-balance-input"), label).toEqual(await look("#deepseek-api-key-input"));
        if (theme === "dark") expect((await look("#deepseek-monthly-budget-input")).background, label).not.toBe("rgb(255, 255, 255)");
        // Every field ends inside the panel, the long commit attribution
        // select too.
        const outside = await panel.evaluate((node) => {
          const right = node.getBoundingClientRect().right;
          return [...node.querySelectorAll("input, select")]
            .filter((field) => field.offsetParent !== null && field.getBoundingClientRect().right > right + 0.5)
            .map((field) => field.id);
        });
        expect(outside, `${label}: fields past the panel's edge`).toEqual([]);
        await starting.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, `deepseek-budget-field-${viewport.name}-${theme}-screen.png`) });
        // The whole window, title to the last field, on every screen.
        const dialog = page.locator("#settings-modal .summary-dialog");
        await liftHeightCaps(page, panel, viewport, dialog);
        await dialog.screenshot({ path: path.join(shotDir, `deepseek-budget-field-${viewport.name}-${theme}.png`) });
        await restoreHeightCaps(page, panel, viewport);
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });

    // The balance bar measures from the starting balance.
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.showUsage(); });
    await page.locator('[data-usage-tab="deepseek"]').click();
    const balanceBar = page.locator('[data-usage-panel="deepseek"] [data-meter-id="deepseek-balance-cny"]');
    await expect(balanceBar).toContainText("¥40.00 of ¥150.00 used · ¥110.00 left");
    await expect(balanceBar).toContainText("Measured from ¥150.00, the starting balance set on the DeepSeek tab.");
    for (const viewport of viewports.filter((entry) => entry.name.startsWith("phone"))) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        await balanceBar.scrollIntoViewIfNeeded();
        await balanceBar.screenshot({ path: path.join(shotDir, `deepseek-starting-balance-bar-${viewport.name}-${theme}.png`) });
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  test("a starting balance a top-up replaced says so on the tab, and typed in again it applies again", async ({ page, request }, testInfo) => {
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20, startingBalance: 120 },
    });
    expect(saved.status()).toBe(200);
    const { startingBalanceSetAt } = await saved.json();
    // The relay saw the balance rise (a top-up, ¥110 after it) after the
    // starting balance was set, and had read the balance before the rise
    // after it was set too: the top-up replaces it.
    const roseAt = new Date(Date.parse(startingBalanceSetAt) + 1).toISOString();
    const db = new DatabaseSync(path.join(relay.dataDir, "oar.db"));
    try {
      db.prepare(`
        INSERT INTO deepseek_balance_reference (currency, reference_total, last_total, reference_at, updated_at, rose_at, last_read_at, rose_from_at)
        VALUES ('CNY', 110, 110, ?, ?, ?, ?, ?)
        ON CONFLICT(currency) DO UPDATE SET reference_total = 110, last_total = 110, reference_at = excluded.reference_at,
          rose_at = excluded.rose_at, last_read_at = excluded.last_read_at, rose_from_at = excluded.rose_from_at
      `).run(roseAt, roseAt, roseAt, roseAt, startingBalanceSetAt);
    } finally {
      db.close();
    }
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    const viewports = [
      { name: "phone-small", width: 320, height: 640 },
      { name: "phone-portrait", width: 390, height: 844 },
    ];
    // The field with its help and note, a margin around it.
    const shoot = async (name) => {
      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const theme of ["dark", "light"]) {
          await page.evaluate((value) => {
            if (value === "light") document.documentElement.setAttribute("data-theme", "light");
            else document.documentElement.removeAttribute("data-theme");
          }, theme);
          const field = page.locator('label[for="deepseek-starting-balance-input"]');
          await field.scrollIntoViewIfNeeded();
          const top = await field.boundingBox();
          const last = await page.locator("#deepseek-starting-balance-status").isVisible()
            ? await page.locator("#deepseek-starting-balance-status").boundingBox()
            : await page.locator("#deepseek-starting-balance-help").boundingBox();
          const panelBox = await page.locator("#settings-provider-panel-deepseek").boundingBox();
          await page.screenshot({
            path: path.join(shotDir, `deepseek-starting-balance-${name}-${viewport.name}-${theme}.png`),
            clip: {
              x: Math.max(0, panelBox.x - 8),
              y: Math.max(0, top.y - 8),
              width: Math.min(viewport.width - Math.max(0, panelBox.x - 8), panelBox.width + 16),
              height: last.y + last.height - top.y + 16,
            },
          });
        }
      }
      await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
    };

    await page.setViewportSize({ width: viewports[0].width, height: viewports[0].height });
    await openApp(page, relay);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    const starting = page.locator("#deepseek-starting-balance-input");
    const status = page.locator("#deepseek-starting-balance-status");
    await expect(starting).toHaveValue("120");
    await expect(status).toBeVisible();
    await expect(status).toHaveText(`No longer used: the balance rose on ${roseAt.slice(0, 10)} (a top-up), so the bar measures from the balance after it. Enter an amount again to measure from it.`);
    // It looks apart from the help text: the warning colour, in a box.
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        if (value === "light") document.documentElement.setAttribute("data-theme", "light");
        else document.documentElement.removeAttribute("data-theme");
      }, theme);
      const styleOf = (selector) => page.locator(selector).evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, border: style.borderTopStyle, background: style.backgroundColor };
      });
      const note = await styleOf("#deepseek-starting-balance-status");
      const help = await styleOf("#deepseek-starting-balance-help");
      expect(note.color, theme).not.toBe(help.color);
      expect(note.border, theme).toBe("solid");
      expect(note.background, theme).not.toBe(help.background);
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
    await shoot("replaced");

    // Saving the tab's other fields leaves it replaced: the Save went
    // through (its answer, then a reload, show the new budget) and the
    // starting balance kept its time.
    const savePosted = () => page.waitForResponse((response) => response.url().endsWith("/api/settings/deepseek") && response.request().method() === "POST");
    const reopen = async () => {
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openSettingsModal === "function");
      await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    };
    await page.locator("#deepseek-monthly-budget-input").fill("25");
    let posted = savePosted();
    await page.locator("#deepseek-save-btn").click();
    let answer = await (await posted).json();
    expect([answer.monthlyBudget, answer.startingBalanceSetAt]).toEqual([25, startingBalanceSetAt]);
    expect(answer.startingBalanceNote).toMatch(/^No longer used/);
    await reopen();
    await expect(page.locator("#deepseek-monthly-budget-input")).toHaveValue("25");
    await expect(starting).toHaveValue("120");
    await expect(status).toBeVisible();
    // The same amount typed in again and saved: it applies again, after a
    // reload too.
    await starting.fill("");
    await starting.fill("120");
    posted = savePosted();
    await page.locator("#deepseek-save-btn").click();
    answer = await (await posted).json();
    expect(answer.startingBalanceSetAt).not.toBe(startingBalanceSetAt);
    expect(answer.startingBalanceNote).toBe(null);
    await reopen();
    await expect(status).toBeHidden();
    await expect(starting).toHaveValue("120");
    await shoot("rearmed");

    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.showUsage(); });
    await page.locator('[data-usage-tab="deepseek"]').click();
    const balanceBar = page.locator('[data-usage-panel="deepseek"] [data-meter-id="deepseek-balance-cny"]');
    await expect(balanceBar).toContainText("¥10.00 of ¥120.00 used · ¥110.00 left");
    await expect(balanceBar).toContainText("Measured from ¥120.00, the starting balance set on the DeepSeek tab.");
  });

  test("a top-up seen while the tab is open does not let a Save of another field bring the starting balance back", async ({ page, request }) => {
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20, startingBalance: 120 },
    });
    expect(saved.status()).toBe(200);
    const { startingBalanceSetAt } = await saved.json();
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, relay);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    const status = page.locator("#deepseek-starting-balance-status");
    await expect(page.locator("#deepseek-starting-balance-input")).toHaveValue("120");
    await expect(status).toBeHidden();
    // With the tab open, the relay notes a top-up after the setting, from a
    // read after it (as a poll of the usage card would).
    const roseAt = new Date().toISOString();
    const db = new DatabaseSync(path.join(relay.dataDir, "oar.db"));
    try {
      db.prepare(`
        INSERT INTO deepseek_balance_reference (currency, reference_total, last_total, reference_at, updated_at, rose_at, last_read_at, rose_from_at)
        VALUES ('CNY', 110, 110, ?, ?, ?, ?, ?)
        ON CONFLICT(currency) DO UPDATE SET reference_total = 110, last_total = 110, reference_at = excluded.reference_at,
          rose_at = excluded.rose_at, last_read_at = excluded.last_read_at, rose_from_at = excluded.rose_from_at
      `).run(roseAt, roseAt, roseAt, roseAt, startingBalanceSetAt);
    } finally {
      db.close();
    }
    // The tab still says nothing; the budget alone is changed and saved.
    await expect(status).toBeHidden();
    await page.locator("#deepseek-monthly-budget-input").fill("25");
    const posted = page.waitForResponse((response) => response.url().endsWith("/api/settings/deepseek") && response.request().method() === "POST");
    await page.locator("#deepseek-save-btn").click();
    const response = await posted;
    expect(response.request().postDataJSON()).toMatchObject({ monthlyBudget: 25, startingBalance: 120, startingBalanceEdited: false });
    const answer = await response.json();
    expect(answer.startingBalanceSetAt).toBe(startingBalanceSetAt);
    expect(answer.startingBalanceNote).toMatch(/^No longer used: the balance rose on /);
    await expect(status).toBeVisible();
    // After a reload too: still replaced, the budget saved.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    await expect(page.locator("#deepseek-monthly-budget-input")).toHaveValue("25");
    await expect(status).toBeVisible();
  });

  test("the budget currency picked on the tab is saved: USD after a reload", async ({ page, request }, testInfo) => {
    // A budget saved without a currency: the tab shows the balance's.
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: TEST_KEY, baseUrl: fake.url, monthlyBudget: 20, monthlyBudgetCurrency: null },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).monthlyBudgetCurrency).toBe(null);
    const openTab = async () => {
      await openApp(page, relay);
      await page.waitForFunction(() => typeof window.openSettingsModal === "function");
      await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
      await expect(page.locator("#deepseek-monthly-budget-input")).toHaveValue("20");
    };
    const currency = page.locator("#deepseek-monthly-budget-currency-select");
    await page.setViewportSize({ width: 390, height: 844 });
    await openTab();
    await expect(currency).toHaveValue("");
    // Picked and saved in the browser, not through the API.
    await currency.selectOption("USD");
    const posted = page.waitForResponse((response) => response.url().endsWith("/api/settings/deepseek") && response.request().method() === "POST");
    await page.locator("#deepseek-save-btn").click();
    expect((await (await posted).json()).monthlyBudgetCurrency).toBe("USD");
    await page.reload();
    await openTab();
    await expect(currency).toHaveValue("USD");
    const stored = await (await request.get(`${relay.baseUrl}/api/settings/deepseek`, { headers: headers() })).json();
    expect(stored.monthlyBudgetCurrency).toBe("USD");

    // The budget fields with USD picked, a margin around them.
    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    for (const viewport of [{ name: "phone-small", width: 320, height: 640 }, { name: "phone-portrait", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          if (value === "light") document.documentElement.setAttribute("data-theme", "light");
          else document.documentElement.removeAttribute("data-theme");
        }, theme);
        const first = page.locator('label[for="deepseek-monthly-budget-input"]');
        await first.scrollIntoViewIfNeeded();
        const top = await first.boundingBox();
        const last = await currency.boundingBox();
        const panelBox = await page.locator("#settings-provider-panel-deepseek").boundingBox();
        await page.screenshot({
          path: path.join(shotDir, `deepseek-budget-currency-usd-${viewport.name}-${theme}.png`),
          clip: {
            x: Math.max(0, panelBox.x - 8),
            y: Math.max(0, top.y - 8),
            width: Math.min(viewport.width - Math.max(0, panelBox.x - 8), panelBox.width + 16),
            height: last.y + last.height - top.y + 16,
          },
        });
      }
    }
    await page.evaluate(() => { document.documentElement.removeAttribute("data-theme"); });
  });

  test("a refused balance read shows the reason and never a key", async ({ request }) => {
    // The service keeps a good answer for a minute; another key is read
    // afresh, and the fake refuses it.
    const otherKey = "sk-test-1111111111111111";
    // Its own turn, so the test also holds on a retry's fresh relay (a CLI
    // session the first test did not report; the same totals once more book
    // nothing when both run).
    const reported = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-1",
        at: "2026-10-21T02:00:00.000Z",
        totals: [{ model: "deepseek-flash", hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
      },
    });
    expect(reported.status()).toBe(200);
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: otherKey, monthlyBudget: 20 },
    });
    expect(saved.status()).toBe(200);
    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=deepseek`, { headers: headers() })).json();
    const card = usage.providers.find((entry) => entry.provider === "deepseek");
    expect(card.status).toBe("partial");
    expect(card.message).toContain("The balance could not be read: DeepSeek balance check failed (401)");
    const text = JSON.stringify(card);
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(otherKey);
    // The spend does not depend on the balance; without one it is in USD
    // (peak flash: $0.006 + $0.30 + $1.20 per 1M), and so is the budget bar.
    expect(card.notes.find((note) => note.id === "deepseek-spend").text).toContain("$1.51");
    expect(card.meters.find((meter) => meter.id === "deepseek-monthly-budget")).toMatchObject({ unit: "usd", allowance: 20 });
    // Another key has no earlier balance read: no balance bar.
    expect(card.meters.some((meter) => meter.id.startsWith("deepseek-balance-"))).toBe(false);
  });

});

// A relay of its own: the import's turn and key would change the sums of the
// tests above.
test.describe("DeepSeek usage export import", () => {
  let relay = null;
  let fake = null;
  const conversationId = `deepseek-usage-import-${Date.now()}`;

  const headers = () => ({ Authorization: `Bearer ${relay.token}` });

  test.beforeAll(async () => {
    ({ relay, fake } = await startDeepSeekRelay(conversationId));
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    if (fake) await fake.close();
    relay = null;
    fake = null;
  });

  test("the usage export imported in Settings shows on the card as actual figures, in both themes, on a desktop and a phone", async ({ page, request }, testInfo) => {
    // The key the export belongs to, a turn the day before the export (the
    // first day of the daily history is never replaced: its earlier turns
    // may be in the totals only), then a turn on the export's day, so the
    // card has an estimate for the export to replace.
    const saved = await request.post(`${relay.baseUrl}/api/settings/deepseek`, {
      headers: headers(),
      data: { apiKey: IMPORT_KEY, baseUrl: fake.url, monthlyBudget: 20 },
    });
    expect(saved.status()).toBe(200);
    const earlier = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-history",
        at: "2026-10-23T09:00:00.000Z",
        totals: [{ model: "deepseek-flash", missTokens: 100_000, outputTokens: 10_000 }],
      },
    });
    expect(earlier.status()).toBe(200);
    const reported = await request.post(`${relay.baseUrl}/api/deepseek-plan-usage`, {
      headers: headers(),
      data: {
        conversationId,
        claudeNativeSessionId: "native-import",
        at: "2026-10-24T09:00:00.000Z",
        totals: [{ model: "deepseek-flash", missTokens: 1_000_000, outputTokens: 1_000_000 }],
      },
    });
    expect(reported.status()).toBe(200);
    // Another relay's agent may not import.
    const remote = await request.post(`${relay.baseUrl}/api/deepseek-usage-import`, {
      headers: { ...headers(), "x-oar-remote-origin": "relay-fixture-b", "x-oar-remote-hops": "1" },
      data: { amount: "a", cost: "b" },
    });
    expect(remote.status()).toBe(403);

    const shotDir = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim() || testInfo.outputPath();
    const setTheme = (theme) => page.evaluate((value) => {
      if (value === "light") document.documentElement.setAttribute("data-theme", "light");
      else document.documentElement.removeAttribute("data-theme");
    }, theme);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.openSettingsModal("providers", "deepseek"));
    const control = page.locator("#deepseek-usage-import");
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const status = page.locator("#deepseek-usage-import-status");

    // One file only: refused before anything is sent.
    await page.locator("#deepseek-usage-amount-input").setInputFiles(path.join(FIXTURES, "amount.csv"));
    await page.locator("#deepseek-usage-import-btn").click();
    await expect(status).toHaveText("Choose both files of the export: the amount file and the cost file.");
    await expect(status).toHaveAttribute("data-state", "error");
    // Swapped files: the relay's reason, inline.
    await page.locator("#deepseek-usage-amount-input").setInputFiles(path.join(FIXTURES, "cost.csv"));
    await page.locator("#deepseek-usage-cost-input").setInputFiles(path.join(FIXTURES, "amount.csv"));
    await page.locator("#deepseek-usage-import-btn").click();
    await expect(status).toContainText("The amount file is not a DeepSeek usage export");
    await expect(status).toHaveAttribute("data-state", "error");
    // A cost file of another range: the files do not match, nothing is stored.
    const costText = fs.readFileSync(path.join(FIXTURES, "cost.csv"), "utf8");
    const otherCost = costText.replace(/,0\.50868424\d*,/, ",0.6,");
    expect(otherCost).not.toBe(costText);
    await page.locator("#deepseek-usage-amount-input").setInputFiles(path.join(FIXTURES, "amount.csv"));
    await page.locator("#deepseek-usage-cost-input").setInputFiles({ name: "cost.csv", mimeType: "text/csv", buffer: Buffer.from(otherCost) });
    await page.locator("#deepseek-usage-import-btn").click();
    await expect(status).toContainText("The files do not match for deepseek-flash");
    await expect(status).toHaveAttribute("data-state", "error");
    await control.screenshot({ path: path.join(shotDir, "deepseek-import-settings-error-desktop-dark.png") });
    // The right files.
    await page.locator("#deepseek-usage-amount-input").setInputFiles(path.join(FIXTURES, "amount.csv"));
    await page.locator("#deepseek-usage-cost-input").setInputFiles(path.join(FIXTURES, "cost.csv"));
    await page.locator("#deepseek-usage-import-btn").click();
    await expect(status).toContainText(/^Imported \d+ rows for 2026-10-24/);
    await expect(status).toContainText("The usage card shows the saved key's figures (CNY) on the export's days through");
    await expect(status).toHaveAttribute("data-state", "active");
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await setTheme(theme);
        await control.scrollIntoViewIfNeeded();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${viewport.name} ${theme}: the page scrolls sideways`).toBeLessThanOrEqual(0);
        const statusColor = await status.evaluate((node) => getComputedStyle(node).color);
        expect(statusColor).not.toBe(await control.evaluate((node) => getComputedStyle(node).backgroundColor));
        await control.screenshot({ path: path.join(shotDir, `deepseek-import-settings-${viewport.name}-${theme}.png`) });
      }
    }
    await setTheme("dark");
    await page.setViewportSize({ width: 1280, height: 900 });

    const usage = await (await request.get(`${relay.baseUrl}/api/usage?providers=deepseek`, { headers: headers() })).json();
    const card = usage.providers.find((entry) => entry.provider === "deepseek");
    const notes = Object.fromEntries(card.notes.map((note) => [note.id, note.text]));
    expect(notes["deepseek-actual"]).toMatch(/^Actual figures from the DeepSeek export on the days it covers \(the last through 2026-10-2[56] 00:00 UTC\+01:00\), estimated on the others\. On export days the export's cost includes the web searches\./);
    expect(notes["deepseek-spend"]).toMatch(/^Spend, actual and estimated: ¥/);
    expect(card.charts.find((chart) => chart.id === "deepseek-daily-spend").note).toMatch(/^Actual from the DeepSeek export on the days it covers, by its days; estimated on the others/);
    // The budget bar of a month with export days is not flagged "estimated".
    const budget = card.meters.find((meter) => meter.id === "deepseek-monthly-budget");
    expect(budget.estimated).toBe(false);
    expect(budget.note).toMatch(/actual on the days of the DeepSeek export/);
    const byModel = card.details.find((section) => section.id === "deepseek-spend-by-model");
    expect(byModel.rows.map((row) => row.label)).toEqual(expect.arrayContaining(["DeepSeek Flash", "DeepSeek V4 Pro"]));

    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.closeSettingsModal?.(); window.showUsage(); });
    await page.locator('[data-usage-tab="deepseek"]').click();
    const panel = page.locator('[data-usage-panel="deepseek"]');
    await expect(panel.locator('[data-note-id="deepseek-actual"]')).toContainText("Actual figures from the DeepSeek export on the days it covers");
    await expect(panel.locator('[data-meter-id="deepseek-monthly-budget"] .plan-usage-flag')).toHaveCount(0);
    await expect(panel.locator('[data-note-id="deepseek-spend"]')).toContainText("Spend, actual and estimated");
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ["dark", "light"]) {
        await setTheme(theme);
        const overflow = await panel.evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow, `${viewport.name} ${theme}: the card is wider than its box`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: path.join(shotDir, `deepseek-import-card-${viewport.name}-${theme}-screen.png`) });
        // The whole card: the modal's height cap lifted for the shot.
        await panel.evaluate((node) => {
          for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
            element.dataset.shotStyle = element.getAttribute("style") || "";
            Object.assign(element.style, { maxHeight: "none", height: "auto", overflow: "visible" });
          }
        });
        const height = await panel.evaluate((node) => node.getBoundingClientRect().bottom);
        await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(height) + 40) });
        await panel.screenshot({ path: path.join(shotDir, `deepseek-import-card-${viewport.name}-${theme}.png`) });
        await panel.evaluate((node) => {
          for (let element = node.parentElement; element && element !== document.body; element = element.parentElement) {
            element.setAttribute("style", element.dataset.shotStyle || "");
            delete element.dataset.shotStyle;
          }
        });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      }
    }
    await setTheme("dark");
  });
});
