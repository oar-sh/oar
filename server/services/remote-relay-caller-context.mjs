'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import {
  REMOTE_RELAY_APPROVAL_SOURCE,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_PROVIDERS,
} from '../../shared/remote-relay-contract.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS, questionExpiresAt } from '../../shared/question-timeout.mjs';
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
  answer_question: 'answer a question',
  stop: 'stop the running turn',
  archive: 'archive a session',
});

/**
 * How the remote turn would run, as far as this relay knows it: the mode (the
 * requested one, else the calling session's, which the dispatcher passes on),
 * the provider a new session gets (requested, else the caller's), and the
 * model and working directory when the agent asked for them.
 */
function describeRemoteTurn(action, args, caller) {
  const parts = [];
  const mode = toText(args.mode).toLowerCase() || toText(caller?.mode).toLowerCase();
  if (mode) parts.push(`Mode: ${mode}`);
  if (action === 'create_session') {
    const requested = toText(args.provider).toLowerCase();
    const callerProvider = toText(caller?.provider).toLowerCase();
    const provider = requested || (REMOTE_RELAY_PROVIDERS.includes(callerProvider) ? callerProvider : 'github');
    parts.push(`Provider: ${provider}`);
  }
  if (toText(args.model)) parts.push(`Model: ${excerpt(args.model)}`);
  if (toText(args.cwd)) parts.push(`Folder: ${excerpt(args.cwd)}`);
  return parts.join(' · ');
}

/**
 * The card text: what the agent wants to do where, how the remote turn would
 * run, then the prompt (or the answer) it wants to send, so the user decides
 * on the actual words. `caller` is the calling session's context.
 */
export function formatRemoteRelayApprovalPrompt({ relay, action, args = {}, caller = null } = {}) {
  const name = toText(relay?.name) || 'a remote relay';
  const verb = APPROVAL_VERBS[action] || toText(action).replace(/_/g, ' ') || 'act';
  const target = args.session ? ` (session ${shortId(args.session)})` : '';
  const lines = [`Allow the agent to ${verb} on relay "${name}"${target}?`];
  if (action === 'send' || action === 'create_session') {
    const details = describeRemoteTurn(action, args, caller);
    if (details) lines.push(details);
    const text = excerpt(args.text);
    if (text) lines.push(`“${text}”`);
  } else if (action === 'answer_question') {
    const answer = excerpt([...(Array.isArray(args.choices) ? args.choices : []), args.answer].filter(Boolean).join(', '));
    if (answer) lines.push(`Answer: “${answer}”`);
  }
  return lines.join('\n\n');
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
  const getConversation = db.prepare(`SELECT id, title, preferred_relay_mode, preferred_model FROM conversations WHERE id = ?`);
  const getRuntimeSession = db.prepare(`SELECT provider_type, provider_model, model FROM runtime_sessions WHERE conversation_id = ?`);
  const listProcessingRows = db.prepare(`
    SELECT id, kind, relay_mode, model, attempt_id, owner_sdk_session_id, timestamp, processing_at
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

  function originHops(messageId) {
    const origin = messageId ? repository?.getMessageOrigin?.(messageId) : null;
    const hops = Number(origin?.hops);
    return Number.isInteger(hops) && hops >= 0 ? hops : 0;
  }

  /**
   * A turn's hops: those of its own user message, or for a continuation row
   * (no message of its own) those of the latest user message before it, the
   * turn whose background work it continues.
   */
  function rowHops(conversationId, row) {
    if (toText(row.kind).toLowerCase() !== 'continuation') return originHops(row.id);
    const at = toText(row.timestamp) || toText(row.processing_at);
    const message = at
      ? getLatestUserMessageAtOrBefore.get(conversationId, at)
      : getLatestUserMessage.get(conversationId);
    return originHops(message?.id);
  }

  /**
   * `{ conversationId, title, provider, model, mode, processingRowId,
   * attemptId, userMessageId, hops }` for the conversation making the call.
   * `hops` is how many relays the current turn's prompt already crossed: 0
   * for a human's message. A steered message folded into the live turn is
   * part of what the agent is acting on, so the highest count among the
   * conversation's processing rows wins (a background continuation counts as
   * the turn it continues); without a turn (an off-turn call) the latest user
   * message decides.
   */
  function getCallerContext(conversationId) {
    const id = toText(conversationId);
    const conversation = getConversation.get(id) || null;
    const runtime = getRuntimeSession.get(id) || null;
    const rows = listProcessingRows.all(id);
    const live = liveTurnRow(id, rows);
    const hops = rows.length
      ? Math.max(...rows.map((row) => rowHops(id, row)))
      : originHops(getLatestUserMessage.get(id)?.id);
    return {
      conversationId: id,
      title: toText(conversation?.title),
      provider: toText(runtime?.provider_type).toLowerCase() || 'github',
      model: toText(live?.model) || toText(runtime?.provider_model) || toText(runtime?.model) || toText(conversation?.preferred_model) || '',
      mode: normalizeMode(live?.relay_mode || conversation?.preferred_relay_mode),
      processingRowId: live?.id || null,
      attemptId: toText(live?.attempt_id) || null,
      userMessageId: live?.id || null,
      hops,
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
   */
  async function requestApproval({ conversationId, callerContext, relay, action, args = {}, signal } = {}) {
    const rowId = toText(callerContext?.processingRowId);
    const row = rowId ? getQueueRow.get(rowId) : null;
    if (!row || row.status !== 'processing') {
      return {
        approved: false,
        code: REMOTE_RELAY_ERROR_CODES.noTurn,
        error: 'This write action needs the user\'s approval, but the conversation has no running turn to ask on.',
      };
    }

    const createdAt = now().toISOString();
    const questionId = String(uuid());
    const relayMode = normalizeMode(row.relay_mode);
    const prompt = formatRemoteRelayApprovalPrompt({ relay, action, args, caller: callerContext });
    const context = sanitizeRelayQuestionContext({
      source: REMOTE_RELAY_APPROVAL_SOURCE,
      rationale: `Write actions on other relays need approval in ${relayMode} mode.`,
      queueMessageId: row.id,
      conversationId: toText(conversationId) || row.conversation_id,
      relayMode,
      header: APPROVAL_HEADER,
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
        const approved = toText(current.answer).toLowerCase() === APPROVAL_ALLOW.toLowerCase();
        return approved ? { approved: true } : { approved: false };
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
