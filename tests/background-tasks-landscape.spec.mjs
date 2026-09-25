import { expect, test, devices } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Phone landscape leaves ~360px of height: the background-task list's height
// budget must keep the whole composer on screen, and the list must scroll by
// touch. Real touch events (CDP touchStart/Move/End) — the synthetic
// scroll-gesture API does not drive touch scrolling reliably here.

const { defaultBrowserType: _ignored, ...pixelLandscape } = devices["Pixel 7 landscape"];
test.use({ ...pixelLandscape });

async function touchSwipe(cdp, x, fromY, toY) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: fromY + ((toY - fromY) * step) / 10 }],
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("phone landscape keeps portrait text size, the composer on screen, and the task list touch-scrollable", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `bg-landscape-${Date.now()}`, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    conversationId = String((await queued.json())?.conversationId || "");
    const now = Date.now();
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      taskId: `landscape-${now}-${index}`,
      taskType: "local_agent",
      subagentType: "general-purpose",
      description: `Job ${index}`,
      startedAt: now,
      model: "claude-opus-5-5",
      lastToolCall: "Tool (Bash): npm test -- --long-flag",
      totalTokens: 1000,
    }));
    const published = await request.post("/api/background-tasks", { headers, data: { conversationId, tasks } });
    expect(published.ok()).toBeTruthy();

    await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const panel = page.locator("#background-tasks-panel");
    await expect(panel).toBeVisible();
    if ((await panel.getAttribute("open")) === null) await page.locator("#background-tasks-summary").click();
    await expect(panel).toHaveAttribute("open", "");

    const layout = await page.evaluate(() => {
      const list = document.getElementById("background-tasks-list");
      return {
        viewportHeight: innerHeight,
        inputBottom: document.getElementById("input-area").getBoundingClientRect().bottom,
        sendBottom: document.getElementById("send-btn").getBoundingClientRect().bottom,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    });
    // Rotating keeps the portrait text size (Pixel 7 portrait root: 14px);
    // the desktop root (16px) used to apply once the width passed 680px.
    const rootFontPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(rootFontPx).toBeGreaterThanOrEqual(12);
    expect(rootFontPx).toBeLessThanOrEqual(14.01);
    expect(layout.inputBottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.sendBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);

    const list = page.locator("#background-tasks-list");
    const box = await list.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await touchSwipe(cdp, Math.round(box.x + box.width / 2), Math.round(box.y + box.height - 6), Math.round(box.y + 6));
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  } finally {
    if (conversationId) {
      await request.post("/api/background-tasks", { headers, data: { conversationId, tasks: [] } }).catch(() => {});
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
    }
  }
});
