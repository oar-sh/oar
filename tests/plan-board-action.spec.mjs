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
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

test("a plan board action queues its follow-up message", async ({ request }) => {
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
    await request.post("/api/response", {
      headers,
      data: { messageId, conversationId, text: "The plan is ready.", model: "gpt-5.4-mini", mode: "plan" },
    });

    const acted = await request.post(`/api/relay-board/${boardId}/action`, {
      headers,
      data: { actionId: "autopilot" },
    });
    expect(acted.status()).toBe(200);
    followUpId = String((await acted.json())?.queuedMessageId || "");
    expect(followUpId).toBeTruthy();

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
