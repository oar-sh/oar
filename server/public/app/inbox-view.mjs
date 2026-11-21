// The Inbox, as DOM: every pending question across this relay and its paired
// relays (GET /api/inbox), grouped by relay and by the sessions' groups,
// newest first; what was answered or dismissed in the last day under a
// divider. And the card a question that does not block (relay_tool `ask`)
// shows in its own session. Which items show, and where, is
// inbox-sections.mjs; the filters and folds kept are inbox-view-state.mjs.
//
// Every card folds to one line (its chevron, or ➖ for all of them), and
// every relay section and group sub-section folds to its heading and counts.
// Those controls carry `data-inbox-view`; answers carry `data-inbox-action`.
//
// Every text here is written by an agent, some on other relays: it goes into
// the page through textContent only, never as HTML or a link. Buttons carry
// what they act on in data attributes; inbox-ui.js handles the clicks.
//
// The browser cannot import shared/ (only server/public is served): the few
// values of shared/relay-asks.mjs this needs are kept here, and
// inbox-view.test.mjs asserts they match.

import { boardOutcomeLine } from './relay-board-inline.mjs';
import { ANSWER_THERE_QID_PATTERN, answerThereUrl } from './remote-relay-links.mjs';
import {
  inboxCountsText,
  inboxFilterActive,
  inboxGroupChoices,
  inboxGroupOf,
  inboxGroupSelection,
  inboxRelayKey,
  inboxSections,
} from './inbox-sections.mjs';
import { inboxItemKey, normalizeInboxView } from './inbox-view-state.mjs';

export { answerThereUrl };
export {
  INBOX_ANSWERED_KEEP_MS,
  INBOX_FILTERS,
  inboxFilterMatches,
  inboxSections,
} from './inbox-sections.mjs';

export const RELAY_ASK_SOCKET_EVENT = 'relay_ask_updated';
export const INBOX_REMOTE_CHANGED_EVENT = 'inbox_remote_changed';

// The head label of a paired relay's approval card by its `variant`
// (REMOTE_RELAY_APPROVAL_VARIANTS of shared/remote-relay-contract.mjs).
export const INBOX_APPROVAL_VARIANT_LABELS = Object.freeze({
  create_session: 'New session',
  loop_guard: 'Loop guard',
  write: 'Write',
  session_settings: 'Session settings',
  watch: 'Watch',
  local_sessions: 'Start sessions',
});

function toText(value) {
  return String(value ?? '').trim();
}

function el(doc, tag, className = '', text = null) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function button(doc, className, label, data = {}) {
  const node = el(doc, 'button', className, label);
  node.type = 'button';
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== '') node.dataset[key] = String(value);
  }
  return node;
}

/** "just now", "5 min", "3 h", "2 d" since `createdAt`. */
export function formatInboxAge(createdAt, now = Date.now()) {
  const at = Date.parse(toText(createdAt));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** A link that opens one session in a relay's web UI (remoteConversationUrl's copy). */
export function inboxSessionUrl(relayUrl, sessionId) {
  const base = toText(relayUrl).replace(/\/+$/, '');
  const id = toText(sessionId);
  if (!base || !/^https?:\/\//i.test(base)) return '';
  return id ? `${base}/?conv=${encodeURIComponent(id)}` : `${base}/`;
}

/**
 * A load that never runs twice at once, and never misses a change: a call
 * while one runs is answered by that one and asks for one more after it
 * (once, however many calls came meanwhile). Resolves with the last load's
 * result.
 */
export function createCoalescedRefresh(load) {
  let running = null;
  let again = false;
  function refresh() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      try {
        do {
          again = false;
          result = await load();
        } while (again);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }
  return refresh;
}

// The folds a card has: an ask's `Details` and a plan card's `The plan`.
export const INBOX_FOLD_SELECTOR = 'details.inbox-item-detail, details.inbox-plan-body';

/**
 * A fold's key: its card's relay and id, and which fold it is. Every render
 * builds the cards anew, closed; the keys of the open ones carry them over.
 */
export function inboxFoldKey(details) {
  const card = details?.closest?.('.inbox-item');
  const itemId = toText(card?.dataset?.itemId);
  if (!itemId) return '';
  const fold = details.classList?.contains('inbox-plan-body') ? 'plan' : 'detail';
  return `${toText(card.dataset.relayId) || 'self'}\n${itemId}\n${fold}`;
}

/** Notes whether `details` is open in `openFolds` (a Set of fold keys). */
export function noteInboxFold(openFolds, details) {
  const key = inboxFoldKey(details);
  if (!key) return;
  if (details.open) openFolds.add(key);
  else openFolds.delete(key);
}

/** Notes every fold under `root`, as it is now. */
export function captureInboxFolds(openFolds, root) {
  for (const details of root?.querySelectorAll?.(INBOX_FOLD_SELECTOR) || []) noteInboxFold(openFolds, details);
}

/** Opens the folds under `root` that were open before its re-render. */
export function restoreInboxFolds(openFolds, root) {
  for (const details of root?.querySelectorAll?.(INBOX_FOLD_SELECTOR) || []) {
    if (openFolds.has(inboxFoldKey(details))) details.open = true;
  }
}

/**
 * Forgets the folds of items no longer listed (an Inbox load, GET
 * /api/inbox). A relay that did not answer keeps its folds: its items did
 * not leave, they are just not shown.
 */
export function pruneInboxFolds(openFolds, relays, { now = Date.now() } = {}) {
  const listed = new Set();
  const kept = new Set();
  for (const section of inboxSections(relays, { now })) {
    if (!section.relay.reachable) kept.add(section.relay.id || 'self');
    for (const item of [...section.pending, ...section.closed]) listed.add(`${section.relay.id || 'self'}\n${toText(item.id)}`);
  }
  for (const key of [...openFolds]) {
    const [relayId, itemId] = key.split('\n');
    if (!kept.has(relayId) && !listed.has(`${relayId}\n${itemId}`)) openFolds.delete(key);
  }
}

/** Pending items across every relay (the sidebar's badge), whatever the filter. */
export function inboxPendingCount(relays) {
  return (Array.isArray(relays) ? relays : [])
    .reduce((sum, relay) => sum + (Array.isArray(relay?.items) ? relay.items : []).filter((item) => toText(item?.status) === 'pending').length, 0);
}

/**
 * The sidebar badge: the urgent count, marked, while an urgent item waits;
 * else every pending item. Only asks can be urgent (`urgency: 'now'`); a
 * card a turn waits on or a plan card counts as a normal one.
 */
export function inboxBadge(relays) {
  let pending = 0;
  let urgent = 0;
  for (const relay of Array.isArray(relays) ? relays : []) {
    for (const item of Array.isArray(relay?.items) ? relay.items : []) {
      if (toText(item?.status) !== 'pending') continue;
      pending += 1;
      if (toText(item.kind) === 'ask' && item.urgency === 'now') urgent += 1;
    }
  }
  if (urgent > 0) return { text: String(urgent), urgent: true, pending, urgentCount: urgent };
  return { text: pending ? String(pending) : '', urgent: false, pending, urgentCount: 0 };
}

function headLine(doc, item, { relay, now, label }) {
  const head = el(doc, 'div', 'inbox-item-head');
  head.append(el(doc, 'span', 'inbox-item-kind', label));
  if (item.urgency === 'now') head.append(el(doc, 'span', 'inbox-item-urgent', 'urgent'));
  const age = formatInboxAge(item.createdAt, now);
  if (age) head.append(el(doc, 'span', 'inbox-item-age', age));
  if (relay && !relay.self) head.append(el(doc, 'span', 'inbox-item-relay', relay.name));
  return head;
}

function sessionLine(doc, item, relay, { withLink = true } = {}) {
  const line = el(doc, 'div', 'inbox-item-session');
  const title = toText(item?.session?.title) || 'Untitled session';
  if (withLink && relay?.self) {
    line.append(button(doc, 'inbox-open-session', title, { inboxAction: 'open', sessionId: item?.session?.id }));
  } else if (withLink && relay && !relay.self) {
    const url = inboxSessionUrl(relay.url, item?.session?.id);
    if (url) {
      const link = el(doc, 'a', 'inbox-open-there', title);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    } else {
      line.append(el(doc, 'span', 'inbox-session-title', title));
    }
  } else {
    line.append(el(doc, 'span', 'inbox-session-title', title));
  }
  const asker = item?.askedBy;
  if (item?.onBehalf && asker) {
    const who = [toText(asker.title) || toText(asker.conversationId), toText(asker.relay) ? `on ${toText(asker.relay)}` : ''].filter(Boolean).join(' ');
    if (who) line.append(el(doc, 'span', 'inbox-item-asker', `asked by ${who}`));
  }
  return line;
}

function outcomeLine(doc, item, mode = 'inbox') {
  if (item.status === 'dismissed') return el(doc, 'div', 'inbox-item-outcome', 'Dismissed');
  // The 📓 panel lists every close of the last day; the Inbox only these two.
  if (mode === 'panel' && item.status === 'withdrawn') return el(doc, 'div', 'inbox-item-outcome', 'Withdrawn');
  if (mode === 'panel' && item.status === 'cancelled') return el(doc, 'div', 'inbox-item-outcome', 'Cancelled');
  if (item.status !== 'answered') return null;
  if (mode === 'panel') {
    // The choice, or the answer's first line.
    const short = toText(item.choice) || toText(String(item.answer || '').split(/\r?\n/).find((line) => line.trim()) || '');
    return el(doc, 'div', 'inbox-item-outcome', `Answered: ${short}`);
  }
  const answer = toText(item.answer) || toText(item.choice);
  const via = toText(item.answeredVia);
  return el(doc, 'div', 'inbox-item-outcome', `Answered: ${answer}${via ? ` (from ${via})` : ''}`);
}

/**
 * A paired relay's pending item, answered on that relay by its person:
 * "Open there" opens that relay's web UI on the item's session (`?conv=`),
 * or a note when the relay gave no address.
 */
function openThereActions(doc, item, relay) {
  const url = inboxSessionUrl(relay?.url, item?.session?.id);
  const actions = el(doc, 'div', 'inbox-item-actions');
  if (url) {
    const link = el(doc, 'a', 'inbox-open-there inbox-open-there-button', 'Open there');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = `Answer it on ${toText(relay?.name) || 'that relay'}`;
    actions.append(link);
  } else {
    actions.append(el(doc, 'span', 'inbox-item-note', 'Answer it on that relay.'));
  }
  return actions;
}

/**
 * Whether a paired relay's pending item gets option buttons that open it on
 * that relay in a popup (agent auth §13.2, 1a): the relay says its page
 * takes `?answer=` (answerLink), and the item is an ask, a plain ask_user
 * card with options, or an approval. A plan card, a card with fields and a
 * multi-select card keep "Open there" alone.
 */
export function canAnswerThere(item, relay) {
  if (!relay || relay.self || relay.answerLink !== true) return false;
  if (toText(item?.status) !== 'pending') return false;
  if (!ANSWER_THERE_QID_PATTERN.test(toText(item?.id))) return false;
  const kind = toText(item?.kind);
  if (kind === 'plan' || kind === 'relay_notice' || item?.structured || item?.multiSelect) return false;
  // A paired relay's approval comes without its choices: one button, the
  // choice is made there.
  if (kind === 'approval') return true;
  return Array.isArray(item?.options) && item.options.some((option) => toText(option));
}

/**
 * The popup buttons of `canAnswerThere`: one per option (that option
 * preselected there, nothing answered by the click), or one "Answer there"
 * for an approval, then "answers on <relay>" and "Open there". Null when no
 * address can be built.
 */
function answerThereActions(doc, item, relay) {
  const options = Array.isArray(item?.options) ? item.options.map(toText).filter(Boolean) : [];
  const relayName = toText(relay?.name) || 'that relay';
  const data = { inboxAction: 'answer-there', relayId: relay?.id, itemId: item?.id };
  const wrap = el(doc, 'div', 'inbox-answer-there');
  const row = el(doc, 'div', 'inbox-item-options');
  if (options.length && toText(item?.kind) !== 'approval') {
    for (const [index, option] of options.entries()) {
      const url = answerThereUrl(relay?.url, item?.id, index);
      if (!url) return null;
      const node = button(doc, 'inbox-choice inbox-answer-there-choice', option, { ...data, option: index, url });
      node.setAttribute('aria-label', `${option} (answers on ${relayName}, in a new window)`);
      row.append(node);
    }
  } else {
    const url = answerThereUrl(relay?.url, item?.id);
    if (!url) return null;
    const node = button(doc, 'inbox-choice inbox-answer-there-choice', 'Answer there', { ...data, url });
    node.setAttribute('aria-label', `Answer on ${relayName}, in a new window`);
    row.append(node);
  }
  wrap.append(row);
  const actions = openThereActions(doc, item, relay);
  actions.prepend(el(doc, 'span', 'inbox-answer-there-hint', `answers on ${relayName}`));
  wrap.append(actions);
  return wrap;
}

/** "Open there", or the popup buttons and "Open there" when the item can be answered in one. */
function remoteActions(doc, item, relay) {
  return (canAnswerThere(item, relay) && answerThereActions(doc, item, relay)) || openThereActions(doc, item, relay);
}

/**
 * A question that does not block, as a card: in the Inbox (`mode` "inbox",
 * with its session and relay), in its session ("session") or in the
 * session's 📓 panel ("panel": its Details open). `answerable`: the buttons
 * answer it (this relay's ask, or a paired relay's while the pairing carries
 * answers); a paired relay's ask that is not shows "Open there" instead.
 */
export function buildAskCard(doc, item, { relay = null, mode = 'inbox', now = Date.now(), answerable = true } = {}) {
  const card = el(doc, 'article', `inbox-item inbox-ask${mode === 'session' ? ' relay-ask-card' : ''}`);
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = 'ask';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  const label = mode === 'session' ? 'Question for you · does not block this session' : (mode === 'panel' ? 'Question for you' : 'Question');
  card.append(headLine(doc, item, { relay, now, label }));
  if (mode === 'inbox') card.append(sessionLine(doc, item, relay));
  else if (item.onBehalf && item.askedBy) card.append(sessionLine(doc, item, relay, { withLink: false }));
  card.append(el(doc, 'p', 'inbox-item-question', item.question || item.prompt || ''));
  const options = Array.isArray(item.options) ? item.options.map(toText).filter(Boolean) : [];
  const recommendation = toText(item.recommendation);
  const recommendedOption = options.find((option) => option === recommendation) || '';
  if (recommendation && !recommendedOption) card.append(el(doc, 'p', 'inbox-item-recommendation', `Recommended: ${recommendation}`));
  if (toText(item.detail)) {
    const details = el(doc, 'details', 'inbox-item-detail');
    details.append(el(doc, 'summary', '', 'Details'));
    // Plain text, line breaks kept: never parsed as markup.
    details.append(el(doc, 'pre', 'inbox-item-detail-text', item.detail));
    if (mode === 'panel') details.open = true;
    card.append(details);
  }
  const outcome = outcomeLine(doc, item, mode);
  if (outcome) card.append(outcome);
  // A paired relay's ask this relay may not answer: read-only, "Open there".
  if (item.status === 'pending' && !answerable && relay && !relay.self && mode === 'inbox') {
    card.append(remoteActions(doc, item, relay));
    return card;
  }
  if (item.status === 'pending' && answerable) {
    const data = { relayId: relay?.id || 'self', itemId: item.id };
    if (options.length) {
      const row = el(doc, 'div', 'inbox-item-options');
      for (const option of options) {
        const choice = button(doc, `inbox-choice${option === recommendedOption ? ' recommended' : ''}`, option, { ...data, inboxAction: 'choice', choice: option });
        if (option === recommendedOption) {
          choice.append(el(doc, 'span', 'inbox-recommended-tag', 'recommended'));
          choice.setAttribute('aria-label', `${option} (recommended)`);
        }
        row.append(choice);
      }
      card.append(row);
    }
    const reply = el(doc, 'div', 'inbox-item-reply');
    const field = el(doc, 'textarea', 'inbox-answer-text');
    field.rows = 2;
    field.placeholder = options.length ? 'Or type an answer…' : 'Your answer…';
    field.setAttribute('aria-label', 'Answer');
    field.dataset.itemId = toText(item.id);
    reply.append(field);
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-answer', 'Answer', { ...data, inboxAction: 'answer' }));
    actions.append(button(doc, 'inbox-dismiss', 'Dismiss', { ...data, inboxAction: 'dismiss' }));
    reply.append(actions);
    card.append(reply);
  }
  return card;
}

/**
 * A card a turn waits on (ask_user) or an approval card, in the Inbox. Here:
 * a plain one is answered like in its session (choices, or typed text); one
 * with fields or several picks opens its session. A paired relay's is never
 * answered from here: "Open there".
 */
export function buildCardItem(doc, item, { relay = null, now = Date.now() } = {}) {
  const approval = item.kind === 'approval';
  const card = el(doc, 'article', `inbox-item inbox-card${approval ? ' inbox-approval' : ''}`);
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = toText(item.kind) || 'ask_user';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  // A paired relay's approval says what it is about; one from a
  // relay without summaries (0.9.19) keeps the plain text.
  const summary = approval && !relay?.self ? toText(item.summary) : '';
  const variant = toText(item.variant);
  const variantLabel = Object.hasOwn(INBOX_APPROVAL_VARIANT_LABELS, variant) ? INBOX_APPROVAL_VARIANT_LABELS[variant] : '';
  const kindLabel = summary ? (variantLabel || 'Approval') : (approval ? 'Approval' : 'Question');
  card.append(headLine(doc, item, { relay, now, label: `${kindLabel} · the session waits` }));
  card.append(sessionLine(doc, item, relay));
  if (toText(item.header)) card.append(el(doc, 'div', 'inbox-item-header', item.header));
  if (summary) card.append(el(doc, 'p', 'inbox-item-question inbox-item-summary', `${toText(relay?.name) || 'that relay'} · ${summary}`));
  else if (toText(item.question)) card.append(el(doc, 'p', 'inbox-item-question', item.question));
  else if (approval) card.append(el(doc, 'p', 'inbox-item-question', 'An Allow / Deny card on that relay.'));
  const outcome = outcomeLine(doc, item);
  if (outcome) card.append(outcome);
  if (item.status !== 'pending') return card;
  if (!relay?.self) {
    card.append(remoteActions(doc, item, relay));
    return card;
  }
  const options = Array.isArray(item.options) ? item.options.map(toText).filter(Boolean) : [];
  const data = { relayId: 'self', itemId: item.id, sessionId: item?.session?.id, sdkSessionId: item.sdkSessionId || '' };
  if (item.structured || item.multiSelect) {
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-open-session-button', 'Open the session to answer', { inboxAction: 'open', sessionId: item?.session?.id }));
    card.append(actions);
    return card;
  }
  if (options.length) {
    const row = el(doc, 'div', 'inbox-item-options');
    for (const option of options) row.append(button(doc, 'inbox-choice', option, { ...data, inboxAction: 'card-choice', choice: option }));
    card.append(row);
  }
  if (item.allowFreeform !== false || !options.length) {
    const reply = el(doc, 'div', 'inbox-item-reply');
    const field = el(doc, 'textarea', 'inbox-answer-text');
    field.rows = 2;
    field.placeholder = 'Your answer…';
    field.setAttribute('aria-label', 'Answer');
    field.dataset.itemId = toText(item.id);
    reply.append(field);
    const actions = el(doc, 'div', 'inbox-item-actions');
    actions.append(button(doc, 'inbox-answer', 'Answer', { ...data, inboxAction: 'card-answer' }));
    reply.append(actions);
    card.append(reply);
  }
  return card;
}

/**
 * A plan card in the Inbox: the plan folded, and the card's own
 * buttons, which act as the card in its session does (a plan-only session
 * asks first). Settled, it says what was chosen. A paired relay's shows its
 * title alone: "Open there".
 */
export function buildPlanItem(doc, item, { relay = null, now = Date.now() } = {}) {
  const card = el(doc, 'article', 'inbox-item inbox-card inbox-plan');
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = 'plan';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  card.append(headLine(doc, item, { relay, now, label: 'Plan · ready for review' }));
  card.append(sessionLine(doc, item, relay));
  card.append(el(doc, 'div', 'inbox-item-header', toText(item.title) || 'Plan ready for review'));
  if (relay?.self && toText(item.body)) {
    const details = el(doc, 'details', 'inbox-plan-body');
    details.append(el(doc, 'summary', '', 'The plan'));
    details.append(el(doc, 'div', 'inbox-plan-text', item.body));
    card.append(details);
  }
  if (item.status !== 'pending') {
    const outcome = boardOutcomeLine(item);
    if (outcome) card.append(el(doc, 'div', 'inbox-item-outcome', outcome));
    return card;
  }
  if (!relay?.self) {
    card.append(openThereActions(doc, item, relay));
    return card;
  }
  const recommended = toText(item.recommendedAction).toLowerCase();
  const row = el(doc, 'div', 'inbox-item-options inbox-plan-actions');
  for (const action of Array.isArray(item.actions) ? item.actions : []) {
    const actionId = toText(action?.id).toLowerCase();
    if (!actionId) continue;
    const node = button(doc, `inbox-choice inbox-plan-action${actionId === recommended ? ' inbox-plan-action-recommended' : ''}`, toText(action?.label) || actionId, {
      relayId: 'self', inboxAction: 'plan-action', boardId: item.id, actionId, sessionId: item?.session?.id,
    });
    row.append(node);
  }
  card.append(row);
  return card;
}

/**
 * This relay's own notice of a paired relay's refused claim (origin binding):
 * what happened, a way to the relay's entry in Settings → Relays, Dismiss.
 */
function buildRelayNoticeItem(doc, item, { relay, now }) {
  const card = el(doc, 'article', 'inbox-item inbox-relay-notice');
  card.dataset.kind = 'relay_notice';
  card.dataset.itemId = toText(item.id);
  card.append(headLine(doc, item, { relay, now, label: 'Relay notice' }));
  card.append(el(doc, 'p', 'inbox-item-question', toText(item.question)));
  if (toText(item.detail)) card.append(el(doc, 'p', 'inbox-item-detail', toText(item.detail)));
  const row = el(doc, 'div', 'inbox-item-actions');
  row.append(button(doc, 'inbox-choice inbox-relay-notice-open', 'Open Settings → Relays', { inboxAction: 'relay-settings', relayEntryId: toText(item.relayEntryId) }));
  row.append(button(doc, 'inbox-dismiss inbox-relay-notice-dismiss', 'Dismiss', { inboxAction: 'relay-notice-dismiss', relayEntryId: toText(item.relayEntryId) }));
  card.append(row);
  return card;
}

function buildItem(doc, item, relay, now, pairedAnswers = false) {
  if (item.kind === 'relay_notice') return buildRelayNoticeItem(doc, item, { relay, now });
  if (item.kind === 'ask') {
    const answerable = relay?.self === true || pairedAnswers === true;
    return buildAskCard(doc, item, { relay, now, mode: 'inbox', answerable });
  }
  if (item.kind === 'plan') return buildPlanItem(doc, item, { relay, now });
  return buildCardItem(doc, item, { relay, now });
}

// ─── Folds ────────────────────────────────────────────────────────────────────

export const INBOX_FOLD_ALL_LABELS = Object.freeze({ fold: 'Fold all questions', unfold: 'Unfold all questions' });

function chevron(doc) {
  const node = el(doc, 'span', 'inbox-fold-chevron', '›');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function firstLine(value) {
  return toText(String(value ?? '').split(/\r?\n/).find((line) => line.trim()) || '');
}

/** What a folded card says it is about: its question's first line, else its title. */
export function inboxItemLine(item) {
  return firstLine(item?.question) || firstLine(item?.prompt) || firstLine(item?.summary)
    || firstLine(item?.title) || firstLine(item?.header);
}

function foldedKindLabel(item) {
  const kind = toText(item?.kind);
  if (kind === 'plan') return 'Plan';
  if (kind === 'relay_notice') return 'Relay notice';
  if (kind !== 'approval') return 'Question';
  const variant = toText(item.variant);
  return (toText(item.summary) && Object.hasOwn(INBOX_APPROVAL_VARIANT_LABELS, variant) && INBOX_APPROVAL_VARIANT_LABELS[variant]) || 'Approval';
}

function cardFocusKey(relay, item) {
  return `item:${inboxItemKey(relay?.id, item?.id)}`;
}

/**
 * A card folded to one line: one button that unfolds it, with its kind, the
 * urgent mark, its age, its question's first line and (in the Inbox) its
 * session's title. Nothing on it answers.
 */
export function buildFoldedItem(doc, item, { relay = null, mode = 'inbox', now = Date.now() } = {}) {
  const card = el(doc, 'article', 'inbox-item is-folded');
  card.dataset.itemId = toText(item.id);
  card.dataset.kind = toText(item.kind) || 'ask_user';
  if (relay?.id) card.dataset.relayId = relay.id;
  card.dataset.status = toText(item.status) || 'pending';
  const row = button(doc, 'inbox-item-unfold', null, { inboxView: 'unfold-item', focusKey: cardFocusKey(relay, item) });
  row.setAttribute('aria-expanded', 'false');
  row.title = 'Unfold';
  row.append(chevron(doc), el(doc, 'span', 'inbox-fold-part inbox-item-kind', foldedKindLabel(item)));
  if (item.urgency === 'now' && toText(item.kind) === 'ask') row.append(el(doc, 'span', 'inbox-fold-part inbox-item-urgent', 'urgent'));
  const age = formatInboxAge(item.createdAt, now);
  if (age) row.append(el(doc, 'span', 'inbox-fold-part inbox-item-age', age));
  const line = inboxItemLine(item);
  if (line) row.append(el(doc, 'span', 'inbox-fold-part inbox-item-line', line));
  if (mode === 'inbox' && item?.session) {
    row.append(el(doc, 'span', 'inbox-fold-part inbox-item-line-session', toText(item.session.title) || 'Untitled session'));
  }
  card.append(row);
  return card;
}

/**
 * A card of the Inbox (`mode` "inbox") or of the 📓 panel ("panel", asks
 * only): folded to one line, or whole with a chevron that folds it.
 */
export function buildInboxCard(doc, item, { relay = null, mode = 'inbox', now = Date.now(), pairedAnswers = false, folded = false } = {}) {
  if (folded) return buildFoldedItem(doc, item, { relay, mode, now });
  const card = mode === 'panel' ? buildAskCard(doc, item, { relay, mode, now }) : buildItem(doc, item, relay, now, pairedAnswers);
  const fold = button(doc, 'inbox-item-fold', null, { inboxView: 'fold-item', focusKey: cardFocusKey(relay, item) });
  fold.setAttribute('aria-expanded', 'true');
  fold.setAttribute('aria-label', 'Fold this question');
  fold.title = 'Fold';
  fold.append(chevron(doc));
  card.querySelector(':scope > .inbox-item-head')?.prepend(fold);
  return card;
}

/**
 * ➖ while a card under `root` is unfolded (a click folds them all), ➕ once
 * every one is folded (a click unfolds them); off with no card.
 */
export function syncInboxFoldAll(node, root) {
  if (!node) return;
  const cards = [...(root?.querySelectorAll?.('.inbox-item[data-item-id]') || [])];
  const unfold = cards.length > 0 && cards.every((card) => card.classList.contains('is-folded'));
  const label = unfold ? INBOX_FOLD_ALL_LABELS.unfold : INBOX_FOLD_ALL_LABELS.fold;
  node.textContent = unfold ? '➕' : '➖';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.dataset.foldAll = unfold ? 'unfold' : 'fold';
  node.disabled = cards.length === 0;
}

/** The ➖ button of the Inbox's filter bar and of the 📓 panel's head. */
export function buildFoldAllButton(doc, className = 'inbox-fold-all') {
  const node = button(doc, className, '➖', { inboxView: 'fold-all', focusKey: 'fold-all' });
  node.setAttribute('aria-label', INBOX_FOLD_ALL_LABELS.fold);
  node.title = INBOX_FOLD_ALL_LABELS.fold;
  return node;
}

/** A toggle chip of the filter bar (Unanswered, This relay). */
export function buildFilterChip(doc, label, viewAction, pressed) {
  const chip = button(doc, `inbox-filter-chip${pressed ? ' active' : ''}`, label, { inboxView: viewAction, focusKey: `chip:${viewAction}` });
  chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  return chip;
}

/**
 * A heading of a relay section (h2) or a group sub-section (h3): its name,
 * and, when it has items, a chevron that folds it and its counts.
 */
function sectionHeading(doc, tag, { key, label, labelClass, counts = '', foldable = false, folded = false }) {
  const heading = el(doc, tag, `inbox-section-heading ${tag === 'h2' ? 'inbox-relay-heading' : 'inbox-group-heading'}`);
  const name = el(doc, 'span', labelClass, label);
  if (foldable) {
    const toggle = button(doc, 'inbox-section-fold', null, { inboxView: 'fold-section', sectionKey: key, focusKey: `section:${key}` });
    toggle.setAttribute('aria-expanded', folded ? 'false' : 'true');
    toggle.append(chevron(doc), name);
    heading.append(toggle);
  } else {
    heading.append(name);
  }
  if (counts) heading.append(el(doc, 'span', 'inbox-section-count', counts));
  return heading;
}

/**
 * The Groups picker: a fold (details) with one checkbox per group that has
 * items. None ticked: every group.
 */
function groupsPicker(doc, choices, picked, open) {
  const picker = el(doc, 'details', 'inbox-groups-picker');
  const summary = el(doc, 'summary', `inbox-filter-chip inbox-groups-toggle${picked.size ? ' active' : ''}`, picked.size ? `Groups (${picked.size}) ▾` : 'Groups ▾');
  summary.dataset.focusKey = 'groups';
  picker.append(summary);
  const list = el(doc, 'div', 'inbox-groups-popover');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Show these groups');
  for (const choice of choices) {
    const row = el(doc, 'label', `inbox-groups-choice${choice.id ? '' : ' is-no-group'}`);
    const box = el(doc, 'input', 'inbox-groups-check');
    box.type = 'checkbox';
    box.checked = picked.has(choice.key);
    box.dataset.inboxGroupKey = choice.key;
    box.dataset.focusKey = `group:${choice.key}`;
    row.append(box, el(doc, 'span', 'inbox-groups-label', choice.label));
    list.append(row);
  }
  list.append(el(doc, 'p', 'inbox-groups-hint', 'None ticked: every group.'));
  picker.append(list);
  picker.open = open === true;
  return picker;
}

function filterBar(doc, view, { relays, now, groupsOpen }) {
  const bar = el(doc, 'div', 'inbox-filter');
  const who = el(doc, 'div', 'inbox-filter-who');
  who.setAttribute('role', 'group');
  who.setAttribute('aria-label', 'Show');
  for (const [value, label] of [['all', 'All'], ['mine', 'Mine'], ['agents', 'Agents']]) {
    const option = button(doc, `inbox-filter-option${view.who === value ? ' active' : ''}`, label, { inboxFilter: value, focusKey: `who:${value}` });
    option.setAttribute('aria-pressed', view.who === value ? 'true' : 'false');
    who.append(option);
  }
  bar.append(who, buildFilterChip(doc, 'Unanswered', 'unanswered', view.unanswered));
  // Only with a paired relay listed is there anything to narrow.
  if (relays.some((relay) => relay?.self !== true)) bar.append(buildFilterChip(doc, 'This relay', 'this-relay', view.thisRelay));
  const choices = inboxGroupChoices(relays, { now });
  if (choices.some((choice) => choice.id)) bar.append(groupsPicker(doc, choices, inboxGroupSelection(view.groups, relays, { now }), groupsOpen));
  return bar;
}

function appendParts(doc, host, pending, closed, card) {
  for (const item of pending) host.append(card(item));
  if (!closed.length) return;
  const divider = el(doc, 'div', 'inbox-divider', 'Answered in the last day');
  divider.setAttribute('role', 'separator');
  host.append(divider);
  for (const item of closed) host.append(card(item));
}

/**
 * The whole Inbox: the filter bar, then one section per relay, with a
 * sub-section per group when its items are in more than one. `filter`: "all"
 * / "mine" / "agents", or a view (inbox-view-state.mjs) with its folds, and
 * `groupsOpen` while the Groups picker is open. `pairedAnswers` (GET
 * /api/inbox): a paired relay's asks are answered from here; off (the
 * default), they show read-only with "Open there".
 */
export function renderInbox(doc, { relays = [], filter = 'all', now = Date.now(), loading = false, pairedAnswers = false } = {}) {
  const view = normalizeInboxView(typeof filter === 'string' ? { who: filter } : filter);
  const list = Array.isArray(relays) ? relays : [];
  const foldedItems = new Set(view.foldedItems);
  const foldedSections = new Set(view.foldedSections);
  const root = el(doc, 'section', 'status-view inbox-view');
  root.setAttribute('aria-label', 'Inbox');
  const bar = filterBar(doc, view, { relays: list, now, groupsOpen: filter?.groupsOpen === true });
  const foldAll = buildFoldAllButton(doc);
  bar.append(foldAll);
  root.append(bar);
  const filtered = inboxFilterActive(view, list, { now });
  let anything = false;
  let selfSaid = '';
  for (const section of inboxSections(list, { filter: view, now })) {
    const relay = section.relay;
    const relayKey = inboxRelayKey(relay);
    const group = el(doc, 'section', 'inbox-relay');
    group.dataset.relayId = relay.id;
    const title = relay.self ? `${relay.name} (this relay)` : relay.name;
    const shown = section.pending.length + section.closed.length;
    if (!relay.reachable || !shown) {
      if (!relay.reachable) {
        group.append(sectionHeading(doc, 'h2', { label: title, labelClass: 'inbox-relay-name' }));
        group.append(el(doc, 'p', 'inbox-relay-unreachable', `Not reachable${relay.error ? `: ${relay.error}` : ''}`));
      } else if (!relay.self && relay.note) {
        group.append(sectionHeading(doc, 'h2', { label: title, labelClass: 'inbox-relay-name' }));
        group.append(el(doc, 'p', 'inbox-empty inbox-relay-note', relay.note));
      } else if (relay.self) {
        // Emptied by a filter, or empty.
        selfSaid = loading ? 'Loading…' : (section.listed ? 'Nothing matches this filter.' : 'Nothing waits for you here.');
        group.append(sectionHeading(doc, 'h2', { label: title, labelClass: 'inbox-relay-name' }));
        group.append(el(doc, 'p', 'inbox-empty', selfSaid));
      } else if (section.listedPending) {
        // A paired relay whose waiting items a filter hides says so: it
        // never vanishes while something waits there.
        group.append(sectionHeading(doc, 'h2', { label: title, labelClass: 'inbox-relay-name' }));
        group.append(el(doc, 'p', 'inbox-empty', 'Nothing matches this filter.'));
      } else {
        continue;
      }
      root.append(group);
      continue;
    }
    anything = true;
    const folded = foldedSections.has(relayKey);
    group.append(sectionHeading(doc, 'h2', {
      key: relayKey, label: title, labelClass: 'inbox-relay-name', counts: inboxCountsText(section.pending, section.closed), foldable: true, folded,
    }));
    root.append(group);
    if (folded) continue;
    const card = (item) => {
      const node = buildInboxCard(doc, item, {
        relay, mode: 'inbox', now, pairedAnswers, folded: foldedItems.has(inboxItemKey(relay.id, item.id)),
      });
      // Its group, for the scroll anchor (inbox-ui.js).
      node.dataset.groupId = inboxGroupOf(item)?.id || '';
      return node;
    };
    // All in one group (or none): no sub-heading.
    if (section.groups.length <= 1) {
      appendParts(doc, group, section.pending, section.closed, card);
      continue;
    }
    for (const bucket of section.groups) {
      const sub = el(doc, 'section', `inbox-group${bucket.id ? '' : ' is-no-group'}`);
      sub.dataset.relayId = relay.id;
      sub.dataset.groupId = bucket.id;
      const subFolded = foldedSections.has(bucket.key);
      sub.append(sectionHeading(doc, 'h3', {
        key: bucket.key, label: bucket.name, labelClass: 'inbox-group-name', counts: inboxCountsText(bucket.pending, bucket.closed), foldable: true, folded: subFolded,
      }));
      if (!subFolded) appendParts(doc, sub, bucket.pending, bucket.closed, card);
      group.append(sub);
    }
  }
  if (!anything && filtered && selfSaid !== 'Nothing matches this filter.') root.append(el(doc, 'p', 'inbox-empty', 'Nothing matches this filter.'));
  syncInboxFoldAll(foldAll, root);
  return root;
}
