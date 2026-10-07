import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

/**
 * Pinned messages, against the shared e2e relay.
 *
 * One turn is seeded through the API; thirty older messages are written
 * straight into the test relay's database, because a history longer than one
 * page cannot be seeded through the API inside the prompt limit of a test run.
 *
 * The page pins the newest reply from its bubble, a second device follows
 * without a reload, the 📍 list shows the pins in conversation order, a row
 * jumps to a message far outside the loaded history, 🗑 unpins, a reload
 * keeps the state, and the shared view knows nothing of any of it.
 *
 * The last test jumps while a turn is running: neither the live poll nor the
 * refresh at the end of the turn may put the end of the conversation back
 * over the window that was jumped to.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      const userId = `pin-old-${stamp}-u${number}`;
      const replyId = `pin-old-${stamp}-a${number}`;
      insert.run(userId, conversationId, "user", `Old question ${number} of the long history`, new Date(base + index * 2000).toISOString());
      insert.run(replyId, conversationId, "assistant", `Old answer ${number} of the long history`, new Date(base + index * 2000 + 1000).toISOString());
      ids.push(userId, replyId);
    }
    return ids;
  } finally {
    db.close();
  }
}

async function setPin(request, headers, conversationId, messageId, pinned) {
  const response = await request.patch(`/api/conversation/${conversationId}/message/${messageId}/pin`, {
    headers,
    data: { pinned },
  });
  expect(response.ok(), `PATCH pin answered ${response.status()}`).toBeTruthy();
  return response.json();
}

async function openConversationPage(page, token, conversationId) {
  await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator(".msg").first()).toBeVisible();
  // Only the socket's connect handler turns the dot green: from here on this
  // page receives the pin broadcasts.
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders }).catch(() => null);
    if (dequeued?.ok()) {
      const message = (await dequeued.json())?.message || null;
      if (message && String(message.id) === messageId) return;
      if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    }
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

const bubble = (page, messageId) => page.locator(`#messages .msg[data-message-id="${messageId}"]`);
const pinButton = (page) => page.locator("#pinned-messages-btn");
const pinModal = (page) => page.locator("#summary-modal");

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe(`pinned messages on a ${profile.name} viewport`, () => {
    test.use(profile.use);

    test("pin from the bubble, follow on a second device, list, jump, unpin, and nothing in the shared view", async ({ page, request, browser }) => {
      const token = relayToken();
      const headers = { Authorization: `Bearer ${token}` };
      const stamp = `${profile.name}-${Date.now()}`;
      const { conversationId, replyId } = await seedTurn(request, headers, `Pin the build notes ${stamp}`);
      const olderIds = insertOlderMessages(conversationId, stamp);
      const oldestId = olderIds[0];
      const second = await browser.newContext();

      try {
        await openConversationPage(page, token, conversationId);
        const secondPage = await second.newPage();
        await openConversationPage(secondPage, token, conversationId);

        // No pins yet: no button. The oldest message is outside the loaded page.
        await expect(pinButton(page)).toBeHidden();
        await expect(bubble(page, oldestId)).toHaveCount(0);

        // Pin is revealed like Hide: on hover, or on a phone by a tap on the bubble.
        const reply = bubble(page, replyId);
        const replyPin = reply.locator(".msg-pin-btn");
        await expect(replyPin).toHaveText("Pin");
        await expect(replyPin).toHaveCSS("opacity", "0");
        if (profile.touch) {
          await reply.locator(".msg-bubble").tap();
        } else {
          await reply.locator(".msg-bubble").hover();
        }
        await expect(replyPin).toHaveCSS("opacity", "1");
        const pinning = page.waitForResponse((response) => response.url().includes(`/message/${replyId}/pin`));
        if (profile.touch) await replyPin.tap(); else await replyPin.click();
        expect((await pinning).status()).toBe(200);

        // A pinned message keeps its label and Unpin in view; the count appears.
        await expect(reply.locator(".msg-pinned-label")).toHaveText("📍 Pinned");
        await expect(replyPin).toHaveText("Unpin");
        await page.mouse.move(2, 2);
        await expect(replyPin).toHaveCSS("opacity", "1");
        await expect(pinButton(page)).toBeVisible();
        await expect(pinButton(page).locator(".header-icon-count")).toHaveText("1");

        // The other device learns of it by socket, without a reload.
        await expect(pinButton(secondPage).locator(".header-icon-count")).toHaveText("1");
        await expect(bubble(secondPage, replyId).locator(".msg-pinned-label")).toHaveText("📍 Pinned");

        // A pin set elsewhere (here: through the API) arrives the same way.
        await setPin(request, headers, conversationId, oldestId, true);
        await expect(pinButton(page).locator(".header-icon-count")).toHaveText("2");

        // The list: conversation order, role and preview, a trash per row.
        await pinButton(page).click();
        await expect(pinModal(page)).toHaveClass(/visible/);
        await expect(page.locator("#summary-modal-title")).toHaveText("📍 Pinned messages");
        await expect(page.locator("#summary-modal-subtitle")).toHaveText("2 pinned");
        const rows = pinModal(page).locator(".pinned-row");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0).locator(".pinned-row-meta")).toContainText("You");
        await expect(rows.nth(0).locator(".pinned-row-preview")).toHaveText("Old question 01 of the long history");
        await expect(rows.nth(1).locator(".pinned-row-meta")).toContainText("Agent");
        await expect(rows.nth(1).locator(".pinned-row-preview")).toContainText(`Pin the build notes ${stamp} reply`);
        const unpinBox = await rows.nth(0).locator(".pinned-row-unpin").boundingBox();
        expect(unpinBox.width).toBeGreaterThanOrEqual(44);
        expect(unpinBox.height).toBeGreaterThanOrEqual(44);
        if (profile.touch) {
          // The modal is a near-full-screen card on a phone, and its title has room.
          const dialogBox = await pinModal(page).locator(".summary-dialog").boundingBox();
          expect(dialogBox.width).toBeGreaterThanOrEqual(page.viewportSize().width - 20);
          const titleBox = await page.locator("#summary-modal-title").boundingBox();
          expect(titleBox.width).toBeGreaterThan(100);
        }

        // A row closes the list and brings the message into view, although it
        // was thirty messages above the loaded page.
        await rows.nth(0).locator(".pinned-row-jump").click();
        await expect(pinModal(page)).not.toHaveClass(/visible/);
        await expect(bubble(page, oldestId)).toHaveClass(/msg-search-target/);
        await expect(bubble(page, oldestId)).toBeInViewport();
        await expect(bubble(page, oldestId).locator(".msg-pinned-label")).toHaveText("📍 Pinned");

        // Escape closes the list like every other use of this modal.
        await pinButton(page).click();
        await expect(pinModal(page)).toHaveClass(/visible/);
        await page.keyboard.press("Escape");
        await expect(pinModal(page)).not.toHaveClass(/visible/);

        // 🗑 unpins: the row goes, the list stays open, the bubble offers Pin again.
        await pinButton(page).click();
        const unpinning = page.waitForResponse((response) => response.url().includes(`/message/${oldestId}/pin`));
        await rows.nth(0).locator(".pinned-row-unpin").click();
        expect((await unpinning).status()).toBe(200);
        await expect(rows).toHaveCount(1);
        await expect(pinModal(page)).toHaveClass(/visible/);
        await expect(page.locator("#summary-modal-subtitle")).toHaveText("1 pinned");
        await expect(pinButton(page).locator(".header-icon-count")).toHaveText("1");
        await expect(bubble(page, oldestId).locator(".msg-pin-btn")).toHaveText("Pin");
        await expect(bubble(page, oldestId).locator(".msg-pinned-label")).toHaveCount(0);
        await expect(pinButton(secondPage).locator(".header-icon-count")).toHaveText("1");
        await page.locator("#summary-modal .summary-close").click();

        // A reload finds the pin where it was.
        await page.reload();
        await expect(bubble(page, replyId).locator(".msg-pinned-label")).toHaveText("📍 Pinned");
        await expect(pinButton(page).locator(".header-icon-count")).toHaveText("1");

        // The shared view: neither the API nor the page says anything of pins.
        const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
        expect(share.ok()).toBeTruthy();
        const shareToken = String((await share.json())?.token || "");
        expect(shareToken).toBeTruthy();
        const sharedContext = await browser.newContext();
        try {
          const sharedApi = await sharedContext.request.get(`/api/shared/${shareToken}`);
          expect(sharedApi.ok()).toBeTruthy();
          const sharedBody = await sharedApi.json();
          expect(sharedBody.messages.length).toBeGreaterThan(0);
          expect(JSON.stringify(sharedBody)).not.toMatch(/pinned|"pins"/i);
          const sharedPage = await sharedContext.newPage();
          await sharedPage.goto(`/shared/${shareToken}`);
          await expect(sharedPage.locator(`#messages .msg[data-message-id="${replyId}"]`)).toBeVisible();
          await expect(sharedPage.locator(".msg-pin-btn")).toHaveCount(0);
          await expect(sharedPage.locator(".msg-pinned-label")).toHaveCount(0);
          await expect(sharedPage.locator("#pinned-messages-btn")).toBeHidden();
        } finally {
          await sharedContext.close();
        }

        // Unpin from the bubble: the last pin gone, the button with it.
        const lastUnpin = page.waitForResponse((response) => response.url().includes(`/message/${replyId}/pin`));
        if (profile.touch) await bubble(page, replyId).locator(".msg-pin-btn").tap();
        else await bubble(page, replyId).locator(".msg-pin-btn").click();
        expect((await lastUnpin).status()).toBe(200);
        await expect(pinButton(page)).toBeHidden();
        await expect(pinButton(secondPage)).toBeHidden();
      } finally {
        await second.close();
        await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
    });
  });
}

test("a jump to a pinned message holds while a turn is running", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = `running-${Date.now()}`;
  let conversationId = "";
  let runningId = "";

  try {
    // The spec is the worker: it takes the turn and leaves it running.
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Keep working ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok(), `POST /api/message answered ${queued.status()}`).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    runningId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, runningId, String(queuedBody?.ownerSessionId || ""));
    // Sixty older messages: the window around the oldest one ends well before
    // the end of the conversation.
    const oldestId = insertOlderMessages(conversationId, stamp, 30)[0];
    await setPin(request, headers, conversationId, oldestId, true);

    await openConversationPage(page, token, conversationId);
    await expect(page.locator("#thinking-indicator")).toBeVisible();
    await expect(bubble(page, oldestId)).toHaveCount(0);

    await pinButton(page).click();
    await pinModal(page).locator(".pinned-row-jump").first().click();
    await expect(bubble(page, oldestId)).toBeInViewport();

    // The live poll comes round every 900 ms while a turn runs. It must not
    // put the end of the conversation back over the window just jumped to.
    await page.waitForTimeout(3_000);
    await expect(bubble(page, oldestId)).toBeInViewport();

    // The turn ends and the page refreshes itself: the window still stays.
    const finished = await request.post("/api/response", {
      headers,
      data: { messageId: runningId, conversationId, text: "Done.", model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(finished.ok()).toBeTruthy();
    runningId = "";
    await expect(page.locator("#thinking-indicator")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(bubble(page, oldestId)).toBeInViewport();
    await expect(pinButton(page).locator(".header-icon-count")).toHaveText("1");
  } finally {
    if (runningId) {
      await request.post("/api/response", {
        headers,
        data: { messageId: runningId, conversationId, text: "Done.", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
  }
});
