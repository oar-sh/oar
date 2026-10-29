'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import {
  REMOTE_RELAY_APPROVAL_SOURCE,
  REMOTE_RELAY_APPROVAL_SUMMARY_MAX,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_PROVIDERS,
} from '../../shared/remote-relay-contract.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS, questionExpiresAt } from '../../shared/question-timeout.mjs';
import { readApprovalAnswer } from '../../shared/question-answer-rule.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { pickLiveTurnRowId } from './live-turn-picker.mjs';
import { sanitizeRelayQuestionContext } from './relay-question-context.mjs';

// The runtime side of the remote-relay dispatcher: who is calling (the
// conversation, its current turn, provider, model, relay mode and hop count)
// and the approval card that write actions need in ask/plan mode.
//
// A tool call arrives while the calling session's turn is processing, so the
// turn is that conversation's live processing queue row. Its id is also the
// id of the user message behind it (POST /api/message writes both with one
// id), which is where an agent-sent prompt keeps its `origin` and hop count.
//
// A background continuation turn (queue kind 'continuation') has no user
// message behind it; it continues work an earlier turn started, so it counts
// the hops of the latest user message before it.
//
// The approval card is an ordinary relay question on that row, written the
// way POST /api/relay-question writes one: same columns, same socket event and
// push, so it renders like any ask_user card and the stale-recovery and turn
// ceiling exemptions for a turn waiting on a question apply to it. Its context
// source (REMOTE_RELAY_APPROVAL_SOURCE) keeps other relays' agents away from it.

const LOG_PREFIX = '[remote-relays]';
const APPROVAL_HEADER = 'Remote relay';
// The once-per-conversation card for sessions an agent starts on this relay.
const LOCAL_SESSIONS_HEADER = 'Agent sessions';
const WATCH_HEADER = 'Relay events';
const APPROVAL_ALLOW = 'Allow';
const APPROVAL_DENY = 'Deny';
const EXCERPT_MAX = 200;

function toText(value) {
  return String(value ?? '').trim();
}

function shortId(value) {
  return toText(value).slice(0, 8) || '-';
}

function defaultNormalizeRelayMode(mode) {
  return toText(mode).toLowerCase() || null;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Enough of the runtime's formatQuestionRow for the card and the tests. */
function defaultFormatQuestionRow(row) {
  if (!row) return null;
  const envelope = parseJson(row.request, null);
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    sdkSessionId: row.sdk_session_id || null,
    messageId: row.message_id,
    mode: row.relay_mode,
    prompt: row.prompt,
    choices: parseJson(row.choices, []),
    context: envelope && typeof envelope === 'object' ? envelope.context || null : null,
    allowFreeform: envelope?.allowFreeform ?? false,
    status: row.status,
    answer: row.answer || null,
    createdAt: row.created_at,
    answeredAt: row.answered_at || null,
    expiresAt: row.expires_at,
  };
}

function excerpt(value) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

const APPROVAL_VERBS = Object.freeze({
  send: 'send a prompt',
  create_session: 'start a new session',
  update_session: 'change the settings of a session',
  answer_question: 'answer a question',
  stop: 'stop the running turn',
  archive: 'archive a session',
  schedule: 'schedule a prompt',
  ask: 'ask you a question on behalf of another session',
});

/**
 * How the remote turn would run, as far as this relay knows it: the mode (the
 * requested one; for a new session else the calling session's, which the
 * dispatcher passes on; a send without one leaves the target's own),
 * the provider a new session gets (requested, else the caller's), the model
 * and working directory when the agent asked for them, and the session group
 * a new session goes into (`group`, as the target resolved it).
 */
function describeRemoteTurn(action, args, caller, group = null) {
  const parts = [];
  const planOnly = action === 'create_session' && args.planOnly === true;
  const mode = toText(args.mode).toLowerCase()
    || (action === 'create_session' ? (planOnly ? 'plan' : toText(caller?.mode).toLowerCase()) : '');
  if (mode) parts.push(`Mode: ${mode}`);
  if (planOnly) parts.push('Plan only');
  if (action === 'create_session') {
    const requested = toText(args.provider).toLowerCase();
    const callerProvider = toText(caller?.provider).toLowerCase();
    const provider = requested || (REMOTE_RELAY_PROVIDERS.includes(callerProvider) ? callerProvider : 'github');
    parts.push(`Provider: ${provider}`);
  }
  // A send that names a Claude billing moves the session to it with the
  // message: who pays for its turns changes, so the card says so.
  if (action === 'send') {
    const billing = toText(args.provider).toLowerCase();
    if (billing === 'claude-api') parts.push('Switches billing to API key');
    else if (billing === 'claude') parts.push('Switches billing to subscription');
  }
  if (toText(args.model)) parts.push(`Model: ${excerpt(args.model)}`);
  if (toText(args.cwd)) parts.push(`Folder: ${excerpt(args.cwd)}`);
  if (action === 'create_session') {
    const groupName = toText(group?.name) || toText(args.group);
    if (groupName) parts.push(`Group: ${excerpt(groupName)}${toText(group?.id) ? ` (${excerpt(group.id)})` : ''}`);
  }
  return parts.join(' · ');
}

/** What an update_session sets, for the card: `Model: … · Effort: … · Group: none`. */
function describeSettingsChange(args) {
  const parts = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(args || {}, key);
  if (toText(args.model)) parts.push(`Model: ${excerpt(args.model)}`);
  if (toText(args.effort)) parts.push(`Effort: ${excerpt(args.effort)}`);
  if (toText(args.mode)) parts.push(`Mode: ${excerpt(args.mode)}`);
  if (has('auto_compact_window')) parts.push(`Auto-compact window: ${excerpt(args.auto_compact_window)}`);
  if (toText(args.title)) parts.push(`Title: “${excerpt(args.title)}”`);
  if (has('group')) parts.push(`Group: ${args.group === null ? 'none' : excerpt(args.group)}`);
  if (typeof args.thinking_enabled === 'boolean') parts.push(`Thinking: ${args.thinking_enabled ? 'on' : 'off'}`);
  if (toText(args.thinking_display)) parts.push(`Thinking text: ${toText(args.thinking_display) === 'omitted' ? 'hidden' : 'visible'}`);
  if (toText(args.cwd)) parts.push(`Folder: ${excerpt(args.cwd)} (its CLI restarts there)`);
  if (typeof args.planOnly === 'boolean') parts.push(`planOnly: ${args.planOnly}`);
  return parts.join(' · ');
}

/**
 * What a session an agent starts on this relay works on, for the card: the
 * repository (and branch) of a Claude Cloud session, else the folder, else
 * the relay's default folder.
 */
function describeLocalSessionTarget(args) {
  const repo = toText(args.repo).replace(/^https?:\/\/(?:www\.)?github\.com\//i, '');
  if (repo) return toText(args.branch) ? `${excerpt(repo)}, branch ${excerpt(args.branch)}` : excerpt(repo);
  return toText(args.cwd) ? excerpt(args.cwd) : 'the default folder';
}

/**
 * The card text: what the agent wants to do where, how the remote turn would
 * run, then the prompt (or the answer) it wants to send, so the user decides
 * on the actual words. `caller` is the calling session's context.
 *
 * `localSessions` is the once-per-conversation card of the local target: the
 * agent wants to start sessions on this relay itself. Allowing it covers the
 * later ones of that conversation, so the card says what they cost.
 */
/**
 * The card for relay event subscriptions (`watch`): the first subscribe of a
 * conversation (`kind: 'subscribe'`, with the sessions or "all"), or a
 * transfer of another conversation's subscriptions (`kind: 'transfer'`).
 * "All sessions" is always spelled out.
 */
function formatWatchApprovalPrompt(watch) {
  // A paired relay's sessions: named with it, so the user knows where.
  const relayName = toText(watch.relayName);
  const where = relayName ? `relay "${excerpt(relayName)}"` : 'this relay';
  if (watch.kind === 'transfer') {
    const from = watch.from || {};
    const title = toText(from.title) ? `“${excerpt(from.title)}” ` : '';
    const lines = [`This agent wants to take over ${watch.count} event subscription${watch.count === 1 ? '' : 's'} from session ${title}(${shortId(from.id)}) → this session. The old session stops getting their events.`];
    const relays = (Array.isArray(watch.relays) ? watch.relays : []).map((name) => `"${excerpt(name)}"`);
    if (relays.length) lines.push(`Among them: subscriptions on relay${relays.length === 1 ? '' : 's'} ${relays.join(', ')}.`);
    if (watch.all) lines.push(`Among them: ALL sessions of ${relayName ? where : 'a relay'}, including ones created later.`);
    return lines.join('\n\n');
  }
  const lines = [];
  if (watch.all) {
    const excluded = Number(watch.excludeCount) || 0;
    lines.push(`This agent wants to watch ALL sessions of ${where}, including ones created later${excluded ? ` (except ${excluded} it leaves out)` : ''}, and be woken by their events.`);
  } else {
    const sessions = (Array.isArray(watch.sessions) ? watch.sessions : []).slice(0, 10)
      .map((session) => (toText(session?.title) ? `“${excerpt(session.title)}” (${shortId(session.id)})` : shortId(session?.id)));
    const more = (watch.sessions?.length || 0) - sessions.length;
    lines.push(`This agent wants to watch ${sessions.join(', ')}${more > 0 ? ` and ${more} more` : ''}${relayName ? ` on ${where}` : ''} and be woken by their events.`);
  }
  const events = (Array.isArray(watch.events) ? watch.events : []).join(', ');
  const quiet = watch.quietHours && typeof watch.quietHours === 'object' ? watch.quietHours : null;
  const extras = [
    watch.once ? 'once' : '',
    Number(watch.heartbeatMinutes) > 0 ? `heartbeat every ${watch.heartbeatMinutes} min` : '',
    Number(watch.digestMinutes) > 0 ? `digest every ${watch.digestMinutes} min` : '',
    quiet ? `quiet ${excerpt(`${toText(quiet.from)}–${toText(quiet.to)} ${toText(quiet.tz)}`)}` : '',
  ].filter(Boolean);
  if (events) lines.push(`Events: ${events}${extras.length ? ` · ${extras.join(' · ')}` : ''}`);
  return lines.join('\n\n');
}

export function formatRemoteRelayApprovalPrompt({ relay, action, args = {}, caller = null, agentPrompts = 0, localSessions = false, watch = null, group = null, sessionSettings = null } = {}) {
  if (watch && typeof watch === 'object') return formatWatchApprovalPrompt(watch);
  const local = relay?.local === true;
  const name = toText(relay?.name) || 'a remote relay';
  const where = local ? 'this relay' : `relay "${name}"`;
  const verb = APPROVAL_VERBS[action] || toText(action).replace(/_/g, ' ') || 'act';
  const target = args.session ? ` (session ${shortId(args.session)})` : '';
  // The once-per-conversation card for changing sessions the calling conversation did not start.
  if (sessionSettings && typeof sessionSettings === 'object') {
    const title = toText(sessionSettings.title) ? `“${excerpt(sessionSettings.title)}” ` : '';
    const lines = [
      `This agent wants to change the settings of sessions on ${where} that its conversation did not start (yours or other agents'), first ${title}(${shortId(sessionSettings.session || args.session)}).`,
    ];
    const details = describeSettingsChange(args);
    if (details) lines.push(details);
    return lines.join('\n\n');
  }
  const lines = [];
  // The loop guard's card: agents that prompt each other without the user.
  if (agentPrompts > 0) {
    lines.push(`The agent has sent ${agentPrompts} prompts to ${local ? 'other agents' : 'agents on other relays'} since your last message. Let it go on?`);
  }
  if (localSessions) {
    const requested = toText(args.provider).toLowerCase();
    const callerProvider = toText(caller?.provider).toLowerCase();
    const provider = requested || (REMOTE_RELAY_PROVIDERS.includes(callerProvider) ? callerProvider : 'github');
    lines.push(`This agent wants to start sessions on this relay (${provider}, ${describeLocalSessionTarget(args)}). Sessions it starts use this relay's accounts.`);
  } else {
    lines.push(`Allow the agent to ${verb} on ${where}${target}?`);
  }
  if (action === 'send' || action === 'create_session') {
    const details = describeRemoteTurn(action, args, caller, group);
    if (details) lines.push(details);
    const text = excerpt(args.text);
    if (text) lines.push(`“${text}”`);
  } else if (action === 'answer_question') {
    const answer = excerpt([...(Array.isArray(args.choices) ? args.choices : []), args.answer].filter(Boolean).join(', '));
    if (answer) lines.push(`Answer: “${answer}”`);
  } else if (action === 'update_session') {
    const details = describeSettingsChange(args);
    if (details) lines.push(details);
  } else if (action === 'schedule') {
    // A schedule for another session: when it fires, and the words it sends.
    const every = Number(args.every_minutes);
    const when = [
      toText(args.title) ? `“${excerpt(args.title)}”` : '',
      toText(args.at) ? `At: ${excerpt(args.at)}` : '',
      every > 0 ? `Every ${every} min${args.once === true ? ', once' : ''}` : '',
    ].filter(Boolean).join(' · ');
    if (when) lines.push(when);
    const text = excerpt(args.text);
    if (text) lines.push(`“${text}”`);
  } else if (action === 'ask') {
    // An ask on behalf of another session: its card shows there, and the
    // answer wakes that session.
    const question = excerpt(args.question);
    if (question) lines.push(`“${question}”`);
    const options = (Array.isArray(args.options) ? args.options : []).map(excerpt).filter(Boolean);
    if (options.length) lines.push(`Options: ${options.join(' · ')}`);
  }
  return lines.join('\n\n');
}

// A name inside a summary line: short, so the line keeps its point.
const SUMMARY_NAME_MAX = 60;

function summaryName(value) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text.length > SUMMARY_NAME_MAX ? `${text.slice(0, SUMMARY_NAME_MAX - 1)}…` : text;
}

/**
 * What an approval card is about, for another relay's Inbox and push:
 * `{ variant, summary }`. The summary names the kind, the
 * requesting session and the reason (titles, a model, counts), never the
 * prompt, the answer or the question the agent would send: those stay on
 * this relay, in the card itself. Same inputs as the card text.
 */
export function formatApprovalSummary({ relay, action, args = {}, caller = null, agentPrompts = 0, localSessions = false, watch = null, sessionSettings = null } = {}) {
  const requester = `'${summaryName(caller?.title) || shortId(caller?.conversationId)}'`;
  const by = `requested by ${requester}`;
  const local = relay?.local === true;
  const where = local ? 'this relay' : `relay "${summaryName(relay?.name) || 'a remote relay'}"`;
  let variant;
  let summary;
  if (watch && typeof watch === 'object') {
    variant = 'watch';
    if (watch.kind === 'transfer') {
      const count = Number(watch.count) || 0;
      summary = `Take over ${count} event subscription${count === 1 ? '' : 's'} ${by}`;
    } else {
      const count = Array.isArray(watch.sessions) ? watch.sessions.length : 0;
      summary = `Watch ${watch.all ? 'ALL sessions' : `${count} session${count === 1 ? '' : 's'}`} ${by}`;
    }
  } else if (sessionSettings && typeof sessionSettings === 'object') {
    variant = 'session_settings';
    summary = `Change settings of '${summaryName(sessionSettings.title) || shortId(sessionSettings.session || args.session)}' ${by}`;
  } else if (agentPrompts > 0) {
    variant = 'loop_guard';
    summary = `Loop guard: ${agentPrompts} prompts by ${requester}`;
  } else if (localSessions) {
    variant = 'local_sessions';
    summary = `Start sessions on this relay ${by}`;
  } else if (action === 'create_session') {
    variant = 'create_session';
    const details = [summaryName(args.title), summaryName(args.model)].filter(Boolean).join(', ');
    summary = `New session ${by}${details ? `: ${details}` : ''}`;
  } else {
    variant = 'write';
    const verb = APPROVAL_VERBS[action] || toText(action).replace(/_/g, ' ') || 'act';
    summary = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} on ${where} ${by}`;
  }
  return { variant, summary: summary.slice(0, REMOTE_RELAY_APPROVAL_SUMMARY_MAX) };
}

export function createRemoteRelayCallerContext({
  db,
  repository,
  questions = null,
  resolveLiveTurnQueueRow = null,
  formatQuestionRow = defaultFormatQuestionRow,
  normalizeRelayMode = defaultNormalizeRelayMode,
  defaultRelayMode = 'agent',
  emit = () => {},
  notifyQuestion = () => {},
  uuid = nodeRandomUUID,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  questionPollMs = 1000,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
} = {}) {
  const questionStatements = questions || createQuestionRepository(db);
  // Plan-only (migration 0035): NULL on a schema without it.
  const conversationsHavePlanOnly = db.prepare(`PRAGMA table_info(conversations)`).all()
    .some((column) => column.name === 'plan_only');
  const getConversation = db.prepare(`
    SELECT id, title, preferred_relay_mode, preferred_model, preferred_reasoning_effort,
      ${conversationsHavePlanOnly ? 'plan_only' : 'NULL AS plan_only'} FROM conversations WHERE id = ?
  `);
  const getRuntimeSession = db.prepare(`SELECT provider_type, provider_model, model FROM runtime_sessions WHERE conversation_id = ?`);
  const listProcessingRows = db.prepare(`
    SELECT id, kind, relay_mode, model, reasoning_effort, attempt_id, owner_sdk_session_id, timestamp, processing_at
    FROM queue
    WHERE conversation_id = ? AND status = 'processing'
    ORDER BY COALESCE(processing_at, timestamp) ASC
  `);
  const getQueueRow = db.prepare(`SELECT * FROM queue WHERE id = ?`);
  const getLatestUserMessage = db.prepare(`
    SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY timestamp DESC LIMIT 1
  `);
  const getLatestUserMessageAtOrBefore = db.prepare(`
    SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1
  `);

  function normalizeMode(mode) {
    return normalizeRelayMode(mode) || defaultRelayMode;
  }

  /** The live turn: the runtime's own picker when given, else the same rule. */
  function liveTurnRow(conversationId, rows) {
    if (!rows.length) return null;
    if (typeof resolveLiveTurnQueueRow === 'function') {
      const live = resolveLiveTurnQueueRow(conversationId);
      const match = live && rows.find((row) => row.id === live.id);
      if (match) return match;
    }
    if (rows.length === 1) return rows[0];
    const liveId = pickLiveTurnRowId(rows.map((row) => {
      const output = questionStatements.getLastOutputAtByQueueMessage?.get({ id: row.id }) || null;
      return {
        id: String(row.id),
        lastOutputAtMs: Date.parse(String(output?.last_output_at || '')) || 0,
        streamDone: Number(output?.stream_done || 0) === 1,
        processingAtMs: Date.parse(String(row.processing_at || row.timestamp || '')) || 0,
      };
    }));
    return rows.find((row) => row.id === liveId) || rows[0];
  }

  function messageOrigin(messageId) {
    return (messageId ? repository?.getMessageOrigin?.(messageId) : null) || null;
  }

  function originHops(origin) {
    const hops = Number(origin?.hops);
    return Number.isInteger(hops) && hops >= 0 ? hops : 0;
  }

  /**
   * Where a turn's prompt came from (null for a human's): the origin of its
   * own user message, or for a continuation row (no message of its own) that
   * of the latest user message before it, the turn whose background work it
   * continues.
   */
  function rowOrigin(conversationId, row) {
    if (toText(row.kind).toLowerCase() !== 'continuation') return messageOrigin(row.id);
    const at = toText(row.timestamp) || toText(row.processing_at);
    const message = at
      ? getLatestUserMessageAtOrBefore.get(conversationId, at)
      : getLatestUserMessage.get(conversationId);
    return messageOrigin(message?.id);
  }

  /**
   * `{ conversationId, title, provider, model, effort, mode, planOnly,
   * processingRowId, attemptId, userMessageId, hops, originRelayIds }` for the
   * conversation making the call. A plan-only conversation's `mode` is its
   * saved one, not its live turn's.
   * `effort` is the reasoning effort of the live turn, else the one the
   * conversation prefers ('' when neither is known).
   * `hops` is how many relays the current turn's prompt already crossed: 0
   * for a human's message. A steered message folded into the live turn is
   * part of what the agent is acting on, so the highest count among the
   * conversation's processing rows wins (a background continuation counts as
   * the turn it continues); without a turn (an off-turn call) the latest user
   * message decides.
   * `originRelayIds` are the relays (their instance ids) those prompts came
   * from: empty when the agent acts on the user's words alone. `origin` is
   * the one among them with the most hops (null for the user's words).
   */
  function getCallerContext(conversationId) {
    const id = toText(conversationId);
    const conversation = getConversation.get(id) || null;
    const runtime = getRuntimeSession.get(id) || null;
    const rows = listProcessingRows.all(id);
    const live = liveTurnRow(id, rows);
    const origins = (rows.length
      ? rows.map((row) => rowOrigin(id, row))
      : [messageOrigin(getLatestUserMessage.get(id)?.id)]).filter(Boolean);
    const hops = Math.max(0, ...origins.map(originHops));
    const originRelayIds = [...new Set(origins.map((origin) => toText(origin.relayId)))];
    // The prompt with the most hops: what a schedule of this turn's passes on.
    const origin = origins.reduce((best, entry) => (!best || originHops(entry) > originHops(best) ? entry : best), null);
    const planOnly = Number(conversation?.plan_only) === 1;
    return {
      conversationId: id,
      title: toText(conversation?.title),
      provider: toText(runtime?.provider_type).toLowerCase() || 'github',
      model: toText(live?.model) || toText(runtime?.provider_model) || toText(runtime?.model) || toText(conversation?.preferred_model) || '',
      effort: (toText(live?.reasoning_effort) || toText(conversation?.preferred_reasoning_effort)).toLowerCase(),
      // A plan-only conversation's mode is its saved one (plan): the one write
      // turn of "Approve plan" runs in agent mode, and what it starts or sends
      // must not pass for an agent-mode caller's (an agent session by default,
      // no approval card).
      mode: normalizeMode(planOnly
        ? (conversation?.preferred_relay_mode || live?.relay_mode)
        : (live?.relay_mode || conversation?.preferred_relay_mode)),
      planOnly,
      processingRowId: live?.id || null,
      attemptId: toText(live?.attempt_id) || null,
      userMessageId: live?.id || null,
      hops,
      originRelayIds,
      origin,
    };
  }

  function formatQuestion(questionId) {
    return formatQuestionRow(questionStatements.getQuestion.get(questionId));
  }

  function withdraw(questionId) {
    try {
      questionStatements.timeoutQuestion.run(questionId);
      emit('relay_question_updated', { question: formatQuestion(questionId) });
    } catch {}
  }

  /**
   * Puts an Allow / Deny card on the calling turn and waits for the user.
   * Resolves `{ approved:true }`, or `{ approved:false, code?, error? }`:
   * denied, timed out, cancelled with the turn, or no turn to ask on (fails
   * closed with REMOTE_RELAY_NO_ACTIVE_TURN). Waits as long as the question
   * lives (8 h by default); `signal` withdraws the card early.
   * `agentPrompts` (the loop guard) is how many prompts the agent has sent to
   * other relays' agents since the user last wrote; the card then asks for
   * that, in any relay mode.
   * `localSessions` makes it the card for starting sessions on this relay
   * itself, asked once per conversation (the dispatcher remembers the Allow).
   * `group` (`{ id, name }`) is the session group a create_session names, as
   * the target resolved it; the card says where the session goes.
   * `sessionSettings` (`{ session, title, changed }`) makes it the card for an
   * update_session on a session the calling conversation did not start, asked once per
   * conversation and relay (the dispatcher remembers the Allow).
   */
  async function requestApproval({ conversationId, callerContext, relay, action, args = {}, signal, agentPrompts = 0, localSessions = false, watch = null, group = null, sessionSettings = null } = {}) {
    const rowId = toText(callerContext?.processingRowId);
    const row = rowId ? getQueueRow.get(rowId) : null;
    if (!row || row.status !== 'processing') {
      let error = 'This write action needs the user\'s approval, but the conversation has no running turn to ask on.';
      if (watch) error = 'Watching sessions needs the user\'s approval, but the conversation has no running turn to ask on.';
      else if (localSessions) error = 'Starting sessions on this relay needs the user\'s approval once per conversation, but the conversation has no running turn to ask on.';
      else if (sessionSettings) error = 'Changing a session this conversation did not start needs the owner\'s approval once per conversation, but the conversation has no running turn to ask on.';
      return { approved: false, code: REMOTE_RELAY_ERROR_CODES.noTurn, error };
    }

    const createdAt = now().toISOString();
    const questionId = String(uuid());
    const relayMode = normalizeMode(row.relay_mode);
    const prompt = formatRemoteRelayApprovalPrompt({ relay, action, args, caller: callerContext, agentPrompts, localSessions, watch, group, sessionSettings });
    const local = relay?.local === true;
    let rationale = `Write actions on ${local ? 'other sessions of this relay' : 'other relays'} need approval in ${relayMode} mode.`;
    if (agentPrompts > 0) {
      rationale = local
        ? 'Agents that keep prompting each other need your go from time to time.'
        : 'Agents on different relays that keep prompting each other need your go from time to time.';
    } else if (localSessions) {
      rationale = 'Allow covers every session this conversation\'s agent starts on this relay; Deny refuses this one.';
    } else if (sessionSettings) {
      rationale = `Allow covers this conversation's later changes to sessions on ${local ? 'this relay' : `relay "${excerpt(relay?.name)}"`} that it did not start; Deny refuses this one. Sessions this conversation started need no approval.`;
    } else if (watch?.kind === 'transfer') {
      rationale = 'The subscriptions keep their settings; event messages are the relay\'s, never yours, and approve nothing.';
    } else if (watch) {
      const there = toText(watch.relayName) ? ` on relay "${excerpt(watch.relayName)}"` : '';
      rationale = watch.all
        ? `Allow covers this conversation's later subscriptions${there} too. Event messages are the relay's, never yours, and approve nothing.`
        : `Allow covers this conversation's later subscriptions${there}, except one to all sessions, which is asked again. Event messages are the relay's, never yours, and approve nothing.`;
    }
    // The same source for every card of this tool: it is what keeps agents
    // (other relays' and this relay's own) from seeing or answering one.
    const context = sanitizeRelayQuestionContext({
      source: REMOTE_RELAY_APPROVAL_SOURCE,
      rationale,
      queueMessageId: row.id,
      conversationId: toText(conversationId) || row.conversation_id,
      relayMode,
      header: watch ? WATCH_HEADER : (localSessions || (sessionSettings && local) ? LOCAL_SESSIONS_HEADER : APPROVAL_HEADER),
      // What a paired relay's Inbox and push show of this card.
      ...formatApprovalSummary({ relay, action, args, caller: callerContext, agentPrompts, localSessions, watch, sessionSettings }),
    }, { normalizeRelayMode: normalizeMode, defaultRelayMode });
    questionStatements.insertQuestion.run(
      questionId,
      row.id,
      toText(conversationId) || row.conversation_id,
      row.id,
      relayMode,
      prompt,
      JSON.stringify([APPROVAL_ALLOW, APPROVAL_DENY]),
      JSON.stringify({ request: null, context, allowFreeform: false }),
      null,
      toText(row.owner_sdk_session_id) || null,
      null,
      null,
      null,
      createdAt,
      questionExpiresAt(createdAt, questionTimeoutMs),
      toText(row.attempt_id) || null,
    );
    const question = formatQuestion(questionId);
    try {
      logger?.log?.(`${LOG_PREFIX} approval ${shortId(questionId)} conv=${shortId(row.conversation_id)} ${action} ${toText(relay?.name) || '-'}`);
    } catch {}
    try { emit('relay_question', { question }); } catch {}
    try { void notifyQuestion(question); } catch {}

    for (;;) {
      const current = questionStatements.getQuestion.get(questionId);
      if (!current) return { approved: false, error: 'The approval question was removed.' };
      if (current.status === 'answered') {
        const decision = readApprovalAnswer(current.answer, { approve: APPROVAL_ALLOW, deny: APPROVAL_DENY });
        if (decision === 'approve') return { approved: true };
        if (decision === 'deny') return { approved: false };
        // The answer route takes only the choices; anything else in the row
        // is no decision of the user's, so it is not passed off as their Deny.
        return { approved: false, error: 'The approval question was answered with neither Allow nor Deny. Go on without it, or ask the user first.' };
      }
      if (current.status !== 'pending') {
        return {
          approved: false,
          error: current.status === 'timed_out'
            ? 'The approval question timed out without an answer.'
            : 'The approval question was cancelled (the turn ended).',
        };
      }
      if (signal?.aborted) {
        withdraw(questionId);
        return { approved: false, error: 'The tool call was abandoned before the user answered.' };
      }
      await sleep(questionPollMs);
    }
  }

  return { getCallerContext, requestApproval };
}
