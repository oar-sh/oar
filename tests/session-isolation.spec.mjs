import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

function relayHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pauseRelay(request, headers) {
  const response = await request.post("/api/relay/pause", { headers });
  expect(response.ok()).toBeTruthy();
}

async function resumeRelay(request, headers) {
  const response = await request.post("/api/relay/resume", { headers });
  expect(response.ok()).toBeTruthy();
}

async function createUnboundConversation(request, headers, text = "session-isolation seed") {
  const response = await request.post("/api/message", {
    headers,
    data: {
      text,
      relayMode: "agent",
      model: "gpt-5.4-mini",
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const conversationId = String(body?.conversationId || "").trim();
  const messageId = String(body?.messageId || "").trim();
  expect(conversationId).toBeTruthy();
  expect(messageId).toBeTruthy();
  return { conversationId, messageId };
}

test.describe.serial("session isolation", () => {
  test("rejects follow-up turns on an unbound conversation", async ({ request }) => {
    const token = relayToken();
    const headers = relayHeaders(token);
    let conversationId = "";

    try {
      await pauseRelay(request, headers);
      await sleep(2500);
      const created = await createUnboundConversation(request, headers, "session isolation seed");
      conversationId = created.conversationId;
      const conversation = await request.get(`/api/conversation/${conversationId}`, { headers });
      expect(conversation.ok()).toBeTruthy();
      const conversationBody = await conversation.json();
      expect(String(conversationBody?.sdkSessionId || "")).toBe("");

      const followup = await request.post("/api/message", {
        headers,
        data: {
          text: "follow-up should be blocked",
          conversationId,
          relayMode: "agent",
          model: "gpt-5.4-mini",
        },
      });
      expect(followup.status()).toBe(409);
      const payload = await followup.json();
      expect(String(payload?.error || "")).toMatch(/session-bound|binding/i);
    } finally {
      if (conversationId) {
        await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
      await resumeRelay(request, headers).catch(() => {});
    }
  });

  test("stale last conversation cannot send until it is session-bound", async ({ page, request }) => {
    const token = relayToken();
    const headers = relayHeaders(token);
    let conversationId = "";

    try {
      await pauseRelay(request, headers);
      await sleep(2500);
      const created = await createUnboundConversation(request, headers, "stale auto-open seed");
      conversationId = created.conversationId;

      await page.addInitScript((id) => {
        localStorage.setItem("copilot_last_conv", id);
      }, conversationId);

      await page.goto(`/?token=${encodeURIComponent(token)}`);
      await page.waitForLoadState("networkidle");

      const beforeCount = await page.locator(".msg.user").count();
      await page.fill("#msg-input", "blocked follow-up");
      await page.click("#send-btn");
      await expect(page.locator("#model-banner")).toContainText(/session-bound|waiting to be claimed/i);
      await expect(page.locator(".msg.user")).toHaveCount(beforeCount);
    } finally {
      if (conversationId) {
        await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
      }
      await resumeRelay(request, headers).catch(() => {});
    }
  });
});
