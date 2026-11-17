// The worker log view: the end of the open conversation's worker log (what
// its worker process wrote to stdout and stderr), opened from the chat menu.
// The last lines come from GET /api/conversation/:id/worker-log; new bytes
// arrive as `worker_log_chunk`, which the relay sends only to pages watching
// the conversation's log (`worker_log_watch`). A chunk that does not continue
// where the view stands (a dropped chunk, a log rolled over at a relaunch)
// reads the tail again. "Load earlier" pages back up to 5 MB. Everything was
// cleaned and scrubbed on the relay; there is no download.
//
// It is the task console's view (task-console-render.mjs, the same markup
// classes): above the composer on wider screens, full screen on phones.
// Escape, ×, a click outside, the system back and a switch to another
// conversation close it.

import { apiFetchOrThrow } from './api-client.js';
import { IS_SHARED_VIEW, currentConvId, onCurrentConvChange } from './store.js';
import { createViewerHistory } from './viewer-history.mjs';
import { getSocket } from './socket-handlers.js';
import { bindMenuAction } from './tap-actions.js';
import { createTaskConsoleWatch } from './task-console-watch.mjs';
import { createLineFolder } from './task-output-text.mjs';
import { buildLineNode, chunkAction, chunkEndOffset, loadEarlierState } from './task-console-render.mjs';

const TAIL_LINES = 2000;
// Wider than a phone, the view stops above the composer when the composer's
// top is at least this far down the window; otherwise it covers the page.
const PHONE_MAX_WIDTH = 680;
const ABOVE_COMPOSER_MIN_TOP = 360;
// What may come in live before the tail is read again.
const LIVE_LINES_MAX = 20_000;
const LIVE_BYTES_MAX = 5 * 1024 * 1024;

const wl = {
  open: false,
  conversationId: '',
  kind: '',
  message: '',
  error: '',
  note: '',
  loading: false,
  loadingEarlier: false,
  fetchToken: 0,
  earlierNodes: [],
  folder: null,
  folded: { lines: [], partial: '' },
  liveNodes: [],
  partialNode: null,
  startOffset: 0,
  nextOffset: 0,
  size: 0,
  mtime: null,
  hasMoreBefore: false,
  loadedBytes: 0,
  // Bytes appended live since the tail was read.
  liveBytes: 0,
  following: true,
  pendingChunks: null,
  refetching: false,
  // Closed while offline: the relay is told at the next connect.
  unwatchPending: false,
  tickTimer: null,
  info: { provider: '', sdkSessionId: '', dir: '', path: '', previous: [] },
  offSwitch: null,
};

let viewHistory = null;
let initialized = false;
const logWatch = createTaskConsoleWatch({
  getSocket,
  events: { watch: 'worker_log_watch', unwatch: 'worker_log_unwatch' },
  itemKey: null,
});

function elements() {
  return {
    modal: document.getElementById('worker-log-modal'),
    meta: document.getElementById('worker-log-meta'),
    path: document.getElementById('worker-log-path'),
    scroll: document.getElementById('worker-log-scroll'),
    earlier: document.getElementById('worker-log-earlier'),
    earlierTop: document.getElementById('worker-log-earlier-top'),
    body: document.getElementById('worker-log-body'),
    status: document.getElementById('worker-log-status'),
    jump: document.getElementById('worker-log-jump'),
  };
}

function isAtBottom(scroll) {
  return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(mtime) {
  const at = Number(mtime);
  if (!Number.isFinite(at) || at <= 0) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const { meta, path } = elements();
  const { provider, sdkSessionId, dir, previous } = wl.info;
  if (meta) {
    const parts = [];
    if (provider) parts.push(provider);
    if (sdkSessionId) parts.push(`session ${sdkSessionId}`);
    if (wl.kind === 'file') {
      parts.push(formatBytes(wl.size));
      const age = formatAge(wl.mtime);
      if (age) parts.push(`last write ${age}`);
    }
    if (previous.length) parts.push(`earlier: ${previous.map((file) => file.name).join(', ')}`);
    meta.textContent = parts.join(' · ');
  }
  if (path) {
    path.textContent = wl.info.path ? wl.info.path : (dir ? `Folder: ${dir}` : '');
    path.title = wl.info.path || dir || '';
  }
  syncLayout();
}

/**
 * Wider than a phone, the view ends above the composer, so the chat's input
 * stays in view; without room above it, the view covers the page.
 */
function syncLayout() {
  const { modal } = elements();
  if (!modal) return;
  let bottom = 0;
  if (wl.open && window.innerWidth > PHONE_MAX_WIDTH) {
    const composer = document.getElementById('input-area');
    const rect = composer && !composer.hidden ? composer.getBoundingClientRect?.() : null;
    if (rect && rect.height > 0 && rect.top >= ABOVE_COMPOSER_MIN_TOP && rect.top < window.innerHeight) {
      bottom = Math.ceil(window.innerHeight - rect.top + 6);
    }
  }
  modal.classList.toggle('tc-above-panel', bottom > 0);
  modal.style.bottom = bottom > 0 ? `${bottom}px` : '';
  const dialog = modal.querySelector('[role="dialog"]');
  if (bottom > 0) dialog?.removeAttribute('aria-modal');
  else dialog?.setAttribute('aria-modal', 'true');
}

function renderStatus() {
  const { status } = elements();
  if (!status) return;
  const hasLines = wl.earlierNodes.length || wl.folded.lines.length || wl.folded.partial;
  let text = '';
  if (wl.error) text = wl.error;
  else if (wl.kind === 'none') text = wl.message || 'No worker log yet.';
  else if (wl.loading && !hasLines) text = 'Loading…';
  else if (!hasLines) text = 'The worker log is empty. Lines appear as the worker writes them.';
  if (wl.note) text = text ? `${text} ${wl.note}` : wl.note;
  status.textContent = text;
  status.hidden = !text;
}

function renderEarlierButton() {
  const { earlier, earlierTop } = elements();
  const state = loadEarlierState({ hasMoreBefore: wl.hasMoreBefore, loadedBytes: wl.loadedBytes, loading: wl.loadingEarlier });
  for (const button of [earlier, earlierTop]) {
    if (!button) continue;
    button.hidden = state.hidden;
    button.disabled = state.disabled;
    button.textContent = state.text;
  }
}

// ─── Lines ───────────────────────────────────────────────────────────────────

function clearLines() {
  const { body, jump } = elements();
  if (body) body.textContent = '';
  wl.earlierNodes = [];
  wl.liveNodes = [];
  wl.partialNode = null;
  wl.folder = createLineFolder();
  wl.folded = { lines: [], partial: '' };
  if (jump) jump.hidden = true;
}

function afterContentChange(appended) {
  const { scroll, jump } = elements();
  renderStatus();
  if (!scroll) return;
  if (wl.following) {
    scroll.scrollTop = scroll.scrollHeight;
    if (jump) jump.hidden = true;
  } else if (appended && jump) {
    jump.hidden = false;
  }
}

/** Draw what the folder holds: the last known line again (its ×N can grow), then the new ones. */
function renderLive() {
  const { body } = elements();
  if (!body) return;
  const { lines, partial } = wl.folded;
  let appended = false;
  const from = Math.max(0, wl.liveNodes.length - 1);
  for (let index = from; index < lines.length; index += 1) {
    const node = buildLineNode(document, lines[index]);
    const existing = wl.liveNodes[index];
    if (existing) {
      existing.replaceWith(node);
    } else {
      body.insertBefore(node, wl.partialNode && wl.partialNode.parentNode === body ? wl.partialNode : null);
      appended = true;
    }
    wl.liveNodes[index] = node;
  }
  if (partial) {
    const node = buildLineNode(document, { text: partial, count: 1 }, { partial: true });
    if (wl.partialNode?.parentNode === body) wl.partialNode.replaceWith(node);
    else body.appendChild(node);
    wl.partialNode = node;
    appended = true;
  } else if (wl.partialNode) {
    wl.partialNode.remove();
    wl.partialNode = null;
  }
  afterContentChange(appended);
}

function prependEarlier(lines) {
  const { body, scroll } = elements();
  if (!body || !lines.length) return;
  const heightBefore = scroll ? scroll.scrollHeight : 0;
  const fragment = document.createDocumentFragment();
  const nodes = lines.map((line) => buildLineNode(document, line));
  for (const node of nodes) fragment.appendChild(node);
  body.insertBefore(fragment, body.firstChild);
  wl.earlierNodes = [...nodes, ...wl.earlierNodes];
  // The reader stays on the line they were reading.
  if (scroll) scroll.scrollTop += scroll.scrollHeight - heightBefore;
  renderStatus();
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function logUrl(params = '') {
  return `/api/conversation/${encodeURIComponent(wl.conversationId)}/worker-log${params}`;
}

function errorText(error) {
  if (error?.status === 404) return 'This conversation is no longer available.';
  if (error?.status === 403) return 'Only the person signed in to this relay reads the worker log.';
  return error?.message || 'The worker log could not be loaded.';
}

function applyInfo(data) {
  wl.info = {
    provider: String(data?.provider || ''),
    sdkSessionId: String(data?.sdkSessionId || ''),
    dir: String(data?.dir || ''),
    path: String(data?.path || ''),
    previous: Array.isArray(data?.previous) ? data.previous.filter((file) => file && typeof file.name === 'string') : [],
  };
}

/**
 * Read the tail and draw it from scratch (first open, a gap, a rolled-over
 * log). With `before`, the tail ends exactly where the room stands, so the
 * room's next chunk continues it byte for byte.
 */
async function fetchTail({ before = null } = {}) {
  if (!wl.open) return;
  const token = ++wl.fetchToken;
  const conversationId = wl.conversationId;
  wl.loading = true;
  if (!wl.pendingChunks) wl.pendingChunks = [];
  renderStatus();
  let data;
  try {
    const params = Number.isInteger(before) && before >= 0 ? `?before=${before}&lines=${TAIL_LINES}` : `?lines=${TAIL_LINES}`;
    data = await apiFetchOrThrow(logUrl(params));
  } catch (error) {
    if (token !== wl.fetchToken || !wl.open) return;
    wl.error = errorText(error);
    wl.loading = false;
    wl.pendingChunks = null;
    renderStatus();
    return;
  }
  if (token !== wl.fetchToken || !wl.open || conversationId !== wl.conversationId) return;
  wl.loading = false;
  wl.error = '';
  const pending = wl.pendingChunks || [];
  wl.pendingChunks = null;
  if (!data) {
    renderStatus();
    return;
  }
  applyInfo(data);
  wl.kind = data.kind === 'file' ? 'file' : 'none';
  clearLines();
  if (wl.kind === 'none') {
    wl.message = String(data.message || '');
    wl.hasMoreBefore = false;
    wl.nextOffset = 0;
    wl.size = 0;
    renderEarlierButton();
    renderHeader();
    renderStatus();
    return;
  }
  wl.startOffset = Number(data.startOffset) || 0;
  wl.nextOffset = Number.isFinite(Number(data.endOffset)) ? Number(data.endOffset) : Number(data.size) || 0;
  wl.size = Number(data.size) || wl.nextOffset;
  wl.mtime = data.mtime ?? null;
  wl.hasMoreBefore = data.hasMoreBefore === true;
  wl.folded = wl.folder.feed(String(data.text ?? ''));
  wl.loadedBytes = Math.max(0, wl.nextOffset - wl.startOffset);
  wl.liveBytes = 0;
  renderEarlierButton();
  renderHeader();
  renderLive();
  // Chunks that came while the tail was read: those past it still count.
  for (const chunk of pending) applyChunk(chunk);
}

async function loadEarlier({ reveal = false } = {}) {
  if (!wl.open || wl.loadingEarlier || !wl.hasMoreBefore) return;
  if (loadEarlierState({ hasMoreBefore: true, loadedBytes: wl.loadedBytes }).disabled) return;
  const token = wl.fetchToken;
  wl.loadingEarlier = true;
  renderEarlierButton();
  try {
    const data = await apiFetchOrThrow(logUrl(`?before=${encodeURIComponent(wl.startOffset)}&lines=${TAIL_LINES}`));
    if (token !== wl.fetchToken || !wl.open || !data || data.kind !== 'file') return;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const start = Number(data.startOffset);
    wl.loadedBytes += Number.isFinite(start) ? Math.max(0, wl.startOffset - start) : String(data.text || '').length;
    if (Number.isFinite(start)) wl.startOffset = start;
    wl.hasMoreBefore = data.hasMoreBefore === true;
    prependEarlier(lines);
    const { scroll } = elements();
    if (reveal && scroll && lines.length) {
      wl.following = false;
      scroll.scrollTop = 0;
    }
  } catch (error) {
    if (token === wl.fetchToken) {
      wl.note = errorText(error);
      renderStatus();
    }
  } finally {
    wl.loadingEarlier = false;
    renderEarlierButton();
  }
}

/** Join the log's room, then read the tail up to the offset the room stands at. */
async function syncWithRoom() {
  if (!wl.open) return;
  const { conversationId } = wl;
  wl.pendingChunks = wl.pendingChunks || [];
  const answer = await logWatch.watch(conversationId);
  if (!wl.open || wl.conversationId !== conversationId) return;
  const before = answer?.ok && Number.isInteger(answer.offset) && answer.offset > 0 ? answer.offset : null;
  await fetchTail({ before });
}

function refetchTail() {
  if (wl.refetching) return;
  wl.refetching = true;
  void syncWithRoom().finally(() => { wl.refetching = false; });
}

function applyChunk(chunk) {
  // The log appeared after "No worker log yet": read it from the start. A
  // line the room sent open and now sends again whole (`rewrite`): the tail
  // read again replaces the open one.
  if (wl.kind === 'none' || chunk?.rewrite === true) {
    refetchTail();
    return;
  }
  const action = chunkAction({ nextOffset: wl.nextOffset, size: wl.size }, chunk);
  if (action === 'ignore') return;
  if (action === 'refetch') {
    refetchTail();
    return;
  }
  const text = String(chunk.text ?? '');
  wl.folded = wl.folder.feed(text);
  const end = chunkEndOffset(chunk);
  wl.nextOffset = Number.isFinite(end) ? end : wl.nextOffset + text.length;
  const size = Number(chunk.size);
  if (Number.isFinite(size)) wl.size = Math.max(size, wl.nextOffset);
  if (chunk.mtime !== undefined && chunk.mtime !== null) wl.mtime = chunk.mtime;
  wl.loadedBytes += text.length;
  wl.liveBytes += text.length;
  renderLive();
  renderHeader();
  trimLiveBuffer();
}

/**
 * A view left open on a busy log keeps what came live only up to 20,000
 * lines or 5 MB (twice that while the reader is scrolled up, so the text
 * under them does not move): past it, the tail is read again and the older
 * lines are Load earlier's.
 */
function trimLiveBuffer() {
  const factor = wl.following ? 1 : 2;
  const over = wl.folded.lines.length > LIVE_LINES_MAX * factor || wl.liveBytes > LIVE_BYTES_MAX * factor;
  if (over) refetchTail();
}

// ─── Open / close ────────────────────────────────────────────────────────────

function resetState() {
  wl.kind = '';
  wl.message = '';
  wl.error = '';
  wl.note = '';
  wl.loading = false;
  wl.loadingEarlier = false;
  wl.startOffset = 0;
  wl.nextOffset = 0;
  wl.size = 0;
  wl.mtime = null;
  wl.hasMoreBefore = false;
  wl.loadedBytes = 0;
  wl.liveBytes = 0;
  wl.following = true;
  wl.pendingChunks = null;
  wl.refetching = false;
  wl.info = { provider: '', sdkSessionId: '', dir: '', path: '', previous: [] };
}

export async function openWorkerLogView({ conversationId = currentConvId } = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId || IS_SHARED_VIEW) return;
  const { modal } = elements();
  if (!modal) return;
  if (wl.open && wl.conversationId !== convId) logWatch.unwatch();
  // The watch below replaces the room left while offline.
  wl.unwatchPending = false;
  wl.conversationId = convId;
  resetState();
  clearLines();
  if (!wl.open) {
    wl.open = true;
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('worker-log-open');
    viewHistory?.opened();
    // Another conversation opened (from any view): this log is not its.
    wl.offSwitch = onCurrentConvChange((id) => {
      if (wl.open && String(id || '') !== wl.conversationId) closeWorkerLogView();
    });
  }
  renderHeader();
  renderEarlierButton();
  renderStatus();
  syncTicker();
  modal.querySelector('.worker-log-close')?.focus?.({ preventScroll: true });
  // Joined before the read, so nothing written in between is lost.
  await syncWithRoom();
}

export function closeWorkerLogView({ fromHistory = false } = {}) {
  if (!wl.open) return;
  wl.open = false;
  wl.fetchToken += 1;
  wl.offSwitch?.();
  wl.offSwitch = null;
  const { modal } = elements();
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('worker-log-open');
  // Offline, the relay cannot be told now; a recovered socket would still be
  // in the room, so it is told at the next connect.
  if (!getSocket()?.connected) wl.unwatchPending = true;
  logWatch.unwatch();
  clearLines();
  resetState();
  syncLayout();
  syncTicker();
  if (!fromHistory) viewHistory?.closed();
}

export function isWorkerLogViewOpen() {
  return wl.open;
}

// ─── Live updates ────────────────────────────────────────────────────────────

/** `worker_log_chunk`: new bytes of the log on screen. */
export function handleWorkerLogChunk(payload) {
  if (!wl.open) return;
  if (String(payload?.conversationId || '') !== wl.conversationId) return;
  if (wl.pendingChunks) {
    wl.pendingChunks.push(payload);
    return;
  }
  applyChunk(payload);
}

/**
 * The socket came back: an open view watches the log again and reads what
 * was missed; one closed while offline leaves its room, once.
 */
export async function handleWorkerLogReconnect() {
  if (!wl.open) {
    if (!wl.unwatchPending) return;
    const socket = getSocket();
    if (!socket?.connected) return;
    wl.unwatchPending = false;
    socket.emit('worker_log_unwatch', {});
    return;
  }
  refetchTail();
}

// One timer for the header's "last write" age, only while open.
function syncTicker() {
  if (wl.open && !wl.tickTimer) wl.tickTimer = setInterval(renderHeader, 1000);
  if (!wl.open && wl.tickTimer) {
    clearInterval(wl.tickTimer);
    wl.tickTimer = null;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/** `closeMenu`: closes the chat menu the entry sits in (bootstrap.js owns it). */
export function initWorkerLogView({ closeMenu = () => {} } = {}) {
  if (initialized) return;
  initialized = true;
  viewHistory = createViewerHistory({
    history: window.history,
    mark: 'oarWorkerLog',
    onBack: () => closeWorkerLogView({ fromHistory: true }),
  });
  window.addEventListener('popstate', () => viewHistory.onPopState());

  bindMenuAction(document.getElementById('chat-menu-worker-log'), (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    void openWorkerLogView();
  });

  const { modal, scroll, jump, earlier, earlierTop } = elements();
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeWorkerLogView();
  });
  modal?.querySelector('.worker-log-close')?.addEventListener('click', () => closeWorkerLogView());
  earlier?.addEventListener('click', () => void loadEarlier());
  earlierTop?.addEventListener('click', () => void loadEarlier({ reveal: true }));
  window.addEventListener('resize', () => {
    if (wl.open) syncLayout();
  });
  jump?.addEventListener('click', () => {
    wl.following = true;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    jump.hidden = true;
  });
  scroll?.addEventListener('scroll', () => {
    wl.following = isAtBottom(scroll);
    if (wl.following && jump) jump.hidden = true;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !wl.open) return;
    // Above the composer, Escape in the composer (or any field outside the
    // view) is that field's own.
    if (modal?.classList.contains('tc-above-panel') && !modal.contains(event.target)
      && event.target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    event.preventDefault();
    closeWorkerLogView();
  });
}
