import { expect, test, devices } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A turn paused at the Claude usage limit, as the phone shows it: the banner
// above the composer with Resume now and Cancel. The isolated relay runs no
// Claude worker, so the pause is put into what the relay answers; the relay's
// own side is covered by claude-usage-limit.routes-integration.test.mjs.

const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"];
test.use({ ...pixel });

test("a paused turn shows when it carries on, and Resume now asks the relay to send it", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `usage-limit-banner-${Date.now()}`, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    conversationId = String((await queued.json())?.conversationId || "");

    const resumeAt = new Date(Date.now() + 61 * 60 * 1000).toISOString();
    let pause = {
      conversationId,
      messageId: "held-follow-up-1",
      rateLimitType: "five_hour",
      label: "5-hour limit",
      resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      resumeAt,
      auto: true,
      pausedAt: new Date().toISOString(),
    };
    const withPause = async (route, patch) => {
      const response = await route.fetch();
      let body = null;
      try { body = await response.json(); } catch {}
      if (!body || typeof body !== "object") return route.fulfill({ response });
      return route.fulfill({ response, json: patch(body) });
    };
    await page.route(`**/api/conversation/${conversationId}*`, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return withPause(route, (body) => ({ ...body, usageLimitPause: pause }));
    });
    await page.route("**/api/status*", (route) => withPause(route, (body) => ({
      ...body,
      usageLimit: { account: null, pauses: pause ? [pause] : [] },
    })));
    const resumeRequests = [];
    await page.route("**/api/usage-limit/resume", async (route) => {
      resumeRequests.push(route.request().postDataJSON());
      pause = null;
      await route.fulfill({ json: { ok: true, resumed: true, messageId: "held-follow-up-1", pause: null } });
    });

    await page.addInitScript((id) => localStorage.setItem("copilot_last_conv", id), conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const banner = page.locator("#usage-limit-banner");
    await expect(banner).toBeVisible();
    // The clock time alone today, with the day in front after midnight.
    const clock = await page.evaluate((iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), resumeAt);
    const text = banner.locator(".usage-limit-text");
    await expect(text).toContainText("⏸ Paused at the Claude 5-hour limit — carries on at ");
    await expect(text).toContainText(clock);
    await expect(banner.locator("button")).toHaveText(["Resume now", "Cancel"]);

    // On a phone the banner stays inside the screen and leaves the composer on it.
    const layout = await page.evaluate(() => {
      const rect = document.getElementById("usage-limit-banner").getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        left: rect.left,
        right: rect.right,
        bannerBottom: rect.bottom,
        composerTop: document.getElementById("msg-input").getBoundingClientRect().top,
        sendBottom: document.getElementById("send-btn").getBoundingClientRect().bottom,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.bannerBottom).toBeLessThanOrEqual(layout.composerTop + 1);
    expect(layout.sendBottom).toBeLessThanOrEqual(layout.viewportHeight);

    await banner.locator("button", { hasText: "Resume now" }).click();
    await expect.poll(() => resumeRequests.length).toBe(1);
    expect(resumeRequests[0]).toEqual({ conversationId });
    await expect(banner).toBeHidden();
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${encodeURIComponent(conversationId)}`, { headers }).catch(() => {});
    }
  }
});
