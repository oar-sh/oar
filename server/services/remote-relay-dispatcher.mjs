'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import { isFailureNoteText } from '../../shared/failure-note-text.mjs';
import {
  REMOTE_RELAY_APPROVAL_MODES,
  REMOTE_RELAY_ASK_ACTIONS,
  REMOTE_RELAY_CLOUD_PROVIDER,
  REMOTE_RELAY_EFFORT_PATTERN,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_GROUP_LIMITS,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_LOCAL_ALIAS,
  REMOTE_RELAY_LOCAL_ID,
  REMOTE_RELAY_PROVIDERS,
  REMOTE_RELAY_SEND_PROVIDERS,
  REMOTE_RELAY_SESSION_SETTINGS,
  formatSessionGroupList,
  isRemoteRelayApprovalQuestion,
  isRemoteRelayPromptAction,
  isRemoteRelayWriteAction,
  normalizeRemoteRelayOrigin,
  remoteConversationUrl,
  remoteRelayActionPermission,
  remoteRelayPermissionAllows,
  resolveSessionGroupReference,
  stripRemotePromptHeader,
  summarizeRemoteRelayCall,
  validateRemoteRelayToolInput,
  withRemotePromptHeader,
} from '../../shared/remote-relay-contract.mjs';
import { schemaFields } from '../../shared/question-schema.mjs';
import { matchQuestionChoice } from '../../shared/question-answer-rule.mjs';
import { ANSWERED_ELSEWHERE_KIND } from '../../shared/steer-settle-markers.mjs';
import { RELAY_EVENT_DEFAULT_TYPES, RELAY_EVENT_RELAY_LEVEL_TYPES } from '../../shared/relay-events.mjs';
import { checkRequestedProviderModel, isAutoModelId, providerModelLabel, unknownProviderModelText } from './provider-model-selection.mjs';
import { cleanTaskOutput, parseRunnerSummary, stallMinutes, stripSgr } from '../../shared/task-output-text.mjs';
import { TASK_OUTPUT_NONE_MESSAGES } from '../public/app/task-console-render.mjs';
import {
  RELAY_EVENT_REMOTE_PULL_PATH,
  RELAY_EVENT_REMOTE_SUBSCRIBE_PATH,
  isMissingRelayEventRoute,
  relayWithoutCrossRelayEventsText,
} from './relay-event-link-service.mjs';
import { RELAY_ASK_KIND, relayQuestionKind } from '../../shared/relay-asks.mjs';
import { RELAY_ASK_REMOTE_PATHS, isMissingRelayAskRoute, relayWithoutAsksText } from './relay-ask-link-service.mjs';

// The one place a `relay_tool` tool call is decided and carried out (plan
// §5.6). Every provider adapter ends up at POST /api/remote-relays/tool, whose
// handler calls dispatch(). In order:
//
//   validate → list_relays (local, no gate) → resolve the relay → mention gate
//   → permission → hop limit → rate limit → approval (write actions in
//   ask/plan) → execute against the remote relay's existing API
//
// The relay the agent runs on is a target too (the "local target", named by
// this relay's name or `this`), when its owner switched that on. It needs no
// pairing, mention, permission or hop; instead:
//
//   setting on → no acting on the caller's own conversation → rate limit →
//   create_session only: one level (a created session creates none, unless
//   the owner allowed it for that session), at most localActiveSessions
//   created sessions at work, the user's Allow once per conversation →
//   approval (ask/plan) → execute
//
// update_session, on either kind of target: a session the calling
// conversation started may be changed; any other (the owner's, another
// agent's, the caller's creator) needs the owner's Allow once per calling
// conversation and target (remembered as an unlock), and the target holds to
// the same rule itself (its settings route refuses without owner_approved).
//
// Its actions run through the same code as a paired relay's: `call()` hands
// them to the loopback client, which reaches this relay's own routes
// in-process (remote-relay-loopback.mjs).
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
const SETTINGS_PROVIDERS = Object.freeze(['claude', 'cursor', 'grok', 'openai', 'claude-cloud', 'deepseek', 'claude-api']);
// A Claude Cloud session clones a GitHub repository instead of opening a
// folder: create_session takes `repo` and `branch` for it.
const CLOUD_PROVIDER = REMOTE_RELAY_CLOUD_PROVIDER;
const CLOUD_CREATE_NOTE = 'create_session needs repo (https://github.com/owner/repo or owner/repo) and takes branch instead of cwd. The session works on a fresh clone in a sandbox at Anthropic: write a self-contained prompt and name the branch to work on and to push.';
// POST /api/conversation/bootstrap refuses a cloud session with this code
// while the provider is switched off.
const CLOUD_DISABLED_CODE = 'claude_cloud_disabled';
// The actions an agent must not aim at the conversation it runs in.
const OWN_SESSION_ACTIONS = new Set(['send', 'stop', 'archive', 'wait', 'update_session']);
// The route update_session reaches on the target, and the codes it answers.
const SESSION_SETTINGS_SUFFIX = '/settings';
const SESSION_SETTINGS_CODES = Object.freeze({
  notFound: 'SESSION_NOT_FOUND',
  busy: 'SESSION_BUSY',
  groupNotFound: 'SESSION_GROUP_NOT_FOUND',
  groupAmbiguous: 'SESSION_GROUP_AMBIGUOUS',
});
// How /api/models `providersByModel` names each provider.
const CATALOG_PROVIDER_LABELS = Object.freeze({
  github: 'github-copilot',
  openai: 'openai-byok',
  claude: 'claude',
  cursor: 'cursor',
  grok: 'grok',
  'claude-cloud': 'claude-cloud',
  deepseek: 'deepseek',
  'claude-api': 'claude-api',
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
  /^relay recovery limit reached after \d+ attempts/i,
  /^relay timeout after \d+ attempts/i,
]);
const CLAUDE_LONG_CONTEXT_SUFFIX = /\[1m\]$/i;
// How many of a provider's model ids an unknown-model refusal carries.
const UNKNOWN_MODEL_LIST_MAX = 50;
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

const SESSION_STATES = new Set(['running_turn', 'background_only', 'idle']);

function isBusyState(state) {
  return state === 'running_turn' || state === 'background_only';
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
  return isFailureNoteText(value) || FAILURE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
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

/** The models /api/models lists for a provider label ("openai-byok"). */
function catalogModelsLabelled(catalog, label) {
  const providersByModel = isPlainObject(catalog?.models?.providersByModel) ? catalog.models.providersByModel : {};
  return Object.entries(providersByModel)
    .filter(([, providers]) => Array.isArray(providers) && providers.some((entry) => toText(entry).toLowerCase() === label))
    .map(([model]) => model);
}

/** Copilot's catalogue: every model of /api/models no other provider claims alone. */
function catalogGithubModels(catalog) {
  const models = catalog?.models || {};
  const providersByModel = isPlainObject(models.providersByModel) ? models.providersByModel : {};
  const catalogModels = Array.isArray(models.models) ? models.models.map(toText).filter(Boolean) : [];
  return catalogModels.filter((model) => {
    const providers = catalogProvidersFor(providersByModel, model);
    return providers.length === 0 || providers.includes(CATALOG_PROVIDER_LABELS.github);
  });
}

/**
 * The models a provider's New Chat list offers on the target, which its
 * bootstrap and message routes accept, or null when the target has no list
 * for it yet (discovery has not run or failed, the route did not answer):
 * then a requested model cannot be checked here.
 */
function offeredModelList(catalog, provider) {
  if (provider === 'github') {
    const listed = catalogGithubModels(catalog);
    return listed.length ? listed : null;
  }
  if (provider === 'openai') {
    const listed = catalogModelsLabelled(catalog, CATALOG_PROVIDER_LABELS.openai);
    return listed.length ? listed : null;
  }
  const settings = catalog?.settings?.[provider];
  const listed = Array.isArray(settings?.models) ? settings.models.map(toText).filter(Boolean) : [];
  return listed.length ? listed : null;
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
  return { id: relay.id, name: relay.name, url: relay.url, ...(relay.local ? { local: true } : {}) };
}

/**
 * The question card's view of a relay question: what the agent needs to answer
 * it. Null for the remote's own remote-relay approval cards, which only its
 * user may answer (the remote hides them from us as well).
 */
function mapPendingQuestion(question) {
  if (!isPlainObject(question) || !toText(question.id)) return null;
  if (isRemoteRelayApprovalQuestion(question)) return null;
  const kind = relayQuestionKind(question);
  if (kind === RELAY_ASK_KIND) {
    // A question that does not block: the user's to answer, the session works on.
    return {
      id: toText(question.id),
      kind,
      question: toText(question.question || question.prompt),
      options: (Array.isArray(question.options) ? question.options : []).map((option) => toText(option)).filter(Boolean),
      ...(toText(question.recommendation) ? { recommendation: toText(question.recommendation) } : {}),
      ...(question.urgency === 'now' ? { urgency: 'now' } : {}),
      ...(isPlainObject(question.askedBy) ? { askedBy: question.askedBy } : {}),
      createdAt: question.createdAt || null,
      note: 'Asked with ask: it does not block the session, and only the user answers it.',
    };
  }
  const context = isPlainObject(question.context) ? question.context : {};
  const fields = schemaFields(question.requestSchema);
  return {
    id: toText(question.id),
    kind,
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
  // The local target's client (remote-relay-loopback.mjs): same `request` as
  // `client`, answered by this relay's own routes. Without it the local target
  // does not exist, whatever the setting says.
  localClient = null,
  // `{ enabled, maxWaitSeconds }`: the agent-sessions settings of this relay.
  getAgentSessionsSettings = () => null,
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
  // The relay event service (relay-event-service.mjs): subscribe and its
  // siblings. Without it those actions answer that the relay lacks them.
  relayEvents = null,
  // The event link (relay-event-link-service.mjs): fetches the events of
  // subscriptions on paired relays. Without it those stay refused.
  relayEventLink = null,
  // The relay schedule service (relay-schedule-service.mjs): schedule and its
  // siblings. Without it those actions answer that the relay lacks them.
  relaySchedules = null,
  // The ask service (relay-ask-service.mjs): ask and its siblings, and the
  // link that looks for the answers of asks put on paired relays
  // (relay-ask-link-service.mjs). Without the service those actions answer
  // that the relay lacks them.
  relayAsks = null,
  relayAskLink = null,
} = {}) {
  const inflightByConversation = new Map();
  const callTimesByConversation = new Map();
  const writeTimesByConversation = new Map();
  // The loop guard: prompts sent to other relays' agents per conversation,
  // counted from the user's latest own message. Kept in memory: a restart
  // ends a loop of agents by itself.
  const agentPromptsByConversation = new Map();
  // create_session calls on the local target that passed the cap and have not
  // queued their prompt yet: they count toward it, so parallel calls cannot
  // slip past together.
  const localCreatesByConversation = new Map();
  // The once-per-conversation approval card while it is open: parallel first
  // creates share the one card and its answer.
  const localApprovalsByConversation = new Map();
  // The same for the first subscribe of a conversation (by approval key).
  const watchApprovalsByKey = new Map();
  // And for the first update_session of a conversation on a session the
  // conversation did not start there (by approval key).
  const sessionSettingsApprovalsByKey = new Map();

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

  /**
   * Why a relay is open to a conversation: 'user' (the user mentioned it),
   * 'contact' (an agent on that relay wrote to the conversation, so it may be
   * answered), or null (locked).
   */
  function relayAccess(conversationId, relay) {
    if (isUnlocked(conversationId, relay?.id)) return 'user';
    try {
      if (toText(relay?.relayId) && repository?.hasContactFrom?.(conversationId, relay.relayId)) return 'contact';
    } catch {}
    return null;
  }

  function agentPrompts(conversationId) {
    let since = null;
    try {
      since = repository?.latestHumanMessageId?.(conversationId) || null;
    } catch {}
    const kept = agentPromptsByConversation.get(conversationId);
    if (kept && kept.since === since) return kept;
    const fresh = { since, count: 0 };
    agentPromptsByConversation.set(conversationId, fresh);
    return fresh;
  }

  /**
   * A schedule another conversation set comes due in a session: that is a
   * prompt of the conversation that set it, counted by its loop guard like
   * a send. False (the firing is held) once the guard wants the user first;
   * it lets the firing go again after the user wrote in that conversation,
   * or allowed its agent's next prompt on the card.
   */
  function admitScheduledFiring({ createdBy } = {}) {
    const requested = toText(createdBy);
    if (!requested) return false;
    let creator = requested;
    try {
      creator = toText(resolveConversationId(requested)) || requested;
    } catch {}
    const kept = agentPrompts(creator);
    if (kept.count >= REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking) return false;
    kept.count += 1;
    return true;
  }

  /** `{ enabled, maxWaitSeconds }`; off and the default wait when unreadable. */
  function agentSessions() {
    let settings = null;
    try {
      settings = getAgentSessionsSettings() || null;
    } catch {}
    const maxWaitSeconds = Number(settings?.maxWaitSeconds);
    return {
      enabled: settings?.enabled === true && typeof localClient?.request === 'function',
      maxWaitSeconds: Number.isFinite(maxWaitSeconds) && maxWaitSeconds > 0
        ? maxWaitSeconds
        : REMOTE_RELAY_LIMITS.waitMaxSeconds,
    };
  }

  /** This relay as a target: the shape of a registry entry, marked `local`. */
  async function localTarget() {
    const self = (await registry.selfIdentity?.()) || {};
    return {
      id: REMOTE_RELAY_LOCAL_ID,
      relayId: toText(self.relayId) || null,
      name: toText(self.name) || toText(await registry.selfName?.()) || REMOTE_RELAY_LOCAL_ALIAS,
      url: toText(self.publicUrl),
      version: toText(self.version) || null,
      permission: 'full',
      local: true,
    };
  }

  function adjustLocalCreates(conversationId, delta) {
    const next = (localCreatesByConversation.get(conversationId) || 0) + delta;
    if (next > 0) localCreatesByConversation.set(conversationId, next);
    else localCreatesByConversation.delete(conversationId);
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
    return (ctx.relay.local ? localClient : client).request(ctx.relay, method, path, {
      ...(query ? { query: compactQuery(query) } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      hops: ctx.hops,
    });
  }

  function sessionPath(session, suffix = '') {
    return `/api/conversation/${encodeURIComponent(session)}${suffix}`;
  }

  /**
   * The questions a remote session has open. `includeAsks` (read_session):
   * the ones that don't block as well (kind "ask"); a relay without them
   * ignores it. The waits leave them out: the session works on, and only the
   * user answers them.
   */
  async function loadPendingQuestions(ctx, conversationId, { includeAsks = false } = {}) {
    try {
      const response = await call(ctx, 'GET', '/api/relay-questions', {
        query: { status: 'pending', conversationId, ...(includeAsks ? { includeAsks: 1 } : {}) },
      });
      return (Array.isArray(response?.questions) ? response.questions : [])
        .map(mapPendingQuestion)
        .filter((question) => question && (includeAsks || question.kind !== RELAY_ASK_KIND));
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
      // The conversation named above lives on the relay that reads this.
      ...(ctx.relay.local ? { local: true } : {}),
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
      // A cloud session takes no effort; without this its models would be
      // listed with the Claude provider's efforts (the ids are the same).
      if (entry.provider === CLOUD_PROVIDER) return entry;
      const efforts = groupEffortsByModel(catalog.models, entry.provider, entry.models);
      return efforts.length ? { ...entry, efforts } : entry;
    });
  }

  function listProviders(catalog) {
    const models = catalog.models || {};
    return REMOTE_RELAY_PROVIDERS.map((provider) => {
      if (provider === 'github') {
        const githubModels = catalogGithubModels(catalog);
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
      if (provider === CLOUD_PROVIDER) {
        // Its settings route has its own shape: a switch and a default model.
        // A relay that predates the provider answers 404 and lands above.
        const enabled = settings.enabled === true;
        const cloudDefault = toText(settings.defaultModel) || null;
        return {
          provider,
          configured: enabled,
          defaultModel: cloudDefault,
          models: enabled
            ? uniqueTexts([...(cloudDefault ? [cloudDefault] : []), ...(Array.isArray(settings.models) ? settings.models : [])])
            : [],
          ...(enabled ? { note: CLOUD_CREATE_NOTE } : {}),
        };
      }
      // What POST /api/conversation/bootstrap requires, plus "not switched off".
      const configured = settings.enabled === true
        && (provider === 'claude' || provider === 'grok' || settings.configured === true);
      const defaultModel = toText(settings.model) || null;
      const listed = provider === 'openai'
        ? catalogModelsLabelled(catalog, CATALOG_PROVIDER_LABELS.openai)
        : (Array.isArray(settings.models) ? settings.models : []);
      return {
        provider,
        configured,
        defaultModel,
        models: configured ? uniqueTexts([...(defaultModel ? [defaultModel] : []), ...listed]) : [],
      };
    });
  }

  // ─── Session groups (relay_info, create_session `group`) ───────────────────

  // The target's read-only group list: id, name and member count only.
  const GROUPS_PATH = '/api/conversation-groups';
  // The target's bootstrap refuses a group with these codes.
  const BOOTSTRAP_GROUP_CODES = Object.freeze({
    notFound: 'SESSION_GROUP_NOT_FOUND',
    ambiguous: 'SESSION_GROUP_AMBIGUOUS',
    unavailable: 'SESSION_GROUPS_UNAVAILABLE',
    invalid: 'SESSION_GROUP_INVALID',
  });

  function groupWhere(ctx) {
    return ctx.relay.local ? 'this relay' : `relay "${ctx.relay.name}"`;
  }

  /** A text that starts with groupWhere(), as the start of a sentence. */
  function sentence(text) {
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }

  function mapGroupList(response) {
    return (Array.isArray(response?.groups) ? response.groups : [])
      .filter(isPlainObject)
      .map((group) => ({ id: toText(group.id), name: clipLine(group.name, 80) || 'Group', memberCount: nonNegativeInt(group.memberCount) }))
      .filter((group) => group.id);
  }

  /**
   * Why the target's group list could not be read: `{ status, code, text }`.
   * A relay without the list (404) predates groups on create_session.
   */
  function groupListProblem(ctx, error) {
    const C = REMOTE_RELAY_ERROR_CODES;
    const where = groupWhere(ctx);
    const code = toText(error?.code);
    const status = Number(error?.status) || 0;
    if (code === C.notFound || status === 404) {
      return { status: 400, code: C.unsupported, text: `The target relay doesn't support groups on create_session yet: ${where} runs an older OAR (its group list answered 404).` };
    }
    if (code === C.unauthorized || status === 401) {
      return { status: 502, code: C.unauthorized, text: `${where} rejected this relay's token when asked for its session groups (401).` };
    }
    if (status === 403 || code === C.inboundDisabled) {
      return { status: 403, code: code || `${C.httpPrefix}403`, text: `${where} refused to list its session groups (403).` };
    }
    if (status === 503 && toText(error?.remoteBody?.error).includes('Session groups are not available')) {
      return { status: 400, code: C.unsupported, text: `Session groups are not available on ${where} (its storage for them is missing).` };
    }
    if (code === C.offline) {
      const detail = toText(error?.detail) || 'no answer';
      return { status: 502, code: C.offline, text: `${where} did not answer when asked for its session groups (${detail}).` };
    }
    if (status >= 500) {
      return { status: 502, code: code || `${C.httpPrefix}${status}`, text: `${where} failed to list its session groups (HTTP ${status}).` };
    }
    return { status: 502, code: code || `${C.httpPrefix}502`, text: `${where} could not list its session groups (${toText(error?.message) || 'unexpected answer'}).` };
  }

  /**
   * The refusal for a group the target does not have, or has several of by
   * that name. `total` is how many there are when `groups` came capped (the
   * target's own refusal).
   */
  function unknownGroupFailure(ctx, requested, found, groups, total = null) {
    const where = groupWhere(ctx);
    const asked = clipLine(requested, 80).replace(/"/g, "'");
    const ambiguous = found.status === 'ambiguous';
    const listed = ambiguous ? found.matches : groups;
    const max = REMOTE_RELAY_GROUP_LIMITS.refusalMax;
    const count = Number.isInteger(total) && total > listed.length ? total : listed.length;
    const names = formatSessionGroupList(listed, max, count);
    let text;
    if (ambiguous) text = `"${asked}" names several session groups on ${where}: ${names}. Pass the id.`;
    else if (groups.length) text = sentence(`${where} has no session group "${asked}". Groups there: ${names}.`);
    else text = sentence(`${where} has no session groups.`);
    return new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unknownGroup, `${text} No session was created.`, {
      group: requested,
      groups: listed.slice(0, max).map((group) => ({ id: group.id, name: group.name })),
      ...(count > max ? { groupsTotal: count } : {}),
      note: groups.length
        ? 'Pass one of these ids or names (relay_info lists them), or leave group out. create_session takes an existing group only; update_session can put the session into a new group of that name afterwards. Renaming groups is the owner\'s.'
        : 'Leave group out; update_session can put the session into a new group of that name afterwards.',
    });
  }

  /**
   * The group a create_session names, looked up on the target before anyone
   * is asked: `{ id, name }`. Any failure to read the target's groups refuses
   * the call (a DispatchFailure), as an unknown or ambiguous group does.
   */
  async function settleRequestedGroup(ctx, requested) {
    let response;
    try {
      response = await call(ctx, 'GET', GROUPS_PATH);
    } catch (error) {
      if (!isRemoteRelayError(error)) throw error;
      const problem = groupListProblem(ctx, error);
      throw new DispatchFailure(problem.status, problem.code, `${sentence(problem.text)} No session was created.`, {
        group: requested,
        note: 'Leave group out (the owner can group the session by hand), or try again once that relay lists its groups.',
      });
    }
    const groups = mapGroupList(response);
    const found = resolveSessionGroupReference(groups, requested);
    if (found.status === 'found') return { id: found.group.id, name: found.group.name };
    throw unknownGroupFailure(ctx, requested, found, groups);
  }

  /** A bootstrap refusal of the group (it vanished after the lookup), as the agent reads it; else null. */
  function bootstrapGroupFailure(ctx, error, requested) {
    if (!requested || !isRemoteRelayError(error)) return null;
    const body = isPlainObject(error.remoteBody) ? error.remoteBody : null;
    const remoteCode = toText(body?.code);
    if (remoteCode === BOOTSTRAP_GROUP_CODES.notFound || remoteCode === BOOTSTRAP_GROUP_CODES.ambiguous) {
      const groups = mapGroupList(body);
      const found = remoteCode === BOOTSTRAP_GROUP_CODES.ambiguous ? { status: 'ambiguous', matches: groups } : { status: 'unknown' };
      const total = Number.isInteger(body?.groupsTotal) ? body.groupsTotal : null;
      return unknownGroupFailure(ctx, requested, found, groups, total);
    }
    if (remoteCode === BOOTSTRAP_GROUP_CODES.unavailable) {
      return new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported,
        `Session groups are not available on ${groupWhere(ctx)} (its storage for them is missing). No session was created.`, { group: requested });
    }
    if (remoteCode === BOOTSTRAP_GROUP_CODES.invalid) {
      return new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, `${toText(body?.error) || 'group is not valid'}. No session was created.`, { group: requested });
    }
    return null;
  }

  /** The `group` of a bootstrap answer in list_sessions' shape, or null. */
  function bootstrapGroupField(value) {
    if (!isPlainObject(value) || !toText(value.id)) return null;
    return { id: toText(value.id), name: toText(value.name) || null, role: toText(value.role) === 'head' ? 'head' : 'member' };
  }

  /** relay_info's `groups` (latest activity first, capped), or a note why there are none. */
  async function relayGroups(ctx) {
    try {
      const groups = mapGroupList(await call(ctx, 'GET', GROUPS_PATH));
      const max = REMOTE_RELAY_GROUP_LIMITS.listMax;
      return {
        groups: groups.slice(0, max),
        ...(groups.length > max ? { groupsTotal: groups.length } : {}),
      };
    } catch (error) {
      if (!isRemoteRelayError(error)) throw error;
      return { groups: null, groupsNote: `${sentence(groupListProblem(ctx, error).text)} create_session cannot take group there.` };
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  // Plan usage as the agent may see it: an allow-list of fields, so a field
  // the relay adds later never leaks. No account names, links or raw
  // payloads; an address or a token-shaped string in a text is masked.
  const USAGE_TEXT_MAX = 300;

  function usageText(value, max = USAGE_TEXT_MAX) {
    const text = clipLine(value, max);
    if (!text) return null;
    return text
      .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[address]')
      .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '[hidden]');
  }

  function usageNumber(value) {
    const number = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
  }

  function usageMeter(meter) {
    if (!isPlainObject(meter)) return null;
    const label = usageText(meter.label, 80);
    if (!label) return null;
    return {
      label,
      unit: toText(meter.unit) || null,
      ...(meter.unlimited === true ? { unlimited: true } : {}),
      ...(meter.estimated === true ? { estimated: true } : {}),
      used: usageNumber(meter.used),
      allowance: usageNumber(meter.allowance),
      remaining: usageNumber(meter.remaining),
      utilization: usageNumber(meter.utilization),
      resetAt: toText(meter.resetAt) || null,
      ...(toText(meter.resetKind) ? { resetKind: toText(meter.resetKind) } : {}),
      ...(toText(meter.severity) ? { severity: toText(meter.severity) } : {}),
      ...(usageText(meter.note) ? { note: usageText(meter.note) } : {}),
    };
  }

  function usageCard(card) {
    if (!isPlainObject(card) || !toText(card.provider)) return null;
    const meters = (Array.isArray(card.meters) ? card.meters : []).slice(0, 12).map(usageMeter).filter(Boolean);
    const details = (Array.isArray(card.details) ? card.details : []).slice(0, 8).map((section) => {
      const rows = (Array.isArray(section?.rows) ? section.rows : []).slice(0, 12)
        .map((row) => ({ label: usageText(row?.label, 80), value: usageText(row?.value, 120) }))
        .filter((row) => row.label && row.value);
      return rows.length ? { label: usageText(section.label, 80), rows } : null;
    }).filter(Boolean);
    const notes = (Array.isArray(card.notes) ? card.notes : []).slice(0, 6).map((note) => usageText(note?.text)).filter(Boolean);
    return {
      provider: toText(card.provider),
      label: usageText(card.label, 60) || toText(card.provider),
      status: toText(card.status) || 'unavailable',
      ...(usageText(card.planName, 80) ? { plan: usageText(card.planName, 80) } : {}),
      ...(usageText(card.message) ? { message: usageText(card.message) } : {}),
      source: toText(card.source) || null,
      capturedAt: toText(card.capturedAt) || null,
      ...(card.stale === true ? { stale: true } : {}),
      meters,
      ...(details.length ? { details } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  function usageLimitState(payload) {
    const account = isPlainObject(payload?.account) ? payload.account : null;
    return {
      account: account ? {
        status: toText(account.status) || null,
        window: toText(account.label) || toText(account.rateLimitType) || null,
        utilization: usageNumber(account.utilization),
        resetsAt: toText(account.resetsAt) || null,
        ...(account.isUsingOverage === true ? { usingOverage: true } : {}),
        observedAt: toText(account.observedAt) || null,
      } : null,
      pauses: (Array.isArray(payload?.pauses) ? payload.pauses : []).slice(0, 20).filter(isPlainObject).map((pause) => ({
        session: toText(pause.conversationId) || null,
        window: toText(pause.label) || toText(pause.rateLimitType) || null,
        resetsAt: toText(pause.resetsAt) || null,
        resumeAt: toText(pause.resumeAt) || null,
        auto: pause.auto === true,
      })),
    };
  }

  /**
   * usage: what each provider plan of the relay has left (GET /api/usage, the
   * usage modal's data) and the Claude usage-limit state (GET
   * /api/usage-limit): numbers, plan names, reset times, states.
   */
  async function usageAction(ctx) {
    let report;
    try {
      report = await call(ctx, 'GET', '/api/usage', { timeoutMs: 30_000 });
    } catch (error) {
      if (isRemoteRelayError(error) && toText(error.code) === REMOTE_RELAY_ERROR_CODES.notFound) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported,
          `Relay "${ctx.relay.name}" does not report plan usage (it runs an older OAR version).`);
      }
      throw error;
    }
    const cards = Array.isArray(report?.providers) ? report.providers : null;
    if (!cards) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported,
        `Relay "${ctx.relay.name}" reports only the Copilot quota in an older shape; it needs an update for plan usage per provider.`);
    }
    const limit = await call(ctx, 'GET', '/api/usage-limit').catch(() => null);
    const providers = cards.slice(0, 12).map(usageCard).filter(Boolean);
    const set = providers.filter((card) => !['not-configured', 'unavailable'].includes(card.status)).map((card) => card.provider);
    const usageLimit = limit?.ok === true ? usageLimitState(limit) : null;
    return {
      summary: `usage → ${ctx.relay.name}: ${set.join(', ') || 'no provider'} reported${usageLimit?.pauses?.length ? `, ${usageLimit.pauses.length} paused at a usage limit` : ''}`,
      providers,
      usageLimit,
      ...(usageLimit ? {} : { note: 'The usage-limit state was not available there.' }),
    };
  }

  async function relayInfo(ctx) {
    const [identity, catalog, groups] = await Promise.all([
      call(ctx, 'GET', '/api/relay/identity').catch(() => null),
      loadCatalog(ctx),
      relayGroups(ctx),
    ]);
    const status = catalog.status;
    const providers = buildProviders(catalog);
    const remoteRelays = isPlainObject(identity?.remoteRelays) ? identity.remoteRelays : null;
    const configured = providers.filter((entry) => entry.configured).map((entry) => entry.provider);
    const version = toText(status.version) || toText(identity?.version) || null;
    return {
      summary: `relay_info → ${ctx.relay.name}: OAR ${version || '?'}, providers ${configured.join(', ') || 'none'}`,
      name: toText(identity?.name) || ctx.relay.name,
      ...(ctx.relay.local ? { self: true } : {}),
      url: ctx.relay.url,
      openUrl: remoteConversationUrl(ctx.relay.url, '') || null,
      version,
      platform: toText(status.platform) || toText(identity?.platform) || null,
      protocol: remoteRelays ? nonNegativeInt(remoteRelays.protocol) : 0,
      // The inbound switch is about other relays' agents; this relay's own are
      // let in by the agent-sessions setting, which is on or this would not run.
      acceptsAgentPrompts: ctx.relay.local ? true : (remoteRelays ? remoteRelays.inbound !== false : null),
      ...(ctx.relay.local ? {
        sessionRules: `create_session: at most ${REMOTE_RELAY_LIMITS.localActiveSessions} sessions you started may work at the same time; a session an agent created cannot create sessions unless the owner allowed it for that session (mayCreateSessions); sessions run on this relay's accounts. update_session: sessions you started freely, any other (the owner's, another agent's, your creator's) after the owner's Allow (once per conversation).`,
      } : {}),
      providers,
      workspaces: {
        default: toText(status.defaultSessionWorkspaceRootPath) || toText(status.workspaceRootPath) || null,
        current: toText(status.workspaceRootPath) || null,
        recent: Array.isArray(status.recentWorkspaceRoots) ? status.recentWorkspaceRoots.map(toText).filter(Boolean) : [],
      },
      relayModes: Array.isArray(status.supportedRelayModes) ? status.supportedRelayModes : [],
      defaultRelayMode: toText(status.defaultRelayMode) || null,
      // The session groups a create_session there may name (`group`).
      ...groups,
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

  /** The session group of a listed row: id, display name and the row's role. */
  function sessionGroupField(row, groups) {
    const groupId = toText(row?.groupId);
    if (!groupId) return {};
    const info = isPlainObject(groups?.[groupId]) ? groups[groupId] : null;
    return {
      group: {
        id: groupId,
        name: toText(info?.displayName) || toText(info?.name) || null,
        role: toText(row?.groupRole) === 'head' ? 'head' : 'member',
      },
    };
  }

  function mapSession(row, workerIds, ctx = null, groups = null) {
    const id = toText(row?.id);
    const via = toText(row?.origin?.relayName);
    // A session an agent of that relay created there, and from which session.
    const createdBy = row?.origin?.local === true ? toText(row.origin.conversationId) : '';
    return {
      id,
      title: toText(row?.title),
      provider: toText(row?.runtimeProviderType) || 'github',
      model: toText(row?.runtimeProviderModel) || toText(row?.runtimeModel) || toText(row?.preferredModel) || null,
      active: row?.activeTurn === true || !!workerIds?.has(id) || isBusyState(row?.sessionState),
      ...sessionActivityFields(row),
      updatedAt: row?.updatedAt || null,
      messageCount: nonNegativeInt(row?.messageCount),
      cwd: toText(row?.currentWorkspaceRootPath) || null,
      ...(via ? { via } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(createdBy && ctx?.relay?.local && createdBy === ctx.conversationId ? { startedByYou: true } : {}),
      // The owner let this agent-started session's agents start sessions.
      ...(row?.mayCreateSessions === true ? { mayCreateSessions: true } : {}),
      // The session group it sits in (sessions an agent started here are
      // grouped under that agent's session; the owner can group by hand).
      ...sessionGroupField(row, groups),
    };
  }

  /**
   * `state` (running_turn | background_only | idle), `tasks[]` and
   * `lastActivityAt` of a session, from the relay's `sessionState` /
   * `sessionTasks`. A relay that predates them gives none.
   */
  /**
   * The console facts read_session adds to a task (`row` is the conversation
   * payload): `taskId` for read_task_output, `output` whether there is any to
   * read, and `health` (minutes since the last output, the quiet threshold,
   * test-run counts) for a task with an output file.
   */
  function taskConsoleFields(row, id) {
    const taskId = toText(id);
    if (!taskId || !isPlainObject(row)) return {};
    const live = (Array.isArray(row.backgroundTasks) ? row.backgroundTasks : []).find((task) => toText(task?.taskId) === taskId);
    const ended = live ? null : (Array.isArray(row.endedBackgroundTasks) ? row.endedBackgroundTasks : []).find((task) => toText(task?.taskId) === taskId);
    const task = live || ended;
    if (!task) return {};
    const kind = toText(task.outputKind) || (toText(task.outputPath) ? 'file' : 'none');
    const health = isPlainObject(task.health) ? task.health : null;
    const quietAfter = Number(row.taskStallMinutes) || null;
    const minutes = live && health ? stallMinutes(health.lastOutputAt, now()) : null;
    // The command line comes scrubbed: the relay cleans it when the worker posts it.
    const command = toText(task.command);
    return {
      taskId,
      output: kind !== 'none',
      ...(command ? { command: clipLine(command, 500) } : {}),
      ...(health ? {
        health: {
          ...(minutes !== null ? { minutesSinceOutput: minutes } : {}),
          ...(quietAfter && minutes !== null ? { quiet: minutes >= quietAfter, quietAfterMinutes: quietAfter } : {}),
          ...(isPlainObject(health.counts) ? { counts: { runner: toText(health.runner) || null, ...health.counts } } : {}),
        },
      } : {}),
    };
  }

  function sessionActivityFields(row, { console: withConsole = false } = {}) {
    const state = toText(row?.sessionState);
    if (!SESSION_STATES.has(state)) return {};
    const tasks = (Array.isArray(row?.sessionTasks) ? row.sessionTasks : [])
      .filter(isPlainObject)
      .slice(0, 20)
      .map((task) => ({
        kind: toText(task.kind) || 'subagent',
        description: clipLine(task.description, 200),
        startedAt: task.startedAt || null,
        lastActivityAt: task.lastActivityAt || null,
        status: toText(task.status) || 'running',
        ...(Number.isInteger(task.exitCode) ? { exitCode: task.exitCode } : {}),
        ...(task.statusReported === false ? { statusReported: false } : {}),
        ...(toText(task.summary) && toText(task.status) !== 'running' ? { summary: clipLine(task.summary, 200) } : {}),
        ...(task.endedAt ? { endedAt: task.endedAt } : {}),
        ...(toText(task.id) ? { id: toText(task.id) } : {}),
        ...(withConsole ? taskConsoleFields(row, task.id) : {}),
      }));
    return {
      state,
      tasks,
      ...(row?.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : {}),
    };
  }

  async function listSessions(ctx, args) {
    const { scope, limit } = args;
    const query = toText(args.query).toLowerCase();
    // recent = the newest page, active = working sessions among the newest
    // pages, all = the whole list page by page (only it honours the cursor).
    let cursor = null;
    if (scope === 'all' && args.cursor) {
      cursor = decodeCursor(args.cursor, ['beforeConversationId', 'beforeUpdatedAt', 'beforeGroupId']);
      if (!cursor) throw invalidInput('cursor is not a nextCursor from list_sessions');
    }
    const workerIds = scope === 'active' ? await liveWorkerConversationIds(ctx) : null;
    const filtering = !!query || scope === 'active';
    const keep = (row) => (!query || toText(row?.title).toLowerCase().includes(query))
      && (scope !== 'active' || row?.activeTurn === true || workerIds.has(toText(row?.id)) || isBusyState(row?.sessionState));

    const sessions = [];
    const seen = new Set();
    let hasMore = false;
    let scanned = 0;
    for (let page = 0; page < (filtering ? LIST_SCAN_PAGES : 1); page += 1) {
      const response = await call(ctx, 'GET', '/api/conversations', {
        query: {
          limit: filtering ? LIST_PAGE_MAX : limit,
          beforeConversationId: cursor?.beforeConversationId,
          beforeUpdatedAt: cursor?.beforeUpdatedAt,
          beforeGroupId: cursor?.beforeGroupId,
        },
      });
      const rows = Array.isArray(response?.conversations) ? response.conversations : [];
      const groups = isPlainObject(response?.groups) ? response.groups : null;
      let consumed = 0;
      for (const row of rows) {
        consumed += 1;
        // A group served again whole (its cursor row vanished) repeats rows.
        if (seen.has(toText(row?.id))) continue;
        seen.add(toText(row?.id));
        if (keep(row)) sessions.push(mapSession(row, workerIds, ctx, groups));
        if (sessions.length >= limit) break;
      }
      scanned += consumed;
      const last = rows[consumed - 1];
      // The row's sort time (its group's newest row, `activityAt`) and its
      // group, so the next page continues from the right place even if the
      // row is archived or deleted before then.
      if (last) {
        cursor = {
          beforeConversationId: toText(last.id),
          beforeUpdatedAt: toText(last.activityAt) || toText(last.updatedAt),
          ...(toText(last.groupId) ? { beforeGroupId: toText(last.groupId) } : {}),
        };
      }
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
      // groupMembers: the session group's live members; the relay gives them
      // to its own sessions only.
      query: { limit: args.last, beforeMessageId: before?.beforeMessageId, beforeTimestamp: before?.beforeTimestamp, groupMembers: 1 },
    });
    const conversationId = toText(conversation?.id) || args.session;
    const pendingQuestions = await loadPendingQuestions(ctx, conversationId, { includeAsks: true });
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
    // Its session group, with the other members and what each is doing.
    const groupInfo = isPlainObject(conversation?.group) ? conversation.group : null;
    const group = groupInfo && toText(groupInfo.id) ? {
      id: toText(groupInfo.id),
      name: toText(groupInfo.displayName) || toText(groupInfo.name) || null,
      role: toText(groupInfo.role) === 'head' ? 'head' : 'member',
      members: (Array.isArray(groupInfo.members) ? groupInfo.members : [])
        .filter(isPlainObject)
        .slice(0, 50)
        .map((member) => ({
          id: toText(member.id),
          title: toText(member.title),
          role: toText(member.role) === 'head' ? 'head' : 'member',
          state: SESSION_STATES.has(toText(member.state)) ? toText(member.state) : 'idle',
          ...(member.archived === true ? { archived: true } : {}),
        })),
    } : null;
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
        active: conversation?.activeTurn === true || isBusyState(conversation?.sessionState),
        ...sessionActivityFields(conversation, { console: true }),
        ...(via ? { via } : {}),
        ...(conversation?.mayCreateSessions === true ? { mayCreateSessions: true } : {}),
        ...(group ? { group } : {}),
        openUrl: remoteConversationUrl(ctx.relay.url, conversationId) || null,
      },
      messages,
      ...(inFlight ? { inFlight } : {}),
      pendingQuestions,
      ...(olderCursor ? { olderCursor } : {}),
      ...(omitted > 0 ? { note: `${omitted} older message${omitted === 1 ? '' : 's'} left out to stay within max_chars; pass olderCursor as before to read them.` } : {}),
    };
  }

  /**
   * read_task_output: the end of a background shell or Monitor task's
   * output (GET …/background-task/:taskId/output on the target relay, which
   * scrubs it), as plain lines without colours, at most `lines` lines and
   * 32 KB; minutes since its last output; test-run counts when it is one.
   */
  async function readTaskOutput(ctx, args) {
    let answer;
    try {
      answer = await call(ctx, 'GET', sessionPath(args.session, `/background-task/${encodeURIComponent(args.task_id)}/output`), {
        query: { lines: args.lines },
      });
    } catch (error) {
      const status = Number(error?.status) || null;
      if (isRemoteRelayError(error) && (status === 404 || toText(error.code) === REMOTE_RELAY_ERROR_CODES.notFound)) {
        const body = isPlainObject(error.remoteBody) ? error.remoteBody : {};
        if (toText(body.code) === 'task-not-found') {
          throw new DispatchFailure(404, REMOTE_RELAY_ERROR_CODES.notFound,
            `Task ${args.task_id} is not running in session ${args.session} on relay "${ctx.relay.name}" and did not end there within the last hour; read_session lists the session's tasks.`);
        }
        if (!/conversation not found/i.test(toText(body.error))) {
          throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported,
            `Relay "${ctx.relay.name}" cannot show background task output (it runs an older OAR version).`);
        }
      }
      throw error;
    }
    const model = Array.isArray(answer?.lines) ? answer.lines : [];
    const task = isPlainObject(answer?.task) ? answer.task : {};
    const ended = answer?.ended === true;
    // Plain text, a repeat folded as ×N; cleaned again, whatever the other
    // side did.
    const rendered = model.map((line) => {
      const text = stripSgr(cleanTaskOutput(String(line?.text ?? '')));
      const count = Number(line?.count) > 1 ? Number(line.count) : 1;
      return count > 1 ? `${text}  [×${count}]` : text;
    });
    let tail = rendered.slice(-args.lines);
    let cut = tail.length < rendered.length;
    let bytes = 0;
    let keepFrom = tail.length;
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      bytes += Buffer.byteLength(tail[index], 'utf8') + 1;
      if (bytes > REMOTE_RELAY_LIMITS.taskOutputBytesMax) break;
      keepFrom = index;
    }
    if (keepFrom > 0) {
      tail = tail.slice(keepFrom);
      cut = true;
    }
    const health = isPlainObject(answer?.health) ? answer.health : null;
    const lastOutputAt = Number(health?.lastOutputAt) || Number(answer?.mtime) || null;
    const minutes = !ended && lastOutputAt ? stallMinutes(lastOutputAt, now()) : null;
    const quietAfter = Number(answer?.taskStallMinutes) || null;
    let counts = null;
    if (isPlainObject(health?.counts)) {
      counts = { runner: toText(health.runner) || null, ...health.counts, final: health.final === true };
    } else {
      const parsed = parseRunnerSummary(model);
      if (parsed) counts = { runner: parsed.runner, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped, final: parsed.final };
    }
    const kind = toText(answer?.kind) || 'file';
    let note = null;
    if (kind === 'none') note = toText(answer?.message) || TASK_OUTPUT_NONE_MESSAGES.provider;
    else if (answer?.pending) note = 'The session\'s worker was asked for the output; call again in a few seconds.';
    else if (answer?.unavailable) note = 'The output file is not there any more (the provider cleaned it up).';
    else if (kind === 'snapshot') note = 'Only the end of this task\'s output is available (its provider keeps no file).';
    const status = ended ? (toText(answer?.status) || 'unknown') : 'running';
    const exitCode = Number.isInteger(answer?.exitCode) ? answer.exitCode : null;
    const parts = [`${tail.length} line${tail.length === 1 ? '' : 's'}`, ended ? `ended (${status}${exitCode !== null ? `, exit ${exitCode}` : ''})` : 'running'];
    if (minutes !== null) parts.push(`last output ${minutes} min ago`);
    if (counts) parts.push(`${counts.passed} passed, ${counts.failed} failed`);
    return {
      summary: `read_task_output → ${ctx.relay.name} session ${shortId(args.session)} task ${shortId(args.task_id)}: ${parts.join(', ')}`,
      task: {
        id: args.task_id,
        description: toText(task.description),
        type: toText(task.taskType) || null,
        startedAt: task.startedAt || null,
        status,
        exitCode,
        ...(task.endedAt ? { endedAt: task.endedAt } : {}),
      },
      stall: minutes === null ? null : {
        minutes,
        since: new Date(lastOutputAt).toISOString(),
        ...(quietAfter ? { quiet: minutes >= quietAfter, quietAfterMinutes: quietAfter } : {}),
      },
      counts,
      tail,
      truncated: cut || answer?.hasMoreBefore === true,
      ...(note ? { note } : {}),
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
    const outcome = await waitForOwnReply(ctx, { session, messageId: args.message_id, waitSeconds: args.wait_seconds });
    return { summary: outcomeSummary('wait', ctx, outcome), ...outcome };
  }

  /**
   * Queues the prompt. A send whose connection fails may still have landed,
   * and the remote dedups on messageId, so it is replayed once with the same
   * id: a 409 DUPLICATE_MESSAGE_ID then means the first attempt got through.
   * When the replay fails too, nobody knows; the error carries the session
   * and message id so the agent checks with wait instead of sending again.
   */
  async function postPrompt(ctx, { session, text, origin, model, mode, effort, billing = '' }) {
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
    // A Claude session moved to another billing with this message: one call,
    // which switches and enqueues together on the target, or does neither.
    const post = () => (billing
      ? postBillingSwitch(ctx, session, { to: billing, by: 'agent', message: body })
      : call(ctx, 'POST', '/api/message', { body }));
    let sent;
    try {
      sent = await post();
    } catch (error) {
      if (!isTransientRemoteError(error)) throw error;
      try {
        sent = await post();
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
   * POST /api/conversation/:id/billing with a message. A relay older than the
   * switch answers 404 without a code: nothing was switched or sent. Its
   * refusals (the billing not set up there, the model, the cap, the
   * history) keep the remote's words.
   */
  async function postBillingSwitch(ctx, session, body) {
    try {
      return await call(ctx, 'POST', sessionPath(session, '/billing'), { body });
    } catch (error) {
      if (isTransientRemoteError(error)) throw error;
      const remoteCode = toText(error?.remoteBody?.code);
      const label = body.to === 'claude-api' ? 'the API key' : 'the subscription';
      if (Number(error?.status) === 404 && !remoteCode) {
        throw new DispatchFailure(409, REMOTE_RELAY_ERROR_CODES.unsupported,
          `Relay "${ctx.relay.name}" cannot switch a session's billing (it runs an OAR from before the switch); nothing was sent. Send without provider to keep the session's billing.`,
          { session });
      }
      const remoteText = toText(error?.remoteBody?.error) || toText(error?.message);
      const code = remoteCode === 'CLAUDE_BILLING_MODEL_UNAVAILABLE'
        ? REMOTE_RELAY_ERROR_CODES.unknownModel
        : (['CLAUDE_API_NOT_CONFIGURED', 'CLAUDE_NOT_CONFIGURED', 'CLAUDE_API_CAP_REACHED'].includes(remoteCode)
          ? REMOTE_RELAY_ERROR_CODES.providerUnavailable
          : (Number(error?.status) === 404 ? REMOTE_RELAY_ERROR_CODES.notFound : REMOTE_RELAY_ERROR_CODES.invalidInput));
      throw new DispatchFailure(Number(error?.status) || 409, code,
        `Relay "${ctx.relay.name}" did not switch session ${session} to ${label}: ${remoteText || 'refused'}. Nothing was sent.`,
        { session, ...(remoteCode ? { remoteCode } : {}) });
    }
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
    // Null for this relay itself while it has no public URL: no link to offer.
    const openUrl = remoteConversationUrl(ctx.relay.url, session) || null;
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
    noteOwnPrompt(ctx, session, sent.messageId);
    if (waitSeconds <= 0) {
      const outcome = { status: 'queued', session, message_id: sent.messageId };
      return { summary: outcomeSummary(action, ctx, outcome), ...outcome, ...extra, openUrl };
    }
    const outcome = await waitForOwnReply(ctx, { session, messageId: sent.messageId, waitSeconds });
    return { summary: outcomeSummary(action, ctx, outcome), ...outcome, ...extra, openUrl };
  }

  /**
   * The event service learns of this conversation's own prompts: a turn_end
   * of one whose finished reply it waited for is not delivered to it again.
   */
  function noteOwnPrompt(ctx, session, messageId) {
    try {
      relayEvents?.noteOwnPrompt?.({
        watcherConversationId: ctx.conversationId,
        // This relay's own sessions: the service's default.
        ...(ctx.relay.local ? {} : { relayId: ctx.relay.id }),
        sessionId: session,
        messageId,
      });
    } catch {}
  }

  /** waitForReply, with that turn's turn_end held while it runs and dropped once the reply came. */
  async function waitForOwnReply(ctx, { session, messageId, waitSeconds }) {
    let token = null;
    try {
      token = relayEvents?.beginOwnWait?.({ watcherConversationId: ctx.conversationId, messageId, waitMs: waitSeconds * 1000 }) || null;
    } catch {}
    let outcome = null;
    try {
      outcome = await waitForReply(ctx, { session, messageId, waitSeconds });
      return outcome;
    } finally {
      try {
        relayEvents?.endOwnWait?.(token, { received: outcome?.status === 'done' && !!outcome?.reply });
      } catch {}
    }
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
    // `provider` on a send is a Claude session's billing: the subscription
    // or the API key. The other one switches the session with this message.
    const billing = toText(args.provider).toLowerCase();
    if (billing && !REMOTE_RELAY_SEND_PROVIDERS.includes(provider)) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
        `Session ${session} on relay "${ctx.relay.name}" runs on ${provider}: provider on send switches a Claude session's billing only. Nothing was sent.`,
        { session, provider });
    }
    const switchTo = billing && billing !== provider ? billing : '';
    // Checked before any approval card (runRelayAction) when the session
    // could be read there; here otherwise. Against the billing it moves to.
    const settled = args.model
      ? (ctx.settledModel || await settleSendModel(ctx, conversation, args.model, { provider: billing }))
      : null;
    const requestedModel = settled?.model || '';
    const modelNote = settled?.note || null;
    // Without a model the remote falls back to its catalogue's current one and
    // silently switches the session; keep the model the session already uses.
    // Grok pins its model at bootstrap and refuses any other, so it gets none.
    const model = requestedModel
      || (provider === 'grok' ? '' : (toText(conversation?.preferredModel) || toText(runtime.providerModel) || toText(runtime.model)));
    const mode = args.mode || ctx.caller.mode || toText(conversation?.preferredRelayMode) || '';
    // The remote runs a prompt that names no effort with its provider's
    // default, not with the one the session is set to: pass that one on, so
    // the session keeps its own. This session's effort is never mirrored here.
    // A Copilot model named with its effort ("gpt-5.4-high") brings that effort.
    const requested = normalizeEffort(args.effort) || normalizeEffort(settled?.effort);
    const own = requested ? '' : normalizeEffort(conversation?.preferredReasoningEffort);
    const origin = await buildOrigin(ctx);
    const { sent, choice } = await postPromptWithEffort(ctx, { session, text: args.text, origin, model, mode, billing: switchTo }, {
      effort: requested || own,
      source: requested ? EFFORT_SOURCES.requested : (own ? EFFORT_SOURCES.remote : ''),
      note: null,
    });
    const billingNote = switchTo
      ? `Session ${session} now runs on ${switchTo === 'claude-api' ? 'the API key' : 'the subscription'}, from this message on (a running turn finishes on the old billing).`
      : '';
    return deliverAndWait('send', ctx, {
      session,
      sent,
      waitSeconds: args.wait_seconds,
      extra: {
        ...(modelNote ? { modelNote } : {}),
        ...(billing && REMOTE_RELAY_SEND_PROVIDERS.includes(provider) ? { provider: switchTo || provider } : {}),
        ...(switchTo ? { billingSwitched: true } : {}),
        ...effortResult(choice),
        ...(billingNote ? { note: [effortResult(choice).note, billingNote].filter(Boolean).join(' ') } : {}),
      },
    });
  }

  /**
   * A model the agent named, checked against the list New Chat offers for
   * `provider` on the target (offeredModelList). Throws a DispatchFailure
   * (unknownModel) for one it does not offer, before anything is created or
   * sent. Returns `{ model, note }`: the id to use (the provider's casing, a
   * Claude alias resolved) and what the agent should know about it, the
   * model left unchecked for want of a list included.
   */
  function settleRequestedModel(ctx, catalog, provider, requested, { creating, extraModels = [], updating = false }) {
    const entry = catalog ? listProviders(catalog).find((candidate) => candidate.provider === provider) : null;
    const offered = catalog ? offeredModelList(catalog, provider) : null;
    const check = checkRequestedProviderModel({
      requestedModel: requested,
      provider,
      // What the message route accepts besides (send): the provider's whole
      // discovered list and the session's own model. Never a list by itself.
      models: offered ? [...offered, ...extraModels.map(toText).filter(Boolean)] : null,
      defaultModel: entry?.defaultModel || '',
      effortsFor: (base) => catalogEffortsFor(catalog?.models, provider, base),
    });
    const where = `on relay "${ctx.relay.name}"`;
    const label = providerModelLabel(provider);
    if (check.status === 'unknown') {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unknownModel,
        `${unknownProviderModelText({ model: requested, provider, suggestions: check.suggestions, models: check.models, where })} ${creating ? 'No session was created.' : (updating ? 'Nothing was changed.' : 'Nothing was sent.')}`,
        {
          provider,
          model: requested,
          suggestions: check.suggestions,
          models: check.models.slice(0, UNKNOWN_MODEL_LIST_MAX),
          note: 'Pass one of these ids (relay_info lists them per provider), or leave model out.',
        });
    }
    if (check.status === 'unchecked') {
      return {
        model: requested,
        note: `Model '${requested}' could not be checked: ${label} ${where} has no model list yet (its model discovery has not run or failed), so ${creating ? 'the session was created with it' : (updating ? 'the session was set to it' : 'the prompt was sent with it')} as asked.`,
      };
    }
    const tierNote = check.tierDropped ? ` ${label} ${where} lists no "[1m]" id for it, so it runs with the standard context.` : '';
    if (check.status === 'alias') {
      return { model: check.model, note: `'${requested}' was taken as ${check.model}, the newest ${label} model of that name ${where}.${tierNote}` };
    }
    // A Copilot model with its effort: the bootstrap and the message route
    // know the listed id, so the effort goes on apart.
    if (check.base) return { model: check.base, effort: check.effort, note: `'${requested}' was taken as ${check.base} with effort ${check.effort}.` };
    if (check.tierDropped) return { model: check.model, note: `'${requested}' was taken as ${check.model}.${tierNote}` };
    // The same id in the provider's casing needs no word; another one does.
    if (check.model.toLowerCase() !== requested.toLowerCase()) {
      return { model: check.model, note: `'${requested}' is listed as ${check.model} ${where}; that is the model used.` };
    }
    return { model: check.model, note: null };
  }

  /** settleRequestedModel for a send to `conversation` (its detail payload); an unread catalogue leaves it unchecked. */
  async function settleSendModel(ctx, conversation, requested, { provider: billing = '' } = {}) {
    const runtime = isPlainObject(conversation?.runtimeSession) ? conversation.runtimeSession : {};
    const own = toText(runtime.providerType).toLowerCase() || 'github';
    // A Claude session moving to its other billing takes that billing's list.
    const provider = billing && REMOTE_RELAY_SEND_PROVIDERS.includes(own) ? billing : own;
    let catalog = null;
    try {
      catalog = await loadCatalog(ctx);
    } catch {
      // No catalogue: the model goes unchecked, and the note says so.
    }
    const settings = catalog?.settings?.[provider];
    return settleRequestedModel(ctx, catalog, provider, requested, {
      creating: false,
      extraModels: [
        ...(Array.isArray(settings?.availableModels) ? settings.availableModels : []),
        runtime.providerModel,
        runtime.model,
      ],
    });
  }

  async function createSession(ctx, args) {
    const catalog = ctx.catalog || await loadCatalog(ctx);
    const providers = buildProviders(catalog);
    const configured = providers.filter((entry) => entry.configured).map((entry) => entry.provider);
    const provider = createProvider(ctx.caller, args);
    const cloud = provider === CLOUD_PROVIDER;
    const entry = providers.find((candidate) => candidate.provider === provider);
    if (!entry?.configured) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.providerUnavailable,
        `Relay "${ctx.relay.name}" has no ${provider} provider set up. Providers there: ${configured.join(', ') || 'none'}. Pass provider to pick one.`,
        { providers: configured, ...(cloud && catalog.settings[CLOUD_PROVIDER] ? { remoteCode: CLOUD_DISABLED_CODE } : {}) });
    }

    let model = args.model || '';
    let modelSource = model ? 'requested' : '';
    let note = null;
    let variantEffort = '';
    if (model) {
      // Refused here when the provider does not offer it: a session created
      // with an id its provider never runs stays empty, and every send to it
      // fails.
      const settled = settleRequestedModel(ctx, catalog, provider, model, { creating: true });
      model = settled.model;
      note = settled.note;
      variantEffort = normalizeEffort(settled.effort);
    }
    // A cloud session without a requested model gets the Claude Cloud tab's
    // default, as New Chat does: the bootstrap picks it, nothing is mirrored.
    if (!model && cloud) {
      modelSource = 'remote default';
    } else if (!model) {
      model = matchOfferedModel(ctx.caller.model, entry.models);
      modelSource = model ? 'same as this session' : '';
    }
    if (!model && !cloud) {
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
    let choice = { effort: normalizeEffort(args.effort) || variantEffort, source: EFFORT_SOURCES.requested, note: null };
    if (!choice.effort && cloud) {
      // A cloud session takes no effort: none is mirrored, none is reported.
      choice = { effort: '', source: '', note: null };
    } else if (!choice.effort) {
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
        // What New Chat sends for a Claude Cloud conversation; the bootstrap
        // validates it and refuses with its own codes.
        ...(cloud ? { cloudSource: { repoUrl: args.repo, ...(args.branch ? { branch: args.branch } : {}) } } : {}),
        // The group the lookup found (its id), else the agent's words; the
        // target resolves it again and refuses before creating anything.
        ...(args.group ? { group: ctx.group?.id || args.group } : {}),
        origin,
      },
    }).catch((error) => {
      throw bootstrapGroupFailure(ctx, error, args.group) || error;
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
    // Nothing to settle for a cloud session that was asked for no effort.
    if (!cloud || choice.effort) choice = settleEffort(ctx, choice, bootstrap?.preferredReasoningEffort);
    const session = toText(bootstrap?.conversationId);
    if (!session) {
      throw new DispatchFailure(502, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}502`,
        `Relay "${ctx.relay.name}" did not return the new session's id.`);
    }
    // A relay that takes group answers the key (null outside a group); one
    // that predates it created the session and passed group over.
    const groupReported = isPlainObject(bootstrap) && Object.prototype.hasOwnProperty.call(bootstrap, 'group');
    const group = groupReported ? bootstrapGroupField(bootstrap.group) : null;
    let groupWarning = null;
    if (args.group && !groupReported) {
      groupWarning = `The session was created WITHOUT a group: ${groupWhere(ctx)} ignored group "${clipLine(args.group, 80)}" (its OAR is older and does not take group on create_session). Tell the user; the owner can move the session into the group by hand.`;
    } else if (args.group && (!group || (ctx.group?.id && group.id !== ctx.group.id))) {
      groupWarning = `The session was created, but not in group "${clipLine(args.group, 80)}": ${groupWhere(ctx)} put it ${group ? `in "${group.name || group.id}" (${group.id})` : 'in no group'}. Tell the user.`;
    }
    const boundModel = toText(bootstrap?.selectedModel) || model;
    // A relay that swapped the asked model for another (one that predates
    // these checks does for Copilot) is named, never passed over in silence.
    if (modelSource === 'requested' && model && !isAutoModelId(model) && boundModel.toLowerCase() !== model.toLowerCase()) {
      note = [note, `Relay "${ctx.relay.name}" started the session on ${boundModel}, not on ${model} as asked.`].filter(Boolean).join(' ');
    }
    let sent;
    try {
      const posted = await postPromptWithEffort(ctx, { session, text: args.text, origin, model: boundModel, mode }, choice);
      sent = posted.sent;
      if (!cloud || choice.effort) choice = posted.choice;
      // From here the new session's queued turn counts toward the cap itself.
      ctx.onPromptQueued?.();
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
          openUrl: remoteConversationUrl(ctx.relay.url, session) || null,
          note: 'Use send with this session and an effort it takes (or none); do not create another session.',
        });
    }
    const result = await deliverAndWait('create_session', ctx, {
      session,
      sent,
      waitSeconds: args.wait_seconds,
      extra: {
        provider: toText(bootstrap?.selectedProviderType) || provider,
        model: boundModel || null,
        modelSource,
        mode: toText(bootstrap?.preferredRelayMode) || mode || null,
        title,
        ...(cloud ? { repo: toText(bootstrap?.cloud?.repoUrl) || args.repo, branch: toText(bootstrap?.cloud?.branch) || args.branch || null } : {}),
        ...(toText(bootstrap?.workspaceRootWarning) ? { cwdWarning: toText(bootstrap.workspaceRootWarning) } : {}),
        ...(note ? { modelNote: note } : {}),
        ...effortResult(choice),
        // The session group it went into, as list_sessions shows it.
        group,
        ...(groupWarning ? { groupWarning } : {}),
      },
    });
    if (!groupWarning) return result;
    // Never a plain success: the summary and the note say what is missing.
    return {
      ...result,
      summary: `${result.summary} (no group: ${groupReported ? 'not applied' : 'target too old'})`,
      note: [groupWarning, result.note].map(toText).filter(Boolean).join(' '),
    };
  }

  /** The provider a new session gets: the one asked for, else the calling session's. */
  function createProvider(caller, args) {
    return args.provider || normalizeProvider(caller?.provider) || 'github';
  }

  /**
   * What is wrong with a create_session call that only the calling session
   * reveals, or null. Checked before anyone is asked for approval: a card for
   * a call that cannot run would be a question about nothing.
   */
  function createSessionProblem(caller, args) {
    if (createProvider(caller, args) === CLOUD_PROVIDER && !args.repo) {
      // The provider came from the calling session (the validator requires
      // repo when the call names claude-cloud itself).
      return `This session's provider is ${CLOUD_PROVIDER}, which a new session gets by default, and a Claude Cloud session needs repo (https://github.com/owner/repo or owner/repo). Pass repo (and branch), or pass another provider (relay_info lists them).`;
    }
    return null;
  }

  /** Whether `session` (a conversation or session id on this relay) is the caller's own conversation. */
  function isOwnConversation(ctx, session) {
    const id = toText(session);
    if (!id) return false;
    if (id === ctx.conversationId) return true;
    try {
      return toText(resolveConversationId(id)) === ctx.conversationId;
    } catch {
      return false;
    }
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
    // A card that takes no typed text gets an option or nothing.
    let extra = toText(args.answer);
    if (extra && question.allowFreeform === false) {
      extra = matchQuestionChoice(extra, options);
      if (!extra) {
        throw invalidInput(`This question takes only its options (${options.join(', ')}), no typed answer; pass one of them in choices.`);
      }
    }
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
    if (ctx.relay.local && session && isOwnConversation(ctx, session)) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.ownSession,
        `Question ${args.question_id} belongs to this conversation itself; an agent cannot answer its own question. It is the user's to answer.`,
        { session });
    }
    if (isRemoteRelayApprovalQuestion(question)) {
      throw new DispatchFailure(403, REMOTE_RELAY_ERROR_CODES.forbidden,
        `Question ${args.question_id} is relay "${ctx.relay.name}"'s approval of its own agent's call to another relay; only its user can answer it.`,
        { session });
    }
    if (toText(question.kind) === RELAY_ASK_KIND) {
      throw new DispatchFailure(403, REMOTE_RELAY_ERROR_CODES.forbidden,
        `Question ${args.question_id} was asked with ask: it is the user's to answer, in the Inbox or that session, not an agent's. Leave it to the user.`,
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

  // ─── update_session ────────────────────────────────────────────────────────

  /** The settings of a call (`args` without relay and session), as the target's route takes them. */
  function requestedSettings(args) {
    const settings = {};
    for (const key of REMOTE_RELAY_SESSION_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(args, key)) settings[key] = args[key];
    }
    return settings;
  }

  /**
   * A refusal of the target's settings route, as the agent reads it (a
   * DispatchFailure), or null for one mapRemoteError handles (offline, token,
   * inbound switch). A 404 without the route's own code is a relay that
   * predates update_session.
   */
  function sessionSettingsFailure(ctx, error, session) {
    if (!isRemoteRelayError(error)) return null;
    const C = REMOTE_RELAY_ERROR_CODES;
    const body = isPlainObject(error.remoteBody) ? error.remoteBody : {};
    const remoteCode = toText(body.code);
    const status = Number(error.status) || 0;
    const where = ctx.relay.local ? 'this relay' : `relay "${ctx.relay.name}"`;
    const text = toText(body.error) || toText(error.message);
    // What the target wrote before the step that failed.
    const changed = Array.isArray(body.changed) ? body.changed.map(toText).filter(Boolean) : [];
    const failed = (failureStatus, code, message, extra = {}) => new DispatchFailure(failureStatus, code, message, { session, ...extra, changed });
    if (remoteCode === 'PROCESS_LIST_UNREADABLE') {
      return failed(503, `${C.httpPrefix}503`, text, { remoteCode, note: 'That relay could not read its process list for a moment: try the change again shortly.' });
    }
    if (status === 404 || toText(error.code) === C.notFound) {
      if (remoteCode === SESSION_SETTINGS_CODES.notFound) {
        return new DispatchFailure(404, C.notFound, `Session ${session} was not found on ${where}.`, { session });
      }
      return new DispatchFailure(400, C.unsupported,
        `${sentence(where)} cannot change a session's settings for agents yet: it runs an older OAR (no update_session there). Nothing was changed.`, { session });
    }
    if (remoteCode === C.permission) {
      return failed(403, C.permission, `${text} Nothing was changed.`);
    }
    if (remoteCode === SESSION_SETTINGS_CODES.busy) {
      return failed(409, C.busy, text, { reason: toText(body.reason) || null });
    }
    if (remoteCode === SESSION_SETTINGS_CODES.groupNotFound || remoteCode === SESSION_SETTINGS_CODES.groupAmbiguous) {
      return failed(400, C.unknownGroup, text, {
        groups: mapGroupList(body).slice(0, REMOTE_RELAY_GROUP_LIMITS.refusalMax).map((group) => ({ id: group.id, name: group.name })),
        ...(Number.isInteger(body.groupsTotal) ? { groupsTotal: body.groupsTotal } : {}),
        note: 'Pass one of these ids, a name for a new group, or "none".',
      });
    }
    if (status === 403 && remoteCode && remoteCode !== C.inboundDisabled) {
      return failed(403, remoteCode, text || `${sentence(where)} refused the change.`);
    }
    if (status >= 400 && status < 500 && status !== 401 && remoteCode !== C.inboundDisabled) {
      return failed(status, status === 429 ? C.rateLimited : C.invalidInput, text || `${sentence(where)} refused the change.`, remoteCode ? { remoteCode } : {});
    }
    // A step that failed on that relay after an earlier one wrote (a CLI that
    // would not restart in the new folder): what was written comes along.
    if (status >= 500 && (changed.length || toText(body.error))) {
      return failed(502, `${C.httpPrefix}${status}`, text || `${sentence(where)} failed to make the change.`, remoteCode ? { remoteCode } : {});
    }
    return null;
  }

  async function sessionSettingsCall(ctx, session, body) {
    try {
      // The origin names the calling conversation: the target changes freely
      // only a session that conversation started.
      const origin = await buildOrigin(ctx);
      return await call(ctx, 'PATCH', sessionPath(session, SESSION_SETTINGS_SUFFIX), { body: { ...body, origin }, timeoutMs: 60_000 });
    } catch (error) {
      throw sessionSettingsFailure(ctx, error, session) || error;
    }
  }

  /**
   * What an update_session would change, checked before anyone is asked:
   * the model against the target's list (as send checks it), the effort
   * against what that model takes, then the target's own dry run (groups,
   * folder, its rule). Throws a DispatchFailure for anything refused.
   */
  async function planSessionUpdate(ctx, args) {
    const conversation = await call(ctx, 'GET', sessionPath(args.session), { query: { limit: 1 } });
    const session = toText(conversation?.id) || args.session;
    const runtime = isPlainObject(conversation?.runtimeSession) ? conversation.runtimeSession : {};
    const provider = toText(runtime.providerType).toLowerCase() || 'github';
    const where = `on relay "${ctx.relay.name}"`;
    const settings = requestedSettings(args);
    const notes = [];
    let catalog = null;
    if (settings.model || settings.effort) catalog = await loadCatalog(ctx).catch(() => null);
    const ownModel = toText(conversation?.preferredModel) || toText(runtime.providerModel) || toText(runtime.model);
    if (settings.model) {
      if (provider === 'grok' && ownModel && settings.model.toLowerCase() !== ownModel.toLowerCase()) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
          `A Grok session keeps the model it was started with (${ownModel}); start a new session for another one. Nothing was changed.`, { session });
      }
      const settled = settleRequestedModel(ctx, catalog, provider, settings.model, {
        creating: false,
        updating: true,
        extraModels: [
          ...(Array.isArray(catalog?.settings?.[provider]?.availableModels) ? catalog.settings[provider].availableModels : []),
          runtime.providerModel,
          runtime.model,
        ],
      });
      settings.model = settled.model;
      if (settled.note) notes.push(settled.note);
      // A Copilot model named with its effort brings that effort.
      if (!settings.effort && normalizeEffort(settled.effort)) settings.effort = normalizeEffort(settled.effort);
    }
    if (settings.effort) {
      if (provider === CLOUD_PROVIDER) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
          `A Claude Cloud session takes no reasoning effort. Nothing was changed.`, { session });
      }
      const model = settings.model || ownModel;
      const offered = catalog ? catalogEffortsFor(catalog.models, provider, model) : null;
      if (offered && offered.length && !offered.includes(settings.effort)) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
          `${model || provider} ${where} does not take effort "${settings.effort}"${supportedEffortsText(offered)}. Nothing was changed.`,
          { session, supportedEfforts: offered });
      }
      if (!offered) notes.push(`Effort "${settings.effort}" could not be checked against ${model || provider} ${where} (no list of its efforts); it was set as asked.`);
    }
    const dry = await sessionSettingsCall(ctx, session, { settings, dry_run: true });
    if (!Array.isArray(dry?.changed)) {
      throw new DispatchFailure(502, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}502`, `Relay "${ctx.relay.name}" did not answer the check of the change as expected. Nothing was changed.`, { session });
    }
    return {
      session,
      title: toText(conversation?.title) || null,
      provider,
      // Whether the owner must allow it: every session the calling
      // conversation did not start itself (the target decides).
      approvalNeeded: dry.approvalNeeded !== false,
      changed: dry.changed.map(toText).filter(Boolean),
      current: isPlainObject(dry.settings) ? dry.settings : null,
      group: isPlainObject(dry.group) ? dry.group : null,
      settings,
      notes: [...notes, ...(Array.isArray(dry.notes) ? dry.notes.map(toText).filter(Boolean) : [])],
    };
  }

  /** The `settings` of an answer as the agent reads it: the target's, the group in list_sessions' shape. */
  function settingsResult(settings) {
    if (!isPlainObject(settings)) return null;
    return { ...settings, group: bootstrapGroupField(settings.group) };
  }

  async function updateSession(ctx, args) {
    const plan = ctx.updatePlan || await planSessionUpdate(ctx, args);
    const openUrl = remoteConversationUrl(ctx.relay.url, plan.session) || null;
    const where = `${ctx.relay.name} session ${shortId(plan.session)}`;
    if (!plan.changed.length) {
      return {
        summary: `update_session → ${where}: nothing to change`,
        session: plan.session,
        settings: settingsResult(plan.current),
        changed: [],
        openUrl,
        note: [...plan.notes, 'The session already has these settings; nothing was changed.'].join(' '),
      };
    }
    const answer = await sessionSettingsCall(ctx, plan.session, { settings: plan.settings, owner_approved: plan.approvalNeeded });
    const changed = Array.isArray(answer?.changed) ? answer.changed.map(toText).filter(Boolean) : plan.changed;
    const notes = [...plan.notes.filter((note) => !(answer?.notes || []).includes(note)), ...(Array.isArray(answer?.notes) ? answer.notes.map(toText).filter(Boolean) : [])];
    if (changed.includes('mode')) {
      notes.push('This mode lasts until the next send that names another mode or comes from a caller in another mode: a send without mode passes the caller\'s own mode.');
    }
    return {
      summary: `update_session → ${where}: ${changed.join(', ') || 'nothing changed'}`,
      session: plan.session,
      settings: settingsResult(answer?.settings),
      changed,
      ...(typeof answer?.relaunched === 'boolean' ? { relaunched: answer.relaunched } : {}),
      ...(isPlainObject(answer?.groupCreated) ? { groupCreated: { id: toText(answer.groupCreated.id), name: toText(answer.groupCreated.name) || null } } : {}),
      openUrl,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  // The owner's Allow for a conversation to change sessions on a relay that it
  // did not start itself, stored as an unlock under `<relay id>:session-settings`.
  function sessionSettingsApprovalKey(relayId) {
    return `${toText(relayId) || REMOTE_RELAY_LOCAL_ID}:session-settings`;
  }

  /**
   * Asked on the first update_session of a conversation that aims at a
   * session on that relay it did not start itself (the owner's, another
   * agent's, its own creator's); remembered once allowed.
   * Parallel calls share the open card. Resolves `{ approved, asked }` or
   * `{ approved:false, code, error }`.
   */
  async function ensureSessionSettingsApproval(ctx, plan, args) {
    const { conversationId } = ctx;
    const key = sessionSettingsApprovalKey(ctx.relay.id);
    if (hasApprovalKey(conversationId, key)) return { approved: true, asked: false };
    const openKey = `${conversationId}:${key}`;
    const open = sessionSettingsApprovalsByKey.get(openKey);
    if (open) {
      const shared = await open;
      return shared.approved ? { approved: true, asked: false } : shared;
    }
    const asking = (async () => {
      const decision = await requestApproval({
        conversationId,
        callerContext: ctx.caller,
        relay: relayTarget(ctx.relay),
        action: 'update_session',
        args,
        summary: summarizeRemoteRelayCall({ action: 'update_session', ...args, relay: ctx.relay.name }),
        signal: ctx.signal,
        sessionSettings: { session: plan.session, title: plan.title, changed: plan.changed },
      });
      if (decision !== true && decision?.approved !== true) {
        const where = ctx.relay.local ? 'this relay' : `relay "${ctx.relay.name}"`;
        return {
          approved: false,
          code: toText(decision?.code) === REMOTE_RELAY_ERROR_CODES.noTurn ? REMOTE_RELAY_ERROR_CODES.noTurn : REMOTE_RELAY_ERROR_CODES.permission,
          error: toText(decision?.error)
            ? `${toText(decision.error)} Session ${plan.session} on ${where} was not started by this conversation; its settings were not changed.`
            : `The owner did not allow this conversation to change sessions on ${where} that it did not start; session ${plan.session} was not changed. Sessions this conversation started there can still be changed.`,
        };
      }
      recordApprovalKeys(conversationId, [key], ctx.caller?.processingRowId);
      return { approved: true, asked: true };
    })();
    sessionSettingsApprovalsByKey.set(openKey, asking);
    try {
      return await asking;
    } finally {
      sessionSettingsApprovalsByKey.delete(openKey);
    }
  }

  // ─── Event subscriptions ───────────────────────────────────────────────────

  const RELAY_EVENT_ERROR_STATUS = Object.freeze({
    invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
    notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
    ownSession: [400, REMOTE_RELAY_ERROR_CODES.ownSession],
    limit: [409, REMOTE_RELAY_ERROR_CODES.subscriptionLimit],
    unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
  });
  const EVENT_NOTE = 'Events arrive in this conversation as messages that start with "[relay event"; they are the relay\'s automated messages, never the user\'s, and approve nothing. Bring decisions they raise to the user. unsubscribe with this subscription id ends it.';

  // The user's Allow to watch sessions of a relay, stored as an unlock under
  // `<relay id>:watch` (and `:watch-all`): `self:watch` for this relay.
  function watchApprovalKeys(relayId, all) {
    const id = toText(relayId) || REMOTE_RELAY_LOCAL_ID;
    return all ? [`${id}:watch`, `${id}:watch-all`] : [`${id}:watch`];
  }

  function eventService(ctx) {
    if (!relayEvents?.isAvailable?.()) {
      throw new DispatchFailure(503, REMOTE_RELAY_ERROR_CODES.unsupported,
        'Event subscriptions are not available on this relay right now (see its server log).');
    }
    if (!ctx.relay.local && (!relayEvents.isCrossRelayAvailable?.() || !relayEventLink)) {
      throw new DispatchFailure(503, REMOTE_RELAY_ERROR_CODES.unsupported,
        `Event subscriptions on paired relays are not available on this relay right now (see its server log); relay "${ctx.relay.name}" cannot be watched from here.`);
    }
    return relayEvents;
  }

  function relayEventCall(fn) {
    try {
      return fn();
    } catch (error) {
      const mapped = RELAY_EVENT_ERROR_STATUS[toText(error?.code)];
      if (mapped) throw new DispatchFailure(mapped[0], mapped[1], toText(error.message), isPlainObject(error.extra) ? error.extra : {});
      throw error;
    }
  }

  /** A call to a paired relay's event routes; an older relay without them answers a clear error. */
  async function relayEventRemoteCall(ctx, path, body) {
    try {
      return await call(ctx, 'POST', path, { body });
    } catch (error) {
      if (isMissingRelayEventRoute(error)) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported, relayWithoutCrossRelayEventsText(ctx.relay.name));
      }
      throw error;
    }
  }

  function hasApprovalKey(conversationId, key) {
    try {
      return repository?.hasUnlock?.(conversationId, key) === true;
    } catch {
      return false;
    }
  }

  function recordApprovalKeys(conversationId, keys, messageId) {
    for (const key of keys) {
      try {
        repository?.recordUnlock?.(conversationId, key, messageId || null);
      } catch (error) {
        try {
          logger?.warn?.(`${LOG_PREFIX} approval ${key} not stored conv=${shortId(conversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
        } catch {}
      }
    }
  }

  /**
   * The user's Allow for this conversation to watch sessions of a relay:
   * asked on its first subscribe there, and again for the first one to
   * "all" unless that was the one asked about. Parallel calls share the
   * open card.
   */
  async function ensureWatchApproval(ctx, { all, watch }) {
    const { conversationId } = ctx;
    const keys = watchApprovalKeys(ctx.relay.id, all);
    const remembered = () => keys.every((key) => hasApprovalKey(conversationId, key));
    if (remembered()) return { approved: true };
    const key = `${conversationId}:${ctx.relay.id}:${all ? 'all' : 'some'}`;
    const open = watchApprovalsByKey.get(key);
    if (open) return open;
    const asking = (async () => {
      const decision = await requestApproval({
        conversationId,
        callerContext: ctx.caller,
        relay: relayTarget(ctx.relay),
        action: 'subscribe',
        args: {},
        summary: `subscribe → ${ctx.relay.name}${all ? ': all sessions' : ''}`,
        signal: ctx.signal,
        watch: { ...watch, ...(ctx.relay.local ? {} : { relayName: ctx.relay.name }) },
      });
      if (decision !== true && decision?.approved !== true) {
        return {
          approved: false,
          code: toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied,
          error: toText(decision?.error) || 'The user did not allow this conversation to watch those sessions. Go on without it, or ask the user first.',
        };
      }
      recordApprovalKeys(conversationId, keys, ctx.caller?.processingRowId);
      return { approved: true };
    })();
    watchApprovalsByKey.set(key, asking);
    try {
      return await asking;
    } finally {
      watchApprovalsByKey.delete(key);
    }
  }

  /** A subscribe's options as the approval card names them. */
  function watchOptions(args) {
    return {
      ...(args.digest_minutes ? { digestMinutes: args.digest_minutes } : {}),
      ...(args.quiet_hours ? { quietHours: args.quiet_hours } : {}),
      ...(args.exclude?.length ? { excludeCount: args.exclude.length } : {}),
    };
  }

  async function subscribeAction(ctx, args) {
    if (!ctx.relay.local) return subscribeRemoteAction(ctx, args);
    const service = eventService(ctx);
    const all = args.scope === 'all';
    const ids = all ? [] : (args.sessions || []);
    // Refused before anyone is asked: the conversation itself, unknown ids.
    if (!all && ids.includes(ctx.conversationId)) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.ownSession,
        `Session ${ctx.conversationId} is the conversation you are running in: it is never watched (your own turns would wake you).`,
        { session: ctx.conversationId });
    }
    const titles = [];
    for (const id of ids) {
      const page = await call(ctx, 'GET', sessionPath(id), { query: { limit: 1 } }).catch(() => null);
      if (!page || page.archived === true) {
        throw new DispatchFailure(404, REMOTE_RELAY_ERROR_CODES.notFound,
          `No live session ${id} on this relay; use an id from list_sessions (archived sessions cannot be watched).`, { session: id });
      }
      titles.push({ id, title: toText(page.title) || null });
    }
    const events = Array.isArray(args.events) && args.events.length ? args.events : [...RELAY_EVENT_DEFAULT_TYPES];
    // Only relay_restarted, no session: nothing of another conversation is
    // watched, so there is nothing to ask the user about.
    if (all || ids.length) {
      const decision = await ensureWatchApproval(ctx, {
        all,
        watch: { kind: 'subscribe', all, sessions: titles, events, once: args.once === true, heartbeatMinutes: args.heartbeat_minutes ?? null, ...watchOptions(args) },
      });
      if (!decision.approved) throw new DispatchFailure(403, decision.code, decision.error);
    }
    const subscription = relayEventCall(() => service.subscribe({
      watcherConversationId: ctx.conversationId,
      scope: all ? 'all' : 'sessions',
      sessionIds: ids,
      events: args.events || null,
      once: args.once === true,
      match: args.match || '',
      stalledMinutes: args.stalled_minutes ?? null,
      heartbeatMinutes: args.heartbeat_minutes ?? null,
      digestMinutes: args.digest_minutes ?? null,
      quietHours: args.quiet_hours ?? null,
      exclude: args.exclude ?? null,
    }));
    const what = all ? 'all sessions' : (ids.length ? `${ids.length} session${ids.length === 1 ? '' : 's'}` : 'relay_restarted');
    return {
      summary: `subscribe → ${ctx.relay.name}: ${what} (${subscription.id})`,
      subscription,
      note: EVENT_NOTE,
    };
  }

  /**
   * subscribe on a paired relay: that relay checks the request first (dry
   * run: sessions, limits, its inbound switch, its version), then the user
   * is asked here, then it stores the subscription and this relay its
   * mirror; the link fetches the events from then on.
   */
  async function subscribeRemoteAction(ctx, args) {
    const relayLevel = (args.events || []).filter((type) => RELAY_EVENT_RELAY_LEVEL_TYPES.includes(type));
    if (relayLevel.length) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
        `${relayLevel.join(', ')} is about the relay you run on: subscribe to it on "${REMOTE_RELAY_LOCAL_ALIAS}". An outage of relay "${ctx.relay.name}" shows as link_lost and link_restored.`);
    }
    if (!args.sessions?.length && args.scope !== 'all') {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, 'subscribe on a paired relay needs sessions (ids from list_sessions) or ["all"].');
    }
    const service = eventService(ctx);
    const all = args.scope === 'all';
    relayEventCall(() => service.checkWatcherCapacity(ctx.conversationId));
    if ((args.digest_minutes || args.quiet_hours || args.exclude?.length) && service.areOptionsAvailable?.() === false) {
      throw new DispatchFailure(503, REMOTE_RELAY_ERROR_CODES.unsupported,
        'digest_minutes, quiet_hours and exclude are not available on this relay right now (see its server log).');
    }
    // Digest and quiet hours are applied here, where the events are
    // delivered; exclude is also the watched relay's (all_idle, stalled).
    const request = {
      watcher: { conversationId: ctx.conversationId, title: toText(ctx.caller?.title) || null },
      subscriber: { name: toText(await registry.selfName?.()) || null },
      scope: all ? 'all' : 'sessions',
      sessions: all ? [] : args.sessions,
      ...(args.events ? { events: args.events } : {}),
      once: args.once === true,
      ...(args.match ? { match: args.match } : {}),
      ...(args.stalled_minutes !== undefined ? { stalled_minutes: args.stalled_minutes } : {}),
      ...(args.heartbeat_minutes !== undefined ? { heartbeat_minutes: args.heartbeat_minutes } : {}),
      ...(args.exclude?.length ? { exclude: args.exclude } : {}),
    };
    const checked = await relayEventRemoteCall(ctx, RELAY_EVENT_REMOTE_SUBSCRIBE_PATH, { ...request, dry_run: true });
    const preview = isPlainObject(checked?.subscription) ? checked.subscription : {};
    const decision = await ensureWatchApproval(ctx, {
      all,
      watch: {
        kind: 'subscribe',
        all,
        sessions: all ? [] : (Array.isArray(preview.sessions) ? preview.sessions : args.sessions.map((id) => ({ id, title: null }))),
        events: Array.isArray(preview.events) ? preview.events : (args.events || [...RELAY_EVENT_DEFAULT_TYPES]),
        once: args.once === true,
        heartbeatMinutes: args.heartbeat_minutes ?? null,
        ...watchOptions(args),
      },
    });
    if (!decision.approved) throw new DispatchFailure(403, decision.code, decision.error);
    const created = await relayEventRemoteCall(ctx, RELAY_EVENT_REMOTE_SUBSCRIBE_PATH, request);
    const remote = isPlainObject(created?.subscription) ? created.subscription : null;
    if (!toText(remote?.id)) {
      throw new DispatchFailure(502, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}502`, `Relay "${ctx.relay.name}" did not return the subscription.`);
    }
    let subscription;
    try {
      subscription = relayEventCall(() => service.addMirror({
        watcherConversationId: ctx.conversationId,
        relayId: ctx.relay.id,
        relayName: ctx.relay.name,
        remote,
        digestMinutes: args.digest_minutes ?? null,
        quietHours: args.quiet_hours ?? null,
        exclude: args.exclude ?? null,
      }));
    } catch (error) {
      // Not kept here: end it there too, so it does not wait for a fetch that never comes.
      await call(ctx, 'POST', RELAY_EVENT_REMOTE_PULL_PATH, {
        body: { after: Number(service.getRemoteLink(ctx.relay.id).cursor) || 0, subscriptions: [], ended: [remote.id] },
      }).catch(() => {});
      throw error;
    }
    void relayEventLink.fetchNow(ctx.relay.id);
    const count = all ? 'all sessions' : `${args.sessions.length} session${args.sessions.length === 1 ? '' : 's'}`;
    return {
      summary: `subscribe → ${ctx.relay.name}: ${count} (${subscription.id})`,
      subscription,
      note: `${EVENT_NOTE} This relay fetches them from relay "${ctx.relay.name}" every few seconds; their lines start with its name. If the link drops, what that relay kept comes as one replayed message once it answers again.`,
    };
  }

  /** Waits (briefly) until the ends of these paired relays reached them: a note for each that did not answer. */
  async function deliverEnds(relayIds) {
    const notes = [];
    for (const relayId of new Set(relayIds)) {
      const result = await relayEventLink?.refresh?.(relayId, { waitMs: 10_000 }).catch(() => null);
      if (result?.ok) continue;
      const name = toText(registry.get?.(relayId)?.name) || relayId;
      notes.push(`Relay "${name}" did not answer (${toText(result?.error) || 'no answer'}); it learns of the end once it answers again, and nothing of it reaches this conversation meanwhile.`);
    }
    return notes;
  }

  async function unsubscribeAction(ctx, args) {
    const service = eventService(ctx);
    const all = args.subscription_id === 'all';
    const ended = relayEventCall(() => service.unsubscribe({
      watcherConversationId: ctx.conversationId,
      subscriptionId: args.subscription_id,
      ...(all ? { relayId: ctx.relay.local ? REMOTE_RELAY_LOCAL_ID : ctx.relay.id } : {}),
    }));
    const notes = await deliverEnds(ended.filter((sub) => sub.remoteId).map((sub) => sub.relay));
    return {
      summary: `unsubscribe → ${ctx.relay.name}: ${ended.length} subscription${ended.length === 1 ? '' : 's'} ended`,
      ended: ended.map(({ pendingSync: _sync, ...sub }) => sub),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  function linkHealth(relayId) {
    const link = relayEvents.getRemoteLink?.(relayId) || {};
    const state = link.lost_at ? 'lost' : (link.first_fail_at ? 'failing' : 'ok');
    return {
      state,
      ...(link.last_ok_at ? { lastAnswerAt: link.last_ok_at } : {}),
      ...(state !== 'ok' && link.last_error ? { error: link.last_error } : {}),
    };
  }

  async function listSubscriptionsAction(ctx, args) {
    const service = eventService(ctx);
    const watcher = toText(args.watcher) || ctx.conversationId;
    // A paired relay's state is fresh: fetched now (briefly waited for).
    if (!ctx.relay.local && service.mirrorsOf(ctx.relay.id).length) await relayEventLink.refresh(ctx.relay.id, { waitMs: 5_000 }).catch(() => {});
    const subscriptions = relayEventCall(() => service.listSubscriptions({ watcherConversationId: watcher }))
      .filter((sub) => ctx.relay.local || sub.relay === ctx.relay.id)
      .map(({ pendingSync, ...sub }) => (sub.remoteId
        ? { ...sub, ...(pendingSync ? { endPending: true } : {}), ...(sub.endedAt ? {} : { link: linkHealth(sub.relay) }) }
        : sub));
    const active = subscriptions.filter((subscription) => !subscription.endedAt).length;
    const notes = [];
    if (subscriptions.length > active) notes.push('Subscriptions with endedAt ended within the last hour (endReason says why).');
    if (subscriptions.some((sub) => sub.link && sub.link.state !== 'ok')) notes.push('A link that is not ok gets no events now; what that relay keeps meanwhile comes as one replayed message once it answers.');
    return {
      summary: `list_subscriptions → ${ctx.relay.name}${watcher === ctx.conversationId ? '' : ` session ${shortId(watcher)}`}: ${active} active`,
      watcher,
      subscriptions,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  async function transferSubscriptionsAction(ctx, args) {
    const service = eventService(ctx);
    const relayId = ctx.relay.local ? null : ctx.relay.id;
    const preview = relayEventCall(() => service.previewTransfer({ fromConversationId: args.from, toConversationId: ctx.conversationId, relayId }));
    // Always asked, also after this conversation's first-subscribe Allow:
    // the subscriptions of another conversation change hands.
    const decision = await requestApproval({
      conversationId: ctx.conversationId,
      callerContext: ctx.caller,
      relay: relayTarget(ctx.relay),
      action: 'transfer_subscriptions',
      args: {},
      summary: `transfer_subscriptions → ${ctx.relay.name}: ${preview.count} from session ${shortId(preview.from.id)}`,
      signal: ctx.signal,
      watch: { kind: 'transfer', from: preview.from, count: preview.count, all: preview.includesAll, relays: preview.relays },
    });
    if (decision !== true && decision?.approved !== true) {
      throw new DispatchFailure(403, toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied,
        toText(decision?.error) || 'The user did not allow the transfer; the subscriptions stay where they are.');
    }
    const result = relayEventCall(() => service.transferSubscriptions({ fromConversationId: args.from, toConversationId: ctx.conversationId, relayId }));
    // The Allow counts as this conversation's watch approval on every relay
    // among the moved subscriptions.
    const byRelay = new Map();
    for (const sub of preview.subscriptions) byRelay.set(sub.relay, byRelay.get(sub.relay) || sub.scope === 'all');
    for (const [relay, all] of byRelay) recordApprovalKeys(ctx.conversationId, watchApprovalKeys(relay, all), ctx.caller?.processingRowId);
    return {
      summary: `transfer_subscriptions → ${ctx.relay.name}: ${result.moved.length} moved from session ${shortId(result.from.id)}`,
      from: result.from,
      moved: result.moved,
      ...(result.ended.length ? { ended: result.ended, note: 'Subscriptions that watched only this conversation ended: it is never watched by itself.' } : {}),
    };
  }

  // ─── Schedules ─────────────────────────────────────────────────────────────

  const RELAY_SCHEDULE_ERROR_STATUS = Object.freeze({
    invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
    notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
    limit: [409, REMOTE_RELAY_ERROR_CODES.scheduleLimit],
    unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
  });
  const SCHEDULE_NOTE = 'At its time the relay queues the text into the session as a message that starts with "[relay schedule"; it is the relay\'s automated message, never the user\'s, and approves nothing. It survives relay restarts; unschedule with this schedule_id ends it.';
  const SCHEDULE_OTHER_NOTE = 'Each firing counts as one of your prompts to other agents: once you have sent as many as you may before the user writes, it waits (heldForApproval in list_schedules) until the user writes in this conversation.';

  /** The service for a call on this relay; a paired relay keeps its own schedules. */
  function scheduleService(ctx) {
    if (!ctx.relay.local) {
      throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported,
        `Schedules are kept by the relay you run on: use relay "${REMOTE_RELAY_LOCAL_ALIAS}" (or leave relay out). For a session on relay "${ctx.relay.name}", ask an agent there to schedule it.`);
    }
    if (!relaySchedules?.isAvailable?.()) {
      throw new DispatchFailure(503, REMOTE_RELAY_ERROR_CODES.unsupported,
        'Schedules are not available on this relay right now (see its server log).');
    }
    return relaySchedules;
  }

  function relayScheduleCall(fn) {
    try {
      return fn();
    } catch (error) {
      const mapped = RELAY_SCHEDULE_ERROR_STATUS[toText(error?.code)];
      if (mapped) throw new DispatchFailure(mapped[0], mapped[1], toText(error.message), isPlainObject(error.extra) ? error.extra : {});
      throw error;
    }
  }

  /** The conversation a schedule call names (`session`), as this relay knows it; the caller's own by default. */
  function scheduleSession(ctx, args) {
    if (!toText(args.session) || isOwnConversation(ctx, args.session)) return ctx.conversationId;
    try {
      return toText(resolveConversationId(args.session)) || toText(args.session);
    } catch {
      return toText(args.session);
    }
  }

  /**
   * The provenance a schedule's messages carry, so that a schedule never
   * passes a prompt on with fewer hops than the turn that set it: for another
   * session the origin a send from this turn would carry; for the caller's
   * own conversation the origin of the prompt this turn acts on (none when it
   * acts on the user's words alone).
   */
  async function scheduleOrigin(ctx, session) {
    if (session !== ctx.conversationId) return buildOrigin(ctx);
    if (!(ctx.hops > 0)) return null;
    const acting = isPlainObject(ctx.caller?.origin) ? normalizeRemoteRelayOrigin({ ...ctx.caller.origin, hops: ctx.hops }) : null;
    return acting || buildOrigin(ctx);
  }

  async function scheduleAction(ctx, args) {
    const service = scheduleService(ctx);
    const session = scheduleSession(ctx, args);
    const origin = await scheduleOrigin(ctx, session);
    const schedule = relayScheduleCall(() => service.create({
      conversationId: session,
      createdBy: ctx.conversationId,
      text: args.text,
      at: args.at ?? null,
      everyMinutes: args.every_minutes ?? null,
      once: args.once ?? null,
      title: args.title || '',
      origin,
    }));
    const when = schedule.everyMinutes
      ? `every ${schedule.everyMinutes} min${schedule.once ? ', once' : ''}`
      : 'once';
    const forOther = session !== ctx.conversationId;
    return {
      summary: `schedule → ${ctx.relay.name}${forOther ? ` session ${shortId(session)}` : ''}: ${when}, next ${schedule.nextFireAt} (${schedule.id})`,
      schedule_id: schedule.id,
      schedule,
      note: forOther ? `${SCHEDULE_NOTE} ${SCHEDULE_OTHER_NOTE}` : SCHEDULE_NOTE,
    };
  }

  async function listSchedulesAction(ctx, args) {
    const service = scheduleService(ctx);
    const session = scheduleSession(ctx, args);
    const schedules = relayScheduleCall(() => service.list({ conversationId: session }));
    const active = schedules.filter((schedule) => !schedule.endedAt).length;
    return {
      summary: `list_schedules → ${ctx.relay.name}${session === ctx.conversationId ? '' : ` session ${shortId(session)}`}: ${active} active`,
      session,
      schedules,
      ...(schedules.length > active ? { note: 'Schedules with endedAt ended within the last hour (endReason says why).' } : {}),
    };
  }

  async function unscheduleAction(ctx, args) {
    const service = scheduleService(ctx);
    const schedule = relayScheduleCall(() => service.unschedule({ scheduleId: args.schedule_id, byConversationId: ctx.conversationId }));
    return {
      summary: `unschedule → ${ctx.relay.name}: ${schedule.id} ended`,
      schedule,
    };
  }

  // ─── Questions that don't block ────────────────────────────────────────────

  const RELAY_ASK_ERROR_STATUS = Object.freeze({
    invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
    notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
    closed: [409, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}409`],
    forbidden: [403, REMOTE_RELAY_ERROR_CODES.forbidden],
    limit: [409, REMOTE_RELAY_ERROR_CODES.questionLimit],
    unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
  });
  const ASK_NOTE = 'The user sees it as a card in that session and in the Inbox. When they answer or dismiss it you get a relay event '
    + 'question_answered (question_id, answer, choice, dismissed, via: the relay it was answered on) without any subscription: a message that starts with "[relay event", '
    + 'automated, but its answer is the user\'s own reply to this question. Keep working on what does not depend on it and do not ask it '
    + 'again meanwhile; withdraw with this question_id takes it back.';

  function askService() {
    if (!relayAsks?.isAvailable?.()) {
      throw new DispatchFailure(503, REMOTE_RELAY_ERROR_CODES.unsupported,
        'Questions that don\'t block are not available on this relay right now (see its server log); use your own question tool instead.');
    }
    return relayAsks;
  }

  function relayAskCall(fn) {
    try {
      return fn();
    } catch (error) {
      const mapped = RELAY_ASK_ERROR_STATUS[toText(error?.code)];
      if (mapped) throw new DispatchFailure(mapped[0], mapped[1], toText(error.message), isPlainObject(error.extra) ? error.extra : {});
      throw error;
    }
  }

  /** The conversation an ask call names (`session`), as this relay knows it; the caller's own by default. */
  function askSession(ctx, args) {
    if (!toText(args.session) || isOwnConversation(ctx, args.session)) return ctx.conversationId;
    try {
      return toText(resolveConversationId(args.session)) || toText(args.session);
    } catch {
      return toText(args.session);
    }
  }

  function askInput(args) {
    return {
      question: args.question,
      options: args.options || [],
      recommendation: args.recommendation || '',
      detail: args.detail || '',
      urgency: args.urgency || 'normal',
    };
  }

  /** A call to a paired relay's ask routes; an older relay without them answers a clear error. */
  async function relayAskRemoteCall(ctx, path, body) {
    try {
      return await call(ctx, 'POST', path, { body });
    } catch (error) {
      if (isMissingRelayAskRoute(error)) {
        throw new DispatchFailure(400, REMOTE_RELAY_ERROR_CODES.unsupported, relayWithoutAsksText(ctx.relay.name));
      }
      throw error;
    }
  }

  async function askAction(ctx, args) {
    const service = askService();
    if (!ctx.relay.local) {
      if (!toText(args.session)) {
        throw invalidInput(`ask on relay "${ctx.relay.name}" needs session (an id from list_sessions there): your own questions go to "${REMOTE_RELAY_LOCAL_ALIAS}".`);
      }
      const response = await relayAskRemoteCall(ctx, RELAY_ASK_REMOTE_PATHS.ask, {
        session: args.session,
        ...askInput(args),
        asker: {
          conversationId: ctx.conversationId,
          title: toText(ctx.caller?.title) || null,
          // Shown there when that relay has no name for this one (a pairing one way round).
          relayName: toText(await registry.selfName?.()) || null,
        },
      });
      const remote = isPlainObject(response?.ask) ? response.ask : null;
      if (!toText(remote?.id)) {
        throw new DispatchFailure(502, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}502`, `Relay "${ctx.relay.name}" did not return the question.`);
      }
      const ask = relayAskCall(() => service.addMirror({ relayId: ctx.relay.id, createdBy: ctx.conversationId, remote }));
      try { relayAskLink?.noteAsked?.(ctx.relay.id); } catch {}
      return {
        summary: `ask → ${ctx.relay.name} session ${shortId(ask.session.id)}: question ${ask.id} pending`,
        question_id: ask.id,
        status: 'pending',
        question: ask,
        note: `${ASK_NOTE} This relay looks for the answer on relay "${ctx.relay.name}" every few seconds; the session there is told too.`,
      };
    }
    const session = askSession(ctx, args);
    const ask = relayAskCall(() => service.create({ conversationId: session, createdBy: ctx.conversationId, ...askInput(args) }));
    const forOther = session !== ctx.conversationId;
    return {
      summary: `ask → ${ctx.relay.name}${forOther ? ` session ${shortId(session)}` : ''}: question ${ask.id} pending${ask.urgency === 'now' ? ' (now)' : ''}`,
      question_id: ask.id,
      status: 'pending',
      question: ask,
      note: forOther ? `${ASK_NOTE} Session ${session} gets the answer too.` : ASK_NOTE,
    };
  }

  async function listQuestionsAction(ctx, args) {
    const service = askService();
    if (!ctx.relay.local) {
      // This conversation's asks there, as this relay last learnt them: fetched now (briefly waited for).
      if (service.pendingMirrorIds(ctx.relay.id).length) await relayAskLink?.fetchNow?.(ctx.relay.id)?.catch?.(() => {});
      const asks = service.listOf(ctx.conversationId)
        .filter((ask) => ask.relayId === ctx.relay.id && (!toText(args.session) || ask.session.id === toText(args.session)));
      return {
        summary: `list_questions → ${ctx.relay.name}: ${asks.filter((ask) => ask.status === 'pending').length} pending`,
        questions: asks,
        note: 'These are the questions this conversation asked there. read_session there lists every pending question of a session, asks (kind ask) included.',
      };
    }
    const session = askSession(ctx, args);
    const asks = service.listOf(session).filter((ask) => !ask.relayId || session === ctx.conversationId);
    const pending = asks.filter((ask) => ask.status === 'pending').length;
    return {
      summary: `list_questions → ${ctx.relay.name}${session === ctx.conversationId ? '' : ` session ${shortId(session)}`}: ${pending} pending`,
      session,
      questions: asks,
      ...(asks.length > pending ? { note: 'Questions that are not pending were answered, dismissed or withdrawn within the last day.' } : {}),
    };
  }

  async function withdrawAction(ctx, args) {
    const service = askService();
    if (!ctx.relay.local) {
      const mirror = service.getMirror(ctx.relay.id, args.question_id);
      if (!mirror || mirror.askedBy?.conversationId !== ctx.conversationId) {
        throw new DispatchFailure(404, REMOTE_RELAY_ERROR_CODES.notFound,
          `This conversation asked no question ${args.question_id} on relay "${ctx.relay.name}"; list_questions there shows the ones it did.`);
      }
      await relayAskRemoteCall(ctx, RELAY_ASK_REMOTE_PATHS.withdraw, { id: args.question_id });
      const ask = service.closeMirror(ctx.relay.id, args.question_id, 'withdrawn');
      return { summary: `withdraw → ${ctx.relay.name}: question ${args.question_id} withdrawn`, question: ask };
    }
    const ask = relayAskCall(() => service.withdraw(args.question_id, { byConversationId: ctx.conversationId }));
    return { summary: `withdraw → ${ctx.relay.name}: question ${ask.id} withdrawn`, question: ask };
  }

  const ACTIONS = Object.freeze({
    ask: askAction,
    list_questions: listQuestionsAction,
    withdraw: withdrawAction,
    schedule: scheduleAction,
    list_schedules: listSchedulesAction,
    unschedule: unscheduleAction,
    subscribe: subscribeAction,
    unsubscribe: unsubscribeAction,
    list_subscriptions: listSubscriptionsAction,
    transfer_subscriptions: transferSubscriptionsAction,
    relay_info: relayInfo,
    usage: usageAction,
    list_sessions: listSessions,
    read_session: readSession,
    read_task_output: readTaskOutput,
    wait: waitAction,
    send,
    create_session: createSession,
    update_session: updateSession,
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
    const settings = agentSessions();
    const local = settings.enabled ? await localTarget() : null;
    const listed = relays.map((relay) => ({
      name: relay.name,
      url: relay.url,
      online: toText(relay.lastStatus).toLowerCase() === 'online',
      version: relay.version || null,
      permission: relay.permission,
      unlocked: relayAccess(conversationId, relay) !== null,
    }));
    // This relay itself comes first: no address, always online, never locked.
    if (local) {
      listed.unshift({ name: local.name, self: true, online: true, version: local.version, permission: 'full', unlocked: true });
    }
    const unlocked = listed.filter((relay) => relay.unlocked).length;
    return {
      status: 200,
      body: {
        ok: true,
        summary: `list_relays: ${listed.length} relay${listed.length === 1 ? '' : 's'}, ${unlocked} unlocked`,
        self: { name: (await registry.selfName?.()) || null },
        relays: listed,
        limits: {
          maxWaitSeconds: settings.maxWaitSeconds,
          ...(local ? { maxActiveSessions: REMOTE_RELAY_LIMITS.localActiveSessions } : {}),
        },
        hint: 'The user unlocks a relay by mentioning @name in the chat; a relay whose agent wrote to this conversation is open as well.'
          + (local
            ? ` The relay marked self is the one you run on: name it (or "${REMOTE_RELAY_LOCAL_ALIAS}") to start and use sessions here, no mention needed. At most ${REMOTE_RELAY_LIMITS.localActiveSessions} sessions you started may work at the same time, and they run on this relay's accounts.`
            : ''),
      },
    };
  }

  /**
   * The relay a call names: `{ relay }` (a registry entry, or the local
   * target), or `{ failure }`. "this" always means the relay the agent runs
   * on; its name does too, unless a paired relay answers to that name.
   */
  async function resolveTarget(name) {
    const query = toText(name).replace(/^@/, '').toLowerCase();
    const settings = agentSessions();
    const alias = query === REMOTE_RELAY_LOCAL_ALIAS;
    const resolved = alias ? null : await registry.resolve(name);
    if (resolved?.relay) return { relay: resolved.relay };
    const selfName = toText(await registry.selfName?.());
    if (alias || (resolved?.error !== 'ambiguous' && selfName && selfName.toLowerCase() === query)) {
      if (!settings.enabled) {
        return {
          failure: failure(403, REMOTE_RELAY_ERROR_CODES.localDisabled,
            'Agents may not start or use sessions on this relay: its setting "Agents may start and use sessions on this relay" (Settings → Relays → Agent sessions) is off. Ask the user to turn it on; do not retry until then.',
            { relay: selfName || REMOTE_RELAY_LOCAL_ALIAS }),
        };
      }
      if (!repository) {
        return {
          failure: failure(503, REMOTE_RELAY_ERROR_CODES.localDisabled,
            'Sessions on this relay are not available to agents right now: its storage for them could not be opened (see the server log).',
            { relay: selfName || REMOTE_RELAY_LOCAL_ALIAS }),
        };
      }
      return { relay: await localTarget() };
    }
    const names = Array.isArray(resolved?.names) ? resolved.names : [];
    const error = resolved?.error === 'ambiguous'
      ? `"${name}" matches several relays (${names.join(', ')}); use the full name.`
      : `No paired relay is called "${name}". Known relays: ${names.join(', ') || 'none'}${settings.enabled ? `; this relay itself is "${selfName || REMOTE_RELAY_LOCAL_ALIAS}" (or "${REMOTE_RELAY_LOCAL_ALIAS}")` : ''}.`;
    return { failure: failure(404, REMOTE_RELAY_ERROR_CODES.unknown, error, { relays: names }) };
  }

  /**
   * The user's Allow for this conversation's agent to start sessions on this
   * relay: remembered once given, asked with a card otherwise. Calls that
   * arrive while the card is open share it and its answer. Resolves
   * `{ approved:true, asked }` or `{ approved:false, code?, error? }`.
   */
  async function ensureLocalSessionApproval({ conversationId, caller, relay, action, args, signal, group = null }) {
    const remembered = () => {
      try {
        return repository.hasLocalSessionApproval(conversationId) === true;
      } catch {
        return false;
      }
    };
    if (remembered()) return { approved: true, asked: false };
    const open = localApprovalsByConversation.get(conversationId);
    if (open) {
      const shared = await open;
      return shared.approved ? { approved: true, asked: false } : shared;
    }
    const asking = (async () => {
      const decision = await requestApproval({
        conversationId,
        callerContext: caller,
        relay: relayTarget(relay),
        action,
        args,
        summary: summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
        signal,
        localSessions: true,
        ...(group ? { group } : {}),
      });
      if (decision !== true && decision?.approved !== true) {
        return {
          approved: false,
          code: toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied,
          error: toText(decision?.error)
            || 'The user did not allow this agent to start a session on this relay. Go on without it, or ask the user before trying again.',
        };
      }
      try {
        repository.recordLocalSessionApproval(conversationId, caller.processingRowId || null);
      } catch (error) {
        // Not remembered: the next create asks again.
        try {
          logger?.warn?.(`${LOG_PREFIX} local session approval not stored conv=${shortId(conversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
        } catch {}
      }
      return { approved: true, asked: true };
    })();
    localApprovalsByConversation.set(conversationId, asking);
    try {
      return await asking;
    } finally {
      localApprovalsByConversation.delete(conversationId);
    }
  }

  /**
   * The local target's own rules for create_session, before anyone is asked:
   * one level, and the cap. Null when the call may go on (the caller then
   * holds a place under the cap until its prompt is queued).
   */
  function refuseLocalCreate(conversationId, relay) {
    let origin = null;
    let active = [];
    try {
      origin = repository.getConversationOrigin(conversationId);
      active = repository.listActiveLocalSessions(conversationId);
    } catch (error) {
      try {
        logger?.warn?.(`${LOG_PREFIX} local session rules unreadable conv=${shortId(conversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
      } catch {}
      return failure(503, REMOTE_RELAY_ERROR_CODES.localDisabled,
        'Sessions on this relay are not available to agents right now: its storage for them could not be read (see the server log).',
        { relay: relay.name });
    }
    // One level, unless the owner allowed this session's agents to start
    // sessions themselves; the cap and the Allow below still apply.
    let ownerAllowed = false;
    try {
      ownerAllowed = repository.mayCreateSessions?.(conversationId) === true;
    } catch {}
    if (origin && !ownerAllowed) {
      return failure(403, REMOTE_RELAY_ERROR_CODES.nestedSession,
        'A session that an agent created cannot create sessions (unless the relay\'s owner allows it for this session). Do the work in this session, or say in your reply what the agent that prompted you should start.',
        { relay: relay.name });
    }
    const limit = REMOTE_RELAY_LIMITS.localActiveSessions;
    const starting = localCreatesByConversation.get(conversationId) || 0;
    if (active.length + starting >= limit) {
      return failure(409, REMOTE_RELAY_ERROR_CODES.sessionLimit,
        `${limit} sessions you started are still working; wait for one to finish.`,
        {
          relay: relay.name,
          limit,
          sessions: active.slice(0, limit),
          note: 'Use wait (or read_session) on one of these sessions; create_session works again once one has no turn queued or running.',
        });
    }
    return null;
  }

  async function runRelayAction({ conversationId, action, args, req, signal, waitNote }) {
    const target = await resolveTarget(args.relay);
    if (!target.relay) return target.failure;
    const relay = target.relay;
    const local = relay.local === true;
    // A schedule for another session prompts it later: it is gated like a
    // send (approval in ask and plan mode, the write limit, the audit line).
    // One for the caller's own conversation prompts nobody else.
    const ownSchedule = action === 'schedule' && (!toText(args.session) || isOwnConversation({ conversationId }, args.session));
    // An ask on behalf of another session puts a card there and wakes it with
    // the answer: a write too (hop limit, approval in ask and plan mode, the
    // write limit, the audit line), but no prompt of an agent's: the loop
    // guard does not count it, the answer is the user's. An ask about the
    // caller's own conversation never gets here (isOwnAskCall).
    const behalfAsk = action === 'ask' && !!toText(args.session) && !isOwnConversation({ conversationId }, args.session);
    const write = isRemoteRelayWriteAction(action) || (action === 'schedule' && !ownSchedule) || behalfAsk;
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

    // A paired relay is gated by the user's mention and its permission. The
    // local target has neither: the setting let the call in (resolveTarget).
    const access = local ? 'user' : relayAccess(conversationId, relay);
    if (!access) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.locked,
        `Relay "${relay.name}" is locked in this conversation. Ask the user to mention @${relay.name} (or its name) in a message to allow work there.`,
        { relay: relay.name }));
    }
    if (!local && !remoteRelayPermissionAllows(relay.permission, action, { ownSession: ownSchedule })) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.forbidden,
        `Relay "${relay.name}" lets agents ${PERMISSION_DESCRIPTIONS[relay.permission] || 'do less'} (permission "${relay.permission}"); ${action} needs "${remoteRelayActionPermission(action, { ownSession: ownSchedule })}". The user can change this in Settings → Relays.`,
        { relay: relay.name, permission: relay.permission }));
    }
    if (local && OWN_SESSION_ACTIONS.has(action) && isOwnConversation({ conversationId }, args.session)) {
      return finish(failure(400, REMOTE_RELAY_ERROR_CODES.ownSession,
        `Session ${args.session} is the conversation you are running in: an agent cannot ${action} itself. Use the id of another session (list_sessions, or the one create_session returned).`,
        { relay: relay.name, session: args.session }));
    }

    const caller = { conversationId, ...((await getCallerContext(conversationId, req)) || {}) };
    caller.mode = toText(caller.mode).toLowerCase();
    // A call on this relay itself crosses no relay: it carries the hops of the
    // prompt it acts on unchanged.
    const hops = nonNegativeInt(caller.hops) + (local ? 0 : 1);
    // The hop limit stops a prompt from travelling on to a third relay. A
    // relay the user unlocked here stays in reach whatever prompts arrive,
    // the relay the prompts came from may always be answered, and reading
    // carries nothing on.
    const origins = Array.isArray(caller.originRelayIds) ? caller.originRelayIds.map(toText) : [];
    const answering = !!toText(relay.relayId) && origins.length > 0
      && origins.every((id) => id === toText(relay.relayId));
    if (write && access !== 'user' && !answering && hops > REMOTE_RELAY_LIMITS.hopLimit) {
      return finish(failure(403, REMOTE_RELAY_ERROR_CODES.hopLimit,
        `This turn acts on a prompt from another relay's agent (hop ${hops - 1}); passing it on to relay "${relay.name}" would pass the limit of ${REMOTE_RELAY_LIMITS.hopLimit} hops. The user can allow it by mentioning @${relay.name} in this conversation.`,
        { relay: relay.name }));
    }

    const retryAfterSeconds = consumeRateLimit(conversationId, write);
    if (retryAfterSeconds !== null) {
      return finish(failure(429, REMOTE_RELAY_ERROR_CODES.rateLimited,
        `Too many remote relay calls from this conversation (at most ${REMOTE_RELAY_LIMITS.callsPerMinute} a minute, ${REMOTE_RELAY_LIMITS.writesPerMinute} of them writes). Try again in ${retryAfterSeconds} s.`,
        { relay: relay.name, retryAfterSeconds }));
    }

    // The target's catalogue, loaded before anyone is asked for approval when
    // the agent names a model: a card for a model that does not exist there
    // would be a question about nothing. createSession reuses it.
    let catalog = null;
    let settledModel = null;
    if (action === 'create_session') {
      const problem = createSessionProblem(caller, args);
      if (problem) return finish(failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, problem, { relay: relay.name }));
    }
    // The group a create_session names, looked up on the target before anyone
    // is asked, like the model: the card names it, and an unknown group (or a
    // target whose groups cannot be read) refuses the call, nothing created.
    let group = null;
    if (action === 'create_session' && args.group) {
      try {
        group = await settleRequestedGroup({ relay, caller, hops, conversationId, signal }, args.group);
      } catch (error) {
        if (error instanceof DispatchFailure) {
          return finish(failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra }));
        }
        throw error;
      }
    }
    if ((action === 'create_session' || action === 'send') && args.model) {
      const early = { relay, caller, hops, conversationId, signal };
      try {
        if (action === 'create_session') {
          catalog = await loadCatalog(early);
          const provider = createProvider(caller, args);
          // A provider not set up there answers as such (createSession), not
          // with a model it has no list for.
          if (listProviders(catalog).find((entry) => entry.provider === provider)?.configured) {
            settleRequestedModel(early, catalog, provider, args.model, { creating: true });
          }
        } else {
          const conversation = await call(early, 'GET', sessionPath(args.session), { query: { limit: 1 } });
          settledModel = await settleSendModel(early, conversation, args.model, { provider: args.provider });
        }
      } catch (error) {
        if (error instanceof DispatchFailure) {
          return finish(failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra }));
        }
        // The target did not answer: the call itself reports that.
        catalog = null;
        settledModel = null;
      }
    }
    // The card names a billing switch only when the send makes one: a
    // provider that is already the session's billing changes nothing. Read
    // off the target before anyone is asked; a target that cannot be read
    // keeps the line (the send itself then answers).
    let cardArgs = args;
    if (action === 'send' && args.provider) {
      try {
        const conversation = await call({ relay, caller, hops, conversationId, signal }, 'GET', sessionPath(args.session), { query: { limit: 1 } });
        const runtime = isPlainObject(conversation?.runtimeSession) ? conversation.runtimeSession : {};
        if (toText(runtime.providerType).toLowerCase() === args.provider) cardArgs = { ...args, provider: undefined };
      } catch {}
    }
    // What an update_session would change, settled on the target before
    // anyone is asked: an unknown model or group, a busy session or a change
    // to nothing never raises a card.
    let updatePlan = null;
    if (action === 'update_session') {
      try {
        updatePlan = await planSessionUpdate({ relay, caller, hops, conversationId, signal }, args);
      } catch (error) {
        if (error instanceof DispatchFailure) {
          return finish(failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra }));
        }
        if (isRemoteRelayError(error)) return finish(mapRemoteError(error, relay, { action, args }));
        throw error;
      }
    }

    const localCreate = local && action === 'create_session';
    let holdsLocalCreate = false;
    const releaseLocalCreate = () => {
      if (!holdsLocalCreate) return;
      holdsLocalCreate = false;
      adjustLocalCreates(conversationId, -1);
    };
    if (localCreate) {
      const refusal = refuseLocalCreate(conversationId, relay);
      if (refusal) return finish(refusal);
      adjustLocalCreates(conversationId, 1);
      holdsLocalCreate = true;
    }

    adjustInflight(conversationId, 1);
    try {
      // A schedule for another session prompts it later: the loop guard counts
      // it now, like a send (and each of its firings once more, admitScheduledFiring).
      const prompting = isRemoteRelayPromptAction(action) || (action === 'schedule' && !ownSchedule);
      let asked = false;
      if (localCreate) {
        const decision = await ensureLocalSessionApproval({ conversationId, caller, relay, action, args, signal, group });
        if (!decision.approved) {
          return finish(failure(403, decision.code || REMOTE_RELAY_ERROR_CODES.approvalDenied, decision.error, { relay: relay.name }));
        }
        // The card this call raised showed its prompt: it is this call's
        // approval too, and the user has just looked at what the agent does.
        if (decision.asked) {
          asked = true;
          agentPrompts(conversationId).count = 0;
        }
      }
      // A session this conversation did not start: the owner's Allow, once per conversation
      // and target. The card this call raised is this call's approval too.
      const updatesNothing = !!updatePlan && !updatePlan.changed.length;
      if (updatePlan && !updatesNothing && updatePlan.approvalNeeded) {
        const decision = await ensureSessionSettingsApproval({ relay, caller, conversationId, signal }, updatePlan, args);
        if (!decision.approved) {
          return finish(failure(403, decision.code, decision.error, { relay: relay.name, session: updatePlan.session }));
        }
        if (decision.asked) asked = true;
      }
      if (!asked && prompting && agentPrompts(conversationId).count >= REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking) {
        // Agents that prompt each other can go on without the user for good:
        // from time to time the user is asked, in any relay mode.
        const decision = await requestApproval({
          conversationId,
          callerContext: caller,
          relay: relayTarget(relay),
          action,
          args: cardArgs,
          summary: summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
          signal,
          agentPrompts: agentPrompts(conversationId).count,
          ...(group ? { group } : {}),
        });
        const approved = decision === true || decision?.approved === true;
        if (!approved) {
          const code = toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied;
          const error = toText(decision?.error)
            || `The agent has sent ${agentPrompts(conversationId).count} prompts to ${local ? 'other agents' : 'other relays\' agents'} since the user last wrote, and the user did not allow more for now.`;
          return finish(failure(403, code, error, { relay: relay.name }));
        }
        agentPrompts(conversationId).count = 0;
        asked = true;
      }
      if (!asked && write && !updatesNothing && REMOTE_RELAY_APPROVAL_MODES.includes(caller.mode)) {
        const decision = await requestApproval({
          conversationId,
          callerContext: caller,
          relay: relayTarget(relay),
          action,
          args: cardArgs,
          summary: summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
          signal,
          ...(group ? { group } : {}),
        });
        const approved = decision === true || decision?.approved === true;
        if (!approved) {
          const code = toText(decision?.code) || REMOTE_RELAY_ERROR_CODES.approvalDenied;
          const error = toText(decision?.error)
            || `The user did not allow this ${action.replace(/_/g, ' ')} on ${local ? 'this relay' : `relay "${relay.name}"`}.`;
          return finish(failure(403, code, error, { relay: relay.name }));
        }
      }

      const ctx = { relay, caller, hops, conversationId, signal, onPromptQueued: releaseLocalCreate, ...(catalog ? { catalog } : {}), ...(settledModel ? { settledModel } : {}), ...(group ? { group } : {}), ...(updatePlan ? { updatePlan } : {}) };
      const body = await ACTIONS[action](ctx, args);
      if (prompting) agentPrompts(conversationId).count += 1;
      const { summary, ...rest } = body;
      const note = [rest.note, waitNote].map(toText).filter(Boolean).join(' ');
      return finish({
        status: 200,
        body: {
          ok: true,
          relay: relay.name,
          summary: summary || summarizeRemoteRelayCall({ action, ...args, relay: relay.name }),
          ...rest,
          ...(note ? { note } : {}),
        },
      });
    } catch (error) {
      if (error instanceof DispatchFailure) {
        return finish(failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra }));
      }
      if (isRemoteRelayError(error)) return finish(mapRemoteError(error, relay, { action, args }));
      throw error;
    } finally {
      releaseLocalCreate();
      adjustInflight(conversationId, -1);
    }
  }

  /**
   * Whether a call is an ask action about the caller's own conversation on
   * this relay: an ask or list_questions without another session, or a
   * withdraw here. Such a call touches nothing but the conversation's own
   * questions, so it needs neither the agent sessions setting nor a mention.
   */
  async function isOwnAskCall(conversationId, action, args) {
    if (!REMOTE_RELAY_ASK_ACTIONS.includes(action)) return false;
    const query = toText(args?.relay).replace(/^@/, '').toLowerCase();
    if (query !== REMOTE_RELAY_LOCAL_ALIAS) {
      const resolved = await registry.resolve(args.relay);
      if (resolved?.relay || resolved?.error === 'ambiguous') return false;
      const selfName = toText(await registry.selfName?.()).toLowerCase();
      if (!selfName || selfName !== query) return false;
    }
    return action === 'withdraw' || !toText(args.session) || isOwnConversation({ conversationId }, args.session);
  }

  /** An ask action on the caller's own conversation (isOwnAskCall): the rate limit, then the action. */
  async function runOwnAskAction({ conversationId, action, args, req, signal }) {
    const relay = await localTarget();
    const retryAfterSeconds = consumeRateLimit(conversationId, false);
    if (retryAfterSeconds !== null) {
      return failure(429, REMOTE_RELAY_ERROR_CODES.rateLimited,
        `Too many remote relay calls from this conversation (at most ${REMOTE_RELAY_LIMITS.callsPerMinute} a minute). Try again in ${retryAfterSeconds} s.`,
        { relay: relay.name, retryAfterSeconds });
    }
    const caller = { conversationId, ...((await getCallerContext(conversationId, req)) || {}) };
    try {
      const { summary, ...rest } = await ACTIONS[action]({ relay, caller, hops: nonNegativeInt(caller.hops), conversationId, signal }, args);
      return { status: 200, body: { ok: true, relay: relay.name, summary, ...rest } };
    } catch (error) {
      if (error instanceof DispatchFailure) return failure(error.status, error.code, error.message, { relay: relay.name, ...error.extra });
      throw error;
    }
  }

  /**
   * One tool call. Never throws: resolves to `{ status, body }` for the route
   * to send as is. `signal` (optional) aborts approval and reply waits when
   * the caller hangs up.
   */
  async function dispatch({ conversationId, action, args, req, signal } = {}) {
    // wait_seconds is cut to this relay's "longest wait" setting, for every
    // target: the waiting is done here, by polling the target.
    const { maxWaitSeconds } = agentSessions();
    const validation = validateRemoteRelayToolInput({ ...(isPlainObject(args) ? args : {}), action }, { maxWaitSeconds });
    const result = await runValidated({ conversationId, req, signal }, validation);
    // The arguments the action does not take, named on the answer (a call
    // that came through a worker's tool had them named there already).
    if (!validation.ignored?.length || !isPlainObject(result?.body)) return result;
    return { ...result, body: { ...result.body, ignored: validation.ignored } };
  }

  async function runValidated({ conversationId, req, signal }, validation) {
    if (!validation.ok) return failure(400, validation.code, validation.error);
    const requestedConversationId = toText(conversationId);
    let callerConversationId = requestedConversationId;
    try {
      callerConversationId = toText(resolveConversationId(requestedConversationId)) || requestedConversationId;
    } catch {}
    if (!callerConversationId) {
      return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, 'conversationId is required');
    }
    const waitNote = validation.waitLimitedFrom
      ? `wait_seconds ${validation.waitLimitedFrom} is more than this relay allows per call (${validation.args.wait_seconds}, set by its owner); it waited at most ${validation.args.wait_seconds} s.`
      : '';
    try {
      if (validation.action === 'list_relays') return await listRelays(callerConversationId);
      if (await isOwnAskCall(callerConversationId, validation.action, validation.args)) {
        return await runOwnAskAction({ conversationId: callerConversationId, action: validation.action, args: validation.args, req, signal });
      }
      return await runRelayAction({
        conversationId: callerConversationId,
        action: validation.action,
        args: validation.args,
        req,
        signal,
        waitNote,
      });
    } catch (error) {
      try {
        logger?.warn?.(`${LOG_PREFIX} ${validation.action} failed conv=${shortId(callerConversationId)}: ${toText(error?.message || error).slice(0, 200)}`);
      } catch {}
      return failure(500, REMOTE_RELAY_INTERNAL_ERROR_CODE, 'The remote relay tool failed on this relay; see its server log.');
    }
  }

  return { dispatch, inflight, admitScheduledFiring };
}
