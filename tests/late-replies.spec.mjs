import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { reserveFreePort, sleep, startRelayServer } from "./relay-server-harness.mjs";
import { attemptOf, completeTurn, createFakeWorker, settleFakeWorkers, startConversation } from "./helpers/fake-worker.mjs";

// No turn a fake worker still holds outlives this file.
test.afterAll(() => settleFakeWorkers());

/**
 * Late replies end to end, without a model: a conversation prompts another
 * session through POST /api/remote-relays/tool the way a worker's tool
 * adapter calls it, does not wait (or stops waiting), and the spec answers
 * the other session's turn as its worker (helpers/fake-worker.mjs). The
 * reply then comes into the sender's conversation by itself, as a relay
 * event row. On this relay the end of the turn makes the relay look at once;
 * toward a paired relay it looks within 15 s, here every second
 * (OAR_LATE_REPLY_TEST_PASS_MS, which also makes the "nothing more comes"
 * windows a few passes long). Both relays are the spec's own, so they can be
 * restarted on their state and the link cut.
 */

// The sweeper's pass, for these relays only: every open row each second.
const LATE_REPLY_ENV = Object.freeze({ OAR_LATE_REPLY_TEST_PASS_MS: "1000" });
// Long enough for three passes: what would come has come by then.
const QUIET_MS = 3_000;

function createApi(getRelay) {
  async function api(route, { method = "GET", body } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }
  api.relay = { baseUrl: () => getRelay().baseUrl, token: () => getRelay().token };
  return api;
}

async function waitFor(check, { timeout = 20_000, interval = 250, what = "the condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function eventRows(api, conversationId) {
  const { payload } = await api(`/api/conversation/${encodeURIComponent(conversationId)}?limit=100`);
  return (payload?.messages || []).filter((message) => message.kind === "relay-event");
}

/** The event rows that carry the late reply (or ack) to one prompt. */
async function lateRowsFor(api, conversationId, messageId) {
  return (await eventRows(api, conversationId)).filter((row) => row.text.includes(`to your prompt ${messageId}`));
}

function waitForLateReply(api, conversationId, messageId, { timeout = 20_000 } = {}) {
  return waitFor(async () => (await lateRowsFor(api, conversationId, messageId))[0] || null, { timeout, what: `the late reply to ${messageId}` });
}

/** Watches `conversationId` for `ms`: the number of late reply rows to `messageId` at the end. */
async function countLateRowsOver(api, conversationId, messageId, ms) {
  await sleep(ms);
  return (await lateRowsFor(api, conversationId, messageId)).length;
}

// The sender turns the spec holds: conversation id → { messageId, worker }.
const senderTurns = new Map();

// A conversation whose first message a "worker" has taken (its turn is
// processing, as while an agent's tool call arrives), held by a question so
// the relay does not hand the turn back for want of a CLI.
async function senderWithRunningTurn(api, text) {
  const { conversationId, messageId, worker } = await startConversation({ text }, api.relay);
  await worker.take(messageId);
  senderTurns.set(conversationId, { messageId, worker });
  const asked = await api("/api/relay-question", {
    method: "POST",
    body: { ...attemptOf(messageId), queueId: messageId, messageId, conversationId, mode: "agent", prompt: "Keep this turn open?", choices: ["Yes"], allowFreeform: false },
  });
  expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
  return conversationId;
}

/** The sender's held turn ends with a reply: the conversation is idle (it can be archived). */
async function endSenderTurn(conversationId) {
  const { messageId, worker } = senderTurns.get(conversationId);
  const answered = await worker.respond(messageId, { text: "Handed out; not waiting.", model: "gpt-5.4-mini", mode: "agent" });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
  senderTurns.delete(conversationId);
}

/** A session that answered its first message and is idle: the one prompted. */
async function idleSession(api, text) {
  const queued = await startConversation({ text }, api.relay);
  const done = await completeTurn(queued, { text: "ready", model: "gpt-5.4-mini", mode: "agent" }, { ...api.relay, stay: true });
  expect(done.status, JSON.stringify(done.payload)).toBe(200);
  return queued.conversationId;
}

/** The prompted session's worker answers the prompt `messageId`. */
async function answerAs(api, sessionId, messageId, text) {
  const worker = createFakeWorker({ ...api.relay, sessionId, conversationId: sessionId });
  await worker.take(messageId);
  const answered = await worker.respond(messageId, { text, model: "gpt-5.4-mini", mode: "agent" });
  expect(answered.status, JSON.stringify(answered.payload)).toBe(200);
}

test.describe.serial("late replies on this relay", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;
  const api = createApi(() => relay);
  const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args: { relay: "this", ...args } },
  });
  let lane = "";

  test.beforeAll(async () => {
    relay = await startRelayServer({ token: randomUUID(), overrides: LATE_REPLY_ENV });
    expect((await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    lane = await idleSession(api, `lane ${Date.now()}: report when asked`);
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("wait 0: the reply comes as a late reply, whole, folded in the transcript, and no turn_end", async ({ page }) => {
    const lead = await senderWithRunningTurn(api, "lead: hand out the work");
    const subscribe = tool(lead, "subscribe", { sessions: [lane], events: ["turn_end"] });
    const card = await waitFor(async () => {
      const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(lead)}`);
      return (payload?.questions || []).find((question) => question?.context?.source === "remote_relay") || null;
    }, { what: "the subscribe card" });
    const allowed = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
      method: "POST",
      body: { answer: "Allow", ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
    });
    expect(allowed.status, JSON.stringify(allowed.payload)).toBe(200);
    expect((await subscribe).status).toBe(200);

    const sent = await tool(lead, "send", { session: lane, text: "Report the four points.", wait_seconds: 0 });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    expect(sent.payload.status).toBe("queued");
    const reply = ["Lane report: all four points are fixed.", "1. export", "2. sidebar", "3. tests", "4. docs"].join("\n");
    await answerAs(api, lane, sent.payload.message_id, reply);

    const row = await waitForLateReply(api, lead, sent.payload.message_id);
    expect(row.text).toContain("late reply from session");
    expect(row.text).toContain("Your reply to this message reaches nobody: to answer, use relay_tool send.");
    for (const line of reply.split("\n")) expect(row.text).toContain(`[relay event] > ${line}`);
    expect((await eventRows(api, lead)).some((event) => /turn_end/.test(event.text)), "no turn_end besides the late reply").toBe(false);

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, lead);
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    const shown = page.locator(`.msg.relay-event[data-message-id="${row.id}"]`);
    await expect(shown).toBeVisible({ timeout: 20_000 });
    await expect(shown.locator(".relay-event-text")).toHaveText(/^late reply from /);
    await expect(shown.locator("details")).not.toHaveAttribute("open", /.*/);
  });

  test("a wait that ran out: the late reply comes once, and a later wait still answers with the note", async () => {
    const lead = await senderWithRunningTurn(api, "lead: a short wait");
    const sent = await tool(lead, "send", { session: lane, text: "Take your time.", wait_seconds: 2 });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    // The call came back without the reply: the lane answers after the wait.
    expect(["queued", "running"]).toContain(sent.payload.status);
    await answerAs(api, lane, sent.payload.message_id, "Took my time: done.");
    await waitForLateReply(api, lead, sent.payload.message_id);
    expect(await countLateRowsOver(api, lead, sent.payload.message_id, QUIET_MS)).toBe(1);
    const waited = await tool(lead, "wait", { session: lane, message_id: sent.payload.message_id, wait_seconds: 5 });
    expect(waited.payload.status).toBe("done");
    expect(waited.payload.reply.text).toBe("Took my time: done.");
    expect(waited.payload.note).toMatch(/Also delivered to your conversation as a late reply at \d\d:\d\dZ\./);
  });

  test("a wait that gets the reply: no late reply comes", async () => {
    const lead = await senderWithRunningTurn(api, "lead: waits for it");
    const calling = tool(lead, "send", { session: lane, text: "Quick one.", wait_seconds: 30 });
    const queued = await waitFor(async () => {
      const { payload } = await api(`/api/conversation/${encodeURIComponent(lane)}?limit=5`);
      return (payload?.messages || []).find((message) => message.role === "user" && message.text.includes("Quick one.")) || null;
    }, { what: "the prompt in the lane" });
    await answerAs(api, lane, queued.id, "Quick answer.");
    const sent = await calling;
    expect(sent.payload.status).toBe("done");
    expect(await countLateRowsOver(api, lead, sent.payload.message_id, QUIET_MS)).toBe(0);
  });

  test("an ack wakes nobody and rides along with the next late reply", async () => {
    const lead = await senderWithRunningTurn(api, "lead: acks");
    const first = await tool(lead, "send", { session: lane, text: "Noted?", wait_seconds: 0 });
    await answerAs(api, lane, first.payload.message_id, "[ack] got it");
    expect(await countLateRowsOver(api, lead, first.payload.message_id, QUIET_MS)).toBe(0);
    const second = await tool(lead, "send", { session: lane, text: "Now the details.", wait_seconds: 0 });
    await answerAs(api, lane, second.payload.message_id, "The details: export fixed, rerun green.");
    const row = await waitForLateReply(api, lead, second.payload.message_id);
    expect(row.text).toContain(`ack from session`);
    expect(row.text).toContain(`to your prompt ${first.payload.message_id}`);
    expect(row.text).toContain("The details: export fixed, rerun green.");
    expect((await eventRows(api, lead)).filter((event) => event.text.includes("late_reply"))).toHaveLength(1);
  });

  // The floor of this test is the lane's own event coalescing (30 s): the
  // word to the lane is not urgent, as the plan has it.
  test("undeliverable: the sender is archived before the reply, and the lane is told once", async () => {
    const lead = await senderWithRunningTurn(api, "lead: leaves early");
    const sent = await tool(lead, "send", { session: lane, text: "Answer after I am gone.", wait_seconds: 0 });
    // A conversation with a turn running is not archived (409): its turn ends first.
    await endSenderTurn(lead);
    const archived = await api(`/api/conversation/${encodeURIComponent(lead)}/archive`, { method: "POST" });
    expect(archived.status, JSON.stringify(archived.payload)).toBe(200);
    await answerAs(api, lane, sent.payload.message_id, "Here you go.");
    const told = await waitFor(async () => (await eventRows(api, lane)).find((row) => /reply_undelivered/.test(row.text)) || null, { timeout: 60_000, what: "reply_undelivered in the lane" });
    expect(told.text).toContain(`(${lead})`);
    expect(told.text).toContain("reached nobody: that session was archived.");
    await sleep(QUIET_MS);
    expect((await eventRows(api, lane)).filter((row) => /reply_undelivered/.test(row.text))).toHaveLength(1);
  });
});

test.describe.serial("late replies across relays", () => {
  test.describe.configure({ timeout: 180_000 });

  let relayA = null;
  let relayB = null;
  const apiA = createApi(() => relayA);
  const apiB = createApi(() => relayB);
  const tool = (conversationId, action, args = {}) => apiA("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args: { relay: "linux-test", ...args } },
  });
  let pairingId = "";
  let lane = "";

  test.beforeAll(async () => {
    relayA = await startRelayServer({ token: randomUUID(), overrides: LATE_REPLY_ENV });
    relayB = await startRelayServer({ token: randomUUID() });
    expect((await apiA("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await apiB("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    // Paired both ways, so A's prompts are verified on B (origin binding);
    // only A, the sender's relay, does anything for a late reply.
    expect((await apiA("/api/settings/remote-relays", { method: "POST", body: { publicUrl: relayA.baseUrl } })).status).toBe(200);
    const added = await apiA("/api/remote-relays", { method: "POST", body: { url: relayB.baseUrl, token: relayB.token } });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    expect(added.payload?.pairedBack, JSON.stringify(added.payload)).toBe(true);
    pairingId = added.payload.relay.id;
    lane = await idleSession(apiB, `lane on linux-test ${Date.now()}`);
  });

  test.afterAll(async () => {
    for (const relay of [relayA, relayB]) if (relay) await relay.stop();
    relayA = null;
    relayB = null;
  });

  test("wait 0 to a paired relay: the late reply comes within the first cadence steps", async () => {
    // The first message names the relay, which unlocks it for the conversation.
    const lead = await senderWithRunningTurn(apiA, "lead: ask linux-test for the report");
    const sent = await tool(lead, "send", { session: lane, text: "Report from there.", wait_seconds: 0 });
    expect(sent.status, JSON.stringify(sent.payload)).toBe(200);
    await answerAs(apiB, lane, sent.payload.message_id, "Report from linux-test.");
    const row = await waitForLateReply(apiA, lead, sent.payload.message_id, { timeout: 40_000 });
    expect(row.text).toContain('on relay "linux-test"');
    expect(row.text).toContain("[relay event] > Report from linux-test.");
  });

  test("the link is cut while the lane answers: the reply comes once the link is back, once", async () => {
    const lead = await senderWithRunningTurn(apiA, "lead: linux-test while the link drops");
    const sent = await tool(lead, "send", { session: lane, text: "Answer during the outage.", wait_seconds: 0 });
    const deadPort = await reserveFreePort();
    expect((await apiA(`/api/remote-relays/${pairingId}`, { method: "PATCH", body: { url: `http://127.0.0.1:${deadPort}` } })).status).toBe(200);
    try {
      await answerAs(apiB, lane, sent.payload.message_id, "Answered while you could not see me.");
      // A pass a second: several reads failed by now.
      expect(await countLateRowsOver(apiA, lead, sent.payload.message_id, QUIET_MS + 1_000)).toBe(0);
    } finally {
      expect((await apiA(`/api/remote-relays/${pairingId}`, { method: "PATCH", body: { url: relayB.baseUrl } })).status).toBe(200);
    }
    await waitForLateReply(apiA, lead, sent.payload.message_id, { timeout: 40_000 });
    expect(await countLateRowsOver(apiA, lead, sent.payload.message_id, QUIET_MS)).toBe(1);
  });

  test("the sender's relay restarts while the reply is in flight: it comes after the restart, once", async () => {
    const lead = await senderWithRunningTurn(apiA, "lead: linux-test across a restart");
    const sent = await tool(lead, "send", { session: lane, text: "Answer while my relay restarts.", wait_seconds: 0 });
    await relayA.kill();
    await answerAs(apiB, lane, sent.payload.message_id, "Answered across the restart.");
    relayA = await startRelayServer({ token: relayA.token, port: relayA.port, state: relayA.state, overrides: LATE_REPLY_ENV });
    await waitForLateReply(apiA, lead, sent.payload.message_id, { timeout: 40_000 });
    expect(await countLateRowsOver(apiA, lead, sent.payload.message_id, QUIET_MS)).toBe(1);
  });
});
