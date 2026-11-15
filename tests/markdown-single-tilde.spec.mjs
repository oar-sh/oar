import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";
import { respondAsWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

// A single tilde means "about". Two of them in one paragraph must not strike
// out the text between them; `~~text~~` still does.

test("single tildes in a reply strike nothing, double tildes do", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  try {
    // Made as the web client makes a chat: bound from the start.
    const started = await startConversation({ text: `How long do the suites take ${stamp}` });
    conversationId = started.conversationId;
    const messageId = started.messageId;
    await started.worker.take(messageId);
    const answered = await respondAsWorker(messageId, {
      conversationId,
      model: "gpt-5.4-mini",
      mode: "agent",
      text: "The unit suite is quick (~35s), followed by the browser suite in the background (~7-11 min). The old plan is ~~dropped~~ kept.",
    });
    expect(answered.ok).toBeTruthy();

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
