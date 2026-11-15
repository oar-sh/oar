/**
 * A session worker played by the test process.
 *
 * The test relay launches no worker (CLI spawn is disabled: it defers the
 * launch), and with session worker routing on every queued row belongs to its
 * conversation's session: it waits for a worker the relay takes for alive. This helper is that
 * worker over the HTTP worker routes:
 *
 *  - it names itself on every call (session id, conversation id, and the pid
 *    of this process, which the relay probes: a worker without a live pid
 *    counts as gone, and its turns are taken back);
 *  - it claims rows of its session only (`take`);
 *  - while it holds a row it sends the heartbeat a worker sends, naming the
 *    rows it holds, so the relay neither counts it as stale nor takes a held
 *    row back. A heartbeat that left a held row out would hand that row back
 *    to the queue, so polls and heartbeats of one worker never overlap.
 *
 * One worker per session id in a process: `fakeWorkerFor` and
 * `createFakeWorker` return the one already made for a session.
 *
 * A conversation is made the way the web client makes one, bound to its
 * session from the start (`startConversation`):
 *
 *   const started = await startConversation({ text: "How long do the suites take" });
 *   await started.worker.take(started.messageId);
 *   await started.worker.respond(started.messageId, { text: "done" });
 *
 * A conversation made by a bare POST /api/message has no session: the relay
 * refuses a second message to it and cannot tell which provider a reply came
 * from. A spec makes one only when that is what it tests.
 *
 * Away from where the row was taken, `respondAsWorker(messageId, body)`
 * answers it as the worker that holds it, and `attemptOf(messageId)` is the
 * attempt echo for the other writes about it. A spec file ends with
 * `test.afterAll(settleFakeWorkers)`.
 */

import { createHeartbeatController } from "../../shared/worker-runtime/heartbeat.mjs";
import { relayBaseUrl, relayToken } from "../e2e-env.mjs";

// Well inside the relay's windows: a relay that hears from workers over HTTP
// only reads as offline after 10 s, a worker is stale after 90 s without a
// heartbeat, a held row's lease runs 120 s.
const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_TAKE_TIMEOUT_MS = 15_000;
// A row nobody settled through the worker (a spec that ended early, a turn
// the relay ended itself) is let go after this long, so its heartbeat stops.
const DEFAULT_HOLD_MS = 10 * 60_000;

// A relay restart takes seconds; a relay gone for this many heartbeats in a
// row is not coming back.
const UNANSWERED_BEATS_BEFORE_LETTING_GO = 4;

const workers = new Map();

function read(value) {
  return typeof value === "function" ? value() : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeWorker({
  // The relay's base URL and token; functions are read on every call, for a
  // relay that restarts on another port.
  baseUrl = relayBaseUrl,
  token = relayToken,
  sessionId,
  conversationId = "",
  pid = process.pid,
  // The kind a worker states in its heartbeat, as every worker of this
  // version does: a relay that launches its workers hands a row to no
  // poller of a session whose worker has not said one. The test relay
  // launches none, but the helper behaves like a worker all the same. The
  // specs' chats run on the Copilot SDK worker; a Claude chat's turn goes
  // only to a worker of its billing's kind ("claude", "claude-api").
  workerKind = "copilot-sdk",
  // What a worker with more to report puts into its heartbeat (see `use`).
  getSteering = null,
  getBackgroundTaskIds = null,
  onResyncBackgroundTasks = null,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  pollMs = DEFAULT_POLL_MS,
  holdMs = DEFAULT_HOLD_MS,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("createFakeWorker needs the session id (the ownerSessionId of the queued message)");
  const known = workers.get(sid);
  if (known) {
    known.rebind({ baseUrl, token, conversationId });
    known.use({ getSteering, getBackgroundTaskIds, onResyncBackgroundTasks });
    return known;
  }

  let relayUrl = baseUrl;
  let relayTokenValue = token;
  let conversation = String(conversationId || "").trim();
  // messageId → { until: when the hold ends by itself, attemptId: the
  // processing attempt the relay named when it handed the row out }.
  const held = new Map();
  let steering = null;
  const hooks = { getSteering, getBackgroundTaskIds, onResyncBackgroundTasks };
  // Every call made as this worker, in order: { method, route, body }.
  const calls = [];
  let timer = null;
  let unanswered = 0;
  let stopped = false;
  // Calls that read or change what the relay knows this worker holds run one
  // after another.
  let chain = Promise.resolve();

  function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  function identityHeaders() {
    return {
      "x-relay-session-id": sid,
      ...(conversation ? { "x-relay-conversation-id": conversation } : {}),
      "x-relay-process-pid": String(pid),
    };
  }

  /** One call to the relay as this worker: `{ status, ok, payload }`. */
  async function call(method, route, body) {
    calls.push({ method, route, body: method === "GET" ? undefined : (body ?? {}) });
    const response = await fetchImpl(`${String(read(relayUrl)).replace(/\/+$/, "")}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${read(relayTokenValue)}`,
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...identityHeaders(),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { status: response.status, ok: response.ok, payload };
  }

  function heldIds() {
    const at = now();
    for (const [id, entry] of held) {
      if (entry.until <= at) held.delete(id);
    }
    return [...held.keys()];
  }

  const heartbeat = createHeartbeatController({
    api: async (method, route, body) => {
      const answer = await call(method, route, body);
      if (!answer.ok) throw new Error(`${route} answered ${answer.status}`);
      return answer.payload;
    },
    pollMs: heartbeatMs,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => heldIds()[0] || "",
    getActiveQueueMessageIds: heldIds,
    getSteeringState: () => (hooks.getSteering ? hooks.getSteering() : steering),
    // No array, no digest: the relay then never asks for the task set.
    getBackgroundTaskIds: () => (hooks.getBackgroundTaskIds ? hooks.getBackgroundTaskIds() : null),
    onResyncBackgroundTasks: () => hooks.onResyncBackgroundTasks?.(),
    workerKind,
  });

  function syncTimer() {
    const wanted = !stopped && heldIds().length > 0;
    if (wanted && !timer) {
      timer = setInterval(() => {
        void exclusive(() => heartbeat.pulseHeartbeat()).then((answered) => {
          // A relay that stays away (stopped at the end of its spec) is no
          // longer told about the rows.
          unanswered = answered ? 0 : unanswered + 1;
          if (unanswered >= UNANSWERED_BEATS_BEFORE_LETTING_GO) held.clear();
          syncTimer();
        }, syncTimer);
      }, heartbeatMs);
      timer.unref?.();
    } else if (!wanted && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function hold(messageId, attemptId = "") {
    const id = String(messageId || "").trim();
    if (!id) return;
    held.set(id, { until: now() + holdMs, attemptId: String(attemptId || "").trim() || held.get(id)?.attemptId || "" });
    unanswered = 0;
    syncTimer();
  }

  function release(messageId) {
    held.delete(String(messageId || "").trim());
    syncTimer();
  }

  /**
   * The attempt echo for a write about a held row: `{ attemptId }`, as every
   * worker write names the processing attempt it belongs to, so the relay
   * refuses a write of an attempt it has replaced. `{}` for a row not held.
   */
  function attemptOf(messageId) {
    heldIds();
    const attemptId = held.get(String(messageId || "").trim())?.attemptId || "";
    return attemptId ? { attemptId } : {};
  }

  /**
   * One heartbeat now, with the rows held. `options.steering` sets the
   * steering snapshot this and every later heartbeat carries (null clears
   * it). Resolves true when the relay answered.
   */
  function beat(options = {}) {
    if (Object.hasOwn(options, "steering")) steering = options.steering || null;
    return exclusive(() => heartbeat.pulseHeartbeat());
  }

  /**
   * One poll for work: the relay's answer as it is. A row it hands out is
   * held from here on, and named in a heartbeat at once (the poll registered
   * the process; the first heartbeat is what the relay waits for after it).
   * A relay that launches its workers hands nothing to a poller whose kind
   * it does not know: not yet (the kind rides on the heartbeat), or no more
   * (it forgets every kind when it restarts). The worker then says its kind
   * in a heartbeat and asks once more.
   */
  async function poll() {
    const claim = () => exclusive(async () => {
      const polled = await call("GET", "/api/pending");
      const id = String(polled.payload?.message?.id || "").trim();
      if (id) hold(id, polled.payload.message.attemptId);
      return polled;
    });
    let answer = await claim();
    if (answer.payload?.reason === "worker-kind-unstated" && workerKind) {
      await beat();
      answer = await claim();
    }
    if (answer.payload?.message?.id) await beat();
    return answer;
  }

  /**
   * Takes the session's next row off the queue and holds it. With a message
   * id, that row: another row of the session handed out first goes back to
   * the queue. Rejects when none came in time, naming what the relay said.
   */
  async function take(messageId = "", { timeoutMs = DEFAULT_TAKE_TIMEOUT_MS } = {}) {
    const wanted = String(messageId || "").trim();
    const deadline = now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await poll();
      if (!last.ok) throw new Error(`fake worker ${sid}: /api/pending answered ${last.status} ${JSON.stringify(last.payload)}`);
      const message = last.payload?.message || null;
      const id = String(message?.id || "").trim();
      if (id && (!wanted || id === wanted)) return message;
      if (id) await requeue(id);
      if (now() >= deadline) break;
      await sleep(pollMs);
    }
    const reason = last?.payload?.routing?.blockedReason
      || (last?.payload?.paused ? "paused" : "")
      || "no row for this session";
    throw new Error(`fake worker ${sid}: ${wanted ? `message ${wanted}` : "a message"} was not handed out within ${timeoutMs} ms (${reason})`);
  }

  /**
   * The turn's reply: POST /api/response with the conversation and the
   * row's attempt filled in. The row is no longer held, whatever the relay
   * answered.
   */
  function respond(messageId, body = {}) {
    return exclusive(async () => {
      try {
        return await call("POST", "/api/response", {
          messageId,
          ...(conversation ? { conversationId: conversation } : {}),
          ...attemptOf(messageId),
          ...body,
        });
      } finally {
        release(messageId);
      }
    });
  }

  /**
   * Hands a row back: POST /api/requeue, with the row's attempt. The row is
   * no longer held.
   */
  function requeue(messageId, body = {}) {
    return exclusive(async () => {
      try {
        return await call("POST", "/api/requeue", { messageId, ...attemptOf(messageId), ...body });
      } finally {
        release(messageId);
      }
    });
  }

  /**
   * What the heartbeat reports beyond the rows held, each a function read on
   * every heartbeat: `getSteering` (the steering snapshot, instead of the one
   * set through `beat`), `getBackgroundTaskIds` (the ids of the worker's live
   * background tasks; the heartbeat then carries their digest) and
   * `onResyncBackgroundTasks` (called when the relay asks for the task set
   * again). A value left out keeps what was set before.
   */
  function use(next = {}) {
    for (const key of Object.keys(hooks)) {
      if (typeof next[key] === "function") hooks[key] = next[key];
    }
    return worker;
  }

  /**
   * The worker ends: the relay is asked to stop the session's worker
   * (POST /api/session-worker/:id/kill; it finds no process that names the
   * session, and never signals this one) and forgets it, so the conversation
   * reads as one whose worker is gone. Rows still held fail with it.
   */
  async function end() {
    const answer = await call("POST", `/api/session-worker/${encodeURIComponent(sid)}/kill`, {});
    stop();
    return answer;
  }

  /** Stops the heartbeat and forgets the rows held; the relay is not told. */
  function stop() {
    stopped = true;
    held.clear();
    syncTimer();
    workers.delete(sid);
  }

  const worker = {
    sessionId: sid,
    get conversationId() { return conversation; },
    /** The identity headers, for a worker route a spec calls itself. */
    get headers() { return identityHeaders(); },
    get holding() { return heldIds(); },
    calls,
    get: (route) => call("GET", route),
    post: (route, body) => call("POST", route, body),
    beat,
    poll,
    take,
    hold,
    release,
    attemptOf,
    respond,
    requeue,
    use,
    end,
    stop,
    rebind(next = {}) {
      if (next.baseUrl) relayUrl = next.baseUrl;
      if (next.token) relayTokenValue = next.token;
      if (String(next.conversationId || "").trim()) conversation = String(next.conversationId).trim();
    },
  };
  workers.set(sid, worker);
  return worker;
}

/**
 * The worker of a queued message, from the answer of POST /api/message
 * (`{ conversationId, ownerSessionId }`): the session that owns the row, or
 * the conversation where the answer names no owner.
 */
export function fakeWorkerFor(queued, options = {}) {
  const conversationId = String(queued?.conversationId || "").trim();
  return createFakeWorker({
    ...options,
    sessionId: String(queued?.ownerSessionId || "").trim() || conversationId,
    conversationId,
  });
}

function workerHolding(messageId) {
  const id = String(messageId || "").trim();
  for (const worker of workers.values()) {
    if (worker.holding.includes(id)) return worker;
  }
  return null;
}

/**
 * A conversation made the way the web client makes one: POST
 * /api/conversation/bootstrap (which binds the conversation to its session,
 * the conversation's own id), then its first message with POST /api/message.
 * Resolves with the answer of POST /api/message (`conversationId`,
 * `messageId`, `ownerSessionId`) and `worker`, the session's fake worker.
 * `text` is the first message and, cut to the relay's length, the title (the
 * title a bare first message gives), unless `title` names another;
 * `bootstrap` and `message` add fields to the two bodies. `options` names the
 * relay when it is not the shared one, and the other options of the worker.
 */
export async function startConversation({ text, title = "", model = "gpt-5.4-mini", relayMode = "agent", bootstrap = {}, message = {} } = {}, options = {}) {
  const conversationId = await bootstrapConversation({ title: title || text, model, relayMode, ...bootstrap }, options);
  const queued = await relayPost("/api/message", { conversationId, text, relayMode, model, ...message }, options);
  const worker = createFakeWorker({ ...options, sessionId: String(queued?.ownerSessionId || "").trim() || conversationId, conversationId });
  return { ...queued, conversationId, worker };
}

/**
 * A conversation made through POST /api/conversation/bootstrap alone, bound
 * to its session and with no message yet, for a spec whose first message is
 * not a plain one: resolves with its id. `fields` go into the body (`title`
 * is cut to the relay's length); `options` names the relay.
 */
export async function bootstrapConversation({ title = "", model = "gpt-5.4-mini", relayMode = "agent", ...fields } = {}, options = {}) {
  const made = await relayPost("/api/conversation/bootstrap", { title: String(title || "").slice(0, 80), model, relayMode, ...fields }, options);
  const conversationId = String(made?.conversationId || "").trim();
  if (!conversationId) throw new Error(`/api/conversation/bootstrap named no conversation: ${JSON.stringify(made)}`);
  return conversationId;
}

// A POST as the owner (not as a worker): the answer's body, or a throw that
// names the status and the body.
async function relayPost(route, body, { baseUrl = relayBaseUrl, token = relayToken, fetchImpl = (...args) => fetch(...args) } = {}) {
  const response = await fetchImpl(`${String(read(baseUrl)).replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${read(token)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }
  if (!response.ok) throw new Error(`${route} answered ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

/**
 * The attempt echo for a write about a row some worker of this process
 * holds: `{ attemptId }` to spread into the body of a stream, thought,
 * activity, sub-agent, question or board post, `{}` for a row nobody holds.
 */
export function attemptOf(messageId) {
  return workerHolding(messageId)?.attemptOf(messageId) || {};
}

/**
 * The reply to a row, sent by the worker that holds it (with the row's
 * attempt). Throws for a row no worker of this process holds: take it first,
 * or use `completeTurn`.
 */
export async function respondAsWorker(messageId, body = {}) {
  const holder = workerHolding(messageId);
  if (!holder) throw new Error(`no fake worker holds message ${String(messageId || "").trim() || "(none)"}: take it first`);
  return holder.respond(messageId, body);
}

/**
 * A whole turn in one call, for a spec that only needs the reply to exist:
 * the queued message (the answer of POST /api/message) is taken by its
 * session's worker (unless a worker holds it already) and answered, and the
 * worker ends, so the conversation is
 * left as one nobody works in. `options.stay` keeps the worker (a ready one,
 * for more turns in the conversation); the other options are the worker's
 * (`baseUrl` and `token` of a relay that is not the shared one).
 */
export async function completeTurn(queued, body = {}, { stay = false, ...options } = {}) {
  const messageId = String(queued?.messageId || "").trim();
  // Taken already (by the worker that holds it): only the reply is left.
  const worker = workerHolding(messageId) || fakeWorkerFor(queued, options);
  if (!worker.holding.includes(messageId)) await worker.take(messageId);
  const answered = await worker.respond(messageId, body);
  if (!stay) await worker.end();
  return answered;
}

/**
 * Ends what the fake workers of this process still hold, for the end of a
 * spec file (`test.afterAll(settleFakeWorkers)`): every row still held is
 * answered, so it does not stay running on a relay the next spec shares, and
 * every worker stops. A turn is meant to be settled by the spec that took
 * it: when it had to answer one, it rejects, naming the rows, and the spec
 * fails. Resolves with no rows otherwise. A relay that is gone (the spec
 * stopped its own) is not waited for, and a row the relay no longer has is
 * not counted.
 */
export async function settleFakeWorkers() {
  const left = [];
  for (const worker of [...workers.values()]) {
    for (const messageId of worker.holding) {
      const settled = await worker.respond(messageId, { text: "Ended at the end of the spec that left this turn running.", mode: "agent" })
        .catch(() => null);
      // A row the relay no longer has (its conversation was deleted) was
      // not running any more.
      if (settled?.ok) left.push({ sessionId: worker.sessionId, messageId });
    }
    worker.stop();
  }
  if (left.length) {
    throw new Error(`[fake-worker] ${left.length} turn(s) were still running at the end of the spec and were answered: ${left.map((row) => row.messageId).join(", ")}`);
  }
  return left;
}

/**
 * The relay hears from a worker, with no turn held: one heartbeat now and one
 * every `everyMs` until `stop()`. For a spec whose relay must read as online
 * between turns too (the page shows a relay that hears from no worker as
 * offline). `options` names the relay when it is not the shared one.
 */
export function relayPresence({ baseUrl = relayBaseUrl, token = relayToken, everyMs = 2_000, fetchImpl = (...args) => fetch(...args) } = {}) {
  const beat = () => fetchImpl(`${String(read(baseUrl)).replace(/\/+$/, "")}/api/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${read(token)}`, "Content-Type": "application/json" },
    body: "{}",
  }).then((response) => response.ok, () => false);
  void beat();
  const timer = setInterval(() => { void beat(); }, everyMs);
  timer.unref?.();
  return { beat, stop: () => clearInterval(timer) };
}

/** Stops every fake worker of this process. */
export function stopFakeWorkers() {
  for (const worker of [...workers.values()]) worker.stop();
}
