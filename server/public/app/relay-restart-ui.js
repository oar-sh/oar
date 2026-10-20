// A queued relay restart, as every device sees it, and the confirmations
// before one: which sessions it waits for (links), how long it has waited,
// that new messages are held, which background tasks survive, and — once the
// maximum wait ran out — the question: restart now, keep waiting, or cancel.
// The relay never restarts by itself past the wait
// (server/services/relay-restart-queue.mjs). The banner row lives in
// host-suspend-ui.js's #pending-action-banner; this module renders it.

import {
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  renderSummaryModalContent,
  setSummaryModalLoading,
  summaryModalState,
  showTransientRelayNotice,
} from './store.js';
import {
  cancelRelayRestart,
  keepWaitingForRelayRestart,
  loadRelayRestartMaxWaitSetting,
  loadRelayRestartPreview,
  requestRelayRestart,
  updateRelayRestartMaxWaitSetting as requestRelayRestartMaxWaitSetting,
} from './api-client.js';
import { describeRelayRestartError } from './relay-restart-error.mjs';

const CONFIRM_KIND = 'restart-relay';
const NOW_KIND = 'restart-relay-now';
const LIST_LIMIT = 6;

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

/** "less than a minute", "12 min", "1 h 5 min". */
export function formatWaited(ms) {
  const minutes = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatMaxWait(ms) {
  const value = Number(ms) || 0;
  return value > 0 ? formatWaited(value) : 'no limit';
}

function isQueued(state) {
  return String(state?.status || '') === 'queued';
}

function actionOf(state) {
  return state?.action === 'restart' || state?.restart ? 'restart' : 'shutdown';
}

function waitingSessions(state) {
  return Array.isArray(state?.waitingFor) ? state.waitingFor : [];
}

function runningTurns(state) {
  const fromList = waitingSessions(state).reduce((sum, entry) => sum + (Number(entry?.turns) || 0), 0);
  return fromList || Number(state?.queue?.processingCount || 0);
}

/** The question is up: the maximum wait ran out and the relay asks. */
export function isRelayRestartAsking(state) {
  return isQueued(state) && !!state?.question;
}

/** The banner's first line, e.g. "🌄 Relay restart queued — waiting for 2 sessions". */
export function relayRestartHeadline(state) {
  const action = actionOf(state);
  const icon = action === 'restart' ? '🌄' : '⏻';
  if (String(state?.status || '') === 'shutting_down') {
    return `${icon} Relay ${action === 'restart' ? 'restarting' : 'shutting down'} now…`;
  }
  if (!isQueued(state)) return '';
  const sessions = waitingSessions(state).length;
  const turns = runningTurns(state);
  const what = sessions > 0 ? plural(sessions, 'session') : turns > 0 ? plural(turns, 'running turn') : '';
  if (isRelayRestartAsking(state)) {
    const now = action === 'restart' ? 'restart now' : 'shut down now';
    return `${icon} The relay ${action} has waited ${formatMaxWait(state.maxWaitMs)}${what ? ` for ${what}` : ''} — ${now}, keep waiting or cancel?`;
  }
  if (!what) return `${icon} Relay ${action} queued — nothing is running, going ahead now`;
  return `${icon} Relay ${action} queued — waiting for ${what}`;
}

/** "waited 12 min of 30 min", from the start of the current waiting period. */
export function relayRestartWaitedText(state, nowMs = Date.now()) {
  if (!isQueued(state)) return '';
  const since = Date.parse(String(state.waitingSince || state.requestedAt || ''));
  if (!Number.isFinite(since)) return '';
  const waited = formatWaited(nowMs - since);
  const limit = Number(state.maxWaitMs) || 0;
  if (isRelayRestartAsking(state)) return `waited ${waited}`;
  return limit > 0 ? `waited ${waited} of ${formatMaxWait(limit)}` : `waited ${waited}, no time limit`;
}

// survives: true, false, or null for a task held since the last restart
// that its worker has not confirmed yet (nobody knows whether it runs).
function taskFate(task) {
  if (task?.survives === false) return 'may stop';
  if (task?.survives == null) return 'not yet confirmed';
  return 'keeps running';
}

/** "2 background agents: export (keeps running)". */
export function describeRestartBackgroundTask(task) {
  const title = String(task?.title || '').trim() || 'a session';
  const detail = String(task?.detail || '').trim() || plural(Number(task?.count) || 1, 'background task');
  return `${title} — ${detail} (${taskFate(task)})`;
}

function heldText(state) {
  const count = Number(state?.held?.count ?? (Number(state?.queue?.pendingCount || 0) + Number(state?.queue?.parkedCount || 0))) || 0;
  if (count > 0) return `New messages are held until the ${actionOf(state)}: ${plural(count, 'message')} waiting.`;
  return `New messages are held until the ${actionOf(state)}.`;
}

function sessionLink(entry, onOpen) {
  const link = document.createElement('a');
  link.href = '#';
  link.className = 'relay-restart-session-link';
  link.dataset.conversationId = String(entry?.conversationId || '');
  link.textContent = String(entry?.title || entry?.conversationId || 'a session');
  link.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen?.(String(entry?.conversationId || ''));
  });
  return link;
}

function detailLine(className, label) {
  const line = document.createElement('div');
  line.className = `relay-restart-detail ${className}`;
  if (label) line.appendChild(document.createTextNode(label));
  return line;
}

function actionButton(label, className, onClick, disabled) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `relay-toast-action ${className}`;
  btn.textContent = label;
  btn.disabled = !!disabled;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void onClick?.();
  });
  return btn;
}

/**
 * The banner row for a queued or starting restart. `handlers`: onOpen
 * (conversationId), onRestartNow, onKeepWaiting, onCancel; `busy` disables
 * the buttons while a request is in flight.
 */
export function renderRelayRestartRow(state, { nowMs = Date.now(), handlers = {}, busy = false } = {}) {
  const row = document.createElement('div');
  row.className = 'pending-action-row relay-restart-row';
  row.dataset.pending = 'relay-shutdown';
  if (isRelayRestartAsking(state)) row.dataset.asking = '1';
  const head = document.createElement('div');
  head.className = 'relay-restart-head';
  const text = document.createElement('span');
  text.className = 'pending-action-text';
  text.textContent = relayRestartHeadline(state);
  head.appendChild(text);
  const waited = relayRestartWaitedText(state, nowMs);
  if (waited) {
    const span = document.createElement('span');
    span.className = 'relay-restart-waited';
    span.textContent = `· ${waited}`;
    head.appendChild(span);
  }
  row.appendChild(head);
  if (!isQueued(state)) return row;

  const sessions = waitingSessions(state);
  if (sessions.length) {
    const line = detailLine('relay-restart-waiting-for', 'Waiting for: ');
    sessions.slice(0, LIST_LIMIT).forEach((entry, index) => {
      if (index) line.appendChild(document.createTextNode(', '));
      line.appendChild(sessionLink(entry, handlers.onOpen));
      const turns = Number(entry?.turns) || 0;
      if (turns > 1) line.appendChild(document.createTextNode(` (${turns} turns)`));
    });
    if (sessions.length > LIST_LIMIT) line.appendChild(document.createTextNode(`, +${sessions.length - LIST_LIMIT} more`));
    row.appendChild(line);
  }
  if (state.holdsNewTurns !== false) row.appendChild(detailLine('relay-restart-held', heldText(state)));
  const tasks = Array.isArray(state.backgroundTasks) ? state.backgroundTasks : [];
  if (tasks.length) {
    const line = detailLine('relay-restart-background', 'Background tasks: ');
    tasks.slice(0, LIST_LIMIT).forEach((task, index) => {
      if (index) line.appendChild(document.createTextNode('; '));
      line.appendChild(sessionLink(task, handlers.onOpen));
      const detail = String(task?.detail || '').trim();
      line.appendChild(document.createTextNode(`${detail ? ` — ${detail}` : ''} (${taskFate(task)})`));
    });
    if (tasks.length > LIST_LIMIT) line.appendChild(document.createTextNode(`; +${tasks.length - LIST_LIMIT} more`));
    if (state.survival?.summary) line.title = String(state.survival.summary);
    row.appendChild(line);
  }

  const actions = document.createElement('div');
  actions.className = 'relay-restart-actions';
  const nowLabel = actionOf(state) === 'restart' ? 'Restart now' : 'Shut down now';
  actions.appendChild(actionButton(nowLabel, 'relay-restart-now', handlers.onRestartNow, busy));
  if (isRelayRestartAsking(state)) {
    actions.appendChild(actionButton(`Keep waiting (${formatMaxWait(state.maxWaitMs)})`, 'relay-restart-keep-waiting', handlers.onKeepWaiting, busy));
  }
  actions.appendChild(actionButton(`Cancel ${actionOf(state)}`, 'pending-action-cancel', handlers.onCancel, busy));
  row.appendChild(actions);
  return row;
}

/** Updates the "waited …" labels in place, so the buttons are not rebuilt every second. */
export function refreshRelayRestartWaitedLabels(state, nowMs = Date.now(), root = document) {
  const text = relayRestartWaitedText(state, nowMs);
  for (const span of root?.querySelectorAll?.('.relay-restart-waited') || []) {
    span.textContent = text ? `· ${text}` : '';
  }
}

function listHtml(items) {
  return items.length ? `<ul class="suspend-host-blockers">${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '';
}

function sessionItemHtml(entry, suffix = '') {
  const title = escHtml(String(entry?.title || entry?.conversationId || 'a session'));
  return `<strong>${title}</strong>${suffix ? ` ${escHtml(suffix)}` : ''}`;
}

function backgroundSectionHtml(picture) {
  const tasks = Array.isArray(picture?.backgroundTasks) ? picture.backgroundTasks : [];
  if (!tasks.length) return '';
  const survive = tasks.filter((task) => task?.survives === true);
  const stop = tasks.filter((task) => task?.survives === false);
  const unknown = tasks.filter((task) => task?.survives == null);
  const item = (task) => `<strong>${escHtml(String(task?.title || 'a session'))}</strong> — ${escHtml(String(task?.detail || plural(Number(task?.count) || 1, 'background task')))}`;
  let html = '';
  if (stop.length) html += `<p><strong>These background tasks may stop:</strong></p>${listHtml(stop.map(item))}`;
  if (survive.length) html += `<p>These background tasks keep running:</p>${listHtml(survive.map(item))}`;
  if (unknown.length) html += `<p>Not yet confirmed by their worker since the last relay restart, so whether they still run is not known:</p>${listHtml(unknown.map(item))}`;
  if (picture?.survival?.summary) html += `<p class="settings-help">${escHtml(picture.survival.summary)}</p>`;
  return `<div class="relay-restart-background-list">${html}</div>`;
}

/**
 * The body of the Restart web relay confirmation for one picture (from
 * GET /api/relay/shutdown). Pure so its shapes are unit-testable.
 */
export function renderRestartConfirmBody(picture = {}, { maxWaitMs = 0 } = {}) {
  const sessions = Array.isArray(picture?.waitingFor) ? picture.waitingFor : [];
  const heldCount = Number(picture?.held?.count || 0);
  const parts = [];
  if (sessions.length) {
    parts.push(`<p>The restart waits until these running turns end:</p>`);
    parts.push(listHtml(sessions.map((entry) => sessionItemHtml(entry, Number(entry?.turns) > 1 ? `(${entry.turns} turns)` : ''))));
    parts.push(`<p>Until then new messages are held${heldCount ? ` (${plural(heldCount, 'message')} already waiting)` : ''}; they run after the restart. `
      + `${Number(maxWaitMs) > 0 ? `After ${escHtml(formatMaxWait(maxWaitMs))} the banner asks whether to restart now, keep waiting or cancel.` : 'There is no time limit on the wait (Settings › General).'}</p>`);
  } else {
    parts.push(`<p>Nothing is running: the relay restarts at once${heldCount ? `, and the ${plural(heldCount, 'waiting message')} run after it` : ''}.</p>`);
  }
  parts.push(backgroundSectionHtml(picture));
  const buttons = [];
  if (sessions.length) {
    buttons.push('<button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart when idle</button>');
    buttons.push('<button class="chat-title-action-btn danger-btn" type="button" onclick="confirmRestartRelayNow()">Restart now</button>');
  } else {
    buttons.push('<button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart web relay</button>');
  }
  buttons.push('<button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>');
  return `${parts.filter(Boolean).join('\n')}\n<div class="summary-modal-actions">${buttons.join('')}</div>`;
}

/** The body of the "Restart now" confirmation: what it does not wait for. */
export function renderRestartNowBody(picture = {}, { action = 'restart', offerCancel = false } = {}) {
  const sessions = Array.isArray(picture?.waitingFor) ? picture.waitingFor : [];
  const workersSurvive = picture?.survival?.workersSurvive !== false;
  const verb = action === 'restart' ? 'Restart' : 'Shut down';
  const parts = [];
  if (sessions.length) {
    if (workersSurvive) {
      parts.push(`<p><strong>${verb} now without waiting for ${plural(sessions.length, 'session')}:</strong></p>`);
      parts.push(listHtml(sessions.map((entry) => sessionItemHtml(entry, Number(entry?.turns) > 1 ? `(${entry.turns} turns)` : ''))));
      parts.push('<p>Their workers keep running and report back to the restarted relay; the live output of these turns pauses while the relay is away, and a turn whose reply does not arrive has to be sent again.</p>');
    } else {
      parts.push(`<p><strong>${verb} now may cut off ${plural(sessions.length, 'session')}:</strong></p>`);
      parts.push(listHtml(sessions.map((entry) => sessionItemHtml(entry))));
      parts.push('<p>Their workers may stop with the relay; a turn whose worker stops ends without a reply.</p>');
    }
  } else {
    parts.push('<p>No turn is running any more.</p>');
  }
  parts.push(backgroundSectionHtml(picture));
  parts.push(`<div class="summary-modal-actions">
    <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmRestartRelayNow()">${verb} now</button>
    ${offerCancel ? `<button class="chat-title-action-btn" type="button" onclick="cancelQueuedRelayRestart()">Cancel ${action}</button>` : ''}
    <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">${offerCancel ? 'Close' : 'Cancel'}</button>
  </div>`);
  return parts.filter(Boolean).join('\n');
}

let applyState = () => {};
let inFlight = false;
// What an open "now" button acts on: the action shown (a queued shutdown
// stays a shutdown) and the queued request it was shown for, or null from
// the ⋯ menu with nothing queued. The relay refuses a request that is gone.
let nowTarget = { action: 'restart', requestedAt: null };

function targetFrom(state) {
  return isQueued(state)
    ? { action: actionOf(state), requestedAt: state.requestedAt || null }
    : { action: 'restart', requestedAt: null };
}

/**
 * A new restart state: a dialog shown for a queued request that is gone (it
 * fired, was cancelled, the relay restarted) closes, so its button cannot
 * restart a relay that came back.
 */
export function noteRelayRestartStateForDialogs(state) {
  const kind = summaryModalState.kind;
  if (kind !== CONFIRM_KIND && kind !== NOW_KIND) return;
  const status = String(state?.status || '');
  const gone = status === 'shutting_down'
    || (nowTarget.requestedAt && (status !== 'queued' || String(state?.requestedAt || '') !== nowTarget.requestedAt));
  if (gone && !inFlight) closeSummaryModal();
}

/** host-suspend-ui.js hands in how a fresh state reaches the banner. */
export function setRelayRestartStateSink(fn) {
  applyState = typeof fn === 'function' ? fn : () => {};
}

export function isRelayRestartRequestInFlight() {
  return inFlight;
}

async function withInFlight(fn) {
  if (inFlight) return;
  inFlight = true;
  applyState(null, { rerenderOnly: true });
  try {
    await fn();
  } finally {
    inFlight = false;
    applyState(null, { rerenderOnly: true });
  }
}

async function loadPictureInto({ kind, title, subtitle, render }) {
  let result = null;
  try {
    result = await loadRelayRestartPreview('restart');
  } catch (error) {
    if (summaryModalState.kind !== kind) return;
    renderSummaryModalContent({
      title,
      kind,
      bodyHtml: `<div class="summary-error">Could not read what is running: ${escHtml(error?.message || 'unknown error')}</div>
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart when idle</button>
          <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
        </div>`,
    });
    return;
  }
  if (summaryModalState.kind !== kind) return;
  if (result?.status) applyState(result);
  renderSummaryModalContent({ title, subtitle, kind, bodyHtml: render(result || {}) });
}

/** ⋯ → Restart web relay: shows what the restart would wait for first. */
export function openRestartRelayConfirmation() {
  nowTarget = { action: 'restart', requestedAt: null };
  const title = 'Restart web relay';
  openSummaryModal({
    title,
    subtitle: 'Queues restart via /api/relay/shutdown',
    kind: CONFIRM_KIND,
    bodyHtml: '<div class="summary-loading">Checking what is running…</div>',
  });
  setSummaryModalLoading(true);
  void loadPictureInto({
    kind: CONFIRM_KIND,
    title,
    subtitle: 'Queues restart via /api/relay/shutdown',
    render: (result) => {
      nowTarget = targetFrom(result);
      if (isQueued(result)) {
        // Already queued: the same choices as the banner.
        return `<p>${escHtml(relayRestartHeadline(result))}.</p>${renderRestartNowBody(result, { action: actionOf(result), offerCancel: true })}`;
      }
      return renderRestartConfirmBody(result.preview || {}, { maxWaitMs: result.maxWaitMs ?? result.preview?.maxWaitMs ?? 0 });
    },
  }).finally(() => setSummaryModalLoading(false));
}

/** The banner's "Restart now": a confirmation that names what it cuts off. */
export function openRestartNowConfirmation(state = null) {
  nowTarget = targetFrom(state);
  const action = nowTarget.action;
  const title = action === 'restart' ? 'Restart web relay now' : 'Shut down web relay now';
  openSummaryModal({
    title,
    subtitle: 'Does not wait for the running turns',
    kind: NOW_KIND,
    bodyHtml: state ? renderRestartNowBody(state, { action }) : '<div class="summary-loading">Checking what is running…</div>',
  });
  // Fresh from the relay: the banner's copy can be a second old.
  void loadPictureInto({
    kind: NOW_KIND,
    title,
    subtitle: 'Does not wait for the running turns',
    render: (result) => {
      // A dialog for a queued request keeps naming that request: if it is
      // gone, the relay refuses the button.
      if (isQueued(result) && !state) nowTarget = targetFrom(result);
      return renderRestartNowBody(isQueued(result) ? result : (result.preview || {}), { action });
    },
  });
}

export async function confirmRestartRelayNow() {
  await withInFlight(async () => {
    setSummaryModalLoading(true);
    let result = null;
    try {
      const { action, requestedAt } = nowTarget;
      result = await requestRelayRestart({
        reason: `manual-${action}-now`,
        restart: action === 'restart',
        immediate: true,
        ...(requestedAt ? { expectRequestedAt: requestedAt } : {}),
      });
    } catch (error) {
      closeSummaryModal();
      const { kind, text } = describeRelayRestartError(error);
      if (kind === 'refused') alert(text);
      else showTransientRelayNotice(text, 9000);
      return;
    }
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to restart the relay');
      return;
    }
    if (result.stale) {
      showTransientRelayNotice('That queued restart is no longer pending; nothing was restarted.', 7000);
      if (result.status) applyState(result);
      return;
    }
    if (result.accepted === false) {
      showTransientRelayNotice('The relay is already shutting down or restarting.', 7000);
      return;
    }
    showTransientRelayNotice(nowTarget.action === 'restart' ? 'Relay restarting now.' : 'Relay shutting down now.', 7000);
  });
}

export async function keepWaitingForQueuedRelayRestart() {
  await withInFlight(async () => {
    let result = null;
    try {
      result = await keepWaitingForRelayRestart();
    } catch (error) {
      showTransientRelayNotice(`Failed to keep the relay restart waiting: ${error?.message || 'unknown error'}`, 6000);
      return;
    }
    if (!result?.ok) return;
    applyState(result);
    showTransientRelayNotice(result.extended
      ? `The relay restart keeps waiting, for at most ${formatMaxWait(result.maxWaitMs)} more.`
      : 'No relay restart was pending.', 5000);
  });
}

export async function cancelQueuedRelayRestart() {
  await withInFlight(async () => {
    let result = null;
    try {
      result = await cancelRelayRestart();
    } catch (error) {
      showTransientRelayNotice(`Failed to cancel the queued relay restart: ${error?.message || 'unknown error'}`, 6000);
      return;
    }
    if (summaryModalState.kind === CONFIRM_KIND || summaryModalState.kind === NOW_KIND) closeSummaryModal();
    if (!result?.ok) {
      showTransientRelayNotice('Failed to cancel the queued relay restart.', 5000);
      return;
    }
    applyState(result);
    showTransientRelayNotice(result.cancelled ? 'Queued relay restart cancelled; held messages go out now.' : 'No relay restart was pending.', 4000);
  });
}

// ─── Settings › General: the maximum wait ────────────────────────────────────
// Mirrors server/services/relay-restart-queue.mjs (the browser cannot import
// it); the select's options are the allowed values.
let maxWaitMinutes = 30;
let maxWaitUpdateInFlight = false;

function syncMaxWaitSelect() {
  const select = document.getElementById('relay-restart-max-wait-select');
  if (!select || select.tagName !== 'SELECT') return;
  select.value = String(maxWaitMinutes);
  select.disabled = maxWaitUpdateInFlight;
}

export async function refreshRelayRestartMaxWaitSetting() {
  syncMaxWaitSelect();
  try {
    const result = await loadRelayRestartMaxWaitSetting();
    if (result && Number.isFinite(Number(result.maxWaitMinutes))) maxWaitMinutes = Number(result.maxWaitMinutes);
  } catch {
    // Keep the last known value; the setting is not critical.
  } finally {
    syncMaxWaitSelect();
  }
}

export async function updateRelayRestartMaxWaitSetting(value) {
  if (maxWaitUpdateInFlight) {
    syncMaxWaitSelect();
    return;
  }
  maxWaitUpdateInFlight = true;
  syncMaxWaitSelect();
  try {
    const result = await requestRelayRestartMaxWaitSetting(Number(value));
    if (result && Number.isFinite(Number(result.maxWaitMinutes))) maxWaitMinutes = Number(result.maxWaitMinutes);
    showTransientRelayNotice(maxWaitMinutes === 0
      ? 'A queued relay restart now waits without a time limit.'
      : `A queued relay restart asks after ${formatMaxWait(maxWaitMinutes * 60_000)}.`);
  } catch (error) {
    alert(error?.message || 'Failed to update the maximum wait of a queued relay restart.');
  } finally {
    maxWaitUpdateInFlight = false;
    syncMaxWaitSelect();
  }
}

export function initRelayRestartUi({ exposeOnWindow = true } = {}) {
  if (!exposeOnWindow || typeof window === 'undefined') return;
  window.openRestartRelayConfirmation = openRestartRelayConfirmation;
  window.openRestartNowConfirmation = openRestartNowConfirmation;
  window.confirmRestartRelayNow = confirmRestartRelayNow;
  window.keepWaitingForQueuedRelayRestart = keepWaitingForQueuedRelayRestart;
  window.cancelQueuedRelayRestart = cancelQueuedRelayRestart;
  window.updateRelayRestartMaxWaitSetting = updateRelayRestartMaxWaitSetting;
}

export function __resetRelayRestartUiForTests() {
  applyState = () => {};
  inFlight = false;
  nowTarget = { action: 'restart', requestedAt: null };
  maxWaitMinutes = 30;
  maxWaitUpdateInFlight = false;
}
