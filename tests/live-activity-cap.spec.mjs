import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// "Tool lines shown while an agent works" (Settings › Appearance),
// against the shared e2e relay. A turn is queued and taken off the queue; its
// tool lines are posted through the routes a session worker uses (no CLI runs
// on the test server): 12 main-agent lines between 3 sub-agents × 150 lines.
//
// Default 50: every main line stays in the live bubble, each sub-agent bubble
// shows its newest 50 ("50+ steps"), live and after a reload. At 10 the main
// list shows its newest 10; at No limit everything. The relay sends the
// running turn's lines as the page's cap says (`activityCap`), so the poll
// response stays small. With OAR_E2E_SCREENSHOT_DIR set, the Settings row
// and the live bubble are shot dark and light.

const SHOT_DIR = String(process.env.OAR_E2E_SCREENSHOT_DIR || "").trim();
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const SUBAGENTS = ["Survey the widget parser", "Count the widget files", "Read the widget tests"];
const SUB_LINES = 150;
// The whole poll response at the default cap stays under this; the same
// turn at 500 per agent (what the relay sent before the page gave its cap)
// is well over it. Measured on this fixture: 18.5 KB at the default, 44 KB
// at 500 per agent (the test logs both).
const POLL_BYTES_BOUND = 30_000;
const MAIN_LINES = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

async function startTurn(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  return { conversationId, messageId };
}

// The worker's heartbeat while the turn runs: without it the CLI reads as
// offline after a while and the live bubble goes with it.
function keepWorkerAlive(request, headers, messageId) {
  const beat = () => request.post("/api/heartbeat", { headers, data: { activeQueueMessageId: messageId } }).catch(() => {});
  void beat();
  const timer = setInterval(beat, 2_000);
  return () => clearInterval(timer);
}

async function openConversationPage(page, token, conversationId, cap = null) {
  await page.addInitScript(({ id, cap: value }) => {
    window.localStorage.setItem("copilot_last_conv", id);
    if (value === null) window.localStorage.removeItem("copilot_live_activity_cap");
    else window.localStorage.setItem("copilot_live_activity_cap", String(value));
  }, { id: conversationId, cap });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

async function shoot(page, name, locator = null) {
  if (!SHOT_DIR) return;
  for (const theme of ["dark", "light"]) {
    // The Settings select follows, so a light shot reads "Light".
    await page.evaluate((value) => {
      window.updateTheme(value);
      const select = document.getElementById("theme-select");
      if (select) select.value = value;
    }, theme);
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${theme}.png` });
  }
  await page.evaluate(() => window.updateTheme("dark"));
}

test.describe("live tool lines", () => {
  test.use({ viewport: PHONE });

  test("each agent keeps its own newest lines, as the setting says", async ({ page, request }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const stamp = Date.now();
    const runIds = SUBAGENTS.map((_, index) => `toolu_cap_${index}_${stamp}`);
    const { conversationId, messageId } = await startTurn(request, headers, `Map the widget code ${stamp}`);
    const activity = (text, subagentRunId = undefined) => request.post("/api/activity", {
      headers,
      data: { messageId, conversationId, mode: "agent", text, ...(subagentRunId ? { subagentRunId } : {}) },
    });
    const mainLine = (n) => `Tool (view): src/widget-main-${n}.js`;
    const subLine = (run, n) => `Tool (grep): widget-${run}-part-${n}`;
    const stopBeating = keepWorkerAlive(request, headers, messageId);

    try {
      for (const [index, runId] of runIds.entries()) {
        expect((await request.post("/api/subagent-run", {
          headers,
          data: { messageId, conversationId, subagentRunId: runId, displayName: SUBAGENTS[index], status: "running", subagentType: "Explore" },
        })).ok()).toBeTruthy();
      }
      // Main lines 1…10 between the sub-agents' bursts, 11 after them; the
      // last one comes live.
      for (let n = 1; n <= SUB_LINES; n += 1) {
        if (n % 5 === 1 && n <= 46) expect((await activity(mainLine(Math.floor(n / 5) + 1))).ok()).toBeTruthy();
        for (const [index, runId] of runIds.entries()) expect((await activity(subLine(index, n), runId)).ok()).toBeTruthy();
      }
      expect((await activity(mainLine(MAIN_LINES - 1))).ok()).toBeTruthy();

      // The in-flight snapshot follows the page's cap: without one (an older
      // page, a paired relay's read) 50 per agent, at no limit (0) all of it.
      const snapshotOf = async (query) => (await (await request.get(`/api/conversation/${conversationId}?limit=5${query}`, { headers })).json()).inFlight;
      expect((await snapshotOf("")).activities.length).toBe(MAIN_LINES - 1 + SUBAGENTS.length * 50);
      expect((await snapshotOf("&activityCap=10")).activities.length).toBe(10 + SUBAGENTS.length * 10);
      expect((await snapshotOf("&activityCap=0")).activities.length).toBe(MAIN_LINES - 1 + SUBAGENTS.length * SUB_LINES);
      // What the old relay sent on every poll (500 per agent) is far over
      // the bound the poll at the default has to keep (below).
      const oldPollBytes = Buffer.byteLength(await (await request.get(`/api/conversation/${conversationId}?limit=20&activityCap=500`, { headers })).body());
      expect(oldPollBytes).toBeGreaterThan(POLL_BYTES_BOUND);

      const mainRows = page.locator("#thinking-activity > .thinking-activity-item");
      const subRows = (runId) => page.locator(`.subagent-bubble[data-subagent-run-id="${runId}"] .subagent-activity > .subagent-activity-item`);
      const expectCounts = async (main, sub) => {
        await expect(mainRows).toHaveCount(main);
        for (const runId of runIds) await expect(subRows(runId)).toHaveCount(sub);
      };

      // Default 50: every main line, the newest 50 of each sub-agent. The
      // page's poll asks for 50 and its whole response stays small.
      const isPoll = (response) => response.url().includes(`/api/conversation/${conversationId}?`);
      const firstPoll = page.waitForResponse((response) => isPoll(response) && response.url().includes("activityCap=50"));
      await openConversationPage(page, token, conversationId);
      const pollBytes = Buffer.byteLength(await (await firstPoll).body());
      console.log(`poll response at the default cap: ${pollBytes} bytes; at 500 per agent: ${oldPollBytes} bytes`);
      expect(pollBytes).toBeLessThan(POLL_BYTES_BOUND);
      await expectCounts(MAIN_LINES - 1, 50);
      // A sub-agent bubble at the cap says it holds the newest of more.
      await expect(page.locator(`.subagent-bubble[data-subagent-run-id="${runIds[1]}"] .subagent-bubble-summary`)).toContainText("50+ steps");
      await expect(mainRows.first()).toContainText("widget-main-1.js");
      await expect(subRows(runIds[1]).first()).toContainText(`widget-1-part-${SUB_LINES - 49}`);
      await expect(subRows(runIds[1]).last()).toContainText(`widget-1-part-${SUB_LINES}`);

      // Live: one more main line and one more sub-agent line.
      expect((await activity(mainLine(MAIN_LINES))).ok()).toBeTruthy();
      expect((await activity(subLine(0, SUB_LINES + 1), runIds[0])).ok()).toBeTruthy();
      await expect(mainRows.last()).toContainText(`widget-main-${MAIN_LINES}.js`);
      await expect(subRows(runIds[0]).last()).toContainText(`widget-0-part-${SUB_LINES + 1}`);
      await expectCounts(MAIN_LINES, 50);
      // Two polls later it still reads the same.
      await page.waitForResponse(isPoll);
      await page.waitForResponse(isPoll);
      await expectCounts(MAIN_LINES, 50);
      await expect(mainRows.first()).toContainText("widget-main-1.js");
      await shoot(page, "live-bubble-phone", page.locator("#thinking-activity"));

      // A reload shows the same.
      await page.reload();
      await expect(page.locator("#cli-dot")).toHaveClass("online");
      await expectCounts(MAIN_LINES, 50);

      // At 10: the newest 10 of each.
      await openConversationPage(page, token, conversationId, 10);
      await expectCounts(10, 10);
      await expect(mainRows.first()).toContainText(`widget-main-${MAIN_LINES - 9}.js`);

      // No limit: everything.
      await openConversationPage(page, token, conversationId, 0);
      await expect(mainRows).toHaveCount(MAIN_LINES);
      await expect(subRows(runIds[0])).toHaveCount(SUB_LINES + 1);
      await expect(subRows(runIds[2])).toHaveCount(SUB_LINES);
    } finally {
      stopBeating();
      await request.post("/api/response", { headers, data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" } }).catch(() => {});
    }
  });

  test("the setting sits in Settings › Appearance", async ({ page }) => {
    await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
    await page.evaluate(() => window.localStorage.removeItem("copilot_live_activity_cap"));
    for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.openSettingsModal("appearance"));
      const slider = page.locator("#live-activity-cap-slider");
      await expect(slider).toBeVisible();
      await expect(slider).toHaveValue("50");
      await expect(page.locator("#live-activity-cap-value")).toHaveText("50 lines");
      await expect(page.locator("#settings-panel-appearance").locator("#live-activity-cap-slider")).toHaveCount(1);
      await shoot(page, `settings-appearance-${name}`, page.locator("#appearance-browser-note"));
    }
    // The far end is no limit, and it is stored.
    const slider = page.locator("#live-activity-cap-slider");
    await slider.fill("510");
    await expect(page.locator("#live-activity-cap-value")).toHaveText("No limit");
    expect(await page.evaluate(() => window.localStorage.getItem("copilot_live_activity_cap"))).toBe("0");
    await page.evaluate(() => window.localStorage.removeItem("copilot_live_activity_cap"));
  });
});
