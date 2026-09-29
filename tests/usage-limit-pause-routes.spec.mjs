import { DatabaseSync } from "node:sqlite";
import { expect, test, devices } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

// A turn paused at the Claude usage limit, through the relay's own routes and
// its own queue: what the worker posts when the CLI refuses a turn, a message
// the user sends while the pause lasts, Resume now and Cancel. The isolated
// relay runs no Claude worker, so the spec is the worker: it dequeues the row
// with the worker's identity and answers it the way the worker does.

const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"];
test.use({ ...pixel });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDb(work) {
  const db = new DatabaseSync(relayDbPath());
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function heldRows(conversationId) {
  return withDb((db) => db.prepare(
    `SELECT id, status, next_attempt_at, text FROM queue WHERE conversation_id = ? AND usage_limit_pause IS NOT NULL ORDER BY rowid`,
  ).all(conversationId));
}

function usageLimitRefusal(messageId, resetsAt) {
  return {
    kind: "claude-usage-limit",
    code: "usage-limit",
    stableCode: "claude.usage-limit",
    message: "You've hit your session limit",
    guidance: "The turn carries on by itself after the reset.",
    rateLimitType: "five_hour",
    resetsAt,
    failedAt: new Date().toISOString(),
    queueMessageId: messageId,
  };
}

async function seedClaudeConversation(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const sessionId = `pw-sid-limit-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const synced = await request.post("/api/session-sync", {
    headers,
    data: { sdk_session_id: sessionId, conversation_id: conversationId },
  });
  expect(synced.ok()).toBeTruthy();
  withDb((db) => db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude' WHERE conversation_id = ?`).run(conversationId));
  return { conversationId, messageId: String(body?.messageId || ""), sessionId, ownerSessionId: String(body?.ownerSessionId || "") };
}

/** Dequeue as the conversation's worker; returns the id handed out, or "". */
async function dequeueNext(request, headers, sessionIds) {
  for (const sessionId of sessionIds.filter(Boolean)) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const dequeued = await request.get("/api/pending", { headers: { ...headers, "x-relay-session-id": sessionId } });
      expect(dequeued.ok()).toBeTruthy();
      const message = (await dequeued.json())?.message || null;
      if (message) return String(message.id);
      await sleep(150);
    }
  }
  return "";
}

async function refuse(request, headers, { conversationId, messageId, resetsAt }) {
  const answered = await request.post("/api/response", {
    headers,
    data: {
      messageId,
      conversationId,
      text: "You've hit your session limit",
      model: "gpt-5.4-mini",
      mode: "agent",
      terminalError: usageLimitRefusal(messageId, resetsAt),
    },
  });
  expect(answered.ok()).toBeTruthy();
  return answered.json();
}

test("a paused turn holds one follow-up through a message sent meanwhile, and Resume now sends it", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const resetsAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const seed = await seedClaudeConversation(request, headers, `Pause seed ${stamp}`);
  const { conversationId } = seed;
  const workers = [seed.ownerSessionId, seed.sessionId];

  try {
    expect(await dequeueNext(request, headers, workers)).toBe(seed.messageId);
    // Other specs leave queued messages on this relay: the count is compared
    // with what it was, not with zero.
    const queuedBefore = Number((await (await request.get("/api/status", { headers })).json()).pendingCount || 0);
    await refuse(request, headers, { conversationId, messageId: seed.messageId, resetsAt });

    // Paused: one held follow-up, listed by the relay, not counted as queued
    // work, and handed to no worker.
    let held = heldRows(conversationId);
    expect(held.length).toBe(1);
    expect(held[0].status).toBe("pending");
    const listed = await (await request.get("/api/usage-limit", { headers })).json();
    expect(listed.pauses.map((pause) => pause.conversationId)).toContain(conversationId);
    const status = await (await request.get("/api/status", { headers })).json();
    expect(Number(status.pendingCount || 0)).toBe(queuedBefore);
    expect(await dequeueNext(request, headers, workers)).toBe("");

    // The page shows the pause and when the turn carries on.
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const banner = page.locator("#usage-limit-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("5-hour limit");
    await expect(page.locator(".msg.assistant").last()).toContainText("Paused");

    // A message sent during the pause is an ordinary message: it is delivered
    // at once, ahead of the held follow-up.
    const sent = await request.post("/api/message", {
      headers,
      data: { conversationId, text: `Sent during the pause ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(sent.ok()).toBeTruthy();
    const sentId = String((await sent.json())?.messageId || "");
    expect(await dequeueNext(request, headers, workers)).toBe(sentId);

    // The CLI refuses it as well: still one follow-up, still held.
    await refuse(request, headers, { conversationId, messageId: sentId, resetsAt });
    held = heldRows(conversationId);
    expect(held.length).toBe(1);
    expect(Date.parse(held[0].next_attempt_at)).toBeGreaterThan(Date.now());
    await expect(banner).toBeVisible();

    // Resume now: the banner goes and the follow-up is what the worker gets.
    await banner.getByRole("button", { name: /resume now/i }).click();
    await expect(banner).toBeHidden();
    expect(await dequeueNext(request, headers, workers)).toBe(held[0].id);
    const after = await (await request.get("/api/usage-limit", { headers })).json();
    expect(after.pauses.map((pause) => pause.conversationId)).not.toContain(conversationId);

    const answered = await request.post("/api/response", {
      headers,
      data: { messageId: held[0].id, conversationId, text: "carried on", model: "gpt-5.4-mini", mode: "agent" },
    });
    expect(answered.ok()).toBeTruthy();
    // The answer is where the user looks for it: below what was written
    // during the pause, not above it at the time of the first refusal. On
    // the open page first, then after a reload.
    const readOrder = () => page.locator(".msg").evaluateAll((nodes) => nodes.map((node) => (node.querySelector(".msg-bubble")?.innerText || "").replace(/\s+/g, " ")));
    const expectOrder = async () => {
      await expect(page.locator(".msg.assistant").last()).toContainText("carried on");
      const order = await readOrder();
      const sentAt = order.findIndex((text) => text.includes("Sent during the pause"));
      const followUps = order.filter((text) => text.includes("Automatic message from OAR"));
      const followUpAt = order.findIndex((text) => text.includes("Automatic message from OAR"));
      expect(sentAt).toBeGreaterThan(-1);
      expect(followUps.length).toBe(1);
      expect(followUpAt).toBeGreaterThan(sentAt);
      // It quotes both refused requests, in the order they were sent.
      expect(order[followUpAt]).toContain(`Pause seed ${stamp}`);
      expect(order[followUpAt]).toContain(`Sent during the pause ${stamp}`);
    };
    await expectOrder();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expectOrder();
  } finally {
    await request.post("/api/usage-limit/cancel", { headers, data: { conversationId } }).catch(() => {});
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

test("Cancel drops the held follow-up and nothing is sent at the reset", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const resetsAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const seed = await seedClaudeConversation(request, headers, `Cancel seed ${stamp}`);
  const { conversationId } = seed;
  const workers = [seed.ownerSessionId, seed.sessionId];

  try {
    expect(await dequeueNext(request, headers, workers)).toBe(seed.messageId);
    await refuse(request, headers, { conversationId, messageId: seed.messageId, resetsAt });
    expect(heldRows(conversationId).length).toBe(1);

    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const banner = page.locator("#usage-limit-banner");
    await expect(banner).toBeVisible();

    await expect(page.locator(".msg.user").last()).toContainText("Automatic message from OAR");
    await banner.getByRole("button", { name: /cancel/i }).click();
    await expect(banner).toBeHidden();
    expect(heldRows(conversationId).length).toBe(0);
    expect(await dequeueNext(request, headers, workers)).toBe("");
    // The relay's own message goes with it, on the open page and for good:
    // it was never sent.
    await expect(page.locator(".msg", { hasText: "Automatic message from OAR" })).toHaveCount(0);
    expect(withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND text LIKE 'Automatic message from OAR%'`).get(conversationId).n)).toBe(0);

    // The conversation is usable again: the next message is delivered.
    const sent = await request.post("/api/message", {
      headers,
      data: { conversationId, text: `After the cancel ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(sent.ok()).toBeTruthy();
    const sentId = String((await sent.json())?.messageId || "");
    expect(await dequeueNext(request, headers, workers)).toBe(sentId);
    await request.post("/api/response", {
      headers,
      data: { messageId: sentId, conversationId, text: "answered", model: "gpt-5.4-mini", mode: "agent" },
    });
  } finally {
    await request.post("/api/usage-limit/cancel", { headers, data: { conversationId } }).catch(() => {});
    await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
