import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * relay_restarted end to end, without a model: an idle conversation
 * subscribes through POST /api/remote-relays/tool the way a worker's tool
 * adapter calls it, the spec queues a restart through the API, the relay's
 * own supervisor brings the runtime back on the same port and database, and
 * the conversation finds one relay event saying who asked and why. A stop by
 * signal and a start on the same state say so.
 *
 * A relay of the spec's own (the agent-sessions setting is switched on
 * here). No worker runs: the event row stays pending, which is all a wake-up
 * is to the relay.
 */

const EVENT_TIMEOUT = 90_000;

test.describe.serial("woken when the relay runs again", () => {
  test.describe.configure({ timeout: 240_000 });

  let relay = null;
  let heartbeat = null;
  let conversationId = "";
  const title = `release coordinator ${Date.now()}`;

  async function api(route, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }

  const tool = (action, args = {}) => api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });

  // The conversation's relay event rows; nothing while the relay is down.
  async function eventRows() {
    try {
      const { payload } = await api(`/api/conversation/${conversationId}?limit=20`);
      return (payload?.messages || []).filter((message) => message?.kind === "relay-event");
    } catch {
      return null;
    }
  }

  async function waitForEventText(pattern) {
    const deadline = Date.now() + EVENT_TIMEOUT;
    let last = null;
    while (Date.now() < deadline) {
      last = await eventRows();
      const row = (last || []).find((message) => pattern.test(String(message.text || "")));
      if (row) return { row, rows: last };
      await sleep(500);
    }
    throw new Error(`No relay event matching ${pattern} (rows: ${JSON.stringify(last)})`);
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID() });
    heartbeat = setInterval(() => {
      api("/api/heartbeat", { method: "POST", body: {} }).catch(() => {});
    }, 2_000);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    // An idle conversation: its first turn taken off the queue and answered.
    const queued = await api("/api/message", { method: "POST", body: { text: title, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
    conversationId = queued.payload.conversationId;
    const { messageId, ownerSessionId } = queued.payload;
    expect((await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } })).status).toBe(200);
    const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
    let handed = false;
    for (let attempt = 0; attempt < 40 && !handed; attempt += 1) {
      handed = String((await api("/api/pending", { headers })).payload?.message?.id || "") === messageId;
      if (!handed) await sleep(250);
    }
    expect(handed, "the first message was handed out").toBe(true);
    expect((await api("/api/response", { method: "POST", body: { messageId, conversationId, text: "ready", model: "gpt-5.4-mini" } })).status).toBe(200);
  });

  test.afterAll(async () => {
    clearInterval(heartbeat);
    heartbeat = null;
    if (relay) await relay.stop();
    relay = null;
  });

  test("a conversation that asked is woken once after a queued restart, with who asked and why", async ({ page }) => {
    const subscribed = await tool("subscribe", { events: ["relay_restarted"], once: true });
    expect(subscribed.status, JSON.stringify(subscribed.payload)).toBe(200);
    expect(subscribed.payload.subscription.sessions).toEqual([]);
    // It watches no session: no approval card.
    const cards = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    expect(cards.payload?.questions || []).toEqual([]);

    const queued = await api("/api/relay/shutdown", { method: "POST", body: { reason: "e2e restart", requestedBy: "e2e-spec", restart: true } });
    expect(queued.status).toBe(200);
    expect(queued.payload.status, JSON.stringify(queued.payload)).toBe("shutting_down");

    // The supervisor brings the runtime back; the event comes after the 30 s coalescing.
    const { row, rows } = await waitForEventText(/relay_restarted: the relay runs again since .*after a restart requested by "e2e-spec" at .* \(reason "e2e restart"\)\./);
    expect(rows).toHaveLength(1);
    expect(row.text).toContain("A restart requested while this turn runs does not wake you again.");
    const active = await api("/api/relay-events/subscriptions");
    expect(active.payload.subscriptions, "the one-shot subscription ended with it").toEqual([]);

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForFunction(() => typeof window.openConversation === "function");
    const eventRow = page.locator(".msg.relay-event").last();
    await expect(eventRow.locator(".relay-event-text")).toHaveText("1 event · relay restarted");
  });

  test("a stop by signal and a start on the same state: the event says it was stopped", async ({ page }) => {
    // On Windows the harness's stop ends the process without its SIGTERM
    // handler, so the relay records no end and the line says it did not
    // record how it stopped.
    test.skip(process.platform === "win32", "no SIGTERM handler on Windows");
    const subscribed = await tool("subscribe", { events: ["relay_restarted"] });
    expect(subscribed.status, JSON.stringify(subscribed.payload)).toBe(200);
    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await expect(page.locator("#chat-title-relay-events .relay-watch-chip")).toHaveText("👁 waiting for a relay restart");

    const state = relay.state;
    const { port, token } = relay;
    await relay.kill();
    relay = await startRelayServer({ token, port, state });

    // The first event row is still pending (no worker took it): the new line is written into it.
    const { rows } = await waitForEventText(/after it was stopped \(SIGTERM\) at /);
    expect(rows).toHaveLength(1);
    expect((String(rows[0].text).match(/relay_restarted:/g) || []).length).toBe(2);
    const active = await api("/api/relay-events/subscriptions");
    expect(active.payload.subscriptions, "a subscription without once stays").toHaveLength(1);
  });
});
