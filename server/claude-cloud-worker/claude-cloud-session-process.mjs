import crypto from 'node:crypto';
import fs from 'node:fs';

import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import { createRelayQuestion } from '../../shared/question-wait.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '../../shared/question-timeout.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
import { stripModelTierSuffix } from '../../shared/claude-cloud/repo-url.mjs';
import { buildClaudeAttachmentContent } from '../claude-worker/claude-attachments.mjs';
import { classifyClaudeResultFailure } from '../claude-worker/claude-turn-failure.mjs';
import {
  attemptFields,
  createClaudeTurnPublisher,
  isStaleAttemptError,
} from '../claude-worker/claude-turn-publisher.mjs';
import { summarizeToolInput } from '../claude-worker/sdk-message-normalizer.mjs';
import {
  createClaudeCloudEventNormalizer,
  readCloudResult,
  readCloudSessionUsage,
  toCloudSequence,
} from './claude-cloud-event-normalizer.mjs';

const PERMISSION_ALLOW = 'Allow';
const PERMISSION_DENY = 'Deny';
const QUESTION_UNANSWERED_MESSAGE = 'The user did not answer. Continue without this, or end the turn and say what you need.';
const PERMISSION_DENIED_MESSAGE = 'The user denied this tool use.';
// A catch-up after a worker restart reads the events of one unfinished turn;
// the cap only stops a cursor that never advances.
const MAX_CATCH_UP_PAGES = 200;

// Failures of the event stream that reconnecting cannot cure.
const FATAL_STREAM_CODES = new Set([
  'login_missing',
  'login_expired',
  'not_found',
  'bad_request',
  'github_not_connected',
  'repo_access_denied',
  'environment_missing',
]);

// What the user can do about a failure the cloud client names. `message` says
// what happened, `guidance` what to do; the relay prints both.
const KNOWN_ERROR_REPLIES = Object.freeze({
  login_missing: {
    message: 'Claude Cloud needs the Claude login of this relay host, and there is none.',
    guidance: 'Log in on Settings → Providers → Claude, then send the message again.',
  },
  login_expired: {
    message: 'The Claude login of this relay host has expired.',
    guidance: 'Log in again on Settings → Providers → Claude, then send the message again.',
  },
  github_not_connected: {
    message: 'GitHub is not connected to the Claude account of this relay host.',
    guidance: 'Connect it at https://claude.ai/connect-github, then send the message again.',
  },
  repo_access_denied: {
    message: 'The Claude GitHub app has no access to this repository.',
    guidance: 'Add the repository to the Claude GitHub app\'s repository access '
      + '(GitHub → Settings → Applications → Claude → Configure), then send the message again.',
  },
  environment_missing: {
    message: 'The cloud environment of this conversation is missing.',
    guidance: 'Choose an environment on Settings → Providers → Claude Cloud, then send the message again.',
  },
  rate_limited: {
    message: 'Claude Cloud refused the request because of a rate limit.',
    guidance: 'Wait a little, then send the message again.',
  },
  not_found: {
    message: 'The cloud session of this conversation was not found.',
    guidance: 'It may have been deleted on claude.ai, or the relay host is logged in to another Claude account. '
      + 'Start a new Claude Cloud chat.',
  },
});

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * The uuid of the user message a queue row becomes. Derived from the row id,
 * not random: a row delivered a second time (requeue, worker restart) names
 * the same message, so the worker finds it in the session's event log and
 * follows the turn it already started instead of sending the prompt again.
 */
export function claudeCloudMessageUuid(queueMessageId) {
  const hex = crypto.createHash('sha256').update(`oar-claude-cloud-message:${queueMessageId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The content of the cloud user message for a relay message: the text, plus
 * an inline block per image. The sandbox cannot read the relay host's files,
 * so there is no path fallback: every attachment that is not an embeddable
 * image (see claude-attachments.mjs for types and size) is named in `refused`
 * and the caller refuses the turn.
 */
export function buildClaudeCloudUserContent(message, { fsImpl = fs } = {}) {
  const text = String(message?.text || '').trim();
  const attachments = (Array.isArray(message?.attachments) ? message.attachments : [])
    .filter((attachment) => attachment && typeof attachment === 'object');
  const imageBlocks = [];
  const refused = [];
  for (const attachment of attachments) {
    const { imageBlocks: blocks } = buildClaudeAttachmentContent([attachment], { fsImpl });
    if (blocks.length) imageBlocks.push(...blocks);
    else refused.push(String(attachment.name || 'attachment').trim() || 'attachment');
  }
  if (refused.length) return { content: null, refused };
  if (!imageBlocks.length) return { content: text, refused };
  return { content: [...(text ? [{ type: 'text', text }] : []), ...imageBlocks], refused };
}

/**
 * One Claude Cloud conversation: the cloud session it is bound to, the event
 * stream of that session, and one turn at a time.
 *
 * A delivered message becomes a user event of the cloud session (the first
 * one creates the session). The turn it starts is everything on the session's
 * event stream after that event, up to the first `result`; events are
 * numbered, the stream can be reopened after any number, and the number of
 * the last finished turn is stored on the relay so a restarted worker can
 * find its place again.
 *
 * `cloud` is the client of shared/claude-cloud/api-client.mjs (the worker
 * never sees the token it holds), `api` the relay api client.
 */
export function createClaudeCloudSessionRunner({
  api,
  cloud,
  sdkSessionId = '',
  defaultModel = '',
  controlPoller = null,
  dbg = () => {},
  now = Date.now,
  sleep = sleepDefault,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  fsImpl = fs,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  askUserBridgeOptions = {},
  reconnectMinMs = 1_000,
  reconnectMaxMs = 15_000,
  reconnectGiveUpMs = 5 * 60_000,
  idleCloseMs = 10 * 60_000,
  interruptGraceMs = 30_000,
  sessionReadTimeoutMs = 10_000,
  // No byte for this long, keepalives included, and the stream is taken for
  // dead and reopened.
  streamIdleTimeoutMs = 120_000,
} = {}) {
  const publisher = createClaudeTurnPublisher({ api, dbg });
  const askUserBridge = createAskUserBridge({
    api,
    getActiveMessage: () => turn?.message || null,
    sdkSessionId,
    sleep,
    questionTimeoutMs,
    questionRationale: 'Claude Cloud requested clarification to continue this turn.',
    dbg,
    ...askUserBridgeOptions,
  });

  // The cloud session this conversation is bound to:
  // - `lastSeq`: the last event handled; older ones are replays and skipped.
  // - `cursorSeq`: the `result` of the last finished turn, which is what the
  //   relay stores. Never a point inside a turn: a restarted worker reads on
  //   from it to find the message it already sent.
  // - `attached`: this process has read the session's log up to `lastSeq`.
  // - `sent`: user messages posted whose turn has not ended (uuid → sequence).
  // - `unfinishedTurns`: turns that ended here without their `result` and may
  //   still run in the cloud.
  let session = null;
  let turn = null;
  let stream = null;
  let idleTimer = null;
  // Events are handled one at a time and in order; posting a user message
  // takes a place in the same line, so no event of the turn it starts is
  // looked at before the turn's start is known.
  let chain = Promise.resolve();

  function enqueue(task) {
    const run = chain.then(task);
    chain = run.catch((error) => dbg('cloud event handling failed', error?.message || String(error)));
    return run;
  }

  function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeoutImpl(() => reject(new Error(`no answer within ${ms} ms`)), ms);
        timer?.unref?.();
      }),
    ]).finally(() => clearTimeoutImpl(timer));
  }

  function newSession(id, { url = null, cursor = 0, attached = false } = {}) {
    return {
      id,
      url,
      lastSeq: cursor,
      cursorSeq: cursor,
      attached,
      sent: new Map(),
      unfinishedTurns: 0,
    };
  }

  function resolveModel(message) {
    const requested = String(message?.model || '').trim();
    const perTurn = requested && requested.toLowerCase() !== 'auto' ? requested : '';
    // The delivered message names the conversation's current model; the launch
    // model is what it was when the worker started, and the model may still be
    // changed until the first message creates the cloud session.
    return stripModelTierSuffix(String(message?.providerModel || '').trim() || perTurn || defaultModel);
  }

  function getActiveQueueMessageId() {
    return turn ? String(turn.message?.id || '') : '';
  }

  // Crash-guard shape: the attempt id fences the dying worker's requeue.
  function getActiveQueueAttempt() {
    if (!turn?.message?.id) return null;
    return { id: String(turn.message.id), attemptId: turn.message.attemptId || null };
  }

  function isTurnActive() {
    return Boolean(turn);
  }

  // ---------------------------------------------------------------------------
  // Relay-facing publishing

  /**
   * Tell the relay which cloud session the conversation is bound to and how
   * far it got. Advisory for the turn: a failed report costs the stored
   * binding (this process keeps its own), never the reply.
   */
  async function reportSession(message, extra = {}) {
    if (!session?.id) return;
    await api('POST', '/api/claude-cloud-session', {
      conversationId: message.conversationId,
      cloudSessionId: session.id,
      ...(session.url ? { sessionUrl: session.url } : {}),
      lastSequence: String(session.cursorSeq),
      ...extra,
    }).catch((error) => dbg('cloud session report failed', error?.message || String(error)));
  }

  function buildTerminalError(message, { code, text, guidance = null, detail = null }) {
    return {
      kind: 'claude-cloud-turn-failed',
      code,
      stableCode: `claude-cloud.${code}`,
      message: text,
      ...(guidance ? { guidance } : {}),
      ...(detail ? { detail } : {}),
      failedAt: new Date(now()).toISOString(),
      queueMessageId: String(message?.id || '') || null,
    };
  }

  async function requeue(message) {
    await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch((error) => {
      if (isStaleAttemptError(error)) dbg('requeue refused as stale_attempt', message.id);
    });
  }

  async function refuseAttachments(message, refused) {
    const names = refused.map((name) => `"${name}"`).join(', ');
    const text = `Claude Cloud takes images only, sent inline (JPEG, PNG, GIF or WebP, up to 5 MB each). Not sent: ${names}.`;
    await publisher.publishResponse(message, {
      text: `System note: ${text} The message was not sent to the cloud session.`,
      model: null,
      terminalError: buildTerminalError(message, {
        code: 'attachment-unsupported',
        text,
        guidance: 'Remove the attachment, or put what the agent needs into the repository or the message, then send it again.',
      }),
    });
  }

  // ---------------------------------------------------------------------------
  // The turn

  function openTurn(message) {
    let resolve = null;
    const done = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {
      message,
      uuid: claudeCloudMessageUuid(message.id),
      model: resolveModel(message),
      // The sequence number the turn starts after (create: 0, send: the
      // number of the user event); null until the message is in the session.
      startSeq: null,
      sent: false,
      settled: false,
      interrupted: false,
      interruptSent: false,
      graceTimer: null,
      controlState: null,
      normalizer: createClaudeCloudEventNormalizer(),
      // The Claude worker's publisher reads and writes this.
      state: {
        responseModel: '',
        lastStreamedText: '',
        result: null,
        modelUsage: null,
        resultTexts: [],
        contextUsage: null,
        planUsage: null,
      },
      permissions: new Map(), // request id -> { controller, silent, responded }
      done,
      resolve,
    };
  }

  /**
   * End the wait of a turn: `result` (the cloud finished it), `stopped` (Stop
   * before anything was sent), `stop-unconfirmed` (Stop, and no `result`
   * within the grace period), `gave-up` (the event stream stayed away) or
   * `error`.
   */
  function settleTurn(t, outcome) {
    if (t.settled) return;
    t.settled = true;
    if (t.graceTimer) clearTimeoutImpl(t.graceTimer);
    t.graceTimer = null;
    // The cloud cannot be told to forget a turn: one that ends here without
    // its `result` may still write, and its `result` still comes. A turn
    // given up for a lost stream is not one of them — it is delivered again
    // and followed from where it started.
    if (outcome.kind !== 'result' && outcome.kind !== 'gave-up' && t.sent && session) {
      session.unfinishedTurns += 1;
    }
    t.resolve(outcome);
  }

  function inTurn(t, sequence) {
    return Boolean(t) && t.startSeq !== null && (sequence === null || sequence > t.startSeq);
  }

  async function handleEvent(event, sequence, { answered = null } = {}) {
    if (!session) return;
    if (sequence !== null) {
      // The stream replays from the start when opened without a position,
      // and a reconnect may repeat what was already seen.
      if (sequence <= session.lastSeq) return;
      session.lastSeq = sequence;
    }
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
    const type = String(payload.type || event?.event_type || '');
    const t = turn && !turn.settled ? turn : null;

    if (type === 'user' && t && t.startSeq === null && sequence !== null
      && (String(payload.uuid || '') === t.uuid || String(event?.event_id || '') === t.uuid)) {
      // The delivered message is in the session already (this row was
      // delivered before): its turn starts here.
      t.startSeq = sequence;
      return;
    }

    if (type === 'result') {
      // One `result` per user message, in the order the messages were sent:
      // the first ones belong to turns that ended here without theirs.
      if (session.unfinishedTurns > 0) {
        session.unfinishedTurns -= 1;
        return;
      }
      if (!inTurn(t, sequence)) return;
      t.state.result = readCloudResult(payload);
      t.state.modelUsage = t.state.result.modelUsage;
      session.cursorSeq = Math.max(session.cursorSeq, sequence ?? session.lastSeq);
      settleTurn(t, { kind: 'result' });
      return;
    }

    // What an unfinished earlier turn still writes is not this turn's output.
    if (!inTurn(t, sequence) || session.unfinishedTurns > 0) return;
    for (const action of t.normalizer.normalize(event, { sequence })) {
      await dispatchAction(t, action, { answered });
    }
  }

  async function dispatchAction(t, action, { answered = null } = {}) {
    const { channel, payload } = action;
    if (channel === 'push') {
      await reportSession(t.message, { pushedBranch: payload.branch });
      return;
    }
    if (channel === 'permission') {
      // Read back from the log after a restart: a request answered further
      // down must not open a card.
      if (!answered?.has(payload.requestId)) startPermissionRequest(t, payload);
      return;
    }
    if (channel === 'permission_settled') {
      const entry = t.permissions.get(payload.requestId);
      if (entry && !entry.responded) {
        // Answered from another client (claude.ai): the card here is moot.
        entry.silent = true;
        entry.controller.abort();
      }
      return;
    }
    await publisher.dispatchAction(t.message, action, t.state);
  }

  // ---------------------------------------------------------------------------
  // Questions and permission prompts

  async function askPermission(t, request, signal) {
    const message = t.message;
    const display = String(request.displayName || request.toolName || 'a tool').trim();
    const summary = truncate(summarizeToolInput(request.toolName, request.input), 400);
    const questionId = await createRelayQuestion({
      api,
      sleep,
      signal,
      dbg,
      payload: {
        queueId: message.id,
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        prompt: [`Claude Cloud asks for permission to use ${display}.`, summary].filter(Boolean).join('\n\n'),
        choices: [PERMISSION_ALLOW, PERMISSION_DENY],
        allowFreeform: false,
        sdk_session_id: sdkSessionId || undefined,
        attemptId: message.attemptId || undefined,
        timeout_ms: questionTimeoutMs,
        context: {
          source: 'ClaudeCloudPermission',
          rationale: 'The cloud agent needs your approval to continue this turn.',
          queueMessageId: message.id || null,
          conversationId: message.conversationId || null,
          relayMode: message.relayMode || 'agent',
        },
      },
    });
    const result = await askUserBridge.waitForRelayQuestionAnswer(questionId, { signal });
    if (result.timedOut || signal.aborted) return { behavior: 'deny', message: QUESTION_UNANSWERED_MESSAGE };
    if (result.answer === PERMISSION_ALLOW) return { behavior: 'allow', updatedInput: request.input };
    return { behavior: 'deny', message: PERMISSION_DENIED_MESSAGE };
  }

  async function askUser(t, request, signal) {
    if (request.toolName !== 'AskUserQuestion') return askPermission(t, request, signal);
    // Same cards as the Claude worker's: one per question, options as
    // buttons (checkmarks for multiSelect, whose labels the card joins with
    // ", "), answers keyed by the question text.
    const { answers, timedOut } = await askUserBridge.handleAskUserQuestion(request.input, { signal });
    if (timedOut || signal.aborted) return { behavior: 'deny', message: QUESTION_UNANSWERED_MESSAGE };
    return { behavior: 'allow', updatedInput: { ...request.input, answers } };
  }

  /**
   * The agent waits for the user. Runs beside the event line, not in it: a
   * card may stay open for hours, and the `result` of a turn stopped
   * meanwhile has to get through.
   */
  function startPermissionRequest(t, request) {
    const requestId = String(request.requestId || '').trim();
    if (!requestId || t.permissions.has(requestId)) return;
    const entry = { controller: new AbortController(), silent: false, responded: false };
    t.permissions.set(requestId, entry);
    (async () => {
      let response = null;
      try {
        response = await askUser(t, request, entry.controller.signal);
      } catch (error) {
        dbg('cloud question bridge failed', request.toolName, error?.message || String(error));
        response = {
          behavior: 'deny',
          message: `Relay bridge failed for ${request.toolName || 'the request'}: ${error?.message || error}`,
        };
      }
      if (entry.silent) return;
      entry.responded = true;
      await cloud.sendControlResponse(session.id, { requestId, response });
    })()
      .catch((error) => dbg('cloud control response failed', error?.message || String(error)))
      .finally(() => {
        if (t.permissions.get(requestId) === entry) t.permissions.delete(requestId);
      });
  }

  // ---------------------------------------------------------------------------
  // Stop

  async function sendInterruptOnce(t) {
    if (t.interruptSent || t.settled || !t.sent || !session) return;
    t.interruptSent = true;
    try {
      await cloud.sendInterrupt(session.id);
    } catch (error) {
      dbg('cloud interrupt failed', error?.message || String(error));
    }
    if (t.settled) return;
    // The interrupted turn ends with its own `result`, normally at once. The
    // sandbox cannot be stopped from here, so without one the turn ends
    // locally and says so.
    t.graceTimer = setTimeoutImpl(() => settleTurn(t, { kind: 'stop-unconfirmed' }), interruptGraceMs);
    t.graceTimer?.unref?.();
  }

  async function abortTurn(t) {
    if (t.settled) return;
    t.interrupted = true;
    // Open cards end as unanswered, which the agent is told as a denial.
    for (const entry of t.permissions.values()) entry.controller.abort();
    // Before the message is in the session there is nothing to interrupt
    // yet; startCloudTurn looks at the flag.
    await sendInterruptOnce(t);
  }

  // ---------------------------------------------------------------------------
  // Event stream

  async function handleFrame(frame) {
    // session_update, delivery_update and ephemeral_event frames carry
    // nothing a turn needs.
    if (String(frame?.kind || '') !== 'client_event') return;
    const event = frame.data && typeof frame.data === 'object' ? frame.data : null;
    if (!event) return;
    await handleEvent(event, toCloudSequence(frame.id) ?? toCloudSequence(event.sequence_num));
  }

  /**
   * Follow the session's events for as long as a turn waits on them. The
   * client does not reconnect by itself: it throws when the stream cannot be
   * opened and resolves when an open one ends, whatever the reason. Mid-turn
   * either is a drop, and the stream is reopened after the last event
   * handled, with a growing pause, until it has stayed away for
   * `reconnectGiveUpMs`. Between turns a stream that ends is left closed; the
   * next delivery opens it again.
   */
  async function followStream(entry) {
    const { signal } = entry.controller;
    let delay = reconnectMinMs;
    let downSince = null;
    try {
      while (!signal.aborted) {
        let failure = null;
        let ended = null;
        try {
          ended = await cloud.openEventStream(session.id, {
            lastEventId: session.lastSeq > 0 ? String(session.lastSeq) : null,
            signal,
            idleTimeoutMs: streamIdleTimeoutMs,
            onOpen: () => { downSince = null; },
            // Not awaited by the client: the frame takes its place in the
            // line and the stream is read on.
            onEvent: (frame) => {
              if (signal.aborted) return;
              downSince = null;
              delay = reconnectMinMs;
              enqueue(() => handleFrame(frame)).catch(() => {});
            },
          });
        } catch (error) {
          failure = error;
        }
        // What the stream delivered is handled before the turn is looked at.
        await chain;
        if (signal.aborted) return;
        const t = turn;
        if (!t || t.settled) return;
        const code = String(failure?.code || '').trim();
        if (failure && FATAL_STREAM_CODES.has(code)) {
          settleTurn(t, { kind: 'error', error: failure });
          return;
        }
        if (downSince === null) {
          downSince = now();
        } else if (now() - downSince >= reconnectGiveUpMs) {
          settleTurn(t, { kind: 'gave-up' });
          return;
        }
        dbg(
          'cloud event stream dropped mid-turn; reconnecting',
          `reason=${failure ? 'not-opened' : (ended?.reason || 'ended')}`,
          `after=${session.lastSeq}`,
          `in=${delay}ms`,
          String(failure?.message || ended?.error?.message || ''),
        );
        await sleep(delay);
        delay = Math.min(delay * 2, reconnectMaxMs);
      }
    } finally {
      // In the same breath as the decision to stop: a delivery that arrives
      // next must see that there is no stream and open one.
      if (stream === entry) stream = null;
    }
  }

  function ensureStream() {
    if (stream || !session?.id) return;
    const entry = { controller: new AbortController(), loop: null };
    stream = entry;
    entry.loop = followStream(entry).catch((error) => {
      dbg('cloud event stream loop failed', error?.message || String(error));
    });
  }

  async function closeStream() {
    const entry = stream;
    stream = null;
    entry?.controller.abort();
    // Frames it had already handed over are still handled, in order.
    await chain;
  }

  function clearIdleClose() {
    if (idleTimer) clearTimeoutImpl(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleClose() {
    clearIdleClose();
    if (!stream) return;
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      if (turn) return;
      dbg('closing the idle cloud event stream');
      void closeStream();
    }, idleCloseMs);
    idleTimer?.unref?.();
  }

  /**
   * After a worker restart: read the session's log on from the stored
   * position. If the delivered message is in it, its turn was started by the
   * previous worker, and everything that turn wrote so far is published
   * again under this attempt.
   */
  async function catchUp() {
    const events = [];
    let cursor = session.lastSeq > 0 ? String(session.lastSeq) : null;
    for (let page = 0; page < MAX_CATCH_UP_PAGES; page += 1) {
      const result = await cloud.listEvents(session.id, { ...(cursor ? { cursor } : {}), sortOrder: 'asc' });
      const batch = Array.isArray(result?.events) ? result.events : [];
      events.push(...batch);
      const next = result?.nextCursor ?? null;
      if (!batch.length || next === null || String(next) === String(cursor)) break;
      cursor = String(next);
    }
    const answered = new Set(events
      .filter((event) => String(event?.payload?.type || event?.event_type || '') === 'control_response')
      .map((event) => String(event?.payload?.response?.request_id || '').trim())
      .filter(Boolean));
    await enqueue(async () => {
      for (const event of events) {
        await handleEvent(event, toCloudSequence(event?.sequence_num), { answered });
      }
    });
  }

  /**
   * A turn that ended here without its `result` is only still to be reckoned
   * with while the cloud is working: an idle session has no `result` left to
   * send, and waiting for one would swallow the next turn's.
   */
  async function confirmUnfinishedTurns() {
    try {
      const { workerStatus } = readCloudSessionUsage(await withTimeout(cloud.getSession(session.id), sessionReadTimeoutMs));
      if (workerStatus === 'idle') session.unfinishedTurns = 0;
    } catch (error) {
      dbg('cloud session read failed', error?.message || String(error));
    }
  }

  /** Put the delivered message into the cloud session, unless it is there already. */
  async function startCloudTurn(t, binding, content) {
    const message = t.message;
    const boundId = String(binding.sessionId || '').trim() || session?.id || '';

    if (!boundId) {
      // The client refuses a create without environment, repository or
      // model with the code the reply below is built from.
      const created = await cloud.createSession({
        title: String(binding.title || '').trim(),
        environmentId: String(binding.environmentId || '').trim(),
        model: t.model,
        repoUrl: String(binding.repoUrl || '').trim(),
        branch: String(binding.branch || '').trim() || null,
        content,
        uuid: t.uuid,
      });
      session = newSession(String(created?.id || '').trim(), {
        url: String(created?.sessionUrl || '').trim() || null,
        attached: true,
      });
      if (!session.id) {
        session = null;
        throw new Error('The cloud did not return a session id.');
      }
      t.startSeq = 0;
      t.sent = true;
      session.sent.set(t.uuid, 0);
      await reportSession(message, t.model ? { model: t.model } : {});
      return;
    }

    if (!session || session.id !== boundId) {
      await closeStream();
      session = newSession(boundId, { cursor: toCloudSequence(binding.lastSequence) ?? 0 });
    }

    const sentAt = session.sent.get(t.uuid);
    if (sentAt !== undefined) {
      // The same row again (requeued after the stream stayed away): the cloud
      // has the message. Replay its turn from the start so this attempt
      // publishes all of it, instead of sending the prompt twice.
      await closeStream();
      session.lastSeq = Math.min(session.lastSeq, sentAt);
      t.startSeq = sentAt;
      t.sent = true;
      return;
    }

    if (!session.attached) {
      await catchUp();
      session.attached = true;
      if (t.startSeq !== null) {
        t.sent = true;
        session.sent.set(t.uuid, t.startSeq);
        return;
      }
    }

    if (t.interrupted) {
      settleTurn(t, { kind: 'stopped' });
      return;
    }
    if (session.unfinishedTurns > 0) await confirmUnfinishedTurns();
    let alreadyInSession = false;
    await enqueue(async () => {
      const sent = await cloud.sendUserMessage(session.id, content, { uuid: t.uuid });
      const sequence = toCloudSequence(sent?.sequence);
      // No event is handled while the message is posted, so a new message is
      // numbered after everything seen. One that is not was in the session
      // before (the cloud recognised its uuid).
      alreadyInSession = sequence !== null && sequence <= session.lastSeq;
      if (t.startSeq === null) t.startSeq = sequence ?? session.lastSeq;
      t.sent = true;
      session.sent.set(t.uuid, t.startSeq);
    });
    if (alreadyInSession) {
      await closeStream();
      session.lastSeq = Math.min(session.lastSeq, t.startSeq);
    }
  }

  async function publishResult(t) {
    const { message, state } = t;
    const result = state.result;
    const responseModel = state.responseModel || t.model || null;
    const streamed = String(state.lastStreamedText || '').trim();

    if (t.interrupted) {
      // Stopped from the relay: surface what streamed and let the relay's
      // abort control own the row's fate, as the other workers do.
      await publisher.publishFinalStream(message, streamed);
      return;
    }
    if (result.interrupted) {
      // Stopped from another client. No abort control exists on the relay
      // for this row, so it needs its answer.
      const text = streamed || 'System note: the cloud turn was stopped from another client before it wrote a reply.';
      await publisher.publishFinalStream(message, text);
      await publisher.publishResponse(message, { text, model: responseModel });
      return;
    }
    if (result.isError) {
      const failure = classifyClaudeResultFailure(result);
      const errorText = result.text || result.errors[0]
        || `Claude Cloud turn failed (${result.subtype || 'unknown error'}).`;
      await publisher.publishFinalStream(message, streamed);
      await publisher.publishResponse(message, {
        text: errorText,
        model: responseModel,
        terminalError: buildTerminalError(message, { code: failure.code, text: errorText, guidance: failure.guidance }),
      });
      return;
    }
    // A turn that ends on tool activity alone is a completed turn, not a
    // failed delivery (see empty-turn-completion.mjs).
    const text = result.text || streamed || EMPTY_TURN_COMPLETION_NOTE;
    await publisher.publishFinalStream(message, text);
    await publisher.publishResponse(message, { text, model: responseModel });
  }

  /**
   * After the reply: store how far the session got, and read the session
   * once for what the events do not carry (context occupancy, the session's
   * cost so far). Advisory, and bounded: it runs inside the turn, so the
   * next delivery waits for it.
   */
  async function publishUsage(t) {
    const { message, state } = t;
    const model = state.responseModel || t.model || '';
    let usage = { contextUsage: null, costUsd: null, sessionUrl: null };
    try {
      usage = readCloudSessionUsage(await withTimeout(cloud.getSession(session.id), sessionReadTimeoutMs), { model });
    } catch (error) {
      dbg('cloud session read failed', error?.message || String(error));
    }
    if (usage.sessionUrl) session.url = usage.sessionUrl;
    const costUsd = usage.costUsd ?? state.result?.totalCostUsd ?? null;
    await reportSession(message, {
      ...(costUsd !== null ? { costUsd } : {}),
      ...(model ? { model } : {}),
    });
    state.contextUsage = usage.contextUsage;
    await publisher.publishContextUsage({ message, state, model, sdkSessionId });
    await publisher.publishPlanUsage({ message, state, sdkSessionId });
  }

  async function finishTurn(t, outcome) {
    const { message, state } = t;
    const streamed = String(state.lastStreamedText || '').trim();
    if (outcome.kind === 'result') {
      session.sent.delete(t.uuid);
      await publishResult(t);
      await publishUsage(t);
      return;
    }
    if (outcome.kind === 'gave-up') {
      // The message stays in `session.sent`: delivered again, its turn is
      // followed from the start instead of being sent a second time.
      await publisher.postActivity(
        message,
        'Cloud: the connection to the cloud session stayed away; the turn is picked up again.',
      );
      await requeue(message);
      return;
    }
    if (outcome.kind === 'error') throw outcome.error;
    session?.sent.delete(t.uuid);
    if (outcome.kind === 'stop-unconfirmed') {
      await publisher.postActivity(
        message,
        `Cloud: no confirmation of the stop within ${Math.round(interruptGraceMs / 1000)} s. The turn ends here; `
          + `the cloud agent may still be working${session?.url ? ` (${session.url})` : ''}.`,
      );
    }
    await publisher.publishFinalStream(message, streamed);
  }

  async function failTurn(t, error) {
    const message = t.message;
    const code = String(error?.code || '').trim();
    const detailText = String(error?.message || error || 'unknown error');
    dbg('cloud turn failed', code || 'error', detailText);
    if (code === 'transient' && !t.state.result) {
      await requeue(message);
      return;
    }
    session?.sent.delete(t.uuid);
    const known = KNOWN_ERROR_REPLIES[code] || null;
    // A 429 may say how long to wait.
    const waitSeconds = Math.ceil(Number(error?.retryAfterMs) / 1000);
    const guidance = known && code === 'rate_limited' && waitSeconds > 0
      ? `Wait about ${waitSeconds} s, then send the message again.`
      : known?.guidance;
    await publisher.publishResponse(message, {
      text: known
        ? `System note: ${known.message} ${guidance}`
        : `System note: the Claude Cloud turn failed (${detailText}). Retry or send a new message.`,
      model: null,
      terminalError: buildTerminalError(message, known
        ? { code, text: known.message, guidance, detail: error?.detail ? String(error.detail) : null }
        : { code: 'turn-error', text: detailText }),
    });
  }

  async function runTurn(t) {
    const message = t.message;
    const binding = message.claudeCloud && typeof message.claudeCloud === 'object' ? message.claudeCloud : {};
    const { content, refused } = buildClaudeCloudUserContent(message, { fsImpl });
    if (refused.length) {
      await refuseAttachments(message, refused);
      return true;
    }
    t.controlState = controlPoller?.start?.({
      queueMessageId: message.id,
      onAbortTurn: () => abortTurn(t),
    });
    await startCloudTurn(t, binding, content);
    if (!t.settled) ensureStream();
    if (t.interrupted) await sendInterruptOnce(t);
    await finishTurn(t, await t.done);
    return true;
  }

  function endTurn(t) {
    controlPoller?.stop?.(t.controlState);
    if (t.graceTimer) clearTimeoutImpl(t.graceTimer);
    t.graceTimer = null;
    for (const entry of t.permissions.values()) {
      // The turn is over: a card still open is closed without an answer to
      // the cloud. One the Stop already closed still sends its denial.
      if (entry.controller.signal.aborted) continue;
      entry.silent = true;
      entry.controller.abort();
    }
  }

  /**
   * Run one delivered message as one cloud turn. Single-flight: a delivery
   * while a turn runs is not accepted (the cloud would queue it as a turn of
   * its own, but v1 has no steering).
   */
  async function handlePendingPayload(pending) {
    const message = pending?.message || pending;
    if (!message?.id) return false;
    if (turn) {
      dbg('turn already active; rejecting concurrent deliver', message.id);
      return false;
    }
    clearIdleClose();
    const t = openTurn(message);
    turn = t;
    try {
      return await runTurn(t);
    } catch (error) {
      settleTurn(t, { kind: 'error', error });
      await failTurn(t, error);
      return true;
    } finally {
      endTurn(t);
      turn = null;
      scheduleIdleClose();
    }
  }

  async function dispose() {
    clearIdleClose();
    if (turn) endTurn(turn);
    const entry = stream;
    stream = null;
    entry?.controller.abort();
  }

  return {
    handlePendingPayload,
    getActiveQueueMessageId,
    getActiveQueueAttempt,
    isTurnActive,
    dispose,
  };
}
