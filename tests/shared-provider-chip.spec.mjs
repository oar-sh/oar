import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

/**
 * The red "ran on <provider>" chip, owner view against shared view.
 *
 * Three turns are seeded through the API; the test relay's database then
 * says which provider each conversation is bound to and which one answered:
 * - bound to Claude, answered by Claude: no chip in either view;
 * - bound to Copilot, answered by Claude: the chip in both views;
 * - no binding at all, answered by Claude: no chip in the shared view, which
 *   has nothing to compare with.
 */

async function seedTurn(request, headers, text) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok(), `POST /api/message answered ${queued.status()}`).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "").trim();
  const userId = String(body?.messageId || "").trim();
  expect(conversationId).toBeTruthy();
  const responded = await request.post("/api/response", {
    headers,
    data: { messageId: userId, conversationId, text: `${text} reply`, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(responded.ok()).toBeTruthy();
  const loaded = await request.get(`/api/conversation/${conversationId}`, { headers });
  const replyId = String((await loaded.json()).messages.find((message) => message.role === "assistant")?.id || "");
  expect(replyId).toBeTruthy();
  return { conversationId, replyId };
}

function withDb(work) {
  const db = new DatabaseSync(relayDbPath(), { timeout: 5_000 });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function setBinding(conversationId, providerType) {
  withDb((db) => {
    if (providerType) {
      db.prepare(`UPDATE runtime_sessions SET provider_type = ? WHERE conversation_id = ?`).run(providerType, conversationId);
    } else {
      db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
    }
  });
}

function setExecutedProvider(messageId, provider) {
  withDb((db) => {
    db.prepare(`UPDATE messages SET executed_provider = ? WHERE id = ?`).run(provider, messageId);
  });
}

async function shareToken(request, headers, conversationId) {
  const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
  expect(share.ok()).toBeTruthy();
  const token = String((await share.json())?.token || "");
  expect(token).toBeTruthy();
  return token;
}

const replyChip = (page, replyId) => page.locator(`#messages .msg[data-message-id="${replyId}"] .msg-provider-mismatch`);

async function openOwnerConversation(page, token, conversationId, replyId) {
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await page.evaluate((id) => window.openConversation(id), conversationId);
  await expect(page.locator(`#messages .msg[data-message-id="${replyId}"]`)).toBeVisible();
}

async function openSharedConversation(browser, token, replyId) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/shared/${token}`);
  await expect(page.locator(`#messages .msg[data-message-id="${replyId}"]`)).toBeVisible();
  return { context, page };
}

test("the provider chip shows only on a real mismatch, in the owner and the shared view", async ({ page, request, browser }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const matching = await seedTurn(request, headers, `Bound and answered by one provider ${stamp}`);
  const mismatched = await seedTurn(request, headers, `Answered by another provider ${stamp}`);
  const unbound = await seedTurn(request, headers, `No provider bound ${stamp}`);
  const created = [matching, mismatched, unbound].map((entry) => entry.conversationId);

  try {
    setBinding(matching.conversationId, "claude");
    setExecutedProvider(matching.replyId, "claude");
    setExecutedProvider(mismatched.replyId, "claude");
    setBinding(unbound.conversationId, null);
    setExecutedProvider(unbound.replyId, "claude");

    // The shared payload names the bound provider, or null.
    const matchingShare = await shareToken(request, headers, matching.conversationId);
    const mismatchedShare = await shareToken(request, headers, mismatched.conversationId);
    const unboundShare = await shareToken(request, headers, unbound.conversationId);
    const sharedApi = await request.get(`/api/shared/${matchingShare}`);
    expect((await sharedApi.json()).runtimeProviderType).toBe("claude");
    const unboundApi = await request.get(`/api/shared/${unboundShare}`);
    expect((await unboundApi.json()).runtimeProviderType).toBeNull();

    // Same provider: no chip, for the owner and for a shared viewer.
    await openOwnerConversation(page, token, matching.conversationId, matching.replyId);
    await expect(replyChip(page, matching.replyId)).toHaveCount(0);
    const matchingShared = await openSharedConversation(browser, matchingShare, matching.replyId);
    try {
      await expect(replyChip(matchingShared.page, matching.replyId)).toHaveCount(0);
    } finally {
      await matchingShared.context.close();
    }

    // Another provider than the bound one: the chip, in both views.
    await openOwnerConversation(page, token, mismatched.conversationId, mismatched.replyId);
    await expect(replyChip(page, mismatched.replyId)).toHaveText("ran on claude");
    const mismatchedShared = await openSharedConversation(browser, mismatchedShare, mismatched.replyId);
    try {
      await expect(replyChip(mismatchedShared.page, mismatched.replyId)).toHaveText("ran on claude");
    } finally {
      await mismatchedShared.context.close();
    }

    // Nothing bound: the shared view has nothing to compare with, so no chip.
    const unboundShared = await openSharedConversation(browser, unboundShare, unbound.replyId);
    try {
      await expect(replyChip(unboundShared.page, unbound.replyId)).toHaveCount(0);
    } finally {
      await unboundShared.context.close();
    }
  } finally {
    for (const conversationId of created) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});
