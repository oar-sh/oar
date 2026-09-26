import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

// A Claude turn with an open question card holds steering: the composer must
// stay usable and say what a send does now ("Queue" — it steers in after the
// answer), and the live bubble's Stop must stay reachable on a phone however
// long the turn gets. The isolated server never spawns a CLI, so the turn is
// a dequeued row, the Claude binding is written straight into its DB, and the
// worker's part — the heartbeat that advertises steering and reports the
// hold — is posted by the spec itself with the worker's identity headers.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bindConversationToClaude(conversationId) {
  const db = new DatabaseSync(relayDbPath());
  try {
    db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude' WHERE conversation_id = ?`).run(conversationId);
  } finally {
    db.close();
  }
}

async function dequeueSpecificMessage(request, headers, messageId, ownerSessionId = "") {
  const dequeueHeaders = String(ownerSessionId || "").trim()
    ? { ...headers, "x-relay-session-id": String(ownerSessionId).trim() }
    : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const msg = (await dequeued.json())?.message || null;
    if (!msg) {
      await sleep(250);
      continue;
    }
    if (String(msg.id || "") === String(messageId || "")) return;
    await request.post("/api/requeue", { headers, data: { messageId: String(msg.id || "") } }).catch(() => {});
    await sleep(120);
  }
  throw new Error("Timed out waiting to dequeue the seeded turn");
}

test("a held Claude turn offers Queue with the reason, and its Stop stays in view on a phone", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Held steering seed ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeueSpecificMessage(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));
    // Follow-up sends are only accepted on session-bound conversations.
    const synced = await request.post("/api/session-sync", {
      headers,
      data: { sdk_session_id: `pw-sid-held-${stamp}`, conversation_id: conversationId },
    });
    expect(synced.ok()).toBeTruthy();
    bindConversationToClaude(conversationId);
    // What the Claude worker's heartbeat reports while a card is open: it
    // steers (`supported`), and steering is held for the question.
    const beat = await request.post("/api/heartbeat", {
      headers: { ...headers, "x-relay-session-id": `pw-sid-held-${stamp}`, "x-relay-conversation-id": conversationId },
      data: {
        activeQueueMessageIds: [messageId],
        steering: { turnActive: true, canSteer: false, holdReason: "question", messageId, supported: true, cancellableIds: [] },
      },
    });
    expect(beat.ok()).toBeTruthy();

    const created = await request.post("/api/relay-question", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "agent",
        prompt: `Held steering question ${stamp}: proceed?`,
        choices: ["Yes", "No"],
        allowFreeform: false,
        timeout_ms: 120000,
      },
    });
    expect(created.ok()).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const liveBubble = page.locator("#thinking-indicator");
    await expect(liveBubble).toBeVisible();

    // Decision 3: enabled, reads Queue, and the tooltip names the reason.
    const sendButton = page.locator("#send-btn");
    await page.fill("#msg-input", "a follow-up for after the answer");
    await expect(sendButton).toHaveText("Queue");
    await expect(sendButton).toBeEnabled();
    await expect(sendButton).toHaveAttribute("title", /after you answer the question/i);

    // A long live turn on a phone: the Stop header sticks to the top of the
    // scroller while the bubble's body scrolls under it.
    await page.evaluate(() => {
      const stream = document.getElementById("thinking-stream");
      stream.hidden = false;
      stream.innerHTML = Array.from({ length: 120 }, (_, i) => `<p>streamed line ${i + 1}</p>`).join("");
      const box = document.getElementById("messages");
      const bubble = document.getElementById("thinking-indicator");
      box.scrollTop = bubble.offsetTop + bubble.offsetHeight - box.clientHeight;
    });
    const stopButton = liveBubble.locator('[data-action="stop-turn"]');
    const geometry = await page.evaluate(() => {
      const box = document.getElementById("messages").getBoundingClientRect();
      const bubble = document.querySelector("#thinking-indicator .thinking-bubble").getBoundingClientRect();
      const stop = document.querySelector('#thinking-indicator [data-action="stop-turn"]').getBoundingClientRect();
      return { boxTop: box.top, boxBottom: box.bottom, bubbleTop: bubble.top, stopTop: stop.top, stopBottom: stop.bottom };
    });
    expect(geometry.bubbleTop).toBeLessThan(geometry.boxTop);
    expect(geometry.stopTop).toBeGreaterThanOrEqual(geometry.boxTop - 1);
    // Stuck to the scroller's top edge, not a padding's depth below it.
    expect(geometry.stopTop - geometry.boxTop).toBeLessThan(12);
    expect(geometry.stopBottom).toBeLessThanOrEqual(geometry.boxBottom);
    await expect(stopButton).toBeVisible();

    // The held send goes out (the relay holds it until the card is answered).
    const posted = page.waitForRequest((req) => req.method() === "POST" && req.url().endsWith("/api/message"));
    await sendButton.click();
    const body = (await posted).postDataJSON();
    expect(body.text).toBe("a follow-up for after the answer");
    expect(body.conversationId).toBe(conversationId);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: { messageId, conversationId, text: "playwright cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});
