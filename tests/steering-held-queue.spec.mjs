import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";
import { attemptOf, respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// A Claude turn with an open question card holds steering: the composer must
// stay usable and say what a send does now ("Queue" — it steers in after the
// answer), and the live bubble's Stop must stay reachable on a phone however
// long the turn gets. The isolated server never spawns a CLI, so the turn is
// a dequeued row, the Claude binding is written straight into its DB, and the
// worker's part — the heartbeat that advertises steering and reports the
// hold — is posted by the spec itself with the worker's identity headers.

function bindConversationToClaude(conversationId) {
  const db = new DatabaseSync(relayDbPath());
  try {
    db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude' WHERE conversation_id = ?`).run(conversationId);
  } finally {
    db.close();
  }
}

test("a held Claude turn offers Queue with the reason, and its Stop stays in view on a phone", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";

  try {
    // Follow-up sends are only accepted on session-bound conversations: made
    // as the web client makes a chat, bound from the start.
    // Its worker is a Claude worker, as the chat is a Claude chat below.
    const started = await startConversation({ text: `Held steering seed ${stamp}` }, { workerKind: "claude" });
    conversationId = String(started.conversationId || "");
    messageId = String(started.messageId || "");
    const worker = started.worker;
    await worker.take(messageId);
    bindConversationToClaude(conversationId);
    // What the Claude worker's heartbeat reports while a card is open: it
    // steers (`supported`), and steering is held for the question.
    const beat = await worker.beat({
      steering: { turnActive: true, canSteer: false, holdReason: "question", messageId, supported: true, cancellableIds: [] },
    });
    expect(beat).toBe(true);

    const created = await request.post("/api/relay-question", {
      headers,
      data: {
        ...attemptOf(messageId),
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
      await respondAsWorker(messageId, { conversationId, text: "playwright cleanup", model: "gpt-5.4-mini", mode: "agent" }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});
