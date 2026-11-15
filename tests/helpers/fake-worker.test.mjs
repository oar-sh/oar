import test from "node:test";
import assert from "node:assert/strict";

import { attemptOf, bootstrapConversation, completeTurn, createFakeWorker, fakeWorkerFor, relayPresence, respondAsWorker, startConversation, settleFakeWorkers, stopFakeWorkers } from "./fake-worker.mjs";

// A relay in memory: a queue of rows per session, every call recorded.
function fakeRelay({ pendingDelayMs = 0 } = {}) {
  const calls = [];
  const queue = [];
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { method: init.method, route, headers: init.headers, body };
    calls.push(call);
    let payload = { ok: true };
    if (route === "/api/pending") {
      if (pendingDelayMs) await new Promise((resolve) => setTimeout(resolve, pendingDelayMs));
      const index = queue.findIndex((row) => row.session === init.headers["x-relay-session-id"]);
      const row = index >= 0 ? queue.splice(index, 1)[0] : null;
      // Every hand-out is a new attempt of the row.
      if (row) row.attempts = (row.attempts || 0) + 1;
      payload = { message: row ? { id: row.id, attemptId: `attempt-${row.id}-${row.attempts}` } : null };
    }
    if (route === "/api/requeue") queue.push({ id: body.messageId, session: init.headers["x-relay-session-id"], attempts: Number(String(body.attemptId || "").split("-").pop()) || 0 });
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  };
  return { calls, queue, fetchImpl, of: (route) => calls.filter((call) => call.route === route) };
}

function workerOn(relay, sessionId, extra = {}) {
  return createFakeWorker({
    baseUrl: "http://relay.test",
    token: "token-fixture",
    sessionId,
    conversationId: `conv-${sessionId}`,
    pid: 4242,
    pollMs: 1,
    fetchImpl: relay.fetchImpl,
    ...extra,
  });
}

test.afterEach(() => stopFakeWorkers());

test("every call names the session, the conversation and the pid", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-identity");
  relay.queue.push({ id: "row-1", session: "session-identity" });
  await worker.take("row-1");
  await worker.respond("row-1", { text: "done" });
  assert.ok(relay.calls.length >= 3);
  for (const call of relay.calls) {
    assert.equal(call.headers["x-relay-session-id"], "session-identity");
    assert.equal(call.headers["x-relay-conversation-id"], "conv-session-identity");
    assert.equal(call.headers["x-relay-process-pid"], "4242");
    assert.equal(call.headers.Authorization, "Bearer token-fixture");
  }
  assert.deepEqual(relay.of("/api/response")[0].body, { messageId: "row-1", conversationId: "conv-session-identity", attemptId: "attempt-row-1-1", text: "done" });
});

test("a taken row is held: the heartbeat names it until it is answered", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-hold");
  relay.queue.push({ id: "row-1", session: "session-hold" });
  const message = await worker.take("row-1");
  assert.equal(message.id, "row-1");
  assert.deepEqual(worker.holding, ["row-1"]);
  // The heartbeat that follows the claim.
  assert.deepEqual(relay.of("/api/heartbeat").at(-1).body, { activeQueueMessageId: "row-1", activeQueueMessageIds: ["row-1"], workerKind: "copilot-sdk" });

  await worker.respond("row-1", { text: "done" });
  assert.deepEqual(worker.holding, []);
  assert.equal(await worker.beat(), true);
  assert.deepEqual(relay.of("/api/heartbeat").at(-1).body, { workerKind: "copilot-sdk" });
});

test("another row of the session handed out first goes back to the queue", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-order");
  relay.queue.push({ id: "row-old", session: "session-order" }, { id: "row-wanted", session: "session-order" });
  const message = await worker.take("row-wanted");
  assert.equal(message.id, "row-wanted");
  assert.deepEqual(relay.of("/api/requeue").map((call) => call.body.messageId), ["row-old"]);
  assert.deepEqual(worker.holding, ["row-wanted"]);
});

test("a heartbeat asked for during a poll waits for it and names the row it claimed", async () => {
  const relay = fakeRelay({ pendingDelayMs: 30 });
  const worker = workerOn(relay, "session-race");
  relay.queue.push({ id: "row-1", session: "session-race" });
  const polled = worker.poll();
  const beaten = worker.beat();
  await Promise.all([polled, beaten]);
  assert.equal(relay.calls[0].route, "/api/pending");
  assert.equal(relay.calls[1].route, "/api/heartbeat");
  for (const call of relay.of("/api/heartbeat")) assert.deepEqual(call.body.activeQueueMessageIds, ["row-1"]);
});

test("the heartbeat runs while a row is held and stops with it", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-timer", { heartbeatMs: 10 });
  relay.queue.push({ id: "row-1", session: "session-timer" });
  await worker.take("row-1");
  const afterTake = relay.of("/api/heartbeat").length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(relay.of("/api/heartbeat").length >= afterTake + 2, "periodic heartbeats while holding");
  for (const call of relay.of("/api/heartbeat")) assert.deepEqual(call.body.activeQueueMessageIds, ["row-1"]);

  await worker.requeue("row-1");
  const afterRelease = relay.of("/api/heartbeat").length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(relay.of("/api/heartbeat").length, afterRelease, "no heartbeat once nothing is held");
});

test("a relay that stays away is no longer told about the rows", async () => {
  const relay = fakeRelay();
  let down = false;
  const fetchImpl = (url, init) => {
    if (down) return Promise.reject(new Error("connect ECONNREFUSED"));
    return relay.fetchImpl(url, init);
  };
  const worker = workerOn(relay, "session-gone", { heartbeatMs: 5, fetchImpl });
  relay.queue.push({ id: "row-1", session: "session-gone" });
  await worker.take("row-1");
  down = true;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(worker.holding, []);
});

test("a hold nobody settled ends by itself", async () => {
  const relay = fakeRelay();
  let clock = 1_000;
  const worker = workerOn(relay, "session-expiry", { holdMs: 500, now: () => clock });
  worker.hold("row-1");
  assert.deepEqual(worker.holding, ["row-1"]);
  clock += 501;
  assert.deepEqual(worker.holding, []);
});

test("take says what the relay answered when no row came", async () => {
  const relay = fakeRelay();
  const blocked = async (url, init) => {
    await relay.fetchImpl(url, init);
    return { status: 200, ok: true, text: async () => JSON.stringify({ message: null, routing: { blockedReason: "restart-delayed" } }) };
  };
  const worker = workerOn(relay, "session-blocked", { fetchImpl: blocked });
  await assert.rejects(worker.take("row-1", { timeoutMs: 5 }), /message row-1 was not handed out within 5 ms \(restart-delayed\)/);
});

test("a steering snapshot set on a heartbeat rides on the later ones", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-steering");
  const steering = { turnActive: true, canSteer: false, holdReason: "question" };
  await worker.beat({ steering });
  await worker.beat();
  assert.deepEqual(relay.of("/api/heartbeat").map((call) => call.body.steering), [steering, steering]);
  await worker.beat({ steering: null });
  assert.equal(relay.of("/api/heartbeat").at(-1).body.steering, undefined);
});

test("a worker's background tasks: their digest rides on the heartbeat, and the relay's request for the set is passed on", async () => {
  const relay = fakeRelay();
  const tasks = ["task-a"];
  let resyncs = 0;
  const asking = async (url, init) => {
    const answer = await relay.fetchImpl(url, init);
    if (new URL(url).pathname !== "/api/heartbeat") return answer;
    return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, resyncBackgroundTasks: true }) };
  };
  const worker = workerOn(relay, "session-tasks", { fetchImpl: asking });
  await worker.beat();
  assert.equal(relay.of("/api/heartbeat")[0].body.backgroundTasks, undefined, "no digest from a worker that reports no tasks");

  worker.use({ getBackgroundTaskIds: () => tasks, onResyncBackgroundTasks: () => { resyncs += 1; } });
  await worker.beat();
  assert.ok(relay.of("/api/heartbeat")[1].body.backgroundTasks, "the digest of the task ids");
  assert.equal(resyncs, 1);
  assert.deepEqual(worker.calls.map((call) => call.route), ["/api/heartbeat", "/api/heartbeat"]);
});

test("every write about a held row can name the attempt the relay handed out", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-attempt");
  relay.queue.push({ id: "row-old", session: "session-attempt" }, { id: "row-1", session: "session-attempt" });
  await worker.take("row-1");
  // The row handed out first went back with its own attempt.
  assert.deepEqual(relay.of("/api/requeue")[0].body, { messageId: "row-old", attemptId: "attempt-row-old-1" });
  assert.deepEqual(worker.attemptOf("row-1"), { attemptId: "attempt-row-1-1" });
  assert.deepEqual(attemptOf("row-1"), { attemptId: "attempt-row-1-1" });
  assert.deepEqual(attemptOf("row-nobody-holds"), {});
  await worker.respond("row-1", { text: "done" });
  assert.equal(relay.of("/api/response")[0].body.attemptId, "attempt-row-1-1");
  assert.deepEqual(attemptOf("row-1"), {});
});

test("a reply goes out as the worker that holds the row, and only as that worker", async () => {
  const relay = fakeRelay();
  const worker = workerOn(relay, "session-reply");
  relay.queue.push({ id: "row-held", session: "session-reply" });
  await worker.take("row-held");
  const held = await respondAsWorker("row-held", { text: "done" });
  assert.equal(held.ok, true);
  assert.equal(relay.of("/api/response")[0].headers["x-relay-session-id"], "session-reply");
  assert.deepEqual(worker.holding, []);

  await assert.rejects(respondAsWorker("row-free", { text: "done" }), /no fake worker holds message row-free: take it first/);
  assert.equal(relay.of("/api/response").length, 1);
});

test("a whole turn in one call: taken by the session's worker, then answered", async () => {
  const relay = fakeRelay();
  relay.queue.push({ id: "row-1", session: "session-turn" });
  const options = { baseUrl: "http://relay.test", token: "token-fixture", pid: 4242, pollMs: 1, fetchImpl: relay.fetchImpl };
  const answered = await completeTurn({ conversationId: "conv-turn", ownerSessionId: "session-turn", messageId: "row-1" }, { text: "done" }, options);
  assert.equal(answered.ok, true);
  assert.deepEqual(relay.of("/api/response")[0].body, { messageId: "row-1", conversationId: "conv-turn", attemptId: "attempt-row-1-1", text: "done" });
});

test("the end of a spec file: rows still held are answered, the workers stop, and the spec fails naming them", async () => {
  const relay = fakeRelay();
  const settledWorker = workerOn(relay, "session-settled");
  const leftWorker = workerOn(relay, "session-left");
  relay.queue.push({ id: "row-settled", session: "session-settled" }, { id: "row-left", session: "session-left" });
  await settledWorker.take("row-settled");
  await settledWorker.respond("row-settled", { text: "done" });
  await leftWorker.take("row-left");

  await assert.rejects(settleFakeWorkers(), /1 turn\(s\) were still running at the end of the spec and were answered: row-left/);
  const answers = relay.of("/api/response");
  assert.equal(answers.at(-1).body.messageId, "row-left");
  assert.equal(answers.at(-1).body.attemptId, "attempt-row-left-1");
  assert.deepEqual(leftWorker.holding, []);
  // A new worker for the session: the old ones are gone.
  assert.notEqual(workerOn(relay, "session-left"), leftWorker);

  // Nothing held: nothing to say.
  assert.deepEqual(await settleFakeWorkers(), []);
});

test("the end of a spec file: a held row the relay no longer has does not fail the spec", async () => {
  const relay = fakeRelay();
  const gone = async (url, init) => {
    const answer = await relay.fetchImpl(url, init);
    if (new URL(url).pathname !== "/api/response") return answer;
    return { status: 404, ok: false, text: async () => JSON.stringify({ error: "Message not found" }) };
  };
  const worker = workerOn(relay, "session-deleted", { fetchImpl: gone });
  relay.queue.push({ id: "row-deleted", session: "session-deleted" });
  await worker.take("row-deleted");
  assert.deepEqual(await settleFakeWorkers(), []);
  assert.deepEqual(worker.holding, []);
});

test("every heartbeat states the worker's kind: the Copilot SDK worker's unless the spec names another", async () => {
  const relay = fakeRelay();
  await workerOn(relay, "session-kind").beat();
  await workerOn(relay, "session-kind-claude", { workerKind: "claude" }).beat();
  assert.deepEqual(relay.of("/api/heartbeat").map((call) => call.body.workerKind), ["copilot-sdk", "claude"]);
});

test("on a relay that launches its workers, the worker says its kind when asked, after a restart too", async () => {
  const relay = fakeRelay();
  // What such a relay knows: the kind each session's worker stated in a
  // heartbeat, in memory only. It hands nothing to a poller it knows no kind
  // for.
  const kinds = new Map();
  const launching = async (url, init) => {
    const route = new URL(url).pathname;
    const session = init.headers["x-relay-session-id"];
    if (route === "/api/heartbeat") {
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.workerKind) kinds.set(session, body.workerKind);
    }
    if (route === "/api/pending" && !kinds.has(session)) {
      relay.calls.push({ method: init.method, route, headers: init.headers, body: null });
      return { status: 200, ok: true, text: async () => JSON.stringify({ message: null, reason: "worker-kind-unstated" }) };
    }
    return relay.fetchImpl(url, init);
  };
  const worker = workerOn(relay, "session-launching", { fetchImpl: launching });
  relay.queue.push({ id: "row-1", session: "session-launching" });
  assert.equal((await worker.take("row-1", { timeoutMs: 50 })).id, "row-1");
  assert.deepEqual(relay.calls.map((call) => call.route), ["/api/pending", "/api/heartbeat", "/api/pending", "/api/heartbeat"]);
  assert.equal(relay.calls[1].body.workerKind, "copilot-sdk");
  await worker.respond("row-1", { text: "done" });

  // The relay restarts and forgets every kind; the same worker carries on.
  kinds.clear();
  relay.queue.push({ id: "row-2", session: "session-launching" });
  assert.equal((await worker.take("row-2", { timeoutMs: 50 })).id, "row-2");
  assert.equal(kinds.get("session-launching"), "copilot-sdk");
});

test("presence without a turn: a heartbeat now and on every interval until stopped", async () => {
  const relay = fakeRelay();
  const presence = relayPresence({ baseUrl: "http://relay.test", token: "token-fixture", everyMs: 5, fetchImpl: relay.fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 40));
  presence.stop();
  const sent = relay.of("/api/heartbeat").length;
  assert.ok(sent >= 3, `several heartbeats (${sent})`);
  assert.equal(relay.of("/api/heartbeat")[0].headers["x-relay-session-id"], undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.of("/api/heartbeat").length, sent);
  assert.equal(await presence.beat(), true);
});

test("a conversation started as the web client starts one: bootstrap, its first message, then the session's worker", async () => {
  const relay = fakeRelay();
  const fetchImpl = async (url, init) => {
    const answer = await relay.fetchImpl(url, init);
    const route = new URL(url).pathname;
    if (route === "/api/conversation/bootstrap") return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true, conversationId: "conv-started" }) };
    if (route === "/api/message") {
      relay.queue.push({ id: "row-first", session: "conv-started" });
      return { status: 200, ok: true, text: async () => JSON.stringify({ conversationId: "conv-started", messageId: "row-first", ownerSessionId: "conv-started" }) };
    }
    return answer;
  };
  const started = await startConversation({ text: "How long do the suites take" }, { baseUrl: "http://relay.test", token: "token-fixture", pid: 4242, pollMs: 1, fetchImpl });
  assert.deepEqual(relay.of("/api/conversation/bootstrap")[0].body, { title: "How long do the suites take", model: "gpt-5.4-mini", relayMode: "agent" });
  assert.deepEqual(relay.of("/api/message")[0].body, { conversationId: "conv-started", text: "How long do the suites take", relayMode: "agent", model: "gpt-5.4-mini" });
  assert.equal(started.messageId, "row-first");
  assert.equal(started.worker.sessionId, "conv-started");
  await started.worker.take("row-first");
  await started.worker.respond("row-first", { text: "done" });
  assert.deepEqual(relay.calls.map((call) => call.route), ["/api/conversation/bootstrap", "/api/message", "/api/pending", "/api/heartbeat", "/api/response"]);
  assert.equal(relay.of("/api/pending")[0].headers["x-relay-conversation-id"], "conv-started");
});

test("a conversation made through bootstrap alone, with a title cut to the relay's length; a refusal names the route", async () => {
  const relay = fakeRelay();
  const options = { baseUrl: "http://relay.test", token: "token-fixture" };
  const answering = (status, payload) => async (url, init) => {
    await relay.fetchImpl(url, init);
    return { status, ok: status < 400, text: async () => JSON.stringify(payload) };
  };
  const made = await bootstrapConversation({ title: "t".repeat(100), providerType: "openai" }, { ...options, fetchImpl: answering(200, { ok: true, conversationId: "conv-made" }) });
  assert.equal(made, "conv-made");
  assert.deepEqual(relay.of("/api/conversation/bootstrap")[0].body, { title: "t".repeat(80), model: "gpt-5.4-mini", relayMode: "agent", providerType: "openai" });
  await assert.rejects(
    bootstrapConversation({ title: "refused" }, { ...options, fetchImpl: answering(400, { error: "no" }) }),
    /\/api\/conversation\/bootstrap answered 400 \{"error":"no"\}/,
  );
});

test("one worker per session: asking again returns it, with what it holds", async () => {
  const relay = fakeRelay();
  const first = workerOn(relay, "session-same");
  first.hold("row-1");
  const again = fakeWorkerFor({ conversationId: "conv-next", ownerSessionId: "session-same" }, { fetchImpl: relay.fetchImpl });
  assert.equal(again, first);
  assert.deepEqual(again.holding, ["row-1"]);
  assert.equal(again.conversationId, "conv-next");

  // No owner in the answer: the conversation is the session.
  const unowned = fakeWorkerFor({ conversationId: "conv-unowned" }, { baseUrl: "http://relay.test", token: "token-fixture", fetchImpl: relay.fetchImpl });
  assert.equal(unowned.sessionId, "conv-unowned");

  first.stop();
  assert.notEqual(workerOn(relay, "session-same"), first);
});
