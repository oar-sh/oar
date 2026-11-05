// The Inbox in the page: the sidebar's "Inbox" button with its count and
// the view it opens in place of a transcript (like Status). A session's own
// questions that don't block are in its 📓 (questions-panel-ui.js), which
// answers through here. inbox-view.mjs builds the DOM; this module loads,
// keeps and answers.
//
// The list comes from GET /api/inbox (this relay and every paired relay that
// answers), again on every change of a question here (socket) and every
// minute for the paired relays. Answering here is answering the card in its
// session: this relay's through the question routes, a paired relay's ask
// through this relay (POST /api/inbox/relays/:id/asks/:ask/answer); a paired
// relay's cards open there.

import { apiFetch, answerRelayQuestion } from './api-client.js';
import { currentConvId, IS_SHARED_VIEW, setCurrentConv, showTransientRelayNotice } from './store.js';
import { isStatusViewActive, leaveStatusView } from './status-view.mjs';
import { actOnRelayBoard } from './relay-board-view.js';
import {
  captureInboxFolds,
  createCoalescedRefresh,
  inboxBadge,
  INBOX_FILTERS,
  INBOX_FOLD_SELECTOR,
  noteInboxFold,
  pruneInboxFolds,
  renderInbox,
  restoreInboxFolds,
} from './inbox-view.mjs';

const FILTER_STORAGE_KEY = 'oar_inbox_filter';
const REFRESH_MS = 60_000;
const CHANGE_DEBOUNCE_MS = 400;

let inboxActive = false;
let previousConversationId = '';
let relays = [];
let loaded = false;
let filter = 'all';
let refreshTimer = null;
let changeTimer = null;
let clickBound = false;
let started = false;
// Typed answers, kept across re-renders: `${relayId}:${itemId}` → text.
const drafts = new Map();
// The open folds (a card's Details, a plan card's plan), kept across
// re-renders the same way: every socket change and the minute's poll draw
// the cards anew, closed. Forgotten when the item leaves the list.
const openFolds = new Set();
// Where the Inbox was scrolled when it was last left; the next opening
// starts there (the first one at the top). The transcript's own scroll
// height is the transcript's, never the Inbox's.
let inboxScrollTop = 0;
// The 📓 panel's side (questions-panel-ui.js), handed in so the two modules
// do not import each other: an ask the answer routes returned, "open" on an
// ask's session, and that open having run (or failed).
let askHooks = { onAskUpdated: null, onOpenAsk: null, onOpenSettled: null };

export function setInboxAskHooks(hooks = {}) {
  askHooks = { ...askHooks, ...hooks };
}

function readFilter() {
  try {
    const stored = String(localStorage.getItem(FILTER_STORAGE_KEY) || '');
    return INBOX_FILTERS.includes(stored) ? stored : 'all';
  } catch {
    return 'all';
  }
}

export function isInboxViewActive() {
  return inboxActive;
}

/**
 * The sidebar button's count: everything pending, here and on paired relays;
 * while an urgent ask waits, the urgent count in red.
 */
function syncInboxBadge() {
  const { text, urgent, pending: count, urgentCount } = inboxBadge(relays);
  const badge = document.getElementById('inbox-count');
  const buttonEl = document.getElementById('inbox-btn');
  if (badge) {
    badge.textContent = text;
    badge.classList.toggle('is-urgent', urgent);
  }
  if (buttonEl) {
    buttonEl.classList.toggle('has-pending', count > 0);
    const label = urgent
      ? `Inbox, ${urgentCount} urgent of ${count} waiting`
      : (count ? `Inbox, ${count} question${count === 1 ? '' : 's'} waiting` : 'Inbox');
    buttonEl.setAttribute('aria-label', label);
    buttonEl.setAttribute('aria-pressed', inboxActive ? 'true' : 'false');
  }
}

function draftKey(node) {
  const card = node?.closest?.('.inbox-item');
  return card ? `${card.dataset.relayId || 'self'}:${card.dataset.itemId || ''}` : '';
}

export function captureDrafts(host) {
  // Only fields typed into: the same ask can be drawn twice (its session's
  // card and the 📓 panel), and the untouched copy must not wipe the draft.
  for (const field of host.querySelectorAll('.inbox-answer-text')) {
    const key = draftKey(field);
    if (key && field.dataset.draftTouched === '1') drafts.set(key, field.value);
  }
  const active = document.activeElement;
  return active?.classList?.contains('inbox-answer-text') && host.contains(active) ? draftKey(active) : '';
}

export function restoreDrafts(host, focusedKey) {
  for (const field of host.querySelectorAll('.inbox-answer-text')) {
    const key = draftKey(field);
    if (drafts.has(key)) field.value = drafts.get(key);
    if (key && key === focusedKey) field.focus({ preventScroll: true });
  }
}

/**
 * Draws the Inbox into the transcript's place. A re-render keeps the scroll
 * height; the render that opens the view (`opening`) takes the height the
 * Inbox had when it was last left, not the one the transcript showed.
 */
function renderInboxNow({ opening = false } = {}) {
  if (!inboxActive) return;
  const host = document.getElementById('messages');
  if (!host) return;
  const focused = captureDrafts(host);
  if (host.querySelector('.inbox-view')) captureInboxFolds(openFolds, host);
  const top = opening ? inboxScrollTop : host.scrollTop;
  host.replaceChildren(renderInbox(document, { relays, filter, now: Date.now(), loading: !loaded }));
  restoreDrafts(host, focused);
  restoreInboxFolds(openFolds, host);
  host.scrollTop = top;
  const title = document.getElementById('chat-title');
  if (title) {
    const { pending: count, urgentCount } = inboxBadge(relays);
    title.textContent = count ? `Inbox · ${urgentCount ? `${urgentCount} urgent · ` : ''}${count} waiting` : 'Inbox';
  }
}

async function loadInbox() {
  const response = await apiFetch('/api/inbox');
  if (response && Array.isArray(response.relays)) {
    relays = response.relays;
    loaded = true;
    pruneInboxFolds(openFolds, relays);
  }
  syncInboxBadge();
  renderInboxNow();
  return response;
}

// One load at a time; a change while one runs brings one more after it.
const refreshCoalesced = createCoalescedRefresh(loadInbox);

/** Loads the Inbox: never two at once, and one more when asked while one runs. */
export function refreshInbox() {
  if (IS_SHARED_VIEW) return Promise.resolve(null);
  return refreshCoalesced();
}

function scheduleRefresh() {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    void refreshInbox();
  }, CHANGE_DEBOUNCE_MS);
}

/** Socket: an ask of this relay changed (created, answered, dismissed, withdrawn). */
export function noteRelayAskUpdated() {
  scheduleRefresh();
}

/** Socket: a card a turn waits on came or went. */
export function noteInboxQuestionsChanged() {
  scheduleRefresh();
}

export function leaveInboxView() {
  const wasActive = inboxActive;
  if (!wasActive) return false;
  const host = document.getElementById('messages');
  if (host) inboxScrollTop = Math.max(0, Number(host.scrollTop) || 0);
  inboxActive = false;
  document.body.classList.remove('inbox-view-active');
  document.getElementById('input-area')?.removeAttribute('hidden');
  document.getElementById('pending-question-banner')?.removeAttribute('hidden');
  syncInboxBadge();
  window.renderConvList?.();
  return true;
}

/**
 * Nothing to go back to (opened with nothing open, as after an unknown
 * link): the header and the transcript give way to the empty screen.
 * Loaded on demand: the transcript's module is already in the page.
 */
async function showNothingOpen() {
  const { clearOpenConversation } = await import('./journal-view.js');
  clearOpenConversation({ history: false });
}

/**
 * Opens the Inbox, or leaves it for the conversation it was opened from.
 * Opened from Status there is none stored: `returnTo` (the session the
 * history stands on) is opened instead, so the transcript never keeps the list.
 */
export async function toggleInboxView({ returnTo = '' } = {}) {
  if (inboxActive) {
    leaveInboxView();
    const restoreId = previousConversationId || String(returnTo || '').trim();
    previousConversationId = '';
    if (restoreId) await window.openConversation?.(restoreId, { restoreScroll: true });
    else await showNothingOpen();
    return;
  }
  if (isStatusViewActive()) leaveStatusView();
  previousConversationId = String(currentConvId || '').trim();
  inboxActive = true;
  setCurrentConv(null);
  window.renderConvList?.();
  if (previousConversationId) localStorage.setItem('copilot_last_conv', previousConversationId);
  document.body.classList.add('inbox-view-active');
  document.getElementById('pending-question-banner')?.setAttribute('hidden', '');
  document.getElementById('input-area')?.setAttribute('hidden', '');
  for (const id of ['chat-title-cwd', 'chat-title-session-usage']) {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = '';
      node.hidden = true;
    }
  }
  syncInboxBadge();
  renderInboxNow({ opening: true });
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  await refreshInbox();
}

// ─── Answering ────────────────────────────────────────────────────────────────

async function postJson(url, body) {
  let refusal = '';
  const response = await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify(body || {}),
    onErrorResponse: async (res) => {
      try {
        refusal = String((await res.json())?.error || '');
      } catch {}
    },
  });
  return { ok: !!response, response, refusal };
}

function fieldText(card) {
  return String(card?.querySelector('.inbox-answer-text')?.value || '').trim();
}

async function answerAsk(card, data, { choice = '', dismiss = false } = {}) {
  const relayId = data.relayId || 'self';
  const id = data.itemId;
  const typed = fieldText(card);
  if (!dismiss && !choice && !typed) {
    showTransientRelayNotice('Pick an option or type an answer first.');
    return false;
  }
  const body = dismiss ? {} : { choice, answer: typed };
  const url = relayId === 'self'
    ? `/api/relay-question/${encodeURIComponent(id)}/${dismiss ? 'dismiss' : 'answer'}`
    : `/api/inbox/relays/${encodeURIComponent(relayId)}/asks/${encodeURIComponent(id)}/${dismiss ? 'dismiss' : 'answer'}`;
  const result = await postJson(url, body);
  if (!result.ok) {
    showTransientRelayNotice(result.refusal || 'The answer did not go through. Try again.');
    return false;
  }
  drafts.delete(`${relayId}:${id}`);
  if (relayId === 'self' && result.response?.question?.id) {
    try { askHooks.onAskUpdated?.(result.response.question); } catch {}
  }
  return true;
}

async function answerCard(card, data, { choice = '' } = {}) {
  const answer = choice || fieldText(card);
  if (!answer) {
    showTransientRelayNotice('Type an answer first.');
    return false;
  }
  let refusal = '';
  const response = await answerRelayQuestion(data.itemId, answer, data.sdkSessionId || null, {
    onErrorResponse: async (res) => {
      try {
        refusal = String((await res.json())?.error || '');
      } catch {}
    },
  });
  if (!response) {
    showTransientRelayNotice(refusal || 'The answer did not go through. Try again.');
    return false;
  }
  drafts.delete(`self:${data.itemId}`);
  return true;
}

// A plan card's button in the Inbox: the card's own action, with
// the plan-only question first; a card settled meanwhile just shows so.
async function actOnPlanItem(data) {
  const own = relays.find((relay) => relay?.self === true);
  const item = (Array.isArray(own?.items) ? own.items : []).find((entry) => entry?.kind === 'plan' && entry.id === data.boardId) || null;
  const board = item ? { ...item, conversationId: item.session?.id } : null;
  return !!(await actOnRelayBoard(data.boardId, data.actionId, { board }));
}

async function handleAction(target) {
  const data = { ...target.dataset };
  const card = target.closest('.inbox-item');
  if (data.inboxFilter) {
    filter = INBOX_FILTERS.includes(data.inboxFilter) ? data.inboxFilter : 'all';
    try { localStorage.setItem(FILTER_STORAGE_KEY, filter); } catch {}
    renderInboxNow();
    return;
  }
  if (data.inboxAction === 'open') {
    const id = String(data.sessionId || '').trim();
    if (!id) return;
    // An ask's session opens with 📓 open at that ask.
    const askId = card?.dataset.kind === 'ask' && (card.dataset.relayId || 'self') === 'self' ? String(card.dataset.itemId || '') : '';
    if (askId) askHooks.onOpenAsk?.(id, askId);
    leaveInboxView();
    previousConversationId = '';
    try {
      await window.openConversation?.(id);
    } finally {
      // Failed, or landed elsewhere: the request to open 📓 there is dropped.
      if (askId) askHooks.onOpenSettled?.(id);
    }
    return;
  }
  const buttons = card ? [...card.querySelectorAll('button')] : [target];
  for (const node of buttons) node.disabled = true;
  let done = false;
  try {
    if (data.inboxAction === 'choice') done = await answerAsk(card, data, { choice: data.choice });
    else if (data.inboxAction === 'answer') done = await answerAsk(card, data);
    else if (data.inboxAction === 'dismiss') done = await answerAsk(card, data, { dismiss: true });
    else if (data.inboxAction === 'card-choice') done = await answerCard(card, data, { choice: data.choice });
    else if (data.inboxAction === 'card-answer') done = await answerCard(card, data);
    else if (data.inboxAction === 'plan-action') done = await actOnPlanItem(data);
  } finally {
    if (!done) for (const node of buttons) node.disabled = false;
  }
  if (done) await refreshInbox();
}

/**
 * The Inbox's buttons, typed answers and folds inside `host`: the transcript
 * (the Inbox view) or another host that draws the
 * same cards (the 📓 panel). `scope`: the selector a click must be inside.
 */
export function bindInboxActionHost(host, { scope = '.inbox-view' } = {}) {
  if (!host || host.dataset.inboxActionsBound === '1') return;
  host.dataset.inboxActionsBound = '1';
  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-inbox-action], [data-inbox-filter]') : null;
    if (!target || !target.closest(scope)) return;
    event.preventDefault();
    void handleAction(target);
  });
  host.addEventListener('input', (event) => {
    const field = event.target instanceof Element && event.target.classList.contains('inbox-answer-text') ? event.target : null;
    const key = field ? draftKey(field) : '';
    if (key) {
      field.dataset.draftTouched = '1';
      drafts.set(key, field.value);
    }
  });
  // A fold opened or closed by hand. `toggle` does not bubble: caught on the
  // way down.
  host.addEventListener('toggle', (event) => {
    const details = event.target instanceof Element && event.target.matches(INBOX_FOLD_SELECTOR) ? event.target : null;
    if (details && details.isConnected) noteInboxFold(openFolds, details);
  }, true);
}

function bindClicks() {
  if (clickBound) return;
  clickBound = true;
  bindInboxActionHost(document.getElementById('messages'));
}

/** Boot: the count and a refresh every minute (paired relays). */
export function startInbox() {
  if (started || IS_SHARED_VIEW) return;
  started = true;
  filter = readFilter();
  bindClicks();
  syncInboxBadge();
  void refreshInbox();
  refreshTimer = setInterval(() => { void refreshInbox(); }, REFRESH_MS);
  refreshTimer?.unref?.();
}
