import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Relay event subscriptions end to end, without a model: a watching
 * conversation subscribes through POST /api/remote-relays/tool the way a
 * worker's tool adapter calls it, the spec plays the user on the approval
 * card, and a question on the watched session becomes an event row in the
 * watcher's transcript. The page shows the "watching" chip with its
 * Unsubscribe button and the "watched" badge.
 *
 * A relay of the spec's own (the agent-sessions setting is switched on
 * here). No worker runs: a "turn" is a message the spec took off the queue
 * (GET /api/pending), which is what the approval card and a question sit on.
 * The spec reports in the way a worker does while it holds them: a relay that
 * hears from no worker hands a running turn back to the queue 45 s after it
 * was taken, and a busy suite can spend that long before the question below
 * is asked, which then found no turn ("No active relay turn").
 */

const APPROVAL_TIMEOUT = 20_000;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

async function waitForApprovalCard(api, conversationId) {
  const deadline = Date.now() + APPROVAL_TIMEOUT;
  while (Date.now() < deadline) {
    const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    const card = (payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
    if (card) return card;
    await sleep(150);
  }
  throw new Error(`No approval card appeared for conversation ${conversationId.slice(0, 8)}`);
}

function answerCard(api, card, answer) {
  return api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
    method: "POST",
    body: { answer, ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
  });
}

test.describe.serial("relay event subscriptions", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const api = createApi(() => relay);
  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });
  const suffix = Date.now();
  const watchedTitle = `orbit camera ${suffix}`;
  const watcherTitle = `relay assistant ${suffix}`;
  let watched = { conversationId: "", messageId: "" };
  let watcher = { conversationId: "", messageId: "" };

  // A conversation whose first message a "worker" has taken: its turn is
  // processing. Called while nothing else is queued, so the dequeue can only
  // return this message.
  async function conversationWithRunningTurn(text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    const { conversationId, messageId, ownerSessionId } = queued.payload;
    const synced = await api("/api/session-sync", {
      method: "POST",
      body: { sdk_session_id: conversationId, conversation_id: conversationId },
    });
    expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const dequeued = await api("/api/pending", { headers });
      if (String(dequeued.payload?.message?.id || "") === messageId) return { conversationId, messageId };
      await sleep(250);
    }
    throw new Error("The message was never handed out");
  }

  async function openApp(page, conversationId) {
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
  }

  let heartbeat = null;

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    heartbeat = setInterval(() => {
      api("/api/heartbeat", { method: "POST", body: {} }).catch(() => {});
    }, 2_000);
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "bench-relay" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    watched = await conversationWithRunningTurn(watchedTitle);
    watcher = await conversationWithRunningTurn(watcherTitle);
  });

  test.afterAll(async () => {
    clearInterval(heartbeat);
    heartbeat = null;
    if (relay) await relay.stop();
    relay = null;
  });

  test("the first subscribe asks the user once; all is asked again and named", async () => {
    const subscribing = tool(watcher.conversationId, "subscribe", { sessions: [watched.conversationId] });
    const card = await waitForApprovalCard(api, watcher.conversationId);
    expect(card.prompt).toContain("wants to watch");
    expect(card.prompt).toContain(watchedTitle);
    expect((await answerCard(api, card, "Allow")).status).toBe(200);
    const subscribed = await subscribing;
    expect(subscribed.status, JSON.stringify(subscribed.payload)).toBe(200);
    expect(subscribed.payload.subscription.sessions).toEqual([{ id: watched.conversationId, title: watchedTitle }]);

    // Asked once per conversation: the second goes straight through.
    const again = await tool(watcher.conversationId, "subscribe", { sessions: [watched.conversationId], events: ["turn_end"], once: true });
    expect(again.status, JSON.stringify(again.payload)).toBe(200);

    // All sessions are always named on a card: asked again, and denied here.
    const everything = tool(watcher.conversationId, "subscribe", { sessions: ["all"] });
    const allCard = await waitForApprovalCard(api, watcher.conversationId);
    expect(allCard.prompt).toContain("ALL sessions of this relay");
    expect((await answerCard(api, allCard, "Deny")).status).toBe(200);
    expect((await everything).status).toBe(403);

    const listed = await tool(watcher.conversationId, "list_subscriptions");
    expect(listed.payload.subscriptions.filter((sub) => !sub.endedAt)).toHaveLength(2);
    // The watched session's turn is running: list_sessions says so.
    const sessions = await tool(watcher.conversationId, "list_sessions", { relay: "this" });
    const row = sessions.payload.sessions.find((session) => session.id === watched.conversationId);
    expect(row.state).toBe("running_turn");
    expect(row.active).toBe(true);
    expect(Array.isArray(row.tasks)).toBe(true);
  });

  test("a question on the watched session becomes an event row; chip, badge and Unsubscribe", async ({ page }) => {
    await openApp(page, watcher.conversationId);
    const chip = page.locator("#chat-title-relay-events .relay-watch-chip");
    await expect(chip).toHaveText("👁 watching 1 session");

    // An urgent event: no 30 s wait.
    const asked = await api("/api/relay-question", {
      method: "POST",
      body: {
        queueId: watched.messageId,
        messageId: watched.messageId,
        conversationId: watched.conversationId,
        mode: "agent",
        prompt: "Merge the orbit camera branch now?",
        choices: ["Merge", "Wait"],
        allowFreeform: false,
        timeout_ms: 120_000,
      },
    });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);

    const row = page.locator(".msg.relay-event").last();
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/\buser\b/);
    await expect(row.locator(".relay-event-tag")).toHaveText("relay event");
    await expect(row.locator(".relay-event-text")).toHaveText("1 event · question");
    // A question keeps its row open.
    await expect(row.locator(".relay-event-line").first()).toContainText("question_asked \"Merge the orbit camera branch now?\" options: [Merge] [Wait]");
    // Folding works like any details row.
    await row.locator(".relay-event-summary").click();
    await expect(row.locator(".relay-event-line").first()).toBeHidden();

    // The watched session carries the badge, in the sidebar and in its header.
    const sidebarItem = page.locator(`.conv-item[data-conversation-id="${watched.conversationId}"]`);
    await expect(sidebarItem.locator(".conv-watched-badge")).toHaveText("watched");
    await page.evaluate((id) => window.openConversation(id), watched.conversationId);
    await expect(page.locator("#chat-title-relay-events .conv-watched-badge")).toHaveText("watched");
    await expect(page.locator("#chat-title-relay-events .relay-watch-chip")).toHaveCount(0);

    // Back on the watcher: the chip opens its list, Unsubscribe ends them.
    await page.evaluate((id) => window.openConversation(id), watcher.conversationId);
    await chip.click();
    const buttons = page.locator(".relay-watch-panel .relay-watch-unsubscribe");
    await expect(buttons).toHaveCount(2);
    await buttons.first().click();
    await expect(buttons).toHaveCount(1);
    await buttons.first().click();
    await expect(page.locator("#chat-title-relay-events")).toBeHidden();
    await expect(sidebarItem.locator(".conv-watched-badge")).toHaveCount(0);
    const left = await api("/api/relay-events/subscriptions");
    expect(left.payload.subscriptions).toEqual([]);
  });
});
