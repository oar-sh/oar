import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A single tilde means "about". Two of them in one paragraph must not strike
// out the text between them; `~~text~~` still does.

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

test("single tildes in a reply strike nothing, double tildes do", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  try {
    const queued = await request.post("/api/message", {
      headers,
      data: { text: `How long do the suites take ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    conversationId = String(body?.conversationId || "");
    const messageId = String(body?.messageId || "");
    await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
    const answered = await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        model: "gpt-5.4-mini",
        mode: "agent",
        text: "The unit suite is quick (~35s), followed by the browser suite in the background (~7-11 min). The old plan is ~~dropped~~ kept.",
      },
    });
    expect(answered.ok()).toBeTruthy();

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const bubble = page.locator(".msg.assistant .msg-bubble").last();
    await expect(bubble).toContainText("(~35s), followed by the browser suite in the background (~7-11 min).");
    await expect(bubble.locator("del")).toHaveCount(1);
    await expect(bubble.locator("del")).toHaveText("dropped");
  } finally {
    if (conversationId) await request.post(`/api/conversation/${conversationId}/archive`, { headers }).catch(() => {});
  }
});
