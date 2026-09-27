'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import {
  REMOTE_RELAY_APPROVAL_MODES,
  REMOTE_RELAY_EFFORT_PATTERN,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_PROVIDERS,
  isRemoteRelayApprovalQuestion,
  isRemoteRelayWriteAction,
  normalizeRemoteRelayOrigin,
  remoteConversationUrl,
  remoteRelayPermissionAllows,
  REMOTE_RELAY_ACTION_PERMISSION,
  stripRemotePromptHeader,
  summarizeRemoteRelayCall,
  validateRemoteRelayToolInput,
  withRemotePromptHeader,
} from '../../shared/remote-relay-contract.mjs';
import { schemaFields } from '../../shared/question-schema.mjs';
import { ANSWERED_ELSEWHERE_KIND } from '../../shared/steer-settle-markers.mjs';

// The one place a `remote_relay` tool call is decided and carried out (plan
// §5.6). Every provider adapter ends up at POST /api/remote-relays/tool, whose
// handler calls dispatch(). In order:
//
//   validate → list_relays (local, no gate) → resolve the relay → mention gate
//   → permission → hop limit → rate limit → approval (write actions in
//   ask/plan) → execute against the remote relay's existing API
//
// The remote is reached only through the outbound client (auth, origin and
// hop headers are its job). Reply detection reads the remote's own transcript:
// the assistant row whose sourceMessageId is the message we queued, with the
// steering settle kinds (folded / absorbed / stopped) resolved the way the
// remote's UI resolves them.
//
// Nothing here logs prompt or reply text: a write action leaves one line with
// the action, the relay, the remote session and a result code.

const LOG_PREFIX = '[remote-relays]';

// An unexpected failure inside this relay.
export const REMOTE_RELAY_INTERNAL_ERROR_CODE = REMOTE_RELAY_ERROR_CODES.internal;

const RATE_WINDOW_MS = 60_000;
// Rows after the sent message the wait loop reads per poll. A reply sits a few
// rows behind its prompt even in a busy, steered session.
const WAIT_PAGE_LIMIT = 30;
// The most messages GET /api/conversation/:id returns in one page.
const HISTORY_PAGE_MAX = 100;
// When a page after the sent message comes back full, the wait reads on, up to
// this many pages (a late wait in a busy session: the reply is further back).
const AFTER_SCAN_PAGES = 10;
// /api/conversations caps a page at 100; a filtered listing (query or active)
// scans at most this many pages to fill one page of results.
const LIST_PAGE_MAX = 100;
const LIST_SCAN_PAGES = 5;
const PROGRESS_TEXT_MAX = 600;
// How long a session that worked in the background must stay quiet (no task,
// no turn in flight or queued) before its last follow-up counts as the end.
const FOLLOW_UP_SETTLE_MS = 10_000;
const PROGRESS_ACTIVITY_COUNT = 5;
const ACTIVITY_LINE_MAX = 300;
const ACTIVITY_LINES_PER_MESSAGE = 20;
const REPLY_TEXT_MAX = REMOTE_RELAY_LIMITS.perMessageChars * 2;
// A message that would only fit as a stub is dropped instead (read_session).
const MIN_TRIMMED_MESSAGE_CHARS = 200;
const TITLE_MAX = 80;

// The provider settings routes a relay serves; github (Copilot) has none with
// models — its catalogue is /api/models plus /api/status defaultModel.
const SETTINGS_PROVIDERS = Object.freeze(['claude', 'cursor', 'grok', 'openai']);
// How /api/models `providersByModel` names each provider.
const CATALOG_PROVIDER_LABELS = Object.freeze({
  github: 'github-copilot',
  openai: 'openai-byok',
  claude: 'claude',
  cursor: 'cursor',
  grok: 'grok',
});
// Worker statuses that mean "working on something right now" (scope active).
const WORKING_WORKER_STATUSES = new Set(['starting', 'processing']);
// Terminal turn failures are stored as ordinary assistant rows; these are the
// texts the relay writes for them (buildTerminalFailureTextForChat and the two
// recovery-limit paths in messages-routes / server-runtime). Each is the whole
// reply and opens with its marker, or (the stable-code form) with a short
// message followed by "Error code: relay.<code>." in the same paragraph. So a
// marker counts only there: a normal reply that quotes a relay error further
// down is a reply, not a failure.
const FAILURE_TEXT_PATTERNS = Object.freeze([
  /^(?:(?!\n[ \t]*\r?\n)[\s\S]){0,600}?\berror code:\s*relay\.[a-z0-9-]+\.(?=\s|$)/i,
  /^relay recovery limit reached after \d+ attempts/i,
  /^relay timeout after \d+ attempts/i,
]);
const CLAUDE_LONG_CONTEXT_SUFFIX = /\[1m\]$/i;
// POST /api/conversation/bootstrap refuses an effort its model does not take
// with this code (400); POST /api/message sends the same 400 without a code,
// but with the list below.
const EFFORT_UNSUPPORTED_CODE = 'REASONING_EFFORT_UNSUPPORTED';
const EFFORT_SUPPORTED_FIELD = 'supportedReasoningEfforts';
const EFFORT_SOURCES = Object.freeze({
  requested: 'requested',
  caller: 'same as this session',
  remote: 'remote default',
});
// relay_info: efforts per provider, as groups of models that take the same ones.
const EFFORT_LEVELS_MAX = 12;
const EFFORT_GROUPS_MAX = 8;
const EFFORT_GROUP_MODELS_MAX = 40;

function toText(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shortId(value) {
  return toText(value).slice(0, 8) || '-';
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

/** Keeps the head and the tail of a long text: the context and the conclusion. */
function clipMiddle(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return { text, truncated: false };
  const marker = ` … [${text.length - max} characters trimmed] … `;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.6);
  return { text: `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`, truncated: true };
}

/** The newest part of a text that is still growing (a live stream). */
function clipTail(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

function clipLine(value, max) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(value, max) {
  const line = String(value ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** The cursor object the agent passed back, or null when it is not one of ours. */
function decodeCursor(value, keys) {
  try {
    const parsed = JSON.parse(Buffer.from(toText(value), 'base64url').toString('utf8'));
    if (!isPlainObject(parsed)) return null;
    const cursor = {};
    for (const key of keys) {
      const text = toText(parsed[key]);
      if (text) cursor[key] = text.slice(0, 200);
    }
    return Object.keys(cursor).length ? cursor : null;
  } catch {
    return null;
  }
}

function compactQuery(query = {}) {
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

function looksLikeFailureText(text) {
  const value = toText(text);
  return FAILURE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeProvider(value) {
  const provider = toText(value).toLowerCase();
  return REMOTE_RELAY_PROVIDERS.includes(provider) ? provider : '';
}

function uniqueTexts(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = toText(value);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

/** The providers /api/models lists for a model id (keys may keep their casing). */
function catalogProvidersFor(providersByModel, model) {
  if (!isPlainObject(providersByModel)) return [];
  const direct = providersByModel[model] || providersByModel[String(model).toLowerCase()];
  const list = Array.isArray(direct)
    ? direct
    : (Object.entries(providersByModel).find(([key]) => key.toLowerCase() === String(model).toLowerCase())?.[1] || []);
  return Array.isArray(list) ? list.map((entry) => toText(entry).toLowerCase()).filter(Boolean) : [];
}

/**
 * The remote's own id for `candidate` among `offered`: a case-insensitive
 * match, or the same Claude model without / with its "[1m]" long-context
 * suffix. '' when the remote does not offer it.
 */
function matchOfferedModel(candidate, offered = []) {
  const wanted = toText(candidate).toLowerCase();
  if (!wanted) return '';
  const exact = offered.find((model) => model.toLowerCase() === wanted);
  if (exact) return exact;
  const wantedBase = wanted.replace(CLAUDE_LONG_CONTEXT_SUFFIX, '');
  return offered.find((model) => model.toLowerCase().replace(CLAUDE_LONG_CONTEXT_SUFFIX, '') === wantedBase) || '';
}

/** A reasoning effort as the relays write it, or '' when the value is not one. */
function normalizeEffort(value) {
  const effort = toText(value).toLowerCase();
  return REMOTE_RELAY_EFFORT_PATTERN.test(effort) ? effort : '';
}

function effortLevels(values) {
  return uniqueTexts((Array.isArray(values) ? values : []).map(normalizeEffort)).slice(0, EFFORT_LEVELS_MAX);
}

/**
 * The efforts /api/models lists for a provider's model, or null when the
 * remote does not say. `reasoningByProvider` is the provider's own view;
 * `reasoningByModel` is keyed by model id alone, which providers share, so it
 * only decides where the provider has no entry of its own.
 */
function catalogEffortsFor(models, provider, model) {
  const key = toText(model).toLowerCase();
  if (!key || !isPlainObject(models)) return null;
  const keys = uniqueTexts([key, key.replace(CLAUDE_LONG_CONTEXT_SUFFIX, '')]);
  const maps = [
    isPlainObject(models.reasoningByProvider) ? models.reasoningByProvider[provider] : null,
    models.reasoningByModel,
  ];
  for (const map of maps) {
    if (!isPlainObject(map)) continue;
    for (const candidate of keys) {
      const levels = effortLevels(map[candidate]);
      if (levels.length) return levels;
    }
  }
  return null;
}

/** `[{ efforts, models }]`: the models of a provider grouped by the efforts they take. */
function groupEffortsByModel(models, provider, offered = []) {
  const groups = new Map();
  for (const model of offered) {
    const levels = catalogEffortsFor(models, provider, model);
    if (!levels) continue;
    const id = levels.join(' ');
    if (!groups.has(id)) groups.set(id, { efforts: levels, models: [] });
    groups.get(id).models.push(model);
  }
  return [...groups.values()]
    .sort((a, b) => b.models.length - a.models.length)
    .slice(0, EFFORT_GROUPS_MAX)
    .map((group) => (group.models.length > EFFORT_GROUP_MODELS_MAX
      ? { efforts: group.efforts, models: group.models.slice(0, EFFORT_GROUP_MODELS_MAX), more: group.models.length - EFFORT_GROUP_MODELS_MAX }
      : group));
}

/** True when the remote answered 400 because its model does not take the effort we sent. */
function isEffortRejection(error) {
  const body = isPlainObject(error?.remoteBody) ? error.remoteBody : null;
  if (!body || Number(error?.status) !== 400) return false;
  return toText(body.code) === EFFORT_UNSUPPORTED_CODE || Array.isArray(body[EFFORT_SUPPORTED_FIELD]);
}

function supportedEffortsOf(error) {
  return effortLevels(error?.remoteBody?.[EFFORT_SUPPORTED_FIELD]);
}

function supportedEffortsText(levels) {
  return levels.length ? ` (it takes: ${levels.join(', ')})` : '';
}

function isRemoteRelayError(error) {
  return error?.name === 'RemoteRelayError' || /^REMOTE_/.test(toText(error?.code));
}

/** A failure that says nothing about whether the request got through: no connection, a timeout, a 5xx. */
function isTransientRemoteError(error) {
  if (!isRemoteRelayError(error)) return false;
  return toText(error.code) === REMOTE_RELAY_ERROR_CODES.offline || Number(error.status) >= 500;
}

// POST /api/message answers a replayed messageId with this (409).
const DUPLICATE_MESSAGE_ID_CODE = 'DUPLICATE_MESSAGE_ID';

function isOwnDuplicateMessage(error, messageId) {
  const body = isPlainObject(error?.remoteBody) ? error.remoteBody : null;
  if (Number(error?.status) !== 409 || toText(body?.code) !== DUPLICATE_MESSAGE_ID_CODE) return false;
  return !toText(body.messageId) || toText(body.messageId) === messageId;
}

/** A refusal decided on this relay, with the status and code the agent sees. */
class DispatchFailure extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'DispatchFailure';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function failure(status, code, error, extra = {}) {
  return { status, body: { ok: false, code, error, ...extra } };
}

function invalidInput(error) {
  return new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, error);
}

const PERMISSION_DESCRIPTIONS = Object.freeze({
  read: 'only read',
  prompt: 'only read and send prompts',
  full: 'do everything',
});

function relayTarget(relay) {
  return { id: relay.id, name: relay.name, url: relay.url };
}

/**
 * The question card's view of a relay question: what the agent needs to answer
 * it. Null for the remote's own remote-relay approval cards, which only its
 * user may answer (the remote hides them from us as well).
 */
function mapPendingQuestion(question) {
  if (!isPlainObject(question) || !toText(question.id)) return null;
  if (isRemoteRelayApprovalQuestion(question)) return null;
  const context = isPlainObject(question.context) ? question.context : {};
  const fields = schemaFields(question.requestSchema);
  return {
    id: toText(question.id),
    question: toText(question.prompt),
    header: toText(context.header) || null,
    options: Array.isArray(question.choices) ? question.choices.map((choice) => toText(choice)).filter(Boolean) : [],
    multiSelect: context.multiSelect === true,
    allowFreeform: question.allowFreeform !== false,
    ...(fields.length ? {
      fields: fields.map((field) => ({
        name: field.name,
        title: field.title,
        type: field.type,
        required: field.required,
        ...(field.choices.length ? { options: field.choices.map((choice) => String(choice.value)) } : {}),
      })),
    } : {}),
    message_id: toText(question.messageId) || null,
    expiresAt: question.expiresAt || null,
  };
}

function activityTexts(activities, { max = ACTIVITY_LINES_PER_MESSAGE, fromEnd = false } = {}) {
  const lines = (Array.isArray(activities) ? activities : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.text))
    .map((line) => clipLine(line, ACTIVITY_LINE_MAX))
    .filter(Boolean);
  return fromEnd ? lines.slice(-max) : lines.slice(0, max);
}

/**
 * What a turn in flight is doing: its last main-thread stream text and its
 * last activity lines. `messageId` names the message the caller waits for, so
 * the snapshot can say whether that message's own turn is running.
 */
function progressSnapshot(inFlight, messageId = '') {
  if (!isPlainObject(inFlight)) return null;
  const events = Array.isArray(inFlight.streamEvents) ? inFlight.streamEvents : [];
  const mainThread = events.filter((event) => !event?.subagentRunId);
  const lastEvent = (mainThread.length ? mainThread : events).at(-1);
  const turnMessageId = toText(inFlight.messageId) || null;
  const own = !messageId || turnMessageId === messageId;
  return {
    status: own ? 'running' : 'waiting_behind_turn',
    turnMessageId,
    startedAt: inFlight.processingAt || inFlight.timestamp || null,
    text: clipTail(toText(lastEvent?.text), PROGRESS_TEXT_MAX),
    activities: activityTexts(inFlight.activities, { max: PROGRESS_ACTIVITY_COUNT, fromEnd: true }),
  };
}

const FINISHED_TASK_STATUSES = new Set(['completed', 'complete', 'done', 'failed', 'stopped', 'killed', 'cancelled', 'canceled']);

/**
 * Whether the remote agent keeps working after it answered `replyMessageId`:
 * a Claude agent often starts a background task, ends its turn with an
 * interim reply ("started it in the background"), and answers for real in a
 * follow-up turn (kind `continuation`) once the task reports back. `rows` are
 * the rows after the sent message, oldest first; `page` is the conversation
 * read they came with. A later user message ends the follow-up: from there
 * the session is working for someone else.
 */
export function remoteFollowUpState(rows, replyMessageId, page, { sawBackgroundWork = false, sentMessageId = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const start = list.findIndex((row) => toText(row?.id) === replyMessageId);
  const afterReply = start === -1 ? [] : list.slice(start + 1);
  const nextUser = afterReply.findIndex((row) => row?.role === 'user');
  const window = nextUser === -1 ? afterReply : afterReply.slice(0, nextUser);
  const followUps = window.filter((row) => row?.role === 'assistant' && toText(row?.kind).toLowerCase() === 'continuation');
  const tasks = (Array.isArray(page?.backgroundTasks) ? page.backgroundTasks : [])
    .filter((task) => !FINISHED_TASK_STATUSES.has(toText(task?.status).toLowerCase()));
  const handedOver = nextUser !== -1;
  // A queued follow-up turn shows only as activeTurn (between a task's end and
  // the follow-up turn starting); on its own, activeTurn is too weak a sign, so
  // it counts once background work or a follow-up was seen for this message.
  // A turn in flight that belongs to no user message (not the sent one, and no
  // later one exists) is a turn the agent opened itself: a follow-up that is
  // running right now, whether or not a background task was ever published
  // (subagents the agent waits for are not).
  const turnInFlight = isPlainObject(page?.inFlight) ? toText(page.inFlight.messageId) : '';
  const ownTurnInFlight = !!turnInFlight && !handedOver && !!sentMessageId && turnInFlight !== sentMessageId;
  const backgroundSeen = sawBackgroundWork || tasks.length > 0 || followUps.length > 0 || ownTurnInFlight;
  const working = !handedOver && (
    tasks.length > 0
    || (isPlainObject(page?.inFlight) && backgroundSeen)
    || (page?.activeTurn === true && backgroundSeen)
  );
  return {
    backgroundSeen,
    working,
    latest: followUps.at(-1) || null,
    followUpCount: followUps.length,
    tasks: tasks.slice(0, 5).map((task) => clipLine(task?.description || task?.summary || task?.title || task?.taskId || 'background task', 120)),
    taskCount: tasks.length,
  };
}

function replyOf(row, extra = {}) {
  const clipped = clipMiddle(toText(row?.text), REPLY_TEXT_MAX);
  return {
    text: clipped.text,
    model: toText(row?.model) || null,
    messageId: toText(row?.id) || null,
    ...(clipped.truncated ? { truncated: true } : {}),
    ...extra,
  };
}

/**
 * The outcome for `messageId` from the rows after it (oldest first), or null
 * while there is none yet. `{ foldedWithoutReply:true }` means the message was
 * folded into a turn whose reply has not appeared (yet).
 */
export function settleRemoteReply(messages, messageId) {
  const rows = Array.isArray(messages) ? messages : [];
  const own = rows.find((row) => row?.role === 'assistant' && toText(row?.sourceMessageId) === messageId);
  if (!own) return null;
  const kind = toText(own.kind).toLowerCase();
  if (kind === 'stopped') {
    return { status: 'stopped', note: 'The remote turn was stopped before it answered this message.' };
  }
  if (kind === 'folded') {
    const answer = rows.find((row) => row?.role === 'assistant'
      && row !== own
      && (!toText(row.kind) || toText(row.kind).toLowerCase() === 'absorbed'));
    if (!answer) return { foldedWithoutReply: true };
    const note = 'The message was steered into the turn that was already running; this is that turn\'s reply.';
    if (looksLikeFailureText(answer.text)) return { status: 'failed', reply: replyOf(answer, { folded: true }), note };
    return { status: 'done', reply: replyOf(answer, { folded: true }), note };
  }
  if (kind === ANSWERED_ELSEWHERE_KIND) {
    // The marker only points at the answer, which the remote published as a
    // background turn BEFORE it closed the message: the nearest continuation
    // reply above the marker. The marker's own text is never the reply — it
    // tells a human to resend, and a calling agent would run the prompt twice.
    const answer = rows.slice(0, rows.indexOf(own)).reverse().find((row) => row?.role === 'assistant'
      && toText(row.kind).toLowerCase() === 'continuation');
    if (!answer) {
      return {
        status: 'done',
        note: 'The remote agent answered this message in a background turn, but that reply was not found after the message; use read_session to see it. Do not send the message again.',
      };
    }
    const note = 'The remote relay published the answer to this message as a background turn; this is that turn\'s reply.';
    if (looksLikeFailureText(answer.text)) {
      return { status: 'failed', reply: replyOf(answer, { answeredElsewhere: true }), note };
    }
    return { status: 'done', reply: replyOf(answer, { answeredElsewhere: true }), note };
  }
  if (looksLikeFailureText(own.text)) {
    return { status: 'failed', reply: replyOf(own), note: 'The remote turn failed; the reply is the relay\'s failure text.' };
  }
  if (kind === 'absorbed') {
    return {
      status: 'done',
      reply: replyOf(own, { absorbed: true }),
      note: 'The remote agent picked up a later message mid-reply, so the turn continued there; read_session shows the rest.',
    };
  }
  return { status: 'done', reply: replyOf(own) };
}

export function createRemoteRelayDispatcher({
  registry,
  client,
  repository,
  getCallerContext = async () => null,
  requestApproval = async () => false,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  emitStatusEvent = () => {},
  pollIntervalMs = 2000,
  randomUUID = nodeRandomUUID,
  // The OAR MCP server names its session by SDK session id, which older
  // conversations do not share with their conversation id: map it back, so
  // the unlock gate and the caller context read the right conversation.
  resolveConversationId = (id) => id,
} = {}) {
  const inflightByConversation = new Map();
  const callTimesByConversation = new Map();
  const writeTimesByConversation = new Map();

  // ─── Bookkeeping ───────────────────────────────────────────────────────────

  function inflight(conversationId) {
    const requested = toText(conversationId);
    let resolved = requested;
    try {
      resolved = toText(resolveConversationId(requested)) || requested;
    } catch {}
    return inflightByConversation.get(resolved) || 0;
  }

  // The runtime passes no repository when migration 0005 failed this boot:
  // nothing is unlocked then (fail closed).
  function isUnlocked(conversationId, relayId) {
    try {
      return !!repository?.hasUnlock?.(conversationId, relayId);
    } catch {
      return false;
    }
  }

  function adjustInflight(conversationId, delta) {
    const next = inflight(conversationId) + delta;
    if (next > 0) inflightByConversation.set(conversationId, next);
    else inflightByConversation.delete(conversationId);
  }

  function recentTimes(map, conversationId, cutoff) {
    const times = (map.get(conversationId) || []).filter((at) => at > cutoff);
    if (times.length) map.set(conversationId, times);
    else map.delete(conversationId);
    return times;
  }

  /** Sliding one-minute windows per conversation. Null when allowed (and counted). */
  function consumeRateLimit(conversationId, write) {
    const at = now();
    const cutoff = at - RATE_WINDOW_MS;
    const calls = recentTimes(callTimesByConversation, conversationId, cutoff);
    const writes = recentTimes(writeTimesByConversation, conversationId, cutoff);
    const limited = calls.length >= REMOTE_RELAY_LIMITS.callsPerMinute
      ? calls
      : (write && writes.length >= REMOTE_RELAY_LIMITS.writesPerMinute ? writes : null);
    if (limited) {
      return Math.max(1, Math.ceil((limited[0] + RATE_WINDOW_MS - at) / 1000));
    }
    callTimesByConversation.set(conversationId, [...calls, at]);
    if (write) writeTimesByConversation.set(conversationId, [...writes, at]);
    return null;
  }

  function auditWrite({ conversationId, action, relay, session, outcome, ok }) {
    const relayName = toText(relay?.name) || '-';
    try {
      logger?.log?.(`${LOG_PREFIX} ${action} ${relayName} ${shortId(session)} → ${outcome} conv=${shortId(conversationId)}`);
    } catch {}
    try {
      emitStatusEvent({
        type: 'remote_relay',
        action,
        relay: relayName,
        relayId: toText(relay?.id) || null,
        session: toText(session) || null,
        result: outcome,
        ok: !!ok,
        conversationId,
      });
    } catch {}
  }

  // ─── Remote calls ──────────────────────────────────────────────────────────

  function call(ctx, method, path, { query, body, timeoutMs } = {}) {
    return client.request(ctx.relay, method, path, {
      ...(query ? { query: compactQuery(query) } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      hops: ctx.hops,
    });
  }

  function sessionPath(session, suffix = '') {
    return `/api/conversation/${encodeURIComponent(session)}${suffix}`;
  }

  async function loadPendingQuestions(ctx, conversationId) {
    try {
      const response = await call(ctx, 'GET', '/api/relay-questions', {
        query: { status: 'pending', conversationId },
      });
      return (Array.isArray(response?.questions) ? response.questions : [])
        .map(mapPendingQuestion)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Whether nothing is queued or running in the remote conversation. Uses the
   * payload's `activeTurn` when the remote sends one; otherwise (it only has
   * `inFlight`, which misses a row still waiting for its worker) the
   * relay-wide queue counts, which are conservative: any queued work anywhere
   * reads as "not idle".
   */
  async function remoteConversationIdle(ctx, page) {
    if (page?.inFlight) return false;
    if (page?.activeTurn === true) return false;
    if (page?.activeTurn === false) return true;
    try {
      const status = await call(ctx, 'GET', '/api/status');
      const queued = nonNegativeInt(status?.pendingCount)
        + nonNegativeInt(status?.processingCount)
        + nonNegativeInt(status?.parkedCount);
      return queued === 0;
    } catch {
      return false;
    }
  }

  async function buildOrigin(ctx) {
    const self = (await registry.selfIdentity?.()) || {};
    return normalizeRemoteRelayOrigin({
      relayId: self.relayId,
      relayName: self.name || (await registry.selfName?.()),
      relayUrl: self.publicUrl || '',
      conversationId: ctx.caller.conversationId || ctx.conversationId,
      conversationTitle: ctx.caller.title,
      provider: ctx.caller.provider,
      model: ctx.caller.model,
      hops: ctx.hops,
    });
  }

  /**
   * The rows after the sent message: `page` (read with `limit`), and while
   * pages come back full, the ones after it, up to `maxPages` pages in all.
   * `truncated` when there were more than that.
   */
  async function rowsAfterMessage(ctx, session, page, limit, maxPages) {
    const rows = Array.isArray(page?.messages) ? [...page.messages] : [];
    let current = page;
    let currentLimit = limit;
    for (let pages = 1; ; pages += 1) {
      const got = Array.isArray(current?.messages) ? current.messages : [];
      const hasMoreNewer = current?.pageInfo?.hasMoreNewer;
      const more = typeof hasMoreNewer === 'boolean' ? hasMoreNewer : got.length >= currentLimit;
      const cursor = toText(got.at(-1)?.id);
      if (!more || !cursor) return { rows, truncated: false };
      if (pages >= maxPages) return { rows, truncated: true };
      currentLimit = HISTORY_PAGE_MAX;
      current = await call(ctx, 'GET', sessionPath(session), {
        query: { afterMessageId: cursor, limit: currentLimit },
      });
      rows.push(...(Array.isArray(current?.messages) ? current.messages : []));
    }
  }

  /**
   * Polls the remote transcript until `messageId` is answered, settles
   * otherwise, or `waitSeconds` run out. One read per poll in the common case.
   * The prompt is queued by then, so a failed read never surfaces as a bare
   * error (which reads as "not sent" and invites a second send or a second
   * session): the result stays `queued` / `running` with a note to wait again.
   */
  async function waitForReply(ctx, { session, messageId, waitSeconds }) {
    const seen = { inFlight: null };
    try {
      return await pollForReply(ctx, { session, messageId, waitSeconds, seen });
    } catch (error) {
      const remote = isRemoteRelayError(error);
      const code = remote ? (toText(error.code) || REMOTE_RELAY_ERROR_CODES.offline) : REMOTE_RELAY_INTERNAL_ERROR_CODE;
      if (!remote) {
        try {
          logger?.warn?.(`${LOG_PREFIX} wait failed conv=${shortId(ctx.conversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
        } catch {}
      }
      return {
        session,
        message_id: messageId,
        status: seen.inFlight ? 'running' : 'queued',
        progress: progressSnapshot(seen.inFlight, messageId) || { status: 'queued', text: '', activities: [] },
        note: `The wait failed (${code}): the prompt was queued; call wait with this session and message_id to keep waiting. Do not send it again.`,
      };
    }
  }

  async function pollForReply(ctx, { session, messageId, waitSeconds, seen }) {
    const deadline = now() + Math.max(0, waitSeconds) * 1000;
    const base = { session, message_id: messageId };
    let idleSeen = false;
    let firstRead = true;
    for (;;) {
      // The confirming read before "cancelled" looks as far as the remote
      // allows per page, for a reply that sits unusually far behind its
      // message. It and the first read (a late wait) follow a full page with
      // the pages after it; the polls in between watch the first page only.
      const limit = idleSeen ? HISTORY_PAGE_MAX : WAIT_PAGE_LIMIT;
      const page = await call(ctx, 'GET', sessionPath(session), {
        query: { afterMessageId: messageId, limit },
      });
      const inFlight = isPlainObject(page?.inFlight) ? page.inFlight : null;
      seen.inFlight = inFlight;
      const after = await rowsAfterMessage(ctx, session, page, limit, firstRead || idleSeen ? AFTER_SCAN_PAGES : 1);
      firstRead = false;
      const conversationId = toText(page?.id) || session;
      const settled = settleRemoteReply(after.rows, messageId);
      if (settled && !settled.foldedWithoutReply) {
        if (settled.status !== 'done' || !settled.reply?.messageId) return { ...base, ...settled };
        const follow = remoteFollowUpState(after.rows, settled.reply.messageId, page, { sawBackgroundWork: seen.background === true, sentMessageId: messageId });
        if (follow.backgroundSeen) seen.background = true;
        const latestReply = follow.latest ? replyOf(follow.latest, { followUp: true }) : settled.reply;
        if (!follow.working) {
          if (!follow.backgroundSeen) return { ...base, ...settled };
          // After background work, a quiet moment is not the end yet: the
          // worker publishes a new task set up to 2 s late, and a finished
          // task opens its follow-up turn a moment after. Done only once the
          // session stays quiet for the whole settle window.
          if (!seen.quietSince) seen.quietSince = now();
          if (now() - seen.quietSince >= FOLLOW_UP_SETTLE_MS) {
            return {
              ...base,
              status: 'done',
              reply: latestReply,
              ...(follow.latest ? { firstReply: settled.reply } : {}),
              note: follow.latest
                ? `The remote agent finished work it had continued in the background; this is its last follow-up reply (${follow.followUpCount} in all, read_session shows every one).`
                : 'The remote agent\'s background work ended without a follow-up reply; the reply above is its only one.',
            };
          }
        } else {
          seen.quietSince = null;
        }
        if (inFlight) {
          const pendingQuestions = await loadPendingQuestions(ctx, toText(page?.id) || session);
          if (pendingQuestions.length) {
            return {
              ...base,
              status: 'waiting_for_answer',
              reply: latestReply,
              pendingQuestions,
              progress: progressSnapshot(inFlight),
              note: 'The remote agent answered, kept working in the background and now waits for an answer. Ask the user (unless they told you to decide), then call answer_question and wait again.',
            };
          }
        }
        const remainingForFollowUp = deadline - now();
        if (remainingForFollowUp <= 0 || ctx.signal?.aborted) {
          return {
            ...base,
            status: 'running',
            reply: latestReply,
            ...(follow.latest ? { firstReply: settled.reply } : {}),
            background: { tasks: follow.taskCount, running: follow.tasks },
            progress: progressSnapshot(inFlight) || { status: 'background', text: '', activities: [] },
            note: 'The remote agent answered but keeps working in the background; the reply above is its latest so far. Call wait with this session and message_id for the follow-up.',
          };
        }
        await sleep(Math.min(pollIntervalMs, remainingForFollowUp));
        continue;
      }

      if (inFlight) {
        idleSeen = false;
        const pendingQuestions = await loadPendingQuestions(ctx, conversationId);
        if (pendingQuestions.length) {
          return {
            ...base,
            status: 'waiting_for_answer',
            pendingQuestions,
            progress: progressSnapshot(inFlight, messageId),
            note: 'The remote agent is waiting for an answer. Ask the user (unless they told you to decide), then call answer_question and wait again.',
          };
        }
      } else if (await remoteConversationIdle(ctx, page)) {
        if (settled?.foldedWithoutReply) {
          return {
            ...base,
            status: 'done',
            note: 'The message was steered into a turn that has finished, but its reply was not found after the message; use read_session to see it.',
          };
        }
        // A reply and the end of its turn are committed together, but the two
        // reads above are not one snapshot: look once more before calling the
        // message cancelled.
        if (idleSeen && after.truncated) {
          return {
            ...base,
            status: 'done',
            note: `Nothing is queued or running in the remote session, but no reply to this message was found in the ${after.rows.length} messages after it; use read_session to look further back.`,
          };
        }
        if (idleSeen) {
          return {
            ...base,
            status: 'cancelled',
            note: 'Nothing is queued or running in the remote session and the message got no reply (it was cancelled or removed there).',
          };
        }
        idleSeen = true;
        continue;
      } else {
        idleSeen = false;
      }

      const remaining = deadline - now();
      if (remaining <= 0 || ctx.signal?.aborted) {
        return {
          ...base,
          status: inFlight ? 'running' : 'queued',
          progress: progressSnapshot(inFlight, messageId) || { status: 'queued', text: '', activities: [] },
          note: 'Not finished yet. Call wait with this session and message_id to keep waiting.',
        };
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  // ─── Remote catalogue (relay_info, create_session) ─────────────────────────

  async function loadCatalog(ctx) {
    const [status, models, copilot, ...settings] = await Promise.allSettled([
      call(ctx, 'GET', '/api/status'),
      call(ctx, 'GET', '/api/models'),
      call(ctx, 'GET', '/api/settings/copilot'),
      ...SETTINGS_PROVIDERS.map((provider) => call(ctx, 'GET', `/api/settings/${provider}`)),
    ]);
    if (status.status === 'rejected') throw status.reason;
    const value = (result) => (result.status === 'fulfilled' && isPlainObject(result.value) ? result.value : null);
    return {
      status: value(status) || {},
      models: value(models),
      copilot: value(copilot),
      settings: Object.fromEntries(SETTINGS_PROVIDERS.map((provider, index) => [provider, value(settings[index])])),
    };
  }

  /**
   * `[{ provider, configured, defaultModel, models }]` in contract order, with
   * `efforts` where the remote lists the reasoning efforts of those models.
   */
  function buildProviders(catalog) {
    return listProviders(catalog).map((entry) => {
      const efforts = groupEffortsByModel(catalog.models, entry.provider, entry.models);
      return efforts.length ? { ...entry, efforts } : entry;
    });
  }

  function listProviders(catalog) {
    const models = catalog.models || {};
    const providersByModel = isPlainObject(models.providersByModel) ? models.providersByModel : {};
    const catalogModels = Array.isArray(models.models) ? models.models.map(toText).filter(Boolean) : [];
    const modelsLabelled = (label) => Object.entries(providersByModel)
      .filter(([, providers]) => Array.isArray(providers) && providers.some((entry) => toText(entry).toLowerCase() === label))
      .map(([model]) => model);

    return REMOTE_RELAY_PROVIDERS.map((provider) => {
      if (provider === 'github') {
        // Copilot's catalogue is every model no other provider claims alone.
        const githubModels = catalogModels.filter((model) => {
          const providers = catalogProvidersFor(providersByModel, model);
          return providers.length === 0 || providers.includes(CATALOG_PROVIDER_LABELS.github);
        });
        const defaultModel = toText(catalog.status.defaultModel) || toText(models.defaultModel) || toText(models.currentModel) || null;
        return {
          provider,
          configured: true,
          defaultModel,
          models: uniqueTexts([...(defaultModel ? [defaultModel] : []), ...githubModels]),
          ...(toText(catalog.copilot?.engine) ? { engine: toText(catalog.copilot.engine) } : {}),
        };
      }
      const settings = catalog.settings[provider];
      if (!settings) return { provider, configured: false, defaultModel: null, models: [] };
      // What POST /api/conversation/bootstrap requires, plus "not switched off".
      const configured = settings.enabled === true
        && (provider === 'claude' || provider === 'grok' || settings.configured === true);
      const defaultModel = toText(settings.model) || null;
      const listed = provider === 'openai'
        ? modelsLabelled(CATALOG_PROVIDER_LABELS.openai)
        : (Array.isArray(settings.models) ? settings.models : []);
      return {
        provider,
        configured,
        defaultModel,
        models: configured ? uniqueTexts([...(defaultModel ? [defaultModel] : []), ...listed]) : [],
      };
    });
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  async function relayInfo(ctx) {
    const [identity, catalog] = await Promise.all([
      call(ctx, 'GET', '/api/relay/identity').catch(() => null),
      loadCatalog(ctx),
    ]);
    const status = catalog.status;
    const providers = buildProviders(catalog);
    const remoteRelays = isPlainObject(identity?.remoteRelays) ? identity.remoteRelays : null;
    const configured = providers.filter((entry) => entry.configured).map((entry) => entry.provider);
    const version = toText(status.version) || toText(identity?.version) || null;
    return {
      summary: `relay_info → ${ctx.relay.name}: OAR ${version || '?'}, providers ${configured.join(', ') || 'none'}`,
      name: toText(identity?.name) || ctx.relay.name,
      url: ctx.relay.url,
      openUrl: remoteConversationUrl(ctx.relay.url, ''),
      version,
      platform: toText(status.platform) || toText(identity?.platform) || null,
      protocol: remoteRelays ? nonNegativeInt(remoteRelays.protocol) : 0,
      acceptsAgentPrompts: remoteRelays ? remoteRelays.inbound !== false : null,
      providers,
      workspaces: {
        default: toText(status.defaultSessionWorkspaceRootPath) || toText(status.workspaceRootPath) || null,
        current: toText(status.workspaceRootPath) || null,
        recent: Array.isArray(status.recentWorkspaceRoots) ? status.recentWorkspaceRoots.map(toText).filter(Boolean) : [],
      },
      relayModes: Array.isArray(status.supportedRelayModes) ? status.supportedRelayModes : [],
      defaultRelayMode: toText(status.defaultRelayMode) || null,
    };
  }

  async function liveWorkerConversationIds(ctx) {
    try {
      const status = await call(ctx, 'GET', '/api/status');
      const workers = Array.isArray(status?.sessionWorker?.workers) ? status.sessionWorker.workers : [];
      return new Set(workers
        .filter((worker) => WORKING_WORKER_STATUSES.has(toText(worker?.status).toLowerCase()))
        .map((worker) => toText(worker?.conversationId))
        .filter(Boolean));
    } catch {
      return new Set();
    }
  }

  function mapSession(row, workerIds) {
    const id = toText(row?.id);
    const via = toText(row?.origin?.relayName);
    return {
      id,
      title: toText(row?.title),
      provider: toText(row?.runtimeProviderType) || 'github',
      model: toText(row?.runtimeProviderModel) || toText(row?.runtimeModel) || toText(row?.preferredModel) || null,
      active: row?.activeTurn === true || !!workerIds?.has(id),
      updatedAt: row?.updatedAt || null,
      messageCount: nonNegativeInt(row?.messageCount),
      cwd: toText(row?.currentWorkspaceRootPath) || null,
      ...(via ? { via } : {}),
    };
  }

  async function listSessions(ctx, args) {
    const { scope, limit } = args;
    const query = toText(args.query).toLowerCase();
    // recent = the newest page, active = working sessions among the newest
    // pages, all = the whole list page by page (only it honours the cursor).
    let cursor = null;
    if (scope === 'all' && args.cursor) {
      cursor = decodeCursor(args.cursor, ['beforeConversationId', 'beforeUpdatedAt']);
      if (!cursor) throw invalidInput('cursor is not a nextCursor from list_sessions');
    }
    const workerIds = scope === 'active' ? await liveWorkerConversationIds(ctx) : null;
    const filtering = !!query || scope === 'active';
    const keep = (row) => (!query || toText(row?.title).toLowerCase().includes(query))
      && (scope !== 'active' || row?.activeTurn === true || workerIds.has(toText(row?.id)));

    const sessions = [];
    let hasMore = false;
    let scanned = 0;
    for (let page = 0; page < (filtering ? LIST_SCAN_PAGES : 1); page += 1) {
      const response = await call(ctx, 'GET', '/api/conversations', {
        query: {
          limit: filtering ? LIST_PAGE_MAX : limit,
          beforeConversationId: cursor?.beforeConversationId,
          beforeUpdatedAt: cursor?.beforeUpdatedAt,
        },
      });
      const rows = Array.isArray(response?.conversations) ? response.conversations : [];
      let consumed = 0;
      for (const row of rows) {
        consumed += 1;
        if (keep(row)) sessions.push(mapSession(row, workerIds));
        if (sessions.length >= limit) break;
      }
      scanned += consumed;
      const last = rows[consumed - 1];
      if (last) cursor = { beforeConversationId: toText(last.id), beforeUpdatedAt: toText(last.updatedAt) };
      hasMore = consumed < rows.length || response?.pageInfo?.hasMore === true;
      if (sessions.length >= limit || !hasMore || !rows.length) break;
    }

    const nextCursor = scope === 'all' && hasMore && cursor ? encodeCursor(cursor) : null;
    const note = filtering && hasMore && sessions.length < limit && scope !== 'all'
      ? `Searched the newest ${scanned} sessions only; use scope "all" with the cursor to search further.`
      : null;
    return {
      summary: `list_sessions → ${ctx.relay.name}: ${sessions.length} session${sessions.length === 1 ? '' : 's'} (${scope}${query ? `, "${clipLine(args.query, 40)}"` : ''})`,
      scope,
      sessions,
      nextCursor,
      ...(note ? { note } : {}),
    };
  }

  function messageText(row) {
    const text = String(row?.text ?? '');
    // The header line is ours (or another relay's): the badge fields say the
    // same, so the agent reads the prompt itself.
    return row?.role === 'user' && row?.origin ? stripRemotePromptHeader(text) : text;
  }

  /**
   * Newest first within `maxChars`. Each message is capped at its share of
   * the budget, but never below perMessageChars: `last:1, max_chars:20000`
   * returns a 9000-character reply whole, ten messages in the default 12000
   * still get 4000 each. A trimmed message keeps its head and its tail.
   */
  function shapeMessages(rows, { maxChars, includeActivity }) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const out = [];
    const perMessageMax = Math.max(REMOTE_RELAY_LIMITS.perMessageChars, Math.floor(maxChars / Math.max(1, list.length)));
    let budget = maxChars;
    let omitted = 0;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const row = list[index];
      const perMessage = clipMiddle(messageText(row), perMessageMax);
      let text = perMessage.text;
      let truncated = perMessage.truncated;
      if (text.length > budget) {
        if (budget < MIN_TRIMMED_MESSAGE_CHARS && out.length) {
          omitted = index + 1;
          break;
        }
        text = clipMiddle(text, Math.max(budget, MIN_TRIMMED_MESSAGE_CHARS)).text;
        truncated = true;
      }
      budget -= text.length;
      const role = toText(row.role) || 'assistant';
      const via = toText(row?.origin?.relayName);
      const activities = includeActivity && role === 'assistant' ? activityTexts(row.activities) : [];
      out.unshift({
        id: toText(row.id),
        role,
        time: row.timestamp || null,
        ...(toText(row.kind) ? { kind: toText(row.kind) } : {}),
        ...(role === 'assistant' && toText(row.model) ? { model: toText(row.model) } : {}),
        ...(role === 'assistant' && toText(row.sourceMessageId) ? { replyTo: toText(row.sourceMessageId) } : {}),
        ...(via ? { via } : {}),
        text,
        ...(truncated ? { truncated: true } : {}),
        ...(activities.length ? { activities } : {}),
      });
      if (budget <= 0 && index > 0) {
        omitted = index;
        break;
      }
    }
    return { messages: out, omitted };
  }

  async function readSession(ctx, args) {
    let before = null;
    if (args.before) {
      before = decodeCursor(args.before, ['beforeMessageId', 'beforeTimestamp']);
      if (!before) throw invalidInput('before is not an olderCursor from read_session');
    }
    const conversation = await call(ctx, 'GET', sessionPath(args.session), {
      query: { limit: args.last, beforeMessageId: before?.beforeMessageId, beforeTimestamp: before?.beforeTimestamp },
    });
    const conversationId = toText(conversation?.id) || args.session;
    const pendingQuestions = await loadPendingQuestions(ctx, conversationId);
    const { messages, omitted } = shapeMessages(conversation?.messages, {
      maxChars: args.max_chars,
      includeActivity: args.include_activity,
    });
    let olderCursor = null;
    if (omitted > 0 && messages.length) {
      olderCursor = encodeCursor({ beforeMessageId: messages[0].id, beforeTimestamp: toText(messages[0].time) });
    } else if (conversation?.pageInfo?.hasMoreOlder && isPlainObject(conversation.pageInfo.olderCursor)) {
      olderCursor = encodeCursor({
        beforeMessageId: toText(conversation.pageInfo.olderCursor.beforeMessageId),
        beforeTimestamp: toText(conversation.pageInfo.olderCursor.beforeTimestamp),
      });
    }
    const runtime = isPlainObject(conversation?.runtimeSession) ? conversation.runtimeSession : {};
    const via = toText(conversation?.origin?.relayName);
    const inFlight = progressSnapshot(conversation?.inFlight);
    return {
      summary: `read_session → ${ctx.relay.name} session ${shortId(conversationId)}: ${messages.length} message${messages.length === 1 ? '' : 's'}${inFlight ? ', turn running' : ''}${pendingQuestions.length ? `, ${pendingQuestions.length} question${pendingQuestions.length === 1 ? '' : 's'} pending` : ''}`,
      session: {
        id: conversationId,
        title: toText(conversation?.title),
        provider: toText(runtime.providerType) || 'github',
        model: toText(runtime.providerModel) || toText(conversation?.preferredModel) || toText(runtime.model) || null,
        mode: toText(conversation?.preferredRelayMode) || null,
        cwd: toText(conversation?.currentWorkspaceRootPath) || null,
        archived: conversation?.archived === true,
        ...(via ? { via } : {}),
        openUrl: remoteConversationUrl(ctx.relay.url, conversationId),
      },
      messages,
      ...(inFlight ? { inFlight } : {}),
      pendingQuestions,
      ...(olderCursor ? { olderCursor } : {}),
      ...(omitted > 0 ? { note: `${omitted} older message${omitted === 1 ? '' : 's'} left out to stay within max_chars; pass olderCursor as before to read them.` } : {}),
    };
  }

  function outcomeSummary(action, ctx, outcome) {
    const questions = Array.isArray(outcome.pendingQuestions) ? outcome.pendingQuestions.length : 0;
    return `${action} → ${ctx.relay.name} session ${shortId(outcome.session)}: ${outcome.status}`
      + (questions ? `, ${questions} question${questions === 1 ? '' : 's'} pending` : '');
  }

  async function waitAction(ctx, args) {
    // An unknown message id would read as "no reply, nothing running" forever.
    const around = await call(ctx, 'GET', sessionPath(args.session), {
      query: { aroundMessageId: args.message_id, limit: 1 },
    });
    const found = (Array.isArray(around?.messages) ? around.messages : []).some((row) => toText(row?.id) === args.message_id);
    if (!found) {
      throw new DispatchFailure(404, REMOTE_RELAY_ERROR_CODES.notFound,
        `Message ${args.message_id} is not in session ${args.session} on relay "${ctx.relay.name}".`);
    }
    const session = toText(around?.id) || args.session;
    const outcome = await waitForReply(ctx, { session, messageId: args.message_id, waitSeconds: args.wait_seconds });
    return { summary: outcomeSummary('wait', ctx, outcome), ...outcome };
  }

  /**
   * Queues the prompt. A send whose connection fails may still have landed,
   * and the remote dedups on messageId, so it is replayed once with the same
   * id: a 409 DUPLICATE_MESSAGE_ID then means the first attempt got through.
   * When the replay fails too, nobody knows; the error carries the session
   * and message id so the agent checks with wait instead of sending again.
   */
  async function postPrompt(ctx, { session, text, origin, model, mode, effort }) {
    const messageId = String(randomUUID());
    const body = {
      conversationId: session,
      text: withRemotePromptHeader(text, origin),
      messageId,
      origin,
      ...(model ? { model } : {}),
      ...(mode ? { relayMode: mode } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    };
    let sent;
    try {
      sent = await call(ctx, 'POST', '/api/message', { body });
    } catch (error) {
      if (!isTransientRemoteError(error)) throw error;
      try {
        sent = await call(ctx, 'POST', '/api/message', { body });
      } catch (retryError) {
        if (isOwnDuplicateMessage(retryError, messageId)) return { duplicate: false, messageId };
        if (!isTransientRemoteError(retryError)) throw retryError;
        throw new DispatchFailure(502, toText(retryError.code) || REMOTE_RELAY_ERROR_CODES.offline,
          `${toText(retryError.message) || `Relay "${ctx.relay.name}" did not answer`}; the prompt may or may not have been queued.`,
          {
            session,
            message_id: messageId,
            note: 'Call wait with this session and message_id to find out before sending it again: it answers not found when the prompt never arrived.',
          });
      }
    }
    if (sent?.duplicate === true) {
      return {
        duplicate: true,
        messageId: toText(sent.duplicateOfMessageId) || null,
      };
    }
    return {
      duplicate: false,
      messageId: toText(sent?.messageId) || messageId,
      effort: normalizeEffort(sent?.selectedReasoningEffort),
    };
  }

  /**
   * What the remote made of the effort: `reported` is the one it bound (the
   * bootstrap's preferredReasoningEffort, the message's
   * selectedReasoningEffort). Most providers do not refuse an effort their
   * model lacks, they fall back to their default, so the result names the
   * effort the turn runs with and says when that is not the one asked for.
   */
  function settleEffort(ctx, choice, reported) {
    const bound = normalizeEffort(reported);
    if (!bound || bound === choice.effort) return choice;
    if (!choice.effort) return { ...choice, effort: bound, source: EFFORT_SOURCES.remote };
    return {
      effort: bound,
      source: EFFORT_SOURCES.remote,
      note: choice.note
        || `Relay "${ctx.relay.name}" does not offer effort "${choice.effort}" for this model; the turn runs with "${bound}".`,
    };
  }

  /**
   * Queues the prompt with the chosen effort. An effort the agent did not ask
   * for (this session's, the remote session's own) that the remote refuses is
   * dropped and the prompt sent once more without it; one the agent asked for
   * is the remote's to refuse, so that error goes back as it is.
   */
  async function postPromptWithEffort(ctx, prompt, choice) {
    try {
      const sent = await postPrompt(ctx, { ...prompt, effort: choice.effort });
      return { sent, choice: settleEffort(ctx, choice, sent.effort) };
    } catch (error) {
      if (!choice.effort || choice.source === EFFORT_SOURCES.requested || !isEffortRejection(error)) throw error;
      const dropped = {
        effort: '',
        source: EFFORT_SOURCES.remote,
        note: `Relay "${ctx.relay.name}" refused effort "${choice.effort}"${supportedEffortsText(supportedEffortsOf(error))}; sent again without it, so the turn runs with the remote's default.`,
      };
      const sent = await postPrompt(ctx, { ...prompt, effort: '' });
      return { sent, choice: settleEffort(ctx, dropped, sent.effort) };
    }
  }

  /** The `effort` / `effortSource` fields of a result, and the note that goes with them. */
  function effortResult(choice) {
    return {
      ...(choice.source ? { effort: choice.effort || null, effortSource: choice.source } : {}),
      ...(choice.note ? { note: choice.note } : {}),
    };
  }

  async function deliverAndWait(action, ctx, { session, sent, waitSeconds, extra: given = {} }) {
    const openUrl = remoteConversationUrl(ctx.relay.url, session);
    // `extra.note` (how the effort was settled) goes in front of the outcome's own.
    const { note: extraNote, ...extra } = given;
    const result = await deliverOutcome(action, ctx, { session, sent, waitSeconds, extra, openUrl });
    const note = [extraNote, result.note].map(toText).filter(Boolean).join(' ');
    return note ? { ...result, note } : result;
  }

  async function deliverOutcome(action, ctx, { session, sent, waitSeconds, extra, openUrl }) {
    if (sent.duplicate) {
      const outcome = {
        status: 'duplicate',
        session,
        message_id: sent.messageId,
        note: 'The remote relay took this as a repeat of an identical message sent moments ago and did not queue it again. Use wait with this message_id to follow the original.',
      };
      return { summary: outcomeSummary(action, ctx, outcome), ...outcome, ...extra, openUrl };
    }
    if (waitSeconds <= 0) {
      const outcome = { status: 'queued', session, message_id: sent.messageId };
      return { summary: outcomeSummary(action, ctx, outcome), ...outcome, ...extra, openUrl };
    }
    const outcome = await waitForReply(ctx, { session, messageId: sent.messageId, waitSeconds });
    return { summary: outcomeSummary(action, ctx, outcome), ...outcome, ...extra, openUrl };
  }

  async function send(ctx, args) {
    const conversation = await call(ctx, 'GET', sessionPath(args.session), { query: { limit: 1 } });
    const session = toText(conversation?.id) || args.session;
    if (args.if_busy === 'fail' && (conversation?.inFlight || conversation?.activeTurn === true)) {
      throw new DispatchFailure(409, REMOTE_RELAY_ERROR_CODES.busy,
        `Session ${session} on relay "${ctx.relay.name}" is busy with a turn; not sent (if_busy "fail").`,
        { session, progress: progressSnapshot(conversation?.inFlight) });
    }
    const runtime = isPlainObject(conversation?.runtimeSession) ? conversation.runtimeSession : {};
    const provider = toText(runtime.providerType).toLowerCase() || 'github';
    // Without a model the remote falls back to its catalogue's current one and
    // silently switches the session; keep the model the session already uses.
    // Grok pins its model at bootstrap and refuses any other, so it gets none.
    const model = args.model
      || (provider === 'grok' ? '' : (toText(conversation?.preferredModel) || toText(runtime.providerModel) || toText(runtime.model)));
    const mode = args.mode || ctx.caller.mode || toText(conversation?.preferredRelayMode) || '';
    // The remote runs a prompt that names no effort with its provider's
    // default, not with the one the session is set to: pass that one on, so
    // the session keeps its own. This session's effort is never mirrored here.
    const requested = normalizeEffort(args.effort);
    const own = requested ? '' : normalizeEffort(conversation?.preferredReasoningEffort);
    const origin = await buildOrigin(ctx);
    const { sent, choice } = await postPromptWithEffort(ctx, { session, text: args.text, origin, model, mode }, {
      effort: requested || own,
      source: requested ? EFFORT_SOURCES.requested : (own ? EFFORT_SOURCES.remote : ''),
      note: null,
    });
    return deliverAndWait('send', ctx, { session, sent, waitSeconds: args.wait_seconds, extra: effortResult(choice) });
  }

  async function createSession(ctx, args) {
    const catalog = await loadCatalog(ctx);
    const providers = buildProviders(catalog);
    const configured = providers.filter((entry) => entry.configured).map((entry) => entry.provider);
    const provider = args.provider || normalizeProvider(ctx.caller.provider) || 'github';
    const entry = providers.find((candidate) => candidate.provider === provider);
    if (!entry?.configured) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.providerUnavailable,
        `Relay "${ctx.relay.name}" has no ${provider} provider set up. Providers there: ${configured.join(', ') || 'none'}. Pass provider to pick one.`,
        { providers: configured });
    }

    let model = args.model || '';
    let modelSource = model ? 'requested' : '';
    let note = null;
    if (!model) {
      model = matchOfferedModel(ctx.caller.model, entry.models);
      modelSource = model ? 'same as this session' : '';
    }
    if (!model) {
      model = entry.defaultModel || entry.models[0] || '';
      modelSource = 'remote default';
      if (toText(ctx.caller.model)) {
        note = `${provider} on relay "${ctx.relay.name}" does not offer ${ctx.caller.model}; the session uses its default model ${model || '(none)'}.`;
      }
    }
    const mode = args.mode || ctx.caller.mode || toText(catalog.status.defaultRelayMode) || '';
    const title = args.title || firstLine(args.text, TITLE_MAX) || 'Remote session';
    const origin = await buildOrigin(ctx);

    // The effort mirrors the caller like the model does: this session's when
    // the remote lists it for the model (or lists nothing), else the remote's.
    let choice = { effort: normalizeEffort(args.effort), source: EFFORT_SOURCES.requested, note: null };
    if (!choice.effort) {
      const callerEffort = normalizeEffort(ctx.caller.effort);
      const offered = catalogEffortsFor(catalog.models, provider, model);
      if (callerEffort && (!offered || offered.includes(callerEffort))) {
        choice = { effort: callerEffort, source: EFFORT_SOURCES.caller, note: null };
      } else {
        choice = {
          effort: '',
          source: EFFORT_SOURCES.remote,
          note: callerEffort
            ? `${model || provider} on relay "${ctx.relay.name}" does not offer this session's effort "${callerEffort}"${supportedEffortsText(offered || [])}; the session uses the remote's default.`
            : null,
        };
      }
    }

    const bootstrapWith = (effort) => call(ctx, 'POST', '/api/conversation/bootstrap', {
      body: {
        providerType: provider,
        ...(model ? { model } : {}),
        ...(mode ? { relayMode: mode } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        title,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        origin,
      },
    });
    let bootstrap;
    try {
      bootstrap = await bootstrapWith(choice.effort);
    } catch (error) {
      // Only an effort the agent did not ask for is dropped; a refused
      // bootstrap created nothing, so asking again is safe.
      if (!choice.effort || choice.source === EFFORT_SOURCES.requested || !isEffortRejection(error)) throw error;
      choice = {
        effort: '',
        source: EFFORT_SOURCES.remote,
        note: `Relay "${ctx.relay.name}" refused this session's effort "${choice.effort}"${supportedEffortsText(supportedEffortsOf(error))}; the session was started without it and uses the remote's default.`,
      };
      bootstrap = await bootstrapWith('');
    }
    choice = settleEffort(ctx, choice, bootstrap?.preferredReasoningEffort);
    const session = toText(bootstrap?.conversationId);
    if (!session) {
      throw new DispatchFailure(502, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}502`,
        `Relay "${ctx.relay.name}" did not return the new session's id.`);
    }
    const boundModel = toText(bootstrap?.selectedModel) || model;
    let sent;
    try {
      ({ sent, choice } = await postPromptWithEffort(ctx, { session, text: args.text, origin, model: boundModel, mode }, choice));
    } catch (error) {
      if (!choice.effort || !isEffortRejection(error)) throw error;
      // The session exists by now: say so, or the agent starts a second one.
      const supported = supportedEffortsOf(error);
      const remoteCode = toText(error.remoteBody?.code);
      throw new DispatchFailure(400, toText(error.code) || `${REMOTE_RELAY_ERROR_CODES.httpPrefix}400`,
        `${toText(error.message) || `Relay "${ctx.relay.name}" refused effort "${choice.effort}"`}. The session was created, but the prompt was not queued.`,
        {
          session,
          ...(remoteCode ? { remoteCode } : {}),
          ...(supported.length ? { supportedEfforts: supported } : {}),
          openUrl: remoteConversationUrl(ctx.relay.url, session),
          note: 'Use send with this session and an effort it takes (or none); do not create another session.',
        });
    }
    return deliverAndWait('create_session', ctx, {
      session,
      sent,
      waitSeconds: args.wait_seconds,
      extra: {
        provider: toText(bootstrap?.selectedProviderType) || provider,
        model: boundModel || null,
        modelSource,
        mode: toText(bootstrap?.preferredRelayMode) || mode || null,
        title,
        ...(toText(bootstrap?.workspaceRootWarning) ? { cwdWarning: toText(bootstrap.workspaceRootWarning) } : {}),
        ...(note ? { modelNote: note } : {}),
        ...effortResult(choice),
      },
    });
  }

  /** The answer body the remote's answer route expects for this question. */
  function buildAnswer(question, args) {
    const fields = schemaFields(question.requestSchema);
    if (fields.length > 1) {
      let structured = null;
      try {
        structured = JSON.parse(toText(args.answer));
      } catch {}
      if (!isPlainObject(structured)) {
        throw invalidInput(`This question has several fields (${fields.map((field) => field.name).join(', ')}); pass answer as a JSON object with those keys.`);
      }
      return { structuredAnswer: structured, text: JSON.stringify(structured) };
    }
    const options = Array.isArray(question.choices) ? question.choices.map(toText).filter(Boolean) : [];
    const labels = [];
    for (const choice of args.choices || []) {
      const match = options.find((option) => option.toLowerCase() === choice.toLowerCase()) || '';
      if (!match && question.allowFreeform === false) {
        throw invalidInput(`"${clipLine(choice, 80)}" is not an option of this question. Options: ${options.join(', ')}.`);
      }
      const label = match || choice;
      if (!labels.includes(label)) labels.push(label);
    }
    // The card's own format: the picked labels, then any typed text, ", "-joined.
    const extra = toText(args.answer);
    if (extra && !labels.includes(extra)) labels.push(extra);
    const text = labels.join(', ');
    return { answer: text, text };
  }

  async function answerQuestion(ctx, args) {
    const fetched = await call(ctx, 'GET', `/api/relay-question/${encodeURIComponent(args.question_id)}`);
    const question = isPlainObject(fetched?.question) ? fetched.question : null;
    if (!question) {
      throw new DispatchFailure(404, REMOTE_RELAY_ERROR_CODES.notFound,
        `Question ${args.question_id} was not found on relay "${ctx.relay.name}".`);
    }
    const session = toText(question.conversationId) || null;
    if (isRemoteRelayApprovalQuestion(question)) {
      throw new DispatchFailure(403, REMOTE_RELAY_ERROR_CODES.forbidden,
        `Question ${args.question_id} is relay "${ctx.relay.name}"'s approval of its own agent's call to another relay; only its user can answer it.`,
        { session });
    }
    if (toText(question.status) && toText(question.status) !== 'pending') {
      throw new DispatchFailure(409, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}409`,
        `Question ${args.question_id} on relay "${ctx.relay.name}" is already ${toText(question.status).replace(/_/g, ' ')}.`,
        { session });
    }
    const answer = buildAnswer(question, args);
    // The answer route checks the session the question belongs to; the card
    // sends the stored one back, and so do we.
    const sdkSessionId = toText(question.sdkSessionId);
    await call(ctx, 'POST', `/api/relay-question/${encodeURIComponent(args.question_id)}/answer`, {
      body: {
        ...(answer.structuredAnswer ? { structuredAnswer: answer.structuredAnswer } : { answer: answer.answer }),
        ...(sdkSessionId ? { sdk_session_id: sdkSessionId } : {}),
      },
    });
    const messageId = toText(question.messageId) || null;
    return {
      summary: `answer_question → ${ctx.relay.name} question ${shortId(args.question_id)}: answered`,
      status: 'answered',
      question_id: args.question_id,
      session,
      message_id: messageId,
      answer: clipLine(answer.text, 500),
      note: messageId ? 'Call wait with this session and message_id to follow the turn.' : null,
    };
  }

  async function stopTurn(ctx, args) {
    const response = await call(ctx, 'POST', sessionPath(args.session, '/cancel-turn'), { body: {} });
    const acknowledgement = toText(response?.acknowledgement) || (response?.queued ? 'stop-queued' : 'unknown');
    const stopRequested = response?.queued === true;
    const notes = {
      'no-active-turn': 'Nothing was running in that session.',
      'active-turn-unbound': 'A turn is running but it is not bound to a worker the relay can stop.',
      'already-requested': 'A stop was already requested for the running turn.',
    };
    return {
      summary: `stop → ${ctx.relay.name} session ${shortId(args.session)}: ${stopRequested ? 'stop requested' : acknowledgement}`,
      session: args.session,
      stopRequested,
      acknowledgement,
      message_id: toText(response?.activeMessageId) || null,
      ...(notes[acknowledgement] ? { note: notes[acknowledgement] } : {}),
    };
  }

  async function archiveSession(ctx, args) {
    const response = await call(ctx, 'POST', sessionPath(args.session, '/archive'), { body: {} });
    const gone = response?.alreadyDeleted === true;
    return {
      summary: `archive → ${ctx.relay.name} session ${shortId(args.session)}: ${gone ? 'already deleted' : 'archived'}`,
      session: args.session,
      archived: !gone,
      ...(gone ? { note: 'The session was already deleted there.' } : {}),
    };
  }

  const ACTIONS = Object.freeze({
    relay_info: relayInfo,
    list_sessions: listSessions,
    read_session: readSession,
    wait: waitAction,
    send,
    create_session: createSession,
    answer_question: answerQuestion,
    stop: stopTurn,
    archive: archiveSession,
  });

  // ─── Errors ────────────────────────────────────────────────────────────────

  function mapRemoteError(error, relay, { action, args }) {
    const C = REMOTE_RELAY_ERROR_CODES;
    const code = toText(error?.code);
    const status = Number(error?.status) || null;
    const message = toText(error?.message) || `Relay "${relay.name}" did not answer as expected`;
    const remoteBody = isPlainObject(error?.remoteBody) ? error.remoteBody : null;
    const extra = { relay: relay.name };
    if (code === C.offline) return failure(502, C.offline, message, extra);
    if (code === C.unauthorized || status === 401) {
      return failure(502, C.unauthorized, `${message}. Check this relay in Settings → Relays (token).`, extra);
    }
    if (code === C.inboundDisabled || toText(remoteBody?.code) === C.inboundDisabled) {
      return failure(403, C.inboundDisabled, message, extra);
    }
    if (code === C.notFound || status === 404) {
      const what = action === 'answer_question'
        ? `Question ${args.question_id}`
        : (args.session ? `Session ${args.session}` : '');
      return failure(404, C.notFound, what ? `${what} was not found on relay "${relay.name}".` : message, extra);
    }
    const remoteCode = toText(remoteBody?.code) || null;
    const supportedModels = Array.isArray(remoteBody?.supportedModels) ? remoteBody.supportedModels.slice(0, 50) : null;
    // A refused effort: the ones the remote's model takes, so the agent can pick one.
    const supportedEfforts = isEffortRejection(error) ? supportedEffortsOf(error) : [];
    const details = {
      ...extra,
      ...(remoteCode ? { remoteCode } : {}),
      ...(supportedModels ? { supportedModels } : {}),
      ...(supportedEfforts.length ? { supportedEfforts } : {}),
    };
    if (code.startsWith(C.httpPrefix) && status >= 400 && status < 500) return failure(status, code, message, details);
    return failure(502, code || `${C.httpPrefix}502`, message, details);
  }

  // ─── Pipeline ──────────────────────────────────────────────────────────────

  async function listRelays(conversationId) {
    const relays = (await registry.list()) || [];
    const listed = relays.map((relay) => ({
      name: relay.name,
      url: relay.url,
      online: toText(relay.lastStatus).toLowerCase() === 'online',
      version: relay.version || null,
      permission: relay.permission,
      unlocked: isUnlocked(conversationId, relay.id),
    }));
    const unlocked = listed.filter((relay) => relay.unlocked).length;
    return {
      status: 200,
      body: {
        ok: true,
        summary: `list_relays: ${listed.length} relay${listed.length === 1 ? '' : 's'}, ${unlocked} unlocked`,
        self: { name: (await registry.selfName?.()) || null },
        relays: listed,
        hint: 'Mention @name in the chat to unlock a relay.',
      },
    };
  }

  async function runRelayAction({ conversationId, action, args, req, signal }) {
    const resolved = await registry.resolve(args.relay);
    if (!resolved?.relay) {
      const names = Array.isArray(resolved?.names) ? resolved.names : [];
      const error = resolved?.error === 'ambiguous'
        ? `"${args.relay}" matches several relays (${names.join(', ')}); use the full name.`
        : `No paired relay is called "${args.relay}". Known relays: ${names.join(', ') || 'none'}.`;
      return failure(404, REMOTE_RELAY_ERROR_CODES.unknown, error, { relays: names });
    }
    const relay = resolved.relay;
    const write = isRemoteRelayWriteAction(action);
    const finish = (result, session) => {
      if (write) {
        const ok = result.body?.ok === true;
        auditWrite({
          conversationId,
          action,
          relay,
          session: session || result.body?.session || args.session,
          outcome: ok ? (toText(result.body.status) || 'ok') : result.body?.code,
          ok,
        });
      }
      return result;
    };

    if (!isUnlocked(conversationId, relay.id)) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.locked,
        `Relay "${relay.name}" is locked in this conversation. Ask the user to mention @${relay.name} (or its name) in a message to allow work there.`,
        { relay: relay.name }));
    }
    if (!remoteRelayPermissionAllows(relay.permission, action)) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.forbidden,
        `Relay "${relay.name}" lets agents ${PERMISSION_DESCRIPTIONS[relay.permission] || 'do less'} (permission "${relay.permission}"); ${action} needs "${REMOTE_RELAY_ACTION_PERMISSION[action]}". The user can change this in Settings → Relays.`,
        { relay: relay.name, permission: relay.permission }));
    }

    const caller = { conversationId, ...((await getCallerContext(conversationId, req)) || {}) };
    caller.mode = toText(caller.mode).toLowerCase();
    const hops = nonNegativeInt(caller.hops) + 1;
    if (hops > REMOTE_RELAY_LIMITS.hopLimit) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.hopLimit,
        `This turn was started by another relay's agent (hop ${hops - 1}); forwarding it again would pass the limit of ${REMOTE_RELAY_LIMITS.hopLimit} hops.`,
        { relay: relay.name }));
    }

    const retryAfterSeconds = consumeRateLimit(conversationId, write);
    if (retryAfterSeconds !== null) {
      return finish(failure(429, REMOTE_RELAY_ERROR_CODES.rateLimited,
        `Too many remote relay calls from this conversation (at most ${REMOTE_RELAY_LIMITS.callsPerMinute} a minute, ${REMOTE_RELAY_LIMITS.writesPerMinute} of them writes). Try again in ${retryAfterSeconds} s.`,
        { relay: relay.name, retryAfterSeconds }));
    }

    adjustInflight(conversationId, 1);
    try {
      if (write && REMOTE_RELAY_APPROVAL_MODES.includes(caller.mode)) {
        const decision = await requestApproval({
          conversationId,
          callerContext: caller,
          relay: relayTarget(relay),
          action,
          args,
          summary: summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
          signal,
        });
        const approved = decision === true || decision?.approved === true;
        if (!approved) {
          const code = toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied;
          const error = toText(decision?.error)
            || `The user did not allow this ${action.replace(/_/g, ' ')} on relay "${relay.name}".`;
          return finish(failure(403, code, error, { relay: relay.name }));
        }
      }

      const ctx = { relay, caller, hops, conversationId, signal };
      const body = await ACTIONS[action](ctx, args);
      const { summary, ...rest } = body;
      return finish({
        status: 200,
        body: {
          ok: true,
          relay: relay.name,
          summary: summary || summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
          ...rest,
        },
      });
    } catch (error) {
      if (error instanceof DispatchFailure) {
        return finish(failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra }));
      }
      if (isRemoteRelayError(error)) return finish(mapRemoteError(error, relay, { action, args }));
      throw error;
    } finally {
      adjustInflight(conversationId, -1);
    }
  }

  /**
   * One tool call. Never throws: resolves to `{ status, body }` for the route
   * to send as is. `signal` (optional) aborts approval and reply waits when
   * the caller hangs up.
   */
  async function dispatch({ conversationId, action, args, req, signal } = {}) {
    const validation = validateRemoteRelayToolInput({ ...(isPlainObject(args) ? args : {}), action });
    if (!validation.ok) return failure(400, validation.code, validation.error);
    const requestedConversationId = toText(conversationId);
    let callerConversationId = requestedConversationId;
    try {
      callerConversationId = toText(resolveConversationId(requestedConversationId)) || requestedConversationId;
    } catch {}
    if (!callerConversationId) {
      return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, 'conversationId is required');
    }
    try {
      if (validation.action === 'list_relays') return await listRelays(callerConversationId);
      return await runRelayAction({
        conversationId: callerConversationId,
        action: validation.action,
        args: validation.args,
        req,
        signal,
      });
    } catch (error) {
      try {
        logger?.warn?.(`${LOG_PREFIX} ${validation.action} failed conv=${shortId(callerConversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
      } catch {}
      return failure(500, REMOTE_RELAY_INTERNAL_ERROR_CODE, 'The remote relay tool failed on this relay; see its server log.');
    }
  }

  return { dispatch, inflight };
}
