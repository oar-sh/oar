// Agent SDK rows inside Settings: the Claude Agent SDK in the Claude, Claude
// API and DeepSeek tabs, the Cursor SDK in the Cursor tab, and the Windows
// helper (koffi, the relay's own lock check) under General.
//
// The relay installs these on demand from pins it ships (agent-sdk-store.mjs),
// so a row is mostly a window on the store: its state, the pinned and the
// installed version, the live npm log, the last error and the next automatic
// retry, and the one button that state calls for. Nothing here composes a
// command; the request carries an SDK id and the relay looks it up.
//
// Every visible state comes from the `agent_sdk_state` broadcast (the same
// payload as GET /api/agent-sdks/status), so an install survives closing the
// modal or being started by a first chat or another device. Rendering reads
// the latest payload and never assumes a local step sequence; the log is
// redrawn from the whole buffer whenever `logSeq` moves.
//
// The markup holds only empty mounts (`data-agent-sdk="<id>"`); this module
// draws the row into each. One SDK can have several mounts (Claude's), so the
// parts are found by `data-part`, not by id. The log is host process output:
// it goes in with textContent, and the little that goes through innerHTML is
// static and escaped with escHtml anyway.

import { escHtml } from './store.js';
import { cancelAgentSdkInstall, getAgentSdkStatus, startAgentSdkInstall } from './api-client.js';
import { updateProviderReadinessInputs } from './provider-readiness.mjs';

export const AGENT_SDK_IDS = Object.freeze(['claude', 'cursor', 'koffi']);
const STATES = Object.freeze(['missing', 'installing', 'ready', 'error', 'unsupported']);
const ACTIONS = Object.freeze(['install', 'retry', 'reinstall', 'cancel']);
const ACTION_LABELS = Object.freeze({ install: 'Install', retry: 'Retry', reinstall: 'Reinstall', cancel: 'Cancel' });
// Until the first payload names them.
const DEFAULT_LABELS = Object.freeze({ claude: 'Claude Agent SDK', cursor: 'Cursor SDK', koffi: 'Windows helper' });
const STATE_WORDS = Object.freeze({
  missing: 'Not installed',
  installing: 'Installing…',
  ready: 'Installed',
  error: 'Install failed',
  unsupported: 'Not available on this platform',
});
const LOG_WORDS = Object.freeze({ installing: 'Running', ready: 'Finished', error: 'Failed' });

let sdkState = { root: null, host: null, sdks: {} };
let loadFailed = false;
// A request the relay refused before any broadcast, on the row that sent it;
// the SDK's next transition clears it.
let localErrors = {};
const requestsInFlight = new Set();
// One-shot per failed install: its log opens once, and a later redraw of the
// same payload does not fight the user closing it.
const expandedFailures = new Map();
let statusRefresh = null;

function normalizeId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return AGENT_SDK_IDS.includes(value) ? value : '';
}

function normalizeState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return STATES.includes(value) ? value : 'missing';
}

function labelOf(id, status) {
  return String(status?.label || '').trim() || DEFAULT_LABELS[id] || id;
}

/** The Windows helper only where it can exist; the SDK rows always. */
export function isAgentSdkRowShown(id, snapshot) {
  if (normalizeId(id) !== 'koffi') return true;
  const status = snapshot?.sdks?.koffi;
  if (!status || typeof status !== 'object') return false;
  if (status.support) return status.support !== 'no';
  return snapshot?.host?.platform === 'win32';
}

/** "Installed · pinned 0.3.1 · installed 0.3.1", with whose install it waits for. */
export function agentSdkStatusText(status) {
  if (!status || typeof status !== 'object') return 'Checking…';
  const state = normalizeState(status.state);
  const heldBy = Number(status.heldBy) || 0;
  const parts = [state === 'installing' && heldBy
    ? `Installing by another OAR process (pid ${heldBy})…`
    : STATE_WORDS[state]];
  const pinned = String(status.pinned || '').trim();
  const installed = String(status.installed || '').trim();
  if (pinned) parts.push(`pinned ${pinned}`);
  if (installed) parts.push(`installed ${installed}`);
  else if (state !== 'unsupported') parts.push('none installed');
  return parts.join(' · ');
}

export function agentSdkStatusState(status) {
  if (!status || typeof status !== 'object') return 'pending';
  const state = normalizeState(status.state);
  if (state === 'ready') return 'active';
  if (state === 'error' && status.kind !== 'cancelled') return 'error';
  if (state === 'installing') return 'pending';
  return 'unconfigured';
}

function formatRetryTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

// A Reinstall that failed over a folder that still checks out: the row stays
// ready (that folder is what the relay goes on using), with the failure here.
function reinstallFailureOf(status) {
  if (normalizeState(status?.state) !== 'ready') return null;
  const failure = status.reinstallFailure;
  return failure && typeof failure === 'object' && String(failure.error || '').trim() ? failure : null;
}

/** The line under the row: the error, the next automatic retry. */
export function agentSdkNoteText(status) {
  if (!status || typeof status !== 'object') return '';
  const state = normalizeState(status.state);
  const reinstall = reinstallFailureOf(status);
  if (reinstall) {
    const reason = String(reinstall.error).trim().replace(/\.+$/, '');
    const folder = String(status.dir || status.folder || '').trim() || 'The installed folder';
    return `Reinstall failed: ${reason}. ${folder} stays in use.`;
  }
  const parts = [];
  // "Not available" is the whole story already in the status line.
  const error = String(status.error || '').trim();
  if (error && state === 'error') parts.push(error);
  if (status.retryAt && state === 'error') {
    const time = formatRetryTime(status.retryAt);
    if (time) parts.push(`Next automatic retry at ${time}.`);
  }
  return parts.join(' ');
}

/** The buttons a row offers, in order. */
export function agentSdkActions(status, { reinstall = true } = {}) {
  if (!status || typeof status !== 'object') return [];
  switch (normalizeState(status.state)) {
    case 'missing': return ['install'];
    case 'installing': return ['cancel'];
    case 'error': return ['retry'];
    case 'ready': return reinstall ? ['reinstall'] : [];
    default: return [];
  }
}

export function agentSdkLogSummary(status) {
  const word = status?.kind === 'cancelled' ? 'Cancelled'
    : reinstallFailureOf(status) ? LOG_WORDS.error
      : (LOG_WORDS[normalizeState(status?.state)] || 'Install');
  return `${word} · install log`;
}

function part(mount, name) {
  return mount.querySelector(`[data-part="${name}"]`);
}

function setHidden(element, hidden) {
  if (element) element.hidden = !!hidden;
}

function mountSkeleton(mount, id) {
  if (mount.dataset.agentSdkMounted === '1') return;
  mount.dataset.agentSdkMounted = '1';
  const buttons = ACTIONS.map((action) => (
    `<button type="button" class="summary-btn" data-action="${escHtml(action)}" hidden>${escHtml(ACTION_LABELS[action])}</button>`
  )).join('');
  mount.innerHTML = `
    <div class="settings-row" style="margin-bottom: 0;">
      <span class="cli-install-label" data-part="label">${escHtml(DEFAULT_LABELS[id])}</span>
      <div class="settings-help settings-provider-status" data-part="status" style="flex: 1 1 auto;">Checking…</div>
      <div class="settings-inline-actions">${buttons}</div>
    </div>
    <div class="settings-help settings-provider-status settings-gap-xs" data-part="note" hidden></div>
    <details class="cli-install-log" data-part="log-details" hidden>
      <summary data-part="log-summary">Install log</summary>
      <pre data-part="log"></pre>
    </details>
  `;
  for (const button of mount.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => { void runAgentSdkAction(id, button.dataset.action); });
  }
}

function renderMount(mount, { expandFailure = false } = {}) {
  const id = normalizeId(mount.dataset.agentSdk);
  if (!id) return;
  mountSkeleton(mount, id);
  const status = sdkState.sdks?.[id] || null;
  const shown = isAgentSdkRowShown(id, sdkState);
  setHidden(mount, !shown);
  if (!shown) return;

  const label = part(mount, 'label');
  if (label) label.textContent = labelOf(id, status);

  const statusLine = part(mount, 'status');
  if (statusLine) {
    // The same words as the store's error, which the note shows already.
    const localError = localErrors[id] && localErrors[id] !== String(status?.error || '').trim() ? localErrors[id] : '';
    statusLine.textContent = localError
      || (!status && loadFailed ? 'Unable to load the SDK status.' : agentSdkStatusText(status));
    statusLine.dataset.state = localError || (!status && loadFailed) ? 'error' : agentSdkStatusState(status);
  }

  // The Windows helper has nothing to reinstall: its state and a Retry.
  const offered = agentSdkActions(status, { reinstall: id !== 'koffi' });
  const busy = requestsInFlight.has(id);
  for (const button of mount.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    setHidden(button, !offered.includes(action));
    // canInstall is false while spawns are off or the folder is unusable;
    // Cancel needs nothing but the install it stops.
    button.disabled = busy || (action !== 'cancel' && status?.canInstall === false);
  }

  const note = part(mount, 'note');
  const noteText = agentSdkNoteText(status);
  if (note) {
    note.textContent = noteText;
    note.dataset.state = noteText && status?.kind !== 'cancelled' ? 'error' : '';
  }
  setHidden(note, !noteText);

  const details = part(mount, 'log-details');
  const log = String(status?.log || '');
  const showLog = !!status && (normalizeState(status.state) === 'installing' || log.length > 0);
  setHidden(details, !showLog);
  const summary = part(mount, 'log-summary');
  if (summary && status) summary.textContent = agentSdkLogSummary(status);
  const logBox = part(mount, 'log');
  // Keyed on the install, not on logSeq alone: a new install starts with an
  // empty buffer.
  const logKey = `${status?.startedAt || ''}|${status?.logSeq || 0}`;
  if (logBox && showLog && mount.dataset.logKey !== logKey) {
    logBox.textContent = log;
    logBox.scrollTop = logBox.scrollHeight;
    mount.dataset.logKey = logKey;
  }
  if (details && showLog && expandFailure) details.open = true;
}

export function renderAgentSdkRows() {
  if (typeof document === 'undefined') return;
  const expand = new Set();
  for (const id of AGENT_SDK_IDS) {
    const status = sdkState.sdks?.[id];
    const failed = normalizeState(status?.state) === 'error' || !!reinstallFailureOf(status);
    if (!status || !failed || !status.log) continue;
    const signature = `${status.startedAt || ''}|${status.finishedAt || ''}`;
    if (expandedFailures.get(id) === signature) continue;
    expandedFailures.set(id, signature);
    if (status.kind !== 'cancelled') expand.add(id);
  }
  for (const mount of document.querySelectorAll('[data-agent-sdk]')) {
    renderMount(mount, { expandFailure: expand.has(normalizeId(mount.dataset.agentSdk)) });
  }
}

// A broadcast can outrun the HTTP response that started it. Within one
// install (same startedAt) logSeq only grows, so an older snapshot never
// regresses the log or the state.
function isStaleStatus(current, incoming) {
  if (!current || !incoming) return false;
  if (current.startedAt && incoming.startedAt && incoming.startedAt < current.startedAt) return true;
  if (!current.startedAt || current.startedAt !== incoming.startedAt) return false;
  const currentSeq = Number(current.logSeq || 0);
  const incomingSeq = Number(incoming.logSeq || 0);
  if (incomingSeq < currentSeq) return true;
  // Equal: a settled install is not reopened by the slower answer that
  // snapshotted its start.
  return incomingSeq === currentSeq
    && normalizeState(current.state) !== 'installing'
    && normalizeState(incoming.state) === 'installing';
}

/**
 * Single entry point for every payload (GET, POST answers, the broadcast).
 * It also feeds provider readiness, so a failed SDK shows up wherever that is
 * asked.
 */
export function applyAgentSdkState(payload) {
  if (!payload || typeof payload !== 'object' || !payload.sdks || typeof payload.sdks !== 'object') {
    renderAgentSdkRows();
    return sdkState;
  }
  const sdks = { ...sdkState.sdks };
  for (const id of AGENT_SDK_IDS) {
    const incoming = payload.sdks[id];
    if (!incoming || typeof incoming !== 'object' || isStaleStatus(sdks[id], incoming)) continue;
    const before = sdks[id];
    if (!before || before.state !== incoming.state || before.startedAt !== incoming.startedAt) delete localErrors[id];
    sdks[id] = incoming;
  }
  sdkState = {
    root: typeof payload.root === 'string' ? payload.root : sdkState.root,
    host: payload.host && typeof payload.host === 'object' ? payload.host : sdkState.host,
    sdks,
  };
  loadFailed = false;
  updateProviderReadinessInputs({ agentSdks: sdkState });
  renderAgentSdkRows();
  return sdkState;
}

export function getAgentSdkState() {
  return sdkState;
}

/** Reads the rows; a second caller joins the read in flight. */
export function refreshAgentSdkRows() {
  if (statusRefresh) return statusRefresh;
  const promise = (async () => {
    try {
      const payload = await getAgentSdkStatus();
      if (!payload) {
        loadFailed = true;
        renderAgentSdkRows();
        return null;
      }
      return applyAgentSdkState(payload);
    } finally {
      if (statusRefresh === promise) statusRefresh = null;
    }
  })();
  statusRefresh = promise;
  return promise;
}

/** Install, Retry, Reinstall or Cancel, from a row's button. */
export async function runAgentSdkAction(sdk, action) {
  const id = normalizeId(sdk);
  const wanted = ACTIONS.includes(action) ? action : '';
  if (!id || !wanted || requestsInFlight.has(id)) return;
  requestsInFlight.add(id);
  delete localErrors[id];
  renderAgentSdkRows();
  try {
    const payload = wanted === 'cancel'
      ? await cancelAgentSdkInstall(id)
      : await startAgentSdkInstall(id, { reinstall: wanted === 'reinstall' });
    applyAgentSdkState(payload);
  } catch (error) {
    localErrors = { ...localErrors, [id]: String(error?.message || 'The SDK request failed.') };
    // The refusal carried the rows, but as a throw: read them again.
    await refreshAgentSdkRows().catch(() => {});
  } finally {
    requestsInFlight.delete(id);
    renderAgentSdkRows();
  }
}

/** Tests only. */
export function resetAgentSdkUiForTests() {
  sdkState = { root: null, host: null, sdks: {} };
  loadFailed = false;
  localErrors = {};
  requestsInFlight.clear();
  expandedFailures.clear();
  statusRefresh = null;
}
