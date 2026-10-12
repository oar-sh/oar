// Agent-to-agent exchanges in the transcript: a prompt another agent sent this
// session (another relay's agent, or an agent on this relay) and this
// session's reply to it fold into ONE row, "note from win-test · report
// builder · replied", which opens to both as they render otherwise.
//
// DOM-free on purpose, like relay-event-view.mjs: conversation-view.js reads
// the rows off the transcript, plans with this module and applies the plan.
// Presentation only: the transcript data is never touched.
//
// Nothing addressed to the user is folded away. A turn folds only when the
// agent's prompt started it alone:
// - a message steered into the turn (handed off: the reply settled
//   'absorbed'; folded in or stopped with it: the steer's own marker) keeps
//   it unfolded, and so does an agent's prompt that was itself steered into a
//   turn;
// - so does a question or approval card of the turn that is still open;
// - and, while the turn runs, a message of the user's with no answer yet: it
//   may be steered into the turn.
// The last two pass, so a turn shown for them is reported `transient`: the
// caller keeps it shown while the page lives instead of folding it away under
// the user once the card is answered.

import { isRelayEventMessage } from './relay-event-view.mjs';
import { relayErrorCodeFromText } from './relay-error-ctas.mjs';
import { isLocalAgentOrigin, localAgentOriginModel, normalizeRemoteOrigin } from './remote-relay-origin-view.mjs';

export const AGENT_EXCHANGE_HEAD_CLASS = 'agent-exchange-head';
export const AGENT_EXCHANGE_MEMBER_CLASS = 'agent-exchange-member';
export const AGENT_EXCHANGE_CLOSED_CLASS = 'agent-exchange-closed';

export const AGENT_EXCHANGE_STATUS_TEXT = Object.freeze({
  working: 'working…',
  replied: 'replied',
  failed: 'failed',
  stopped: 'stopped',
  none: 'no reply yet',
});

// The code a turn the user stopped ends with (shared/relay-stop-failure.mjs).
const STOPPED_ERROR_CODE = 'turn-aborted';
// A steer's settle markers (steered-turn-merge.mjs): the message was consumed
// by another turn, folded into it or stopped with it.
const STEER_MARKER_KINDS = new Set(['folded', 'stopped']);
const ABSORBED_KIND = 'absorbed';
const ANSWERED_ELSEWHERE_KIND = 'answered-elsewhere';
const TRANSIENT_REASONS = new Set(['open-card', 'user-waiting']);

function defaultEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function idSet(values) {
  return new Set(Array.from(values || [], (value) => String(value ?? '').trim()).filter(Boolean));
}

/** True for an `origin` that names an agent: one on this relay or another relay's. */
export function isAgentOrigin(origin) {
  return isLocalAgentOrigin(origin) || !!normalizeRemoteOrigin(origin);
}

/** A prompt an agent sent: a user row with an agent's origin, never a relay event. */
export function isAgentPromptMessage(message) {
  return message?.role === 'user' && !isRelayEventMessage(message) && isAgentOrigin(message?.origin);
}

/**
 * How a reply ended, from its text: 'failed' or 'stopped' for a failure note
 * of the relay, '' for an answer. The note goes below what the turn had
 * written before it failed, so only the last paragraph is read.
 */
export function replyOutcome(text) {
  const paragraphs = String(text ?? '').trim().split(/\r?\n\s*\r?\n/);
  const code = relayErrorCodeFromText(paragraphs[paragraphs.length - 1]);
  if (!code) return '';
  return code === STOPPED_ERROR_CODE ? 'stopped' : 'failed';
}

/**
 * What the plan needs of one message, built when its row is: an agent
 * prompt's origin, an assistant row's kind, the prompt it answers and how it
 * ended. `parseTimestamp` reads the message's timestamp (the caller's
 * tolerant parser; Date.parse by default).
 */
export function agentExchangeRowOf(message, { id = message?.id, parseTimestamp = Date.parse } = {}) {
  const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'user' ? 'user' : '');
  const timestampMs = Number(parseTimestamp(message?.timestamp));
  return {
    id: String(id ?? '').trim(),
    role,
    relayEvent: isRelayEventMessage(message),
    origin: isAgentPromptMessage(message) ? message.origin : null,
    kind: String(message?.kind || '').trim(),
    sourceMessageId: role === 'assistant' ? String(message?.sourceMessageId || '').trim() : '',
    timestampMs: Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : 0,
    outcome: role === 'assistant' ? replyOutcome(message?.text) : '',
  };
}

function isUsersOwnMessage(row) {
  return row.role === 'user' && !row.origin && !row.relayEvent;
}

/**
 * The plan for a transcript: one entry per agent prompt, in transcript order.
 *
 * `rows` are the transcript's rows in order (agentExchangeRowOf, plus
 * `steered` for a user row steered-turn-merge.mjs classed as steered), and
 * the live bubble of a running turn as `{ id: <its message id>, role:
 * 'assistant', live: true }`. `runningIds` names turns that run without a
 * live bubble on the page, `openCardIds` the turns with an open question or
 * approval card, `keptShownIds` those the caller keeps shown.
 *
 * Each entry: `{ promptId, prompt, members, status, fold, reasons,
 * transient }`. `members` are the reply rows and the live bubble, the rows a
 * folded exchange hides; `fold` is false while any of `reasons` holds.
 */
export function planAgentExchangeFolds(rows, { runningIds = [], openCardIds = [], keptShownIds = [] } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && String(row.id || '').trim());
  const running = idSet(runningIds);
  const openCards = idSet(openCardIds);
  const keptShown = idSet(keptShownIds);

  // One turn per user-side row (the user's, an agent's, a relay event), with
  // its replies and its live bubble.
  const turns = [];
  const turnById = new Map();
  list.forEach((row, index) => {
    if (row.role !== 'user' || turnById.has(row.id)) return;
    const turn = { prompt: row, index, replies: [], live: null };
    turns.push(turn);
    turnById.set(row.id, turn);
  });
  for (const row of list) {
    if (row.role !== 'assistant') continue;
    const turn = turnById.get(row.live ? row.id : row.sourceMessageId);
    if (!turn) continue;
    if (row.live) turn.live = row;
    else turn.replies.push(row);
  }
  for (const turn of turns) {
    turn.running = !!turn.live || running.has(turn.prompt.id);
    turn.markers = turn.replies.filter((row) => STEER_MARKER_KINDS.has(row.kind));
    turn.answers = turn.replies.filter((row) => !STEER_MARKER_KINDS.has(row.kind) && row.kind !== ANSWERED_ELSEWHERE_KIND);
    // When the turn ended (its last answer was written); still open while it
    // runs; null for a turn that has not run (queued, cancelled).
    turn.end = turn.answers.length
      ? Math.max(0, ...turn.answers.map((row) => Number(row.timestampMs) || 0))
      : (turn.running ? Infinity : null);
  }

  // A steer folded into a turn (or stopped with it) settles as a marker under
  // its own message; the turn it joined is the one running when it was sent:
  // sent before it, ended after it, and of those the first to end (a
  // session runs one turn at a time).
  const steeredInto = new Set();
  for (const turn of turns) {
    const sentAt = Number(turn.prompt.timestampMs) || 0;
    if (!turn.markers.length || !sentAt) continue;
    let host = null;
    for (const other of turns) {
      const startedAt = Number(other.prompt.timestampMs) || 0;
      if (other === turn || other.end === null || !startedAt) continue;
      if (startedAt > sentAt || other.end < sentAt) continue;
      if (!host || other.end < host.end || (other.end === host.end && startedAt > host.prompt.timestampMs)) host = other;
    }
    if (host) steeredInto.add(host);
  }

  return turns.filter((turn) => !!turn.prompt.origin).map((turn) => {
    const reasons = [];
    if (turn.prompt.steered || turn.markers.length) reasons.push('steered');
    if (turn.replies.some((row) => row.kind === ABSORBED_KIND) || steeredInto.has(turn)) reasons.push('steered-in');
    // Its answer is on a background-continuation row further down: there is
    // no reply here to fold with it.
    if (turn.replies.some((row) => row.kind === ANSWERED_ELSEWHERE_KIND)) reasons.push('answered-elsewhere');
    if (openCards.has(turn.prompt.id)) reasons.push('open-card');
    if (turn.running && !turn.answers.length && turns.some((other) => other.index > turn.index
      && isUsersOwnMessage(other.prompt)
      && !other.replies.length
      && !other.running)) {
      reasons.push('user-waiting');
    }
    if (keptShown.has(turn.prompt.id)) reasons.push('kept-shown');
    const last = turn.answers[turn.answers.length - 1] || null;
    const status = last ? (last.outcome || 'replied') : (turn.running ? 'working' : 'none');
    return {
      promptId: turn.prompt.id,
      prompt: turn.prompt,
      members: turn.live ? [...turn.replies, turn.live] : turn.replies.slice(),
      status,
      fold: reasons.length === 0,
      reasons,
      transient: reasons.some((reason) => TRANSIENT_REASONS.has(reason)),
    };
  });
}

/**
 * Whether a folded exchange shows open. `choice` is the user's own toggle of
 * it (true opened, false closed, undefined none) and always wins; without
 * one it is open while the turn works and closes by itself once it is
 * replied, failed or stopped.
 */
export function agentExchangeFoldOpen(status, choice) {
  if (typeof choice === 'boolean') return choice;
  return status === 'working';
}

/**
 * The folded row's words: who sent the prompt (the relay's name; for an agent
 * on this relay the name the origin carries, else "this relay"), from which
 * session (for a local one its current title when `conversations` knows it),
 * and how the turn stands.
 */
export function agentExchangeSummary(origin, status, { conversations = null } = {}) {
  const local = localAgentOriginModel(origin, { conversations, linkable: false });
  const remote = local ? null : normalizeRemoteOrigin(origin);
  const from = local ? (oneLine(origin?.relayName) || 'this relay') : (remote?.relayName || 'another relay');
  const title = local ? local.fullTitle : (remote?.conversationTitle || '');
  const known = Object.prototype.hasOwnProperty.call(AGENT_EXCHANGE_STATUS_TEXT, status) ? status : 'none';
  const head = [`note from ${from}`, title].filter(Boolean).join(' · ');
  const statusText = AGENT_EXCHANGE_STATUS_TEXT[known];
  return { from, title, status: known, statusText, head, text: `${head} · ${statusText}` };
}

/**
 * The folded row's markup: a <details> whose summary is the whole row. Its
 * body stays empty — the prompt and the reply are the transcript rows below
 * it, shown while it is open.
 */
export function renderAgentExchangeRowHtml(summary, { escHtml = defaultEscape, timeText = '', open = false } = {}) {
  return `<details class="agent-exchange-row agent-exchange-${escHtml(summary?.status || 'none')}"${open ? ' open' : ''}>`
    + `<summary class="agent-exchange-summary" title="${escHtml(summary?.text)}">`
    + `<span class="agent-exchange-text">${escHtml(summary?.head)}</span>`
    + `<span class="agent-exchange-status">${escHtml(summary?.statusText)}</span>`
    + (timeText ? `<span class="agent-exchange-time">${escHtml(timeText)}</span>` : '')
    + '</summary>'
    + '</details>';
}
