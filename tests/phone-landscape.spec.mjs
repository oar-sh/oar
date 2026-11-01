import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * A phone turned sideways (phone-landscape.mjs, phone-landscape-ui.js):
 *
 *  - :root[data-phone-landscape] and a one-line header (no meta line);
 *  - a pick from the session list focuses no message box and collapses the
 *    list; a long press for the row menu leaves the list open;
 *  - typing mode while the keyboard is up: the label row and the task line
 *    fold into a floating ⚙ and 🤖; the ⚙ opens the panel and the message box
 *    keeps the focus; the 🤖 shows the task panel over the composer.
 *
 * Playwright opens no keyboard: Android resizes the layout for it
 * (interactive-widget=resizes-content), so shrinking the viewport while the
 * pinned screen stays put is the same resize. Titles are invented.
 */

const SCREEN = { width: 915, height: 412 };
test.use({ viewport: SCREEN, screen: SCREEN, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });

// Chromium's mobile emulation reports the viewport as the screen; a real
// phone's screen never changes when the keyboard opens. Pin it.
async function openApp(page, conversationId) {
  await page.addInitScript(({ width, height, id }) => {
    for (const [key, value] of Object.entries({ width, height, availWidth: width, availHeight: height })) {
      Object.defineProperty(window.screen, key, { get: () => value, configurable: true });
    }
    Object.defineProperty(window.screen, "orientation", {
      get: () => ({ type: "landscape-primary", angle: 90, addEventListener() {}, removeEventListener() {} }),
      configurable: true,
    });
    if (id) localStorage.setItem("copilot_last_conv", id);
  }, { ...SCREEN, id: conversationId });
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForLoadState("networkidle");
}

async function seedConversation(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "autopilot", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  return String((await queued.json())?.conversationId || "");
}

async function touchHold(cdp, x, y, ms) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await new Promise((resolve) => setTimeout(resolve, ms));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("phone landscape: one-line header, a pick collapses the list without focus, typing mode folds the composer chrome", async ({ page, request }) => {
  const headers = { Authorization: `Bearer ${relayToken()}` };
  const stamp = Date.now();
  const ids = [];
  try {
    ids.push(await seedConversation(request, headers, `Heron survey notes ${stamp}`));
    ids.push(await seedConversation(request, headers, `Lichen plot tally ${stamp}`));
    const [first, second] = ids;
    const tasks = [{
      taskId: `landscape-float-${stamp}`,
      taskType: "local_agent",
      subagentType: "general-purpose",
      description: "Count the plots",
      startedAt: stamp,
      model: "claude-opus-5-5",
      totalTokens: 100,
    }];
    expect((await request.post("/api/background-tasks", { headers, data: { conversationId: second, tasks } })).ok()).toBeTruthy();

    await openApp(page, first);
    await expect(page.locator("html")).toHaveAttribute("data-phone-landscape", "");

    // One header line: the meta line is gone, the header is about a button high.
    await expect(page.locator("#chat-title-meta")).toBeHidden();
    const headerHeight = await page.locator("#chat-header").evaluate((el) => el.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThanOrEqual(40);
    await expect(page.locator("#chat-header-actions")).toHaveAttribute("data-header-fit", "1");

    // A long press opens the row menu and leaves the list open.
    await expect(page.locator("body")).not.toHaveClass(/\bsidebar-collapsed\b/);
    const secondRow = page.locator(`#conv-list .conv-item[data-conversation-id="${second}"]`);
    const box = await secondRow.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await touchHold(cdp, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2), 800);
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".context-menu")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/\bsidebar-collapsed\b/);

    // A tap opens the session, collapses the list, and raises no keyboard.
    await secondRow.tap();
    await expect(page).toHaveURL(new RegExp(`conv=${second}`));
    await expect(page.locator("body")).toHaveClass(/\bsidebar-collapsed\b/);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.activeElement?.id || "")).not.toBe("msg-input");

    // Typing mode: the message box focused and the keyboard's resize.
    await expect(page.locator("#background-tasks-panel")).toBeVisible();
    await page.locator("#msg-input").focus();
    await page.setViewportSize({ width: SCREEN.width, height: 190 });
    await expect(page.locator("body")).toHaveClass(/\bphone-typing\b/);
    await expect(page.locator("#composer-label-row #composer-settings-label")).toBeHidden();
    await expect(page.locator("#background-tasks-panel")).toBeHidden();
    const gear = page.locator("#composer-float-settings");
    const robot = page.locator("#background-tasks-float");
    await expect(gear).toBeVisible();
    await expect(robot).toBeVisible();

    // The floats sit above the composer, clear of Send and the message box.
    const geometry = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      return { gear: rect("composer-float-settings"), robot: rect("background-tasks-float"), input: rect("msg-input"), send: rect("send-btn"), area: rect("input-area") };
    });
    for (const float of [geometry.gear, geometry.robot]) {
      expect(float.bottom).toBeLessThanOrEqual(geometry.area.top + 0.5);
      expect(float.width).toBeLessThanOrEqual(32);
    }

    // The ⚙ opens the panel; the message box keeps the focus.
    await gear.tap();
    await expect(page.locator("#composer-settings")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.id || "")).toBe("msg-input");
    await gear.tap();
    await expect(page.locator("#composer-settings")).toBeHidden();

    // The 🤖 shows the task panel over the composer; a second tap hides it.
    await robot.tap();
    await expect(page.locator("#background-tasks-panel")).toBeVisible();
    const overlay = await page.locator("#background-tasks-panel").evaluate((el) => el.getBoundingClientRect().bottom);
    expect(overlay).toBeLessThanOrEqual(geometry.area.top + 0.5);
    await robot.tap();
    await expect(page.locator("#background-tasks-panel")).toBeHidden();

    // The keyboard going down brings everything back.
    await page.setViewportSize(SCREEN);
    await expect(page.locator("body")).not.toHaveClass(/\bphone-typing\b/);
    await expect(page.locator("#composer-settings-label")).toBeVisible();
    await expect(page.locator("#background-tasks-panel")).toBeVisible();
    await expect(gear).toBeHidden();
  } finally {
    for (const id of ids.filter(Boolean)) {
      await request.post("/api/background-tasks", { headers, data: { conversationId: id, tasks: [] } }).catch(() => {});
      await request.delete(`/api/conversation/${encodeURIComponent(id)}`, { headers }).catch(() => {});
    }
  }
});
