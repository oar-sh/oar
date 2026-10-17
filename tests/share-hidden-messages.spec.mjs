import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

/**
 * The 🙈 list of messages hidden from shared viewers, against the shared e2e
 * relay.
 *
 * One turn is seeded through the API; thirty older messages are written
 * straight into the test relay's database, so one hidden message sits far
 * outside the loaded page.
 *
 * Hide from the bubble shows the button with its count, a second device
 * follows without a reload, a message hidden elsewhere counts although it is
 * not on the page, a row jumps to it, Unhide in the list drops the count,
 * the shared view knows nothing of the list, and Unhide all (after its
 * confirmation) takes the button away on both devices.
 */

async function seedTurn(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok(), `POST /api/message answered ${queued.status()}`).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "").trim();
  const userId = String(body?.messageId || "").trim();
  expect(conversationId).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId: userId, conversationId, text: `${text} reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  const loaded = await request.get(`/api/conversation/${conversationId}`, { headers });
  const replyId = String((await loaded.json()).messages.find((message) => message.role === "assistant")?.id || "");
  expect(replyId).toBeTruthy();
  return { conversationId, userId, replyId };
}

// Older than the seeded turn by an hour, so they sort before it.
function insertOlderMessages(conversationId, stamp, pairs = 15) {
  const db = new DatabaseSync(relayDbPath(), { timeout: 5_000 });
  try {
    const insert = db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)`);
    const base = Date.now() - 3_600_000;
    const ids = [];
    for (let index = 0; index < pairs; index += 1) {
      const number = String(index + 1).padStart(2, "0");
      const userId = `hide-old-${stamp}-u${number}`;
      const replyId = `hide-old-${stamp}-a${number}`;
      insert.run(userId, conversationId, "user", `Old question ${number} about the report builder`, new Date(base + index * 2000).toISOString());
      insert.run(replyId, conversationId, "assistant", `Old answer ${number} about the report builder`, new Date(base + index * 2000 + 1000).toISOString());
      ids.push(userId, replyId);
    }
    return ids;
  } finally {
    db.close();
  }
}

async function setHidden(request, headers, conversationId, messageId, hiddenFromShares) {
  const response = await request.patch(`/api/conversation/${conversationId}/message/${messageId}/share-visibility`, {
    headers,
    data: { hiddenFromShares },
  });
  expect(response.ok(), `PATCH share-visibility answered ${response.status()}`).toBeTruthy();
  return response.json();
}

async function openConversationPage(page, token, conversationId) {
  await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator(".msg").first()).toBeVisible();
  // Only the socket's connect handler turns the dot green: from here on this
  // page receives the broadcasts.
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

const bubble = (page, messageId) => page.locator(`#messages .msg[data-message-id="${messageId}"]`);
const hiddenButton = (page) => page.locator("#hidden-messages-btn");
const hiddenCount = (page) => hiddenButton(page).locator(".header-icon-count");
const modal = (page) => page.locator("#summary-modal");

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`hidden-messages list on a ${profile.name} viewport`, () => {
    test.use(profile.use);

    test("hide, follow on a second device, list, jump, unhide, nothing in the shared view, unhide all", async ({ page, request, browser }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const { conversationId, replyId } = await seedTurn(request, headers, `Hide the staging notes ${stamp}`);
      const olderIds = insertOlderMessages(conversationId, stamp);
      const oldestId = olderIds[0];
      const second = await browser.newContext();

      try {
        await openConversationPage(page, token, conversationId);
        const secondPage = await second.newPage();
        await openConversationPage(secondPage, token, conversationId);

        // Nothing hidden: no button. The oldest message is outside the loaded page.
        await expect(hiddenButton(page)).toBeHidden();
        await expect(bubble(page, oldestId)).toHaveCount(0);

        // Hide from the bubble: the button appears, with its count.
        const reply = bubble(page, replyId);
        const replyHide = reply.locator(".msg-share-visibility-btn");
        if (profile.touch) await reply.locator(".msg-bubble").tap();
        else await reply.locator(".msg-bubble").hover();
        await expect(replyHide).toHaveCSS("opacity", "1");
        const hiding = page.waitForResponse((response) => response.url().includes(`/message/${replyId}/share-visibility`));
        if (profile.touch) await replyHide.tap(); else await replyHide.click();
        expect((await hiding).status()).toBe(200);
        await expect(reply.locator(".msg-hidden-label")).toHaveText("Hidden from shared viewers");
        await expect(hiddenButton(page)).toBeVisible();
        await expect(hiddenCount(page)).toHaveText("1");

        // The other device learns of it by socket, without a reload: count and bubble.
        await expect(hiddenCount(secondPage)).toHaveText("1");
        await expect(bubble(secondPage, replyId).locator(".msg-hidden-label")).toHaveText("Hidden from shared viewers");
        await expect(bubble(secondPage, replyId).locator(".msg-share-visibility-btn")).toHaveText("Unhide");

        // Hidden elsewhere (here: through the API), not on the page: still counted.
        await setHidden(request, headers, conversationId, oldestId, true);
        await expect(hiddenCount(page)).toHaveText("2");
        await expect(hiddenCount(secondPage)).toHaveText("2");

        // The list: conversation order, role and preview, Unhide per row.
        await hiddenButton(page).click();
        await expect(modal(page)).toHaveClass(/visible/);
        await expect(page.locator("#summary-modal-title")).toHaveText("🙈 Hidden messages");
        await expect(page.locator("#summary-modal-subtitle")).toHaveText("2 hidden from shared viewers");
        const rows = modal(page).locator(".pinned-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0).locator(".pinned-row-meta")).toContainText("You");
        await expect(rows.nth(0).locator(".pinned-row-preview")).toHaveText("Old question 01 about the report builder");
        await expect(rows.nth(1).locator(".pinned-row-meta")).toContainText("Agent");
        await expect(rows.nth(1).locator(".pinned-row-preview")).toContainText(`Hide the staging notes ${stamp} reply`);
        const unhideBox = await rows.nth(0).locator(".hidden-row-unhide").boundingBox();
        expect(unhideBox.height).toBeGreaterThanOrEqual(44);
        if (profile.touch) {
          const titleBox = await page.locator("#summary-modal-title").boundingBox();
          expect(titleBox.width).toBeGreaterThan(100);
        }

        // A row closes the list and brings the message into view, thirty
        // messages above the loaded page.
        await rows.nth(0).locator(".pinned-row-jump").click();
        await expect(modal(page)).not.toHaveClass(/visible/);
        await expect(bubble(page, oldestId)).toBeInViewport();
        await expect(bubble(page, oldestId).locator(".msg-hidden-label")).toHaveText("Hidden from shared viewers");

        // Unhide in the list: the row goes, the list stays open, the count drops,
        // the bubble offers Hide again, the other device follows.
        await hiddenButton(page).click();
        const unhiding = page.waitForResponse((response) => response.url().includes(`/message/${oldestId}/share-visibility`));
        await rows.nth(0).locator(".hidden-row-unhide").click();
        expect((await unhiding).status()).toBe(200);
        await expect(rows).toHaveCount(1);
        await expect(modal(page)).toHaveClass(/visible/);
        await expect(page.locator("#summary-modal-subtitle")).toHaveText("1 hidden from shared viewers");
        await expect(hiddenCount(page)).toHaveText("1");
        await expect(bubble(page, oldestId).locator(".msg-hidden-label")).toHaveCount(0);
        await expect(bubble(page, oldestId).locator(".msg-share-visibility-btn")).toHaveText("Hide");
        await expect(hiddenCount(secondPage)).toHaveText("1");
        await page.locator("#summary-modal .summary-close").click();

        // The shared view: neither the API nor the page carries the list.
        const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
        expect(share.ok()).toBeTruthy();
        const shareToken = String((await share.json())?.token || "");
        expect(shareToken).toBeTruthy();
        const sharedContext = await browser.newContext();
        try {
          const sharedApi = await sharedContext.request.get(`/api/shared/${shareToken}`);
          expect(sharedApi.ok()).toBeTruthy();
          const sharedBody = await sharedApi.json();
          expect("hiddenMessages" in sharedBody).toBe(false);
          expect(sharedBody.messages.some((message) => message.id === replyId)).toBe(false);
          const sharedPage = await sharedContext.newPage();
          await sharedPage.goto(`/shared/${shareToken}`);
          await expect(sharedPage.locator("#messages .msg").first()).toBeVisible();
          await expect(sharedPage.locator("#hidden-messages-btn")).toBeHidden();
        } finally {
          await sharedContext.close();
        }

        // Unhide all asks first; Cancel changes nothing.
        await setHidden(request, headers, conversationId, olderIds[1], true);
        await expect(hiddenCount(page)).toHaveText("2");
        await hiddenButton(page).click();
        await modal(page).locator("[data-hidden-unhide-all]").click();
        await expect(modal(page).locator(".hidden-unhide-all-confirm")).toContainText("Show all 2 messages to shared viewers again?");
        await modal(page).locator("[data-hidden-unhide-all-cancel]").click();
        await expect(modal(page).locator(".hidden-unhide-all-confirm")).toHaveCount(0);
        await expect(rows).toHaveCount(2);

        // Confirmed: the last ones go, and the button with them, on both devices.
        await modal(page).locator("[data-hidden-unhide-all]").click();
        const unhidingAll = page.waitForResponse((response) => response.url().includes(`/conversation/${conversationId}/share-visibility/unhide-all`));
        await modal(page).locator("[data-hidden-unhide-all-confirm]").click();
        expect((await unhidingAll).status()).toBe(200);
        await expect(modal(page).locator(".pinned-empty")).toContainText("No hidden messages.");
        await expect(hiddenButton(page)).toBeHidden();
        await expect(hiddenButton(secondPage)).toBeHidden();
        await expect(bubble(page, replyId).locator(".msg-hidden-label")).toHaveCount(0);
        await expect(bubble(secondPage, replyId).locator(".msg-share-visibility-btn")).toHaveText("Hide");
      } finally {
        await second.close();
        await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
    });
  });
}
