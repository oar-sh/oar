// Agent-to-agent exchanges in the transcript: a prompt another agent sent this
// session (another relay's agent, or an agent on this relay) folds into ONE
// row, "note from win-test · report builder · answered below", which opens to
// the prompt as it renders otherwise.
//
// DOM-free on purpose, like relay-event-view.mjs: conversation-view.js reads
// the rows off the transcript, plans with this module and applies the plan.
// Presentation only: the transcript data is never touched.
//
// Nothing addressed to the user is folded away. The fold covers the agent's
// prompt and nothing else: this session's reply to it can carry a line for
// the user, so the reply, the live bubble of the running turn and every card
// of the turn always show, as they do for a message of the user's own. The
// row still says how the turn stands.
//
// One prompt is left as it is: an agent's prompt that was steered into a
// running turn. It renders as part of that turn's flow (steered-turn-merge.mjs:
// the dashed bubble, the marker attached under it), and a row in its place
// would break that flow.

import { isRelayEventMessage } from './relay-event-view.mjs';
import { relayErrorCodeFromText } from './relay-error-ctas.mjs';
import { isLocalAgentOrigin, localAgentOriginModel, normalizeRemoteOrigin } from './remote-relay-origin-view.mjs';

export const AGENT_EXCHANGE_HEAD_CLASS = 'agent-exchange-head';
export const AGENT_EXCHANGE_CLOSED_CLASS = 'agent-exchange-closed';

export const AGENT_EXCHANGE_STATUS_TEXT = Object.freeze({
  working: 'working…',
  replied: 'answered below',
  failed: 'failed',
  stopped: 'stopped',
  none: 'no reply yet',
});

// The code a turn the user stopped ends with (shared/relay-stop-failure.mjs).
const STOPPED_ERROR_CODE = 'turn-aborted';
// A steer's settle markers (steered-turn-merge.mjs): the message was consumed
// by another turn, folded into it or stopped with it.
const STEER_MARKER_KINDS = new Set(['folded', 'stopped']);

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
 * ended.
 */
export function agentExchangeRowOf(message, { id = message?.id } = {}) {
  const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'user' ? 'user' : '');
  return {
    id: String(id ?? '').trim(),
    role,
    relayEvent: isRelayEventMessage(message),
    origin: isAgentPromptMessage(message) ? message.origin : null,
    kind: String(message?.kind || '').trim(),
    sourceMessageId: role === 'assistant' ? String(message?.sourceMessageId || '').trim() : '',
    outcome: role === 'assistant' ? replyOutcome(message?.text) : '',
  };
}

/**
 * The plan for a transcript: one entry per agent prompt, in transcript order.
 *
 * `rows` are the transcript's rows in order (agentExchangeRowOf, plus
 * `steered` for a user row steered-turn-merge.mjs classed as steered), and
 * the live bubble of a running turn as `{ id: <its message id>, role:
 * 'assistant', live: true }`. `runningIds` names turns that run without a
 * live bubble on the page.
 *
 * Each entry: `{ promptId, prompt, status, fold }`. The prompt's row is the
 * only one a fold covers; the replies and the live bubble are read for the
 * status alone. `fold` is false for a prompt steered into a running turn.
 */
export function planAgentExchangeFolds(rows, { runningIds = [] } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && String(row.id || '').trim());
  const running = new Set(Array.from(runningIds || [], (value) => String(value ?? '').trim()).filter(Boolean));

  const turns = [];
  const turnById = new Map();
  for (const row of list) {
    if (row.role !== 'user' || !row.origin || turnById.has(row.id)) continue;
    const turn = { prompt: row, replies: [], live: false };
    turns.push(turn);
    turnById.set(row.id, turn);
  }
  for (const row of list) {
    if (row.role !== 'assistant') continue;
    const turn = turnById.get(row.live ? row.id : row.sourceMessageId);
    if (!turn) continue;
    if (row.live) turn.live = true;
    else turn.replies.push(row);
  }

  return turns.map((turn) => {
    const markers = turn.replies.filter((row) => STEER_MARKER_KINDS.has(row.kind));
    // An answer, or the marker that the answer is on a continuation row
    // further down.
    const answers = turn.replies.filter((row) => !STEER_MARKER_KINDS.has(row.kind));
    const last = answers[answers.length - 1] || null;
    let status = 'none';
    if (last) status = last.outcome || 'replied';
    else if (turn.live || running.has(turn.prompt.id)) status = 'working';
    return {
      promptId: turn.prompt.id,
      prompt: turn.prompt,
      status,
      fold: !turn.prompt.steered && !markers.length,
    };
  });
}

/**
 * Whether a folded prompt shows open. `choice` is the user's own toggle of
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
 * body stays empty — the prompt's bubble is its sibling in the prompt's own
 * node, shown while it is open.
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
