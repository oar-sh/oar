import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * Share management, against the shared e2e relay.
 *
 * Settings → Sharing lists a shared conversation with its counts and access
 * log; Renew link gives it a new link (an open shared page stops, the old link
 * is a 404, the log carries over); the IP setting keeps the address out of new
 * entries and offers to remove the ones stored before (No keeps them, Yes
 * removes them and keeps the viewer counts); Stop sharing ends it. The ⋯ menu shows "Stop sharing" only while
 * the open conversation has a link, and asks before it stops it.
 *
 * Other specs share conversations on the same relay, so the list is only
 * ever checked for this spec's own rows.
 */

function authHeaders() {
  return { Authorization: `Bearer ${relayToken()}` };
}

async function seedConversation(request, title) {
  const headers = authHeaders();
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `${title}: first question`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok(), `POST /api/message answered ${queued.status()}`).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "").trim();
  expect(conversationId).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId: String(body.messageId), conversationId, text: `${title}: first answer`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  const renamed = await request.patch(`/api/conversation/${conversationId}`, { headers, data: { title } });
  expect(renamed.ok()).toBeTruthy();
  return conversationId;
}

async function createShare(request, conversationId) {
  const response = await request.post(`/api/conversation/${conversationId}/share`, { headers: authHeaders() });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function listShares(request) {
  const response = await request.get("/api/shares", { headers: authHeaders() });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function shareOf(request, conversationId) {
  return (await listShares(request)).shares.find((entry) => entry.conversationId === conversationId) || null;
}

async function openApp(page, conversationId = null) {
  if (conversationId) {
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
  }
  await page.goto(`/?token=${encodeURIComponent(relayToken())}`);
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  // The socket's connect handler reads the share list; from here on the page
  // gets the share events.
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

// Every reader here comes from the same address; a browser of its own makes
// it a viewer of its own (and keeps its open apart from the first one's).
async function openSharedPage(browser, path, userAgent = "") {
  const context = await browser.newContext(userAgent ? { userAgent } : {});
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator("#messages .msg").first()).toBeVisible();
  return { context, page };
}

async function storedIpCount(request) {
  const response = await request.get("/api/settings/shares/stored-viewer-ips", { headers: authHeaders() });
  expect(response.ok()).toBeTruthy();
  return Number((await response.json()).count);
}

function shareRow(page, conversationId) {
  return page.locator(`#settings-shares-list .share-row[data-conversation-id="${conversationId}"]`);
}

async function confirmSummary(page, confirmId) {
  const button = page.locator(`#${confirmId}`);
  await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
  await button.click();
  await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
}

test.describe("share management", () => {
  test("Settings → Sharing lists, logs, renews and stops a share", async ({ page, request, browser }) => {
    const conversationId = await seedConversation(request, "Report builder sharing");
    let restoreIp = false;
    try {
      const { path: firstPath, token: firstToken } = await createShare(request, conversationId);
      const reader = await openSharedPage(browser, firstPath);
      try {
        await openApp(page);
        await page.evaluate(() => window.openSettingsModal("shares"));
        await expect(page.locator("#settings-panel-shares")).toBeVisible();
        const row = shareRow(page, conversationId);
        await expect(row.locator(".share-row-title")).toHaveText("Report builder sharing");
        await expect(row.locator(".share-row-detail")).toContainText("1 open · 1 viewer");
        await expect(page.locator("#settings-shares-empty")).toBeHidden();

        // The access log: one entry, with the reader's browser.
        await row.locator(".share-log-toggle").click();
        await expect(row.locator(".share-open")).toHaveCount(1);
        await expect(row.locator(".share-open-agent")).toContainText("Mozilla");
        // A second reader shows up live.
        const second = await openSharedPage(browser, firstPath, "Mozilla/5.0 FixtureReader/2.0");
        await second.context.close();
        await expect(row.locator(".share-row-detail")).toContainText("2 opens · 2 viewers");
        await expect(row.locator(".share-open")).toHaveCount(2);

        // Renew: the open page stops at its next poll, the old link is a 404,
        // the log carries over.
        await row.locator(".share-renew").click();
        await confirmSummary(page, "share-renew-confirm");
        await expect.poll(async () => (await shareOf(request, conversationId))?.token).not.toBe(firstToken);
        await expect(reader.page.locator("#model-banner")).toHaveText("This shared conversation is not available.");
        await expect(reader.page.locator("#messages .msg")).toHaveCount(0);
        expect((await request.get(firstPath)).status()).toBe(404);
        expect((await request.get(`/api/shared/${firstToken}`)).status()).toBe(404);
        await expect(row.locator(".share-row-detail")).toContainText("new link");
        await expect(row.locator(".share-row-detail")).toContainText("2 opens");

        // IP storage off: the next entry keeps no address.
        const toggle = page.locator("#settings-shares-store-ip");
        await expect(toggle).toBeChecked();
        restoreIp = true;
        await toggle.uncheck();
        await expect(page.locator("#settings-shares-status")).toHaveText("New log entries keep no IP address.");
        expect((await listShares(request)).storeViewerIp).toBe(false);
        // The addresses stored before: asked about, and No keeps them.
        await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
        await expect(page.locator("#summary-modal-body")).toContainText(/Also remove the \d+ IP address(es)? already stored\?/);
        await page.locator("#summary-modal-body [data-share-confirm-cancel]").click();
        await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
        expect((await storedIpCount(request))).toBeGreaterThan(0);
        await expect(row.locator(".share-open-meta").first()).not.toContainText("IP not stored");
        const renewedPath = (await shareOf(request, conversationId)).path;
        const third = await openSharedPage(browser, renewedPath, "Mozilla/5.0 FixtureReader/3.0");
        await third.context.close();
        await expect(row.locator(".share-open")).toHaveCount(3);
        await expect(row.locator(".share-open-meta").first()).toContainText("IP not stored");
        await toggle.check();
        await expect(page.locator("#settings-shares-status")).toHaveText("New log entries keep the viewer's IP address.");
        restoreIp = false;

        // Stop sharing: the row goes, the link is a 404, the log is gone.
        await row.locator(".share-stop").click();
        await expect(page.locator("#summary-modal-body")).toContainText("its access log is deleted");
        await confirmSummary(page, "share-stop-confirm");
        await expect(row).toHaveCount(0);
        expect(await shareOf(request, conversationId)).toBeNull();
        expect((await request.get(renewedPath)).status()).toBe(404);
        expect((await request.get(`/api/conversation/${conversationId}/share/opens`, { headers: authHeaders() })).status()).toBe(404);
      } finally {
        await reader.context.close();
      }
    } finally {
      if (restoreIp) {
        await request.post("/api/settings/shares", { headers: authHeaders(), data: { storeViewerIp: true } }).catch(() => {});
      }
      await request.delete(`/api/conversation/${conversationId}`, { headers: authHeaders() }).catch(() => {});
    }
  });

  test("switching IP storage off can remove the addresses stored before, and the viewers still count", async ({ page, request, browser }) => {
    const conversationId = await seedConversation(request, "Report builder addresses");
    try {
      const { path } = await createShare(request, conversationId);
      const reader = await openSharedPage(browser, path);
      await reader.context.close();
      await openApp(page);
      await page.evaluate(() => window.openSettingsModal("shares"));
      const row = shareRow(page, conversationId);
      await expect(row.locator(".share-row-detail")).toContainText("1 open · 1 viewer");
      await row.locator(".share-log-toggle").click();
      await expect(row.locator(".share-open")).toHaveCount(1);
      await expect(row.locator(".share-open-meta").first()).not.toContainText("IP not stored");

      const count = await storedIpCount(request);
      expect(count).toBeGreaterThan(0);
      await page.locator("#settings-shares-store-ip").uncheck();
      await expect(page.locator("#summary-modal-body")).toContainText(`Also remove the ${count} IP address${count === 1 ? "" : "es"} already stored?`);
      await confirmSummary(page, "share-forget-ips-confirm");
      await expect(page.locator("#settings-shares-status")).toContainText("the stored ones are removed");
      expect(await storedIpCount(request)).toBe(0);
      await expect(row.locator(".share-open-meta").first()).toContainText("IP not stored");
      await expect(row.locator(".share-row-detail")).toContainText("1 open · 1 viewer");
      const events = await request.get("/api/status/events?limit=100", { headers: authHeaders() });
      const shared = (await events.json()).items.filter((item) => item.type === "shared-access-opened");
      expect(shared.every((item) => !item.details?.viewerIp)).toBe(true);

      // With nothing stored, switching off again asks nothing.
      await page.locator("#settings-shares-store-ip").check();
      await expect(page.locator("#settings-shares-status")).toHaveText("New log entries keep the viewer's IP address.");
      await page.locator("#settings-shares-store-ip").uncheck();
      await expect(page.locator("#settings-shares-status")).toHaveText("New log entries keep no IP address.");
      await page.waitForTimeout(500);
      await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
    } finally {
      await request.post("/api/settings/shares", { headers: authHeaders(), data: { storeViewerIp: true } }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers: authHeaders() }).catch(() => {});
    }
  });

  for (const profile of [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
  ]) {
    test.describe(`the ⋯ menu on a ${profile.name} viewport`, () => {
      test.use(profile.use);

      test("Stop sharing shows only for a shared conversation and asks first", async ({ page, request, browser }) => {
        const conversationId = await seedConversation(request, `Export feature menu ${profile.name}`);
        const press = (locator) => (profile.touch ? locator.tap() : locator.click());
        const openMenu = async () => {
          await press(page.locator("#chat-actions-menu-btn"));
          await expect(page.locator("#chat-actions-menu")).toBeVisible();
        };
        try {
          await openApp(page, conversationId);
          await expect(page.locator("#chat-title")).toHaveText(`Export feature menu ${profile.name}`);
          await openMenu();
          await expect(page.locator("#chat-menu-share-conversation")).toBeVisible();
          await expect(page.locator("#chat-menu-stop-sharing")).toBeHidden();
          await page.keyboard.press("Escape");

          // Shared from elsewhere: the menu follows the relay's event.
          const { path } = await createShare(request, conversationId);
          const reader = await openSharedPage(browser, path);
          try {
            await expect.poll(() => page.evaluate(() => !document.getElementById("chat-menu-stop-sharing").hidden)).toBe(true);
            await openMenu();
            await expect(page.locator("#chat-menu-stop-sharing")).toBeVisible();
            await press(page.locator("#chat-menu-stop-sharing"));
            await expect(page.locator("#summary-modal-body")).toContainText(`Export feature menu ${profile.name}`);
            // Cancel keeps the link.
            await press(page.locator("#summary-modal-body [data-share-confirm-cancel]"));
            await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
            expect(await shareOf(request, conversationId)).not.toBeNull();

            await openMenu();
            await press(page.locator("#chat-menu-stop-sharing"));
            await press(page.locator("#share-stop-confirm"));
            await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
            await expect.poll(() => shareOf(request, conversationId)).toBeNull();
            await expect(reader.page.locator("#model-banner")).toHaveText("This shared conversation is not available.");
            expect((await request.get(path)).status()).toBe(404);
            await openMenu();
            await expect(page.locator("#chat-menu-stop-sharing")).toBeHidden();
          } finally {
            await reader.context.close();
          }
        } finally {
          await request.delete(`/api/conversation/${conversationId}`, { headers: authHeaders() }).catch(() => {});
        }
      });
    });
  }
});
