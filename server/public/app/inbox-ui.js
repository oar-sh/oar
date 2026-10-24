// The Inbox in the page: the sidebar's "Inbox" button with its count, the
// view it opens in place of a transcript (like Status), and the card a
// question that does not block shows in its own session. inbox-view.mjs
// builds the DOM; this module loads, keeps and answers.
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
import {
  buildAskCard,
  createCoalescedRefresh,
  inboxPendingCount,
  INBOX_FILTERS,
  renderInbox,
  sessionAsksFromInbox,
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
// This relay's asks for the session cards: id → ask (each Inbox load
// replaces it; the socket updates single asks in between).
let sessionAsks = new Map();
let sessionCardKey = '';

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

/** The sidebar button's count: everything pending, here and on paired relays. */
function syncInboxBadge() {
  const count = inboxPendingCount(relays);
  const badge = document.getElementById('inbox-count');
  const buttonEl = document.getElementById('inbox-btn');
  if (badge) badge.textContent = count ? String(count) : '';
  if (buttonEl) {
    buttonEl.classList.toggle('has-pending', count > 0);
    buttonEl.setAttribute('aria-label', count ? `Inbox, ${count} question${count === 1 ? '' : 's'} waiting` : 'Inbox');
    buttonEl.setAttribute('aria-pressed', inboxActive ? 'true' : 'false');
  }
}

function draftKey(node) {
  const card = node?.closest?.('.inbox-item');
  return card ? `${card.dataset.relayId || 'self'}:${card.dataset.itemId || ''}` : '';
}

function captureDrafts(host) {
  for (const field of host.querySelectorAll('.inbox-answer-text')) {
    const key = draftKey(field);
    if (key) drafts.set(key, field.value);
  }
  const active = document.activeElement;
  return active?.classList?.contains('inbox-answer-text') && host.contains(active) ? draftKey(active) : '';
}

function restoreDrafts(host, focusedKey) {
  for (const field of host.querySelectorAll('.inbox-answer-text')) {
    const key = draftKey(field);
    if (drafts.has(key)) field.value = drafts.get(key);
    if (key && key === focusedKey) field.focus({ preventScroll: true });
  }
}

function renderInboxNow() {
  if (!inboxActive) return;
  const host = document.getElementById('messages');
  if (!host) return;
  const focused = captureDrafts(host);
  const top = host.scrollTop;
  host.replaceChildren(renderInbox(document, { relays, filter, now: Date.now(), loading: !loaded }));
  restoreDrafts(host, focused);
  host.scrollTop = top;
  const title = document.getElementById('chat-title');
  if (title) {
    const count = inboxPendingCount(relays);
    title.textContent = count ? `Inbox · ${count} waiting` : 'Inbox';
  }
}

async function loadInbox() {
  const response = await apiFetch('/api/inbox');
  if (response && Array.isArray(response.relays)) {
    relays = response.relays;
    loaded = true;
    // Built anew from each load: an ask withdrawn or cancelled meanwhile goes.
    sessionAsks = sessionAsksFromInbox(relays);
  }
  syncInboxBadge();
  renderInboxNow();
  renderSessionAskCards();
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
export function noteRelayAskUpdated(payload = {}) {
  const ask = payload?.ask;
  if (ask?.id) sessionAsks.set(ask.id, ask);
  renderSessionAskCards();
  scheduleRefresh();
}

/** Socket: a card a turn waits on came or went. */
export function noteInboxQuestionsChanged() {
  scheduleRefresh();
}

export function leaveInboxView() {
  const wasActive = inboxActive;
  if (!wasActive) return false;
  inboxActive = false;
  document.body.classList.remove('inbox-view-active');
  document.getElementById('input-area')?.removeAttribute('hidden');
  document.getElementById('pending-question-banner')?.removeAttribute('hidden');
  syncInboxBadge();
  window.renderConvList?.();
  return true;
}

export async function toggleInboxView() {
  if (inboxActive) {
    leaveInboxView();
    const restoreId = previousConversationId;
    previousConversationId = '';
    if (restoreId) await window.openConversation?.(restoreId, { restoreScroll: true });
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
  renderInboxNow();
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
  if (relayId === 'self' && result.response?.question?.id) sessionAsks.set(result.response.question.id, result.response.question);
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
    leaveInboxView();
    previousConversationId = '';
    await window.openConversation?.(id);
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
  } finally {
    if (!done) for (const node of buttons) node.disabled = false;
  }
  if (done) {
    renderSessionAskCards();
    await refreshInbox();
  }
}

function bindClicks() {
  if (clickBound) return;
  clickBound = true;
  const host = document.getElementById('messages');
  host?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-inbox-action], [data-inbox-filter]') : null;
    if (!target || !target.closest('.inbox-view, .relay-ask-container')) return;
    event.preventDefault();
    void handleAction(target);
  });
  host?.addEventListener('input', (event) => {
    const field = event.target instanceof Element && event.target.classList.contains('inbox-answer-text') ? event.target : null;
    const key = field ? draftKey(field) : '';
    if (key) drafts.set(key, field.value);
  });
}

// ─── The card in the session ──────────────────────────────────────────────────

/**
 * The pending asks of the conversation on screen, as cards at the end of its
 * transcript (before the cards it waits on). Called with every render of the
 * question cards; a no-op while nothing changed.
 */
export function renderSessionAskCards() {
  const host = document.getElementById('messages');
  if (!host || IS_SHARED_VIEW) return;
  const id = String(currentConvId || '').trim();
  const shown = inboxActive || isStatusViewActive() || !id
    ? []
    : [...sessionAsks.values()]
      .filter((ask) => ask && (ask.conversationId || ask.session?.id) === id && ask.status === 'pending')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const key = JSON.stringify([id, shown.map((ask) => [ask.id, ask.status])]);
  const existing = host.querySelectorAll('.relay-ask-container');
  if (key === sessionCardKey && existing.length === shown.length && [...existing].every((node) => node.isConnected)) return;
  sessionCardKey = key;
  const focused = captureDrafts(host);
  existing.forEach((node) => node.remove());
  const firstQuestion = host.querySelector('.relay-question-container');
  for (const ask of shown) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg relay-ask-container';
    wrapper.dataset.askId = ask.id;
    wrapper.append(buildAskCard(document, { ...ask, session: ask.session || { id } }, { relay: { id: 'self', self: true }, mode: 'session', now: Date.now() }));
    if (firstQuestion) host.insertBefore(wrapper, firstQuestion);
    else host.append(wrapper);
  }
  restoreDrafts(host, focused);
}

/** Boot: the count, the session cards, a refresh every minute (paired relays). */
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
