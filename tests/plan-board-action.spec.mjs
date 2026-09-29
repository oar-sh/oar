import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A plan board's action queues the follow-up that carries the plan out. The
// spec is the worker: it dequeues the turn, posts the board the way a worker
// does, and then presses the action the way the page does.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // The connection may be one that was kept while the page was at work and
    // has been closed since: the next round asks again.
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders }).catch(() => null);
    if (!dequeued) {
      await sleep(200);
      continue;
    }
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

test("a plan board action queues its follow-up message", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";
  let followUpId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Plan the change ${stamp}`, relayMode: "plan", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));

    const created = await request.post("/api/relay-board", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "plan",
        boardType: "plan_ready",
        title: "Plan ready for review",
        body: "1. Rename the module\n2. Update the imports",
        actions: [
          { id: "autopilot", label: "Implement in autopilot", mode: "autopilot" },
          { id: "exit_only", label: "Exit plan mode" },
        ],
        recommendedAction: "autopilot",
      },
    });
    expect(created.ok()).toBeTruthy();
    const boardId = String((await created.json())?.board?.id || "");
    expect(boardId).toBeTruthy();

    // While the turn runs, the board lives in the turn's live bubble.
    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const board = page.locator(`.relay-board-inline[data-board-id="${boardId}"]`);
    await expect(board).toBeVisible();
    await expect(page.locator("#thinking-indicator .relay-board-inline")).toHaveCount(1);
    await expect(board.locator(".relay-board-body")).toContainText("Rename the module");

    // The reply takes it over: inside the reply's bubble, no card of its own.
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: "The plan is ready.", model: "gpt-5.4-mini", mode: "plan" },
    });
    const reply = page.locator(`.msg.assistant[data-source-message-id="${messageId}"]`);
    await expect(reply.locator(".msg-bubble")).toContainText("The plan is ready.");
    await expect(reply.locator(".msg-bubble .relay-board-inline")).toHaveCount(1);
    await expect(page.locator(".relay-board-inline")).toHaveCount(1);
    await expect(page.locator(".relay-board-container")).toHaveCount(0);
    await expect(board.getByRole("button", { name: "Implement in autopilot" })).toBeVisible();
    await expect(page.locator("#mode-select")).toHaveValue("plan");

    // The buttons work from inside the bubble, and the choice stays on show.
    const acting = page.waitForResponse((response) => response.url().includes(`/api/relay-board/${boardId}/action`));
    await board.getByRole("button", { name: "Implement in autopilot" }).click();
    const acted = await acting;
    expect(acted.status()).toBe(200);
    followUpId = String((await acted.json())?.queuedMessageId || "");
    expect(followUpId).toBeTruthy();
    await expect(board.locator(".relay-board-outcome")).toHaveText("Chosen: Implement in autopilot");
    await expect(board.locator("button")).toHaveCount(0);
    await expect(board.locator(".relay-board-body")).toContainText("Rename the module");
    // The session goes on in the mode that was chosen.
    await expect(page.locator("#mode-select")).toHaveValue("autopilot");

    // A reload finds the settled board where it was, and the mode with it.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(reply.locator(".msg-bubble .relay-board-outcome")).toHaveText("Chosen: Implement in autopilot");
    await expect(page.locator("#mode-select")).toHaveValue("autopilot");

    // The follow-up is a message like any other: a worker is handed it.
    await dequeue(request, headers, followUpId, String(queuedBody?.ownerSessionId || ""));
  } finally {
    for (const id of [followUpId, messageId].filter(Boolean)) {
      await request.post("/api/response", {
        headers,
        data: { messageId: id, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});

test("a reply that is the plan shows it once, with the buttons below", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const plan = `1. Split the parser ${stamp}\n2. Move the tests`;
  let conversationId = "";
  let messageId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `Plan the split ${stamp}`, relayMode: "plan", model: "gpt-5.4-mini" },
    });
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    await dequeue(request, headers, messageId, String(queuedBody?.ownerSessionId || ""));
    const created = await request.post("/api/relay-board", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "plan",
        boardType: "plan_ready",
        title: "Plan ready for review",
        body: plan,
        actions: [{ id: "autopilot", label: "Implement in autopilot", mode: "autopilot" }],
      },
    });
    expect(created.ok()).toBeTruthy();
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: `Here is what I would do.\n\n${plan}`, model: "gpt-5.4-mini", mode: "plan" },
    });

    await page.setViewportSize({ width: 412, height: 915 });
    await page.addInitScript((id) => { localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const reply = page.locator(`.msg.assistant[data-source-message-id="${messageId}"] .msg-bubble`);
    await expect(reply.locator(".relay-board-inline")).toHaveCount(1);
    await expect(reply.locator(".relay-board-inline .relay-board-body")).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "Implement in autopilot" })).toBeVisible();
    await expect(reply.getByText(`Split the parser ${stamp}`)).toHaveCount(1);
    await page.screenshot({ path: "/tmp/oar-plan-board-in-reply.png" });
  } finally {
    if (messageId) {
      await request.post("/api/response", {
        headers,
        data: { messageId, conversationId, text: "cleanup", model: "gpt-5.4-mini", mode: "agent" },
      }).catch(() => {});
    }
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
