import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

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
