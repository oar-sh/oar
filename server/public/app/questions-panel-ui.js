// 📓 Questions: the header icon with its count and the list that drops down
// under it, for the conversation on screen. questions-view.mjs orders and
// counts; inbox-view.mjs builds the cards; inbox-ui.js answers them.
//
// The list comes from GET /api/relay-asks?conversationId= when a
// conversation opens (again after a reconnect), and the socket's
// relay_ask_updated keeps it current: an ask that moved to another
// conversation (a compaction) leaves the old list and joins the new one.
// Asks on paired relays (mirrors) are never listed here.
//
// The list is a fixed panel on <body> (the recipe of the "watching" chip's
// list, relay-event-subscriptions-ui.js): under 📓, or under ︙ when 📓 went
// into the menu. On a phone it spans the width under the header over a dim
// backdrop.

import { apiFetch } from './api-client.js';
import { FONT_SCALE_CHANGE_EVENT, getUiScale } from './font-scaling.js';
import { HEADER_ACTIONS_CHANGE_EVENT, notifyHeaderActionsChanged } from './header-priority-actions.mjs';
import { buildAskCard } from './inbox-view.mjs';
import { bindInboxActionHost, captureDrafts, restoreDrafts, setInboxAskHooks } from './inbox-ui.js';
import { isOpeningGestureClick } from './tap-actions.js';
import { currentConvId, IS_SHARED_VIEW } from './store.js';
import { findTurnBubble } from './relay-board-view.js';
import { isStatusViewActive } from './status-view.mjs';
import { askStubHostKey, askStubKey, askStubText } from './questions-stub-view.mjs';
import {
  questionsAria,
  questionsBadge,
  questionsOfConversation,
  questionsPanelTitle,
} from './questions-view.mjs';

const PHONE_QUERY = '(max-width: 680px)';

// conversation id → Map(ask id → ask), for the conversation on screen.
const asksByConversation = new Map();
// The conversations whose list has come in at least once.
const loadedConversations = new Set();
let currentConversationId = '';
// One load per conversation at a time; `generation` drops a stale answer.
const loads = new Map();
// What the socket said while a load ran (conversation id → Map(ask id →
// ask, or null: it left that conversation)): laid over the list that comes
// back, which the relay read before them.
const updatesDuringLoad = new Map();
let generation = 0;
let panelOpen = false;
let panelAnchor = null;
let panelOpenedAt = 0;
// The ask the panel was opened at: marked while it is open, scrolled into
// view once.
let focusAskId = '';
let scrollToFocus = false;
// Where the list last hung from: kept while it is open, so 📓 hiding (its
// last pending ask answered) does not throw the list over to ︙.
let lastAnchorRect = null;
let renderedKey = '';
// The Inbox's "open" on an ask: the panel opens at it once its conversation
// is on screen and its list is in.
let pendingOpen = null;
// Details closed by hand in the panel (they open by default there).
const foldedDetails = new Set();
let started = false;

function toText(value) {
  return String(value ?? '').trim();
}

// A phone, upright or turned sideways: the list is a sheet under the header.
function isPhone() {
  if (document.documentElement.hasAttribute('data-phone-landscape')) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

function asksOf(conversationId) {
  return [...(asksByConversation.get(toText(conversationId))?.values() || [])];
}

/** The open conversation's questions as the panel orders them. */
export function currentQuestions(now = Date.now()) {
  return questionsOfConversation(asksOf(currentConversationId), currentConversationId, now);
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function timeOf(value) {
  const ms = Date.parse(toText(value));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The list as the relay sent it, with what the socket said meanwhile laid
 * over it: an ask it changed is kept unless the list's copy is newer (both
 * times are the relay's), one it moved away stays away.
 */
function storeList(conversationId, asks, updates = null) {
  const map = new Map();
  for (const ask of Array.isArray(asks) ? asks : []) {
    if (!ask?.id || ask.relayId || toText(ask.conversationId) !== conversationId) continue;
    map.set(ask.id, ask);
  }
  for (const [id, update] of updates || []) {
    const listed = map.get(id);
    if (listed && update && timeOf(listed.updatedAt) > timeOf(update.updatedAt)) continue;
    if (update) map.set(id, update);
    else map.delete(id);
  }
  asksByConversation.set(conversationId, map);
  loadedConversations.add(conversationId);
}

async function loadQuestions(conversationId) {
  const id = toText(conversationId);
  if (!id || IS_SHARED_VIEW) return null;
  const mine = ++generation;
  loads.set(id, mine);
  updatesDuringLoad.set(id, new Map());
  const response = await apiFetch(`/api/relay-asks?conversationId=${encodeURIComponent(id)}`);
  if (loads.get(id) !== mine) return response;
  loads.delete(id);
  const updates = updatesDuringLoad.get(id);
  updatesDuringLoad.delete(id);
  if (response && Array.isArray(response.asks)) storeList(id, response.asks, updates);
  else if (!loadedConversations.has(id)) storeList(id, [], updates);
  if (id === currentConversationId) {
    syncQuestionsHeaderButton();
    renderPanel();
    renderQuestionStubs();
    consumePendingOpen();
  }
  return response;
}

/** Reloads the open conversation's list (after a reconnect: whatever changed while away). */
export function refreshQuestions() {
  if (IS_SHARED_VIEW || !currentConversationId) return Promise.resolve(null);
  return loadQuestions(currentConversationId);
}

/**
 * The conversation on screen (null: none). Called on every render of a
 * conversation, the live poll's too: only a new one loads its list.
 */
export function setQuestionsConversation(conversationId) {
  const id = IS_SHARED_VIEW ? '' : toText(conversationId);
  // The Inbox asked to open another conversation at an ask: that is off.
  if (id && pendingOpen && pendingOpen.conversationId !== id) pendingOpen = null;
  if (id !== currentConversationId) {
    currentConversationId = id;
    if (panelOpen) closeQuestionsPanel({ focus: false });
    renderedKey = '';
    // Lists of conversations left are dropped: a return loads anew.
    for (const key of [...asksByConversation.keys()]) {
      if (key === id) continue;
      asksByConversation.delete(key);
      loadedConversations.delete(key);
    }
    if (id) {
      // Updates that come before the first list land here (and on it).
      if (!asksByConversation.has(id)) asksByConversation.set(id, new Map());
      void loadQuestions(id);
    }
    syncQuestionsHeaderButton();
    renderQuestionStubs();
  }
  consumePendingOpen();
}

/**
 * Socket (relay_ask_updated) or an answer route: one ask as it is now. An
 * ask of a paired relay (a mirror) is not listed here.
 */
export function noteQuestionAskUpdated(ask) {
  if (!ask?.id || ask.relayId) return;
  const target = toText(ask.conversationId || ask.session?.id);
  // A load running now read the relay before this: it is laid over its list.
  for (const [conversationId, updates] of updatesDuringLoad) {
    updates.set(ask.id, conversationId === target ? ask : null);
  }
  let touched = false;
  for (const [conversationId, map] of asksByConversation) {
    if (conversationId !== target && map.delete(ask.id)) touched = true;
  }
  const map = asksByConversation.get(target);
  if (map) {
    const known = map.get(ask.id);
    // An older copy (a route's answer after the socket's) does not win.
    if (!known || timeOf(ask.updatedAt) >= timeOf(known.updatedAt)) map.set(ask.id, ask);
    touched = true;
  }
  if (!touched) return;
  syncQuestionsHeaderButton();
  renderPanel();
  renderQuestionStubs();
}

// ─── The header icon ──────────────────────────────────────────────────────────

/** 📓's count and labels for the conversation on screen. */
export function syncQuestionsHeaderButton() {
  const button = document.getElementById('questions-btn');
  if (!button) return;
  const { pending, urgent } = currentQuestions();
  const counts = { pending: pending.length, urgent };
  const badge = questionsBadge(counts);
  // Available or not; whether it fits is the priority+ pass's call.
  button.hidden = IS_SHARED_VIEW || !pending.length;
  button.dataset.count = IS_SHARED_VIEW ? '0' : String(pending.length);
  button.dataset.urgent = IS_SHARED_VIEW ? '0' : String(urgent);
  const countEl = button.querySelector('.header-icon-count');
  if (countEl) {
    countEl.textContent = badge.text;
    countEl.classList.toggle('is-urgent', badge.urgent);
  }
  const label = questionsAria(counts);
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
  notifyHeaderActionsChanged();
}

// ─── The panel ────────────────────────────────────────────────────────────────

function ensureBackdrop() {
  let backdrop = document.getElementById('questions-panel-backdrop');
  if (backdrop) return backdrop;
  backdrop = document.createElement('div');
  backdrop.id = 'questions-panel-backdrop';
  backdrop.hidden = true;
  // Every tap closes. The click a touch still owes after opening the list
  // from ︙ never gets here: the ︙ entry's tap guard (tap-actions.js
  // bindMenuAction) swallows it before it reaches the page.
  backdrop.addEventListener('click', () => closeQuestionsPanel({ focus: false }));
  document.body.appendChild(backdrop);
  return backdrop;
}

function ensurePanel() {
  let panel = document.getElementById('questions-panel');
  if (panel) return panel;
  ensureBackdrop();
  panel = document.createElement('div');
  panel.id = 'questions-panel';
  panel.className = 'questions-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Questions');
  panel.hidden = true;
  document.body.appendChild(panel);
  bindInboxActionHost(panel, { scope: '.questions-panel' });
  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.('.questions-panel-close')) {
      event.preventDefault();
      closeQuestionsPanel();
    }
  });
  panel.addEventListener('toggle', (event) => {
    const details = event.target instanceof Element && event.target.matches('details.inbox-item-detail') ? event.target : null;
    const id = details?.closest?.('.inbox-item')?.dataset.itemId || '';
    if (!id || !details.isConnected) return;
    if (details.open) foldedDetails.delete(id);
    else foldedDetails.add(id);
  }, true);
  return panel;
}

// A box to place against, or null: an element that is not drawn has none.
function drawnRect(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect && (rect.width || rect.height) ? rect : null;
}

function placePanel() {
  const panel = document.getElementById('questions-panel');
  if (!panel || panel.hidden) return;
  const scale = getUiScale();
  const margin = 8 * scale;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const sheet = isPhone();
  panel.classList.toggle('is-sheet', sheet);
  if (sheet) {
    // Full width under the header; the sides come from the stylesheet.
    const header = drawnRect(document.getElementById('chat-header'));
    const top = Math.round((header ? header.bottom : 0) + 4 * scale);
    panel.style.left = '';
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.round(Math.max(120 * scale, viewportHeight - top - margin))}px`;
    return;
  }
  // Under 📓, else under ︙ (📓 went into the menu), right edges lined up.
  // 📓 hiding while the list is open (its last pending ask answered here)
  // leaves the list where it was.
  const rect = drawnRect(panelAnchor)
    || drawnRect(document.getElementById('questions-btn'))
    || lastAnchorRect
    || drawnRect(document.getElementById('chat-actions-menu-btn'));
  if (rect) lastAnchorRect = rect;
  if (!rect) {
    panel.style.top = `${Math.round(margin)}px`;
    panel.style.left = `${Math.round(margin)}px`;
    return;
  }
  const top = Math.round(rect.bottom + 4 * scale);
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.round(Math.max(120 * scale, viewportHeight - top - margin))}px`;
  panel.style.left = '0px';
  const width = panel.offsetWidth;
  const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin));
  panel.style.left = `${Math.round(left)}px`;
}

function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function renderPanel({ force = false } = {}) {
  const panel = document.getElementById('questions-panel');
  if (!panel) return;
  if (!panelOpen) {
    if (!panel.hidden || panel.childElementCount) {
      panel.hidden = true;
      panel.replaceChildren();
    }
    renderedKey = '';
    return;
  }
  const now = Date.now();
  const { pending, urgent, answered } = currentQuestions(now);
  const key = JSON.stringify([
    currentConversationId,
    focusAskId,
    [...pending, ...answered].map((ask) => [ask.id, ask.status, ask.urgency, ask.updatedAt, ask.choice || '', ask.answer || '']),
  ]);
  if (!force && key === renderedKey && panel.childElementCount) return;
  renderedKey = key;
  const focused = captureDrafts(panel);
  const scrollTop = panel.scrollTop;
  const head = el('div', 'questions-panel-head');
  head.append(el('span', 'questions-panel-title', questionsPanelTitle({ pending: pending.length, urgent })));
  const close = el('button', 'questions-panel-close', '✕');
  close.type = 'button';
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close questions');
  head.append(close);
  const body = el('div', 'questions-panel-body');
  const relay = { id: 'self', self: true };
  for (const ask of pending) body.append(buildAskCard(document, ask, { relay, mode: 'panel', now }));
  if (answered.length) {
    const divider = el('div', 'inbox-divider', 'Answered in the last day');
    divider.setAttribute('role', 'separator');
    body.append(divider);
    for (const ask of answered) body.append(buildAskCard(document, ask, { relay, mode: 'panel', now }));
  }
  if (!pending.length && !answered.length) body.append(el('p', 'questions-panel-empty', 'No questions in this conversation.'));
  for (const details of body.querySelectorAll('details.inbox-item-detail')) {
    if (foldedDetails.has(details.closest('.inbox-item')?.dataset.itemId || '')) details.open = false;
  }
  panel.replaceChildren(head, body);
  restoreDrafts(panel, focused);
  panel.hidden = false;
  panel.scrollTop = scrollTop;
  placePanel();
  if (focusAskId) {
    const card = [...panel.querySelectorAll('.inbox-item')].find((node) => node.dataset.itemId === focusAskId);
    if (card) {
      card.classList.add('questions-card-focus');
      // Once: a later re-render leaves the reader's scroll alone.
      if (scrollToFocus) card.scrollIntoView?.({ block: 'nearest' });
      scrollToFocus = false;
    }
  }
}

function syncBackdrop() {
  const backdrop = ensureBackdrop();
  backdrop.hidden = !(panelOpen && isPhone());
}

export function isQuestionsPanelOpen() {
  return panelOpen;
}

/**
 * Opens the list: under `anchor` (📓, or ︙ for its menu twin); with `askId`
 * that card is marked and scrolled into view.
 */
export function openQuestionsPanel({ anchor = null, askId = '' } = {}) {
  if (IS_SHARED_VIEW || !currentConversationId) return false;
  ensurePanel();
  if (!panelOpen) panelOpenedAt = Date.now();
  panelOpen = true;
  panelAnchor = anchor || document.getElementById('questions-btn');
  lastAnchorRect = null;
  focusAskId = toText(askId);
  scrollToFocus = !!focusAskId;
  // The keyboard would cover the list on a phone (as the ⚙ sheet does).
  if (isPhone()) document.getElementById('msg-input')?.blur?.();
  syncBackdrop();
  renderPanel({ force: true });
  syncQuestionsHeaderButton();
  return true;
}

export function closeQuestionsPanel({ focus = true } = {}) {
  if (!panelOpen) return false;
  const anchor = panelAnchor;
  panelOpen = false;
  panelAnchor = null;
  lastAnchorRect = null;
  focusAskId = '';
  scrollToFocus = false;
  syncBackdrop();
  renderPanel();
  syncQuestionsHeaderButton();
  if (focus) {
    // Back to what opened it; 📓 gone meanwhile (nothing left open): ︙.
    const target = [anchor, document.getElementById('questions-btn'), document.getElementById('chat-actions-menu-btn')]
      .find((node) => drawnRect(node));
    target?.focus?.({ preventScroll: true });
  }
  return true;
}

export function toggleQuestionsPanel({ anchor = null, askId = '' } = {}) {
  if (panelOpen) return closeQuestionsPanel();
  return openQuestionsPanel({ anchor, askId });
}

/** The Inbox's "open" on an ask: 📓 opens at it once the conversation is on screen. */
export function requestQuestionsPanelAt(conversationId, askId) {
  const id = toText(conversationId);
  if (!id || !toText(askId) || IS_SHARED_VIEW) return;
  pendingOpen = { conversationId: id, askId: toText(askId) };
}

/**
 * The Inbox's open has run (or failed): a request for a conversation that is
 * not on screen now is dropped, so it never fires on a later visit.
 */
export function settleQuestionsPanelRequest() {
  if (pendingOpen && pendingOpen.conversationId !== currentConversationId) pendingOpen = null;
}

function consumePendingOpen() {
  if (!pendingOpen || pendingOpen.conversationId !== currentConversationId) return;
  if (!loadedConversations.has(currentConversationId) || loads.has(currentConversationId)) return;
  const { askId } = pendingOpen;
  pendingOpen = null;
  openQuestionsPanel({ askId });
}

// ─── The stub in the asking turn's bubble ─────────────────────────────────────

const STUB_ROW_CLASS = 'msg-ask-stubs';
const STANDALONE_CLASS = 'relay-ask-stub-container';

function buildStub(ask) {
  const stub = document.createElement('button');
  stub.type = 'button';
  stub.className = 'msg-ask-stub';
  stub.dataset.askId = ask.id;
  const text = askStubText(ask);
  const urgent = ask.status === 'pending' && ask.urgency === 'now';
  stub.classList.toggle('is-urgent', urgent);
  stub.classList.toggle('is-closed', ask.status !== 'pending');
  if (urgent) {
    // "urgent" in red, the rest as the bubble's text.
    stub.append(document.createTextNode(text.replace(/urgent$/, '')));
    const word = document.createElement('span');
    word.className = 'msg-ask-stub-urgent';
    word.textContent = 'urgent';
    stub.append(word);
  } else {
    stub.textContent = text;
  }
  stub.title = ask.status === 'pending' ? 'Open this question in 📓' : 'Show this question in 📓';
  return stub;
}

// What a stub row goes before in a bubble: the rows a plan board goes before
// too (relay-board-view.js placeBoardSection), so the stubs end the reply's
// text, after its plan board.
const LIVE_TAIL = ':scope > .dots, :scope > #thinking-activity, :scope > .subagent-bubbles-container';
const REPLY_TAIL = ':scope > .msg-attachments, :scope > .msg-activity, :scope > .msg-workflow-runs, :scope > .msg-preview-cards, :scope > .msg-bubble-actions';

/** The row of stubs in `host` (a bubble, or the standalone container), made when missing and kept in place. */
function stubRowOf(host, { live = false, standalone = false } = {}) {
  let row = host.querySelector(`:scope > .${STUB_ROW_CLASS}`);
  if (!row) {
    row = document.createElement('div');
    row.className = STUB_ROW_CLASS;
  }
  const before = standalone ? null : host.querySelector(live ? LIVE_TAIL : REPLY_TAIL);
  if (row.parentNode !== host || row.nextSibling !== before) host.insertBefore(row, before);
  return row;
}

function standaloneContainer(el) {
  let wrapper = el.querySelector(`:scope > .${STANDALONE_CLASS}`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = `msg ${STANDALONE_CLASS}`;
  }
  // At the end of the transcript, before the cards a turn waits on.
  const firstQuestion = el.querySelector(':scope > .relay-question-container');
  if (firstQuestion) {
    if (wrapper.nextSibling !== firstQuestion) el.insertBefore(wrapper, firstQuestion);
  } else if (wrapper.parentNode !== el || wrapper.nextSibling) {
    el.appendChild(wrapper);
  }
  return wrapper;
}

/**
 * Every 📓 stub of the conversation on screen, where it belongs: one per ask,
 * at the end of the bubble of the turn that asked it (its reply, or the live
 * bubble while it runs), oldest first. An ask with no such bubble on the page
 * (asked before 0.9.22, on behalf of another session, carried over by a
 * compaction, or its turn not loaded) stands alone at the transcript's end
 * while it is pending. A cancelled ask leaves none. Idempotent: runs after
 * every render of the transcript, on the live bubble and on every change of
 * an ask; a stub that moved is taken from its old place, never doubled.
 */
export function renderQuestionStubs() {
  const el = document.getElementById('messages');
  if (!el || IS_SHARED_VIEW) return;
  const conversationId = toText(currentConvId);
  const onScreen = !!conversationId && conversationId === currentConversationId
    && !document.body.classList.contains('inbox-view-active') && !isStatusViewActive();
  const asks = onScreen
    ? asksOf(conversationId)
      .filter((ask) => toText(ask.conversationId) === conversationId && askStubText(ask))
      .sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt) || toText(a.id).localeCompare(toText(b.id)))
    : [];
  // Host element → where it is and the asks it shows, in order.
  const groups = new Map();
  for (const ask of asks) {
    const key = askStubHostKey(ask);
    const found = key ? findTurnBubble(el, key) : null;
    let host = found?.bubble || null;
    if (!host) {
      if (ask.status !== 'pending') continue;
      host = standaloneContainer(el);
    }
    if (!groups.has(host)) groups.set(host, { live: !!found?.live, standalone: !found, list: [] });
    groups.get(host).list.push(ask);
  }
  const keep = new Set();
  for (const [host, { live, standalone, list }] of groups) {
    const row = stubRowOf(host, { live, standalone });
    keep.add(row);
    const rowKey = JSON.stringify(list.map((ask) => [ask.id, askStubKey(ask)]));
    if (row.dataset.stubsKey === rowKey && row.childElementCount === list.length) continue;
    row.dataset.stubsKey = rowKey;
    row.replaceChildren(...list.map(buildStub));
  }
  // A row no longer wanted (its asks moved, closed beyond the list or another
  // conversation's), then a standalone container left empty.
  el.querySelectorAll(`.${STUB_ROW_CLASS}`).forEach((row) => { if (!keep.has(row)) row.remove(); });
  el.querySelectorAll(`:scope > .${STANDALONE_CLASS}`).forEach((wrapper) => {
    if (!wrapper.querySelector('.msg-ask-stub')) wrapper.remove();
  });
}

/** Boot: the icon's button, outside clicks, Escape, re-placing, the Inbox's hooks. */
export function initQuestionsPanel() {
  if (started || IS_SHARED_VIEW) return;
  started = true;
  setInboxAskHooks({
    onAskUpdated: noteQuestionAskUpdated,
    onOpenAsk: requestQuestionsPanelAt,
    onOpenSettled: settleQuestionsPanelRequest,
  });
  // A stub opens 📓 at its ask.
  document.getElementById('messages')?.addEventListener('click', (event) => {
    const stub = event.target instanceof Element ? event.target.closest('.msg-ask-stub') : null;
    if (!stub) return;
    event.preventDefault();
    event.stopPropagation();
    openQuestionsPanel({ askId: stub.dataset.askId || '' });
  });
  const button = document.getElementById('questions-btn');
  button?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleQuestionsPanel({ anchor: button });
  });
  document.addEventListener('click', (event) => {
    if (!panelOpen || isOpeningGestureClick(event, panelOpenedAt)) return;
    // composedPath: an answer may have re-rendered the panel already.
    const path = event.composedPath();
    const panel = document.getElementById('questions-panel');
    // The backdrop answers its own taps (with the opening touch's grace).
    const backdrop = document.getElementById('questions-panel-backdrop');
    if ([panel, backdrop, panelAnchor, button].some((node) => node && path.includes(node))) return;
    closeQuestionsPanel({ focus: false });
  });
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    closeQuestionsPanel();
  }, true);
  const replace = () => {
    if (!panelOpen) return;
    // The window changed: what the list hung from is measured anew.
    lastAnchorRect = null;
    syncBackdrop();
    placePanel();
  };
  window.addEventListener('resize', replace);
  window.addEventListener(FONT_SCALE_CHANGE_EVENT, replace);
  window.visualViewport?.addEventListener?.('resize', replace);
  // The header re-fits (an icon shown or put into ︙, the title, the
  // banner): what the list hangs from may have moved. The fit runs in the
  // frame after its notice; the list follows in the one after that.
  const followHeader = () => {
    if (!panelOpen) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (panelOpen) placePanel();
    }));
  };
  window.addEventListener(HEADER_ACTIONS_CHANGE_EVENT, followHeader);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(followHeader);
    for (const id of ['chat-header', 'chat-header-actions']) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
  }
}
