import { randomUUID } from "node:crypto";
import http from "node:http";

import { expect, test } from "@playwright/test";

import { reserveFreePort, sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Relay event subscriptions across two relays, end to end, without a model:
 * relay A ("win-test") holds the watching conversations, relay B
 * ("linux-test") the watched sessions. A is paired with B in one direction
 * only. A conversation subscribes through A's POST /api/remote-relays/tool
 * the way a worker's tool adapter calls it, the spec plays the user on the
 * approval cards, and B's events (questions, replies) arrive in the watcher
 * as event rows that A fetched. Both relays are the spec's own, so they can
 * be restarted on their state and the link between them cut.
 *
 * No worker runs: a "turn" is a message the spec took off the queue (GET
 * /api/pending) or answered (POST /api/response), which is what approval
 * cards and questions sit on and what ends a turn.
 */

const APPROVAL_TIMEOUT = 20_000;
// Longer than the link's gap (60 s) without an answer.
const GAP_WAIT_MS = 63_000;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

async function waitFor(check, { timeout = 20_000, interval = 250, what = "the condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function waitForApprovalCard(api, conversationId) {
  return waitFor(async () => {
    const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    return (payload?.questions || []).find((question) => question?.context?.source === "remote_relay") || null;
  }, { timeout: APPROVAL_TIMEOUT, what: `an approval card on ${conversationId.slice(0, 8)}` });
}

function answerCard(api, card, answer) {
  return api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
    method: "POST",
    body: { answer, ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
  });
}

/** A tool call that shows a card: Allow it (or Deny), then the call's answer. */
async function withCard(api, conversationId, calling, answer = "Allow") {
  const card = await waitForApprovalCard(api, conversationId);
  expect((await answerCard(api, card, answer)).status).toBe(200);
  return { card, result: await calling };
}

// A conversation whose first message a "worker" has taken: its turn is
// processing. Called while nothing else is queued on that relay, so the
// dequeue can only return this message.
async function conversationWithRunningTurn(api, text) {
  const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const { conversationId, messageId, ownerSessionId } = queued.payload;
  const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: conversationId, conversation_id: conversationId } });
  expect(synced.status, JSON.stringify(synced.payload)).toBe(200);
  const headers = ownerSessionId ? { "x-relay-session-id": String(ownerSessionId) } : {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dequeued = await api("/api/pending", { headers });
    if (String(dequeued.payload?.message?.id || "") === messageId) return { conversationId, messageId };
    await sleep(250);
  }
  throw new Error("The message was never handed out");
}

/** A turn that starts and ends with a reply: turn_end for whoever watches. */
async function finishTurn(api, conversationId, text, reply) {
  const queued = await api("/api/message", { method: "POST", body: { conversationId, text, relayMode: "agent", model: "gpt-5.4-mini" } });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
  const done = await api("/api/response", {
    method: "POST",
    body: { messageId: queued.payload.messageId, conversationId, text: reply, model: "gpt-5.4-mini", mode: "agent" },
  });
  expect(done.status, JSON.stringify(done.payload)).toBe(200);
}

function askQuestion(api, turn, prompt, choices = ["Yes", "No"]) {
  return api("/api/relay-question", {
    method: "POST",
    body: {
      queueId: turn.messageId,
      messageId: turn.messageId,
      conversationId: turn.conversationId,
      mode: "agent",
      prompt,
      choices,
      allowFreeform: false,
    },
  });
}

// A relay without a CLI hands a running turn back to the queue after 45 s
// without worker activity, unless a question waits on it: these turns must
// stay running for the whole spec (cards and questions sit on them).
async function holdTurn(api, turn) {
  expect((await askQuestion(api, turn, "Keep this turn open?", ["Yes"])).status).toBe(200);
  return turn;
}

async function eventRows(api, conversationId) {
  const { payload } = await api(`/api/conversation/${encodeURIComponent(conversationId)}?limit=100`);
  return (payload?.messages || []).filter((message) => message.kind === "relay-event");
}

async function waitForEventRow(api, conversationId, pattern, { timeout = 20_000 } = {}) {
  return waitFor(async () => (await eventRows(api, conversationId)).find((row) => pattern.test(row.text)) || null, {
    timeout,
    what: `an event row matching ${pattern}`,
  });
}

/** An OAR relay from before cross-relay subscriptions: identity and reads, a plain 404 for the rest. */
async function startOlderRelay(token) {
  const port = await reserveFreePort();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/relay/identity") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ relayId: "relay-fixture-older", name: "older-relay", version: "0.9.8", remoteRelays: { protocol: 1, inbound: true } }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/conversation/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: url.pathname.split("/").pop(), title: "report builder", messages: [] }));
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(`<!DOCTYPE html><pre>Cannot ${req.method} ${url.pathname}</pre>`);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test.describe.serial("relay event subscriptions across relays", () => {
  test.describe.configure({ timeout: 180_000 });

  let relayA = null;
  let relayB = null;
  let olderRelay = null;
  const apiA = createApi(() => relayA);
  const apiB = createApi(() => relayB);
  const tool = (conversationId, action, args = {}) => apiA("/api/remote-relays/tool", {
    method: "POST",
    body: { conversationId, action, args: { relay: "linux-test", ...args } },
  });
  const suffix = Date.now();
  const titles = {
    builder: `orbit camera ${suffix}`,
    docs: `docs pass ${suffix}`,
  };
  let watcher = null;
  let second = null;
  let locked = null;
  let olderAsker = "";
  let builder = null;
  let docs = "";
  let pairingId = "";
  const subs = {};

  test.beforeAll(async () => {
    relayA = await startRelayServer({ token: randomUUID() });
    relayB = await startRelayServer({ token: randomUUID() });
    expect((await apiA("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await apiB("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    // One way: A knows B; B knows nobody.
    const added = await apiA("/api/remote-relays", { method: "POST", body: { url: relayB.baseUrl, token: relayB.token, pairBack: false } });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    pairingId = added.payload.relay.id;
    olderRelay = await startOlderRelay(relayB.token);
    const older = await apiA("/api/remote-relays", { method: "POST", body: { url: olderRelay.baseUrl, token: relayB.token, pairBack: false } });
    expect(older.payload?.ok, JSON.stringify(older.payload)).toBe(true);
    // The first messages name the relay, which unlocks it for the conversation.
    watcher = await holdTurn(apiA, await conversationWithRunningTurn(apiA, `relay assistant ${suffix}: watch linux-test for me`));
    second = await holdTurn(apiA, await conversationWithRunningTurn(apiA, `second watcher ${suffix}: take over linux-test`));
    locked = await conversationWithRunningTurn(apiA, `sidebar polish ${suffix}: local work only`);
    olderAsker = (await conversationWithRunningTurn(apiA, `report builder ${suffix}: ask older-relay`)).conversationId;
    builder = await holdTurn(apiB, await conversationWithRunningTurn(apiB, titles.builder));
    // Docs' first turn ends at once: its later turns are the spec's.
    const firstDocs = await conversationWithRunningTurn(apiB, titles.docs);
    docs = firstDocs.conversationId;
    await apiB("/api/response", { method: "POST", body: { messageId: firstDocs.messageId, conversationId: docs, text: "Ready.", model: "gpt-5.4-mini", mode: "agent" } });
  });

  test.afterAll(async () => {
    if (relayA) await relayA.stop();
    if (relayB) await relayB.stop();
    if (olderRelay) await olderRelay.close();
    relayA = null;
    relayB = null;
  });

  test("a one-way pairing; locked until the user names the relay; refused while it takes no agents", async () => {
    expect((await apiB("/api/remote-relays")).payload.relays).toEqual([]);
    const refused = await tool(locked.conversationId, "subscribe", { sessions: [builder.conversationId] });
    expect(refused.status).toBe(403);
    expect(refused.payload.code).toBe("REMOTE_RELAY_LOCKED");

    await apiB("/api/settings/remote-relays", { method: "POST", body: { inboundEnabled: false } });
    try {
      const closed = await tool(watcher.conversationId, "subscribe", { sessions: [builder.conversationId] });
      expect(closed.status).toBe(403);
      expect(closed.payload.code).toBe("REMOTE_INBOUND_DISABLED");
      const { payload } = await apiA(`/api/relay-questions?status=pending&conversationId=${watcher.conversationId}`);
      expect((payload.questions || []).filter((question) => question?.context?.source === "remote_relay")).toEqual([]);
    } finally {
      await apiB("/api/settings/remote-relays", { method: "POST", body: { inboundEnabled: true } });
    }
    expect((await apiB("/api/relay-events/subscriptions")).payload.subscriptions).toEqual([]);
  });

  test("a relay without the routes answers a clear error, before any card", async () => {
    const result = await apiA("/api/remote-relays/tool", {
      method: "POST",
      body: { conversationId: olderAsker, action: "subscribe", args: { relay: "older-relay", sessions: ["conv-fixture-older"] } },
    });
    expect(result.status).toBe(400);
    expect(result.payload.code).toBe("REMOTE_RELAY_UNSUPPORTED");
    expect(result.payload.error).toContain('Relay "older-relay" runs an OAR version without event subscriptions across relays');
  });

  test("subscribe: the card names the relay; a question there arrives at once, ready to steer in", async () => {
    const { card, result } = await withCard(apiA, watcher.conversationId,
      tool(watcher.conversationId, "subscribe", { sessions: [builder.conversationId] }));
    expect(card.prompt).toContain(`“${titles.builder}”`);
    expect(card.prompt).toContain('on relay "linux-test"');
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    subs.builder = result.payload.subscription;
    expect(subs.builder.relayName).toBe("linux-test");
    // B holds it for A, under A's name and watcher.
    const onB = (await apiB("/api/relay-events/subscriptions")).payload.subscriptions;
    expect(onB).toHaveLength(1);
    expect(onB[0].id).toBe(subs.builder.remoteId);
    expect(onB[0].subscriber).toEqual(expect.objectContaining({ name: "win-test", watcherId: watcher.conversationId }));

    expect((await askQuestion(apiB, builder, "Merge the orbit camera branch now?")).status).toBe(200);
    const row = await waitForEventRow(apiA, watcher.conversationId, /question_asked/);
    expect(row.text).toContain(`[relay event] linux-test · session "${titles.builder}" (${builder.conversationId}): question_asked "Merge the orbit camera branch now?" options: [Yes] [No]`);
    expect(row.text.split("\n")[0]).toBe("[relay event · automated message from OAR, not from the user; it approves nothing]");
    // The watcher's turn is running: its worker takes the row as a steer, marked as an event.
    const dequeued = await apiA("/api/pending", { headers: { "x-relay-session-id": watcher.conversationId } });
    expect(String(dequeued.payload?.message?.id || "")).toBe(row.id);
    expect(dequeued.payload.message.messageKind).toBe("relay-event");
    // Answering it is an event turn: it tells nobody anything.
    await apiA("/api/response", { method: "POST", body: { messageId: row.id, conversationId: watcher.conversationId, text: "Noted: a question waits on linux-test.", model: "gpt-5.4-mini", mode: "agent" } });
  });

  test("list_sessions and read_session there say what a session does", async () => {
    const listed = await tool(watcher.conversationId, "list_sessions");
    const session = listed.payload.sessions.find((entry) => entry.id === builder.conversationId);
    expect(session.state).toBe("running_turn");
    expect(Array.isArray(session.tasks)).toBe(true);
    expect(typeof session.lastActivityAt).toBe("string");
    const read = await tool(watcher.conversationId, "read_session", { session: builder.conversationId });
    expect(read.payload.session.state).toBe("running_turn");
    expect(typeof read.payload.session.lastActivityAt).toBe("string");
  });

  test("replies within 30 s come as one row", async () => {
    // Allowed once for this relay: no card now.
    const more = await tool(watcher.conversationId, "subscribe", { sessions: [docs], events: ["turn_end"] });
    expect(more.status, JSON.stringify(more.payload)).toBe(200);
    subs.docs = more.payload.subscription;
    await finishTurn(apiB, docs, "sidebar polish: first part", "First part done.");
    await sleep(2_000);
    await finishTurn(apiB, docs, "sidebar polish: second part", "Second part done.");
    const row = await waitForEventRow(apiA, watcher.conversationId, /Second part done/, { timeout: 50_000 });
    expect(row.text).toMatch(/linux-test · session "[^"]+" \([^)]+\): turn_end \(done\) "First part done\."[\s\S]*turn_end \(done\) "Second part done\."/);
    expect((await eventRows(apiA, watcher.conversationId)).filter((entry) => /part done/.test(entry.text))).toHaveLength(1);
  });

  test("transfer to another conversation: the card names the relay, the other relay learns the new watcher", async () => {
    const { card, result } = await withCard(apiA, second.conversationId,
      tool(second.conversationId, "transfer_subscriptions", { from: watcher.conversationId }));
    expect(card.prompt).toContain('relay "linux-test"');
    expect(result.status, JSON.stringify(result.payload)).toBe(200);
    expect(result.payload.moved).toHaveLength(2);
    const listed = await tool(second.conversationId, "list_subscriptions");
    expect(listed.payload.subscriptions.filter((sub) => !sub.endedAt).map((sub) => sub.link.state)).toEqual(["ok", "ok"]);
    await waitFor(async () => {
      const onB = (await apiB("/api/relay-events/subscriptions")).payload.subscriptions;
      return onB.length === 2 && onB.every((sub) => sub.subscriber.watcherId === second.conversationId);
    }, { what: "the new watcher on B" });
  });

  test("a dropped link: what B kept comes as one replayed row, questions first, between link_lost and link_restored", async ({ page }) => {
    const deadPort = await reserveFreePort();
    expect((await apiA(`/api/remote-relays/${pairingId}`, { method: "PATCH", body: { url: `http://127.0.0.1:${deadPort}` } })).status).toBe(200);
    try {
      await finishTurn(apiB, docs, "sidebar polish: third part", "Third part done.");
      expect((await askQuestion(apiB, builder, "Rebase onto main first?")).status).toBe(200);
      await sleep(GAP_WAIT_MS);
      const during = await tool(second.conversationId, "list_subscriptions");
      expect(during.payload.subscriptions.find((sub) => !sub.endedAt).link.state).not.toBe("ok");
    } finally {
      expect((await apiA(`/api/remote-relays/${pairingId}`, { method: "PATCH", body: { url: relayB.baseUrl } })).status).toBe(200);
    }
    // A fresh list fetches at once.
    await tool(second.conversationId, "list_subscriptions");
    const row = await waitForEventRow(apiA, second.conversationId, /link_restored/);
    const lines = row.text.split("\n");
    expect(lines[1]).toMatch(/^\[relay event\] linux-test · link_lost: no answer from relay "linux-test" since /);
    expect(lines[2]).toMatch(/^Replayed: 2 events relay "linux-test" kept while the link was down, questions and errors first:$/);
    expect(lines[3]).toContain('question_asked "Rebase onto main first?"');
    expect(lines[4]).toContain('turn_end (done) "Third part done."');
    expect(lines[5]).toMatch(/link_restored: relay "linux-test" answers again after \d+ min; 2 events it kept meanwhile are listed above$/);

    await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, second.conversationId);
    await page.goto(`${relayA.baseUrl}/?token=${encodeURIComponent(relayA.token)}`);
    const shown = page.locator(`.msg.relay-event[data-message-id="${row.id}"]`);
    await expect(shown).toBeVisible({ timeout: 20_000 });
    await expect(shown.locator(".relay-event-replayed")).toHaveText("replayed");
    await expect(shown.locator(".relay-event-line").first()).toContainText("linux-test · link_lost");
    await expect(page.locator("#chat-title-relay-events .relay-watch-chip")).toHaveText("👁 watching 2 sessions");
  });

  test("B restarts: its subscriptions stay, and an unsubscribe made while it was down reaches it", async () => {
    await relayB.kill();
    const ended = await tool(second.conversationId, "unsubscribe", { subscription_id: subs.docs.id });
    expect(ended.status, JSON.stringify(ended.payload)).toBe(200);
    expect(ended.payload.note).toMatch(/Relay "linux-test" did not answer .*learns of the end once it answers again/);
    relayB = await startRelayServer({ token: relayB.token, port: relayB.port, state: relayB.state });
    await waitFor(async () => {
      const onB = (await apiB("/api/relay-events/subscriptions")).payload.subscriptions;
      return onB.length === 1 && onB[0].id === subs.builder.remoteId;
    }, { timeout: 30_000, what: "the end on B after its restart" });
    expect((await askQuestion(apiB, builder, "Ship after the restart?")).status).toBe(200);
    await waitForEventRow(apiA, second.conversationId, /Ship after the restart\?/);
  });

  test("A restarts: its subscriptions stay and fetching goes on", async () => {
    await relayA.kill();
    expect((await askQuestion(apiB, builder, "Still there after A restarted?")).status).toBe(200);
    relayA = await startRelayServer({ token: relayA.token, port: relayA.port, state: relayA.state });
    const listed = await tool(second.conversationId, "list_subscriptions");
    expect(listed.payload.subscriptions.filter((sub) => !sub.endedAt).map((sub) => sub.id)).toEqual([subs.builder.id]);
    await waitForEventRow(apiA, second.conversationId, /Still there after A restarted\?/);
  });

  test("archiving ends subscriptions: the watched session on B, the watcher on A", async () => {
    // A session is archived once its turn is over.
    await apiB("/api/response", { method: "POST", body: { messageId: builder.messageId, conversationId: builder.conversationId, text: "Orbit camera merged.", model: "gpt-5.4-mini", mode: "agent" } });
    const archived = await apiB(`/api/conversation/${builder.conversationId}/archive`, { method: "POST", body: {} });
    expect(archived.status, JSON.stringify(archived.payload)).toBe(200);
    const listed = await tool(second.conversationId, "list_subscriptions");
    expect(listed.payload.subscriptions.find((sub) => sub.id === subs.builder.id).endReason).toBe("archived");

    const again = await tool(watcher.conversationId, "subscribe", { sessions: [docs] });
    expect(again.status, JSON.stringify(again.payload)).toBe(200);
    await apiA("/api/response", { method: "POST", body: { messageId: watcher.messageId, conversationId: watcher.conversationId, text: "Watching is over.", model: "gpt-5.4-mini", mode: "agent" } });
    const gone = await apiA(`/api/conversation/${watcher.conversationId}/archive`, { method: "POST", body: {} });
    expect(gone.status, JSON.stringify(gone.payload)).toBe(200);
    await waitFor(async () => {
      const onB = (await apiB("/api/relay-events/subscriptions")).payload.subscriptions;
      return onB.length === 0;
    }, { timeout: 30_000, what: "the end on B after the watcher was archived" });
  });

  test("removing the pairing ends the subscriptions on both sides", async () => {
    const fresh = await tool(second.conversationId, "subscribe", { sessions: [docs] });
    expect(fresh.status, JSON.stringify(fresh.payload)).toBe(200);
    expect((await apiB("/api/relay-events/subscriptions")).payload.subscriptions).toHaveLength(1);
    expect((await apiA(`/api/remote-relays/${pairingId}`, { method: "DELETE" })).status).toBe(200);
    await waitFor(async () => (await apiB("/api/relay-events/subscriptions")).payload.subscriptions.length === 0, { what: "the end on B" });
    const left = (await apiA("/api/relay-events/subscriptions")).payload.subscriptions;
    expect(left).toEqual([]);
  });
});

test.describe.serial("two watchers on two relays watching each other", () => {
  test.describe.configure({ timeout: 180_000 });

  let relayA = null;
  let relayB = null;
  const apiA = createApi(() => relayA);
  const apiB = createApi(() => relayB);
  let watcherA = null;
  let watcherB = null;

  test.beforeAll(async () => {
    relayA = await startRelayServer({ token: randomUUID() });
    relayB = await startRelayServer({ token: randomUUID() });
    await apiA("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } });
    await apiB("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } });
    expect((await apiA("/api/remote-relays", { method: "POST", body: { url: relayB.baseUrl, token: relayB.token, pairBack: false } })).payload?.ok).toBe(true);
    expect((await apiB("/api/remote-relays", { method: "POST", body: { url: relayA.baseUrl, token: relayA.token, pairBack: false } })).payload?.ok).toBe(true);
    watcherA = await holdTurn(apiA, await conversationWithRunningTurn(apiA, "report builder: keep an eye on linux-test"));
    watcherB = await holdTurn(apiB, await conversationWithRunningTurn(apiB, "sidebar polish: keep an eye on win-test"));
  });

  test.afterAll(async () => {
    if (relayA) await relayA.stop();
    if (relayB) await relayB.stop();
  });

  test("an event turn on one side wakes nobody on the other", async () => {
    // B's watcher's approval card comes while A's watcher already watches it.
    const subscribeA = apiA("/api/remote-relays/tool", { method: "POST", body: { conversationId: watcherA.conversationId, action: "subscribe", args: { relay: "linux-test", sessions: [watcherB.conversationId] } } });
    expect((await withCard(apiA, watcherA.conversationId, subscribeA)).result.status).toBe(200);
    const subscribeB = apiB("/api/remote-relays/tool", { method: "POST", body: { conversationId: watcherB.conversationId, action: "subscribe", args: { relay: "win-test", sessions: [watcherA.conversationId] } } });
    expect((await withCard(apiB, watcherB.conversationId, subscribeB)).result.status).toBe(200);

    // A's watcher ends an ordinary turn: B's watcher hears of it.
    await apiA("/api/response", { method: "POST", body: { messageId: watcherA.messageId, conversationId: watcherA.conversationId, text: "Report built.", model: "gpt-5.4-mini", mode: "agent" } });
    const row = await waitForEventRow(apiB, watcherB.conversationId, /win-test · session "[^"]+" \([^)]+\): turn_end \(done\) "Report built\."/, { timeout: 50_000 });
    // B's watcher answers that event: an event turn, which is no turn_end for A.
    const dequeued = await apiB("/api/pending", { headers: { "x-relay-session-id": watcherB.conversationId } });
    expect(String(dequeued.payload?.message?.id || "")).toBe(row.id);
    await apiB("/api/response", { method: "POST", body: { messageId: row.id, conversationId: watcherB.conversationId, text: "Seen: the report is built.", model: "gpt-5.4-mini", mode: "agent" } });
    await sleep(45_000);
    // B's watcher's own approval card was a question A's watcher heard of;
    // its event turn, no reply, no idle set.
    const heard = (await eventRows(apiA, watcherA.conversationId)).map((entry) => entry.text).join("\n");
    expect(heard).not.toMatch(/\): turn_end \(|· all_idle:|Seen: the report is built/);
  });
});
