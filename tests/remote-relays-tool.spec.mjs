import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { relayBaseUrl, relayToken } from "./e2e-env.mjs";
import { startRelayServer } from "./relay-server-harness.mjs";

/**
 * The remote_relay tool path end to end, without a model
 * (docs/plans/2026-09-27-remote-relays.md §10): the shared e2e relay ("A",
 * win-test) is paired with a throwaway relay ("B", linux-test), and the spec
 * calls A's POST /api/remote-relays/tool the way a worker's tool adapter does.
 *
 * Neither relay runs a CLI here, so queued turns never answer: send is used
 * with wait_seconds 0, and the ask-mode approval has no live turn to put its
 * card on (which must fail closed).
 */

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function api(baseUrl, token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function queueMessage(baseUrl, token, text, extra = {}) {
  const { status, payload } = await api(baseUrl, token, "/api/message", {
    method: "POST",
    body: { text, relayMode: "agent", model: "gpt-5.4-mini", ...extra },
  });
  expect(status, JSON.stringify(payload)).toBe(200);
  return payload;
}

// A new conversation, bound to a session the way a worker would bind it, so it
// accepts follow-up messages (no CLI runs here to do that).
async function newConversation(baseUrl, token, text, extra = {}) {
  const { conversationId } = await queueMessage(baseUrl, token, text, extra);
  const synced = await api(baseUrl, token, "/api/session-sync", {
    method: "POST",
    body: { sdk_session_id: conversationId, conversation_id: conversationId },
  });
  expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
  return conversationId;
}

function tool(conversationId, action, args = {}) {
  return api(relayBaseUrl(), relayToken(), "/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args },
  });
}

async function removeAllRemotes(baseUrl, token) {
  const { payload } = await api(baseUrl, token, "/api/remote-relays").catch(() => ({ payload: null }));
  for (const relay of payload?.relays || []) {
    await api(baseUrl, token, `/api/remote-relays/${encodeURIComponent(relay.id)}`, { method: "DELETE" }).catch(() => {});
  }
}

test.describe.serial("remote_relay tool between two relays", () => {
  test.describe.configure({ timeout: 120_000 });

  let relayB = null;
  let conversationOnB = "";

  test.beforeAll(async () => {
    relayB = await startRelayServer({ token: randomUUID() });
    await api(relayB.baseUrl, relayB.token, "/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } });
    await api(relayBaseUrl(), relayToken(), "/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } });
    await api(relayBaseUrl(), relayToken(), "/api/settings/remote-relays", { method: "POST", body: { publicUrl: relayBaseUrl() } });
    const added = await api(relayBaseUrl(), relayToken(), "/api/remote-relays", {
      method: "POST",
      body: { url: relayB.baseUrl, token: relayB.token, pairBack: false },
    });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    // A session on B for A's agent to find, read and prompt.
    conversationOnB = await newConversation(relayB.baseUrl, relayB.token, "report builder: collect the numbers");
  });

  test.afterAll(async () => {
    await removeAllRemotes(relayBaseUrl(), relayToken());
    await api(relayBaseUrl(), relayToken(), "/api/settings/remote-relays", {
      method: "POST",
      body: { publicUrl: "", inboundEnabled: true },
    }).catch(() => {});
    await api(relayBaseUrl(), relayToken(), "/api/settings/pwa-app-name", { method: "POST", body: { appName: "" } }).catch(() => {});
    if (relayB) await relayB.stop();
    relayB = null;
  });

  test("a relay stays locked until the user names it, then the agent can list, read and prompt there", async ({ page }) => {
    const conversation = await newConversation(relayBaseUrl(), relayToken(), `tool spec ${Date.now()}: nothing mentioned yet`);

    const listed = await tool(conversation, "list_relays");
    expect(listed.status).toBe(200);
    expect(listed.payload.relays).toEqual([
      expect.objectContaining({ name: "linux-test", online: true, permission: "full", unlocked: false }),
    ]);
    expect(JSON.stringify(listed.payload)).not.toContain(relayB.token);

    const locked = await tool(conversation, "list_sessions", { relay: "linux-test" });
    expect(locked.status).toBe(403);
    expect(locked.payload.code).toBe("REMOTE_RELAY_LOCKED");

    // The plain name in the user's own message unlocks it for the conversation.
    await queueMessage(relayBaseUrl(), relayToken(), "please check what linux-test is doing", { conversationId: conversation });
    const sessions = await tool(conversation, "list_sessions", { relay: "linux-test", scope: "recent" });
    expect(sessions.status, JSON.stringify(sessions.payload)).toBe(200);
    expect(sessions.payload.sessions.map((session) => session.id)).toContain(conversationOnB);

    const read = await tool(conversation, "read_session", { relay: "linux-test", session: conversationOnB });
    expect(read.status).toBe(200);
    expect(read.payload.messages.map((message) => message.text)).toContain("report builder: collect the numbers");

    const sent = await tool(conversation, "send", {
      relay: "linux-test",
      session: conversationOnB,
      text: "sidebar polish: summarise the open work",
      wait_seconds: 0,
    });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    expect(["queued", "running"]).toContain(sent.payload.status);
    const sentId = sent.payload.message_id;
    expect(sentId).toBeTruthy();

    // On B: the prompt carries A's origin and the header line for its agent.
    const onB = await api(relayB.baseUrl, relayB.token, `/api/conversation/${conversationOnB}?limit=5`);
    const stored = (onB.payload.messages || []).find((message) => message.id === sentId);
    expect(stored.origin).toEqual(expect.objectContaining({ relayName: "win-test", conversationId: conversation, hops: 1 }));
    expect(stored.text.startsWith('[Remote prompt from an agent on relay "win-test"')).toBe(true);

    // B's UI shows the badge and hides the header line (opened by deep link).
    await page.goto(`${relayB.baseUrl}/?token=${encodeURIComponent(relayB.token)}&conv=${encodeURIComponent(conversationOnB)}`);
    const bubble = page.locator(`div.msg.msg-from-remote-relay[data-message-id="${sentId}"]`);
    await expect(bubble).toBeVisible({ timeout: 20_000 });
    await expect(bubble).toContainText("from win-test");
    await expect(bubble).toContainText("sidebar polish: summarise the open work");
    await expect(bubble).not.toContainText("Remote prompt from an agent");
  });

  test("the inbound switch on the other relay refuses prompts but not reads", async () => {
    const conversation = (await queueMessage(relayBaseUrl(), relayToken(), `tool spec ${Date.now()}: ask @linux-test`)).conversationId;
    await api(relayB.baseUrl, relayB.token, "/api/settings/remote-relays", { method: "POST", body: { inboundEnabled: false } });
    try {
      const refused = await tool(conversation, "send", { relay: "linux-test", session: conversationOnB, text: "are you there", wait_seconds: 0 });
      expect(refused.status).toBe(403);
      expect(refused.payload.code).toBe("REMOTE_INBOUND_DISABLED");
      const read = await tool(conversation, "read_session", { relay: "linux-test", session: conversationOnB });
      expect(read.status).toBe(200);
    } finally {
      await api(relayB.baseUrl, relayB.token, "/api/settings/remote-relays", { method: "POST", body: { inboundEnabled: true } });
    }
  });

  test("in ask mode a write needs a live turn to ask on, and fails closed without one", async () => {
    const queued = await queueMessage(relayBaseUrl(), relayToken(), `tool spec ${Date.now()}: ask @linux-test`, { relayMode: "ask" });
    const refused = await tool(queued.conversationId, "send", { relay: "linux-test", session: conversationOnB, text: "hello", wait_seconds: 0 });
    expect(refused.status).toBe(403);
    expect(refused.payload.code).toBe("REMOTE_RELAY_NO_ACTIVE_TURN");
    // Reads never ask.
    const read = await tool(queued.conversationId, "list_sessions", { relay: "linux-test" });
    expect(read.status).toBe(200);
  });
});
