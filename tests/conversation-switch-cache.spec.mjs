import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

/**
 * Switching back to a conversation already viewed on the page draws it at
 * once from what the page kept of it; the fresh answer replaces it when it
 * arrives. Here that answer is held by a page route, as a slow relay holds
 * it: the conversation's newest message must be on the page while it waits,
 * and the reply written meanwhile must appear once it is let through.
 *
 * The isolated server runs no CLI, so the turns are dequeued rows answered by
 * the spec in the worker's place.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId = "") {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(response.ok()).toBeTruthy();
    const message = (await response.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(150);
  }
  throw new Error("the queued message was never handed out");
}

// A session-bound conversation with a finished first turn.
async function seedConversation(request, headers, title, stamp) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `${title} ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  expect(conversationId).toBeTruthy();
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  const synced = await request.post("/api/session-sync", {
    headers,
    data: { sdk_session_id: `pw-sid-cache-${stamp}-${conversationId.slice(0, 8)}`, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `${title} first reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  return { conversationId, title: `${title} ${stamp}` };
}

// One more finished turn: a message and its reply.
async function addTurn(request, headers, conversationId, text, reply) {
  const queued = await request.post("/api/message", {
    headers,
    data: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const { messageId } = await queued.json();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: reply, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
}

// Holds the answer of the next transcript read of the conversation until
// release(): the request reaches the relay, its answer waits.
async function holdNextConversationRead(page, conversationId) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let read = () => {};
  const wasRead = new Promise((resolve) => { read = resolve; });
  const state = { held: false, released: false };
  let armed = true;
  await page.route(`**/api/conversation/${conversationId}?*`, async (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get("limit") || 0);
    if (!armed || route.request().method() !== "GET" || limit <= 1) return route.continue();
    armed = false;
    state.held = true;
    const response = await route.fetch();
    read();
    await gate;
    await route.fulfill({ response });
  });
  return {
    state,
    wasRead,
    release() {
      state.released = true;
      release();
    },
  };
}

const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
const bubble = (page, text) => page.locator("#messages .msg", { hasText: text });

test.use({ viewport: { width: 1280, height: 800 } });

test("a conversation viewed before is drawn at once on a switch back, then refreshed", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = `cache-${Date.now()}`;
  const first = await seedConversation(request, headers, "Plan the pottery class schedule", stamp);
  const second = await seedConversation(request, headers, "List the pond plants", stamp);
  const firstNewest = `The glaze day moves to Friday ${stamp}`;
  const secondNewest = `Water lilies go in the deep end ${stamp}`;
  const writtenMeanwhile = `Kiln slots are booked too ${stamp}`;
  try {
    await addTurn(request, headers, first.conversationId, `When is the glaze day ${stamp}`, firstNewest);
    await addTurn(request, headers, second.conversationId, `Where do the lilies go ${stamp}`, secondNewest);

    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, first.conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await expect(page.locator("#cli-dot")).toHaveClass("online");
    await expect(page.locator("#chat-title")).toHaveText(first.title);
    await expect(bubble(page, firstNewest)).toBeVisible();

    await row(page, second.conversationId).click();
    await expect(page.locator("#chat-title")).toHaveText(second.title);
    await expect(bubble(page, secondNewest)).toBeVisible();
    await expect(bubble(page, firstNewest)).toHaveCount(0);

    // Written while the other conversation is open: the kept copy lacks it.
    await addTurn(request, headers, first.conversationId, `And the kiln ${stamp}`, writtenMeanwhile);

    const held = await holdNextConversationRead(page, first.conversationId);
    const clickedAt = Date.now();
    await row(page, first.conversationId).click();
    await expect(page.locator("#chat-title")).toHaveText(first.title);
    await expect(bubble(page, firstNewest)).toBeVisible();
    const drawnAfterMs = Date.now() - clickedAt;
    // Drawn before the fresh answer: the read was made and is still held.
    expect(held.state.released).toBe(false);
    await held.wasRead;
    expect(held.state.held).toBe(true);
    await expect(bubble(page, secondNewest)).toHaveCount(0);
    await expect(bubble(page, writtenMeanwhile)).toHaveCount(0);
    // No live turn is made up from the kept copy.
    await expect(page.locator("#thinking-indicator")).toHaveCount(0);

    const releasedAt = Date.now();
    held.release();
    await expect(bubble(page, writtenMeanwhile)).toBeVisible();
    const refreshedAfterMs = Date.now() - releasedAt;
    await expect(bubble(page, firstNewest)).toBeVisible();
    await expect(page.locator("#thinking-indicator")).toHaveCount(0);

    test.info().annotations.push({
      type: "timing",
      description: `kept copy drawn ${drawnAfterMs} ms after the click; fresh answer drawn ${refreshedAfterMs} ms after its release`,
    });
    console.log(`[conversation-switch-cache] kept copy drawn ${drawnAfterMs} ms after the click; fresh answer drawn ${refreshedAfterMs} ms after its release`);
  } finally {
    for (const conversation of [first, second]) {
      await request.delete(`/api/conversation/${conversation.conversationId}`, { headers }).catch(() => {});
    }
  }
});
