// The task console: a shell or Monitor task's output, opened from its row in
// the composer's background-task panel. The last lines come from
// GET /api/conversation/:id/background-task/:taskId/output; new bytes arrive
// as `task_output_chunk`, which the relay sends only to pages watching the
// task (task-console-watch.mjs). A chunk that does not continue where the
// view stands (a dropped chunk, a rewritten file) reads the tail again.
// "Load earlier" pages back up to 5 MB (from the top of the output, or the
// header while following the end). A provider that can only give a snapshot
// is read again every 3 s instead. A command piped into tail gets a
// marker where its output stops until it ends. On wider screens the console
// ends above the task's row in the composer panel, so the row's chip stays
// in view; full-screen on phones. Escape, ×, a click outside and the system
// back close it.

import { apiFetchOrThrow } from './api-client.js';
import { currentConvId } from './store.js';
import { createViewerHistory } from './viewer-history.mjs';
import { getSocket } from './socket-handlers.js';
import { createTaskConsoleWatch } from './task-console-watch.mjs';
import { createLineFolder } from './task-output-text.mjs';
import {
  findBackgroundTask,
  getBackgroundTaskHealth,
  getTaskStallMinutes,
  isBackgroundTaskStopping,
  onBackgroundTasksPanelRendered,
  stopBackgroundTask,
  subscribeBackgroundTasks,
} from './background-tasks-view.mjs';
import {
  TASK_OUTPUT_NONE_MESSAGES,
  buildLineNode,
  chunkAction,
  chunkEndOffset,
  consoleMetaParts,
  findFirstFailureIndex,
  loadEarlierState,
  pipeHoldNotice,
  runnerChip,
  showPipeHoldMarker,
  stallHint,
  taskPipeHold,
} from './task-console-render.mjs';

const TAIL_LINES = 2000;
const SNAPSHOT_POLL_MS = 3000;
// Wider than a phone, the console stops above the task's row when the row's
// top is at least this far down the window (the console keeps about 320 px
// of it); otherwise it covers the page as before.
const PHONE_MAX_WIDTH = 680;
const ABOVE_ROW_MIN_TOP = 360;

const tc = {
  open: false,
  conversationId: '',
  taskId: '',
  kind: '',
  message: '',
  error: '',
  loading: false,
  loadingEarlier: false,
  fetchToken: 0,
  // Lines paged in by "Load earlier" (completed lines, oldest first) and
  // their nodes; the tail and everything live goes through the folder.
  earlierLines: [],
  earlierNodes: [],
  folder: null,
  folded: { lines: [], partial: '' },
  liveNodes: [],
  partialNode: null,
  startOffset: 0,
  nextOffset: 0,
  // Where the output stood at the first read: past it, output came in.
  openedAt: null,
  size: 0,
  hasMoreBefore: false,
  loadedBytes: 0,
  ended: false,
  status: '',
  exitCode: null,
  health: null,
  following: true,
  pendingChunks: null,
  refetching: false,
  snapshotTimer: null,
  tickTimer: null,
  note: '',
};

let consoleHistory = null;
let initialized = false;
const consoleWatch = createTaskConsoleWatch({ getSocket });

function elements() {
  return {
    modal: document.getElementById('task-console-modal'),
    title: document.getElementById('task-console-title'),
    meta: document.getElementById('task-console-meta'),
    stall: document.getElementById('task-console-stall'),
    chip: document.getElementById('task-console-chip'),
    failure: document.getElementById('task-console-failure'),
    stop: document.getElementById('task-console-stop'),
    scroll: document.getElementById('task-console-scroll'),
    earlier: document.getElementById('task-console-earlier'),
    earlierTop: document.getElementById('task-console-earlier-top'),
    body: document.getElementById('task-console-body'),
    hold: document.getElementById('task-console-hold'),
    status: document.getElementById('task-console-status'),
    jump: document.getElementById('task-console-jump'),
  };
}

function isAtBottom(scroll) {
  return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
}

function formatDuration(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || fromMs <= 0 || !Number.isFinite(toMs) || toMs < fromMs) return '';
  const seconds = Math.floor((toMs - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toMillis(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  return Date.parse(String(value || ''));
}

function currentTask() {
  return findBackgroundTask(tc.conversationId, tc.taskId);
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const { title, meta, stall, chip, failure, stop } = elements();
  const found = currentTask();
  // The panel's row, else what the output answer said about the task.
  const task = found?.task || tc.answerTask || { taskId: tc.taskId };
  const ended = tc.ended || !!found?.ended;
  const status = found?.ended ? (found.task.status ?? tc.status) : tc.status;
  const exitCode = found?.ended ? (found.task.exitCode ?? tc.exitCode) : tc.exitCode;
  if (title) title.textContent = String(task.description || tc.taskId || 'Task');
  const started = toMillis(task.startedAt);
  const endedAt = ended ? toMillis(task.endedAt) : Date.now();
  if (meta) {
    meta.textContent = consoleMetaParts({
      task,
      elapsed: formatDuration(started, Number.isFinite(endedAt) ? endedAt : NaN),
      ended,
      status,
      exitCode,
      kind: tc.kind,
    }).join(' · ');
  }
  const health = getBackgroundTaskHealth(tc.conversationId, tc.taskId) || tc.health;
  const holdNotice = pipeHoldNotice(taskPipeHold(task));
  if (stall) {
    const hint = ended ? null : stallHint(health?.lastOutputAt, getTaskStallMinutes(tc.conversationId));
    stall.hidden = !hint;
    stall.textContent = hint ? hint.text : '';
    stall.className = hint?.warn ? 'tc-stall tc-stall-warn' : 'tc-stall';
    stall.title = holdNotice ? holdNotice.title : '';
  }
  const chipInfo = runnerChip(health);
  if (chip) {
    chip.hidden = !chipInfo;
    chip.textContent = chipInfo ? chipInfo.text : '';
    chip.title = chipInfo ? chipInfo.title : '';
    chip.className = chipInfo?.failed ? 'bg-task-chip bg-task-chip-fail' : 'bg-task-chip';
  }
  if (failure) failure.hidden = !chipInfo?.failed;
  if (stop) {
    const stoppable = !ended && !!found && task.stoppable !== false;
    const stopping = isBackgroundTaskStopping(tc.conversationId, tc.taskId);
    stop.hidden = !stoppable;
    stop.disabled = stopping;
    stop.textContent = stopping ? 'Stopping…' : 'Stop';
  }
  renderHold();
  syncLayout();
}

/** The "output stops here" marker under the last line, while nothing new came. */
function renderHold() {
  const { hold } = elements();
  if (!hold) return;
  const found = currentTask();
  const program = taskPipeHold(found?.task || tc.answerTask);
  const notice = pipeHoldNotice(program);
  const show = !!notice && !tc.loading && showPipeHoldMarker({
    program,
    ended: tc.ended || !!found?.ended,
    kind: tc.kind,
    openedAt: tc.openedAt,
    nextOffset: tc.nextOffset,
  });
  hold.hidden = !show;
  if (!show) return;
  hold.querySelector('.tc-hold-text').textContent = notice.text;
  hold.querySelector('.tc-hold-hint').textContent = notice.hint;
}

/**
 * Wider than a phone, the modal ends above the task's row in the composer
 * panel, so the row (its ✓/✘ chip, clock and Stop) stays in view and live.
 * Without the row on screen, or with too little room above it, the console
 * covers the page as before.
 */
function syncLayout() {
  const { modal } = elements();
  if (!modal) return;
  let bottom = 0;
  if (tc.open && window.innerWidth > PHONE_MAX_WIDTH) {
    const panel = document.getElementById('background-tasks-panel');
    const row = panel && !panel.hidden && panel.hasAttribute('open')
      ? panel.querySelector(`.bg-task-row[data-task-id="${CSS.escape(tc.taskId)}"]`)
      : null;
    const rect = row?.getBoundingClientRect?.();
    if (rect && rect.height > 0 && rect.top >= ABOVE_ROW_MIN_TOP && rect.top < window.innerHeight) {
      bottom = Math.ceil(window.innerHeight - rect.top + 6);
    }
  }
  modal.classList.toggle('tc-above-panel', bottom > 0);
  modal.style.bottom = bottom > 0 ? `${bottom}px` : '';
  // Above the panel the page below stays usable: the console is no modal then.
  const dialog = modal.querySelector('[role="dialog"]');
  if (bottom > 0) dialog?.removeAttribute('aria-modal');
  else dialog?.setAttribute('aria-modal', 'true');
}

function renderStatus() {
  const { status } = elements();
  if (!status) return;
  const hasLines = tc.earlierLines.length || tc.folded.lines.length || tc.folded.partial;
  let text = '';
  if (tc.error) text = tc.error;
  else if (tc.kind === 'none') text = tc.message || TASK_OUTPUT_NONE_MESSAGES.provider;
  else if (tc.loading && !hasLines) text = 'Loading…';
  else if (!hasLines && !tc.note) text = tc.ended ? 'This task wrote no output.' : 'No output yet. Lines appear as the task writes them.';
  if (tc.note) text = text ? `${text} ${tc.note}` : tc.note;
  status.textContent = text;
  status.hidden = !text;
}

// Both "Load earlier" buttons: the one above the first line, and the
// header's, which is in reach while following the end.
function renderEarlierButton() {
  const { earlier, earlierTop } = elements();
  const state = loadEarlierState({ hasMoreBefore: tc.hasMoreBefore, loadedBytes: tc.loadedBytes, loading: tc.loadingEarlier });
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
  tc.earlierLines = [];
  tc.earlierNodes = [];
  tc.liveNodes = [];
  tc.partialNode = null;
  tc.folder = createLineFolder();
  tc.folded = { lines: [], partial: '' };
  if (jump) jump.hidden = true;
}

function afterContentChange(appended) {
  const { scroll, jump } = elements();
  renderStatus();
  renderHold();
  if (!scroll) return;
  if (tc.following) {
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
  const { lines, partial } = tc.folded;
  const before = tc.liveNodes.length;
  let appended = false;
  const from = Math.max(0, before - 1);
  for (let index = from; index < lines.length; index += 1) {
    const node = buildLineNode(document, lines[index]);
    const existing = tc.liveNodes[index];
    if (existing) {
      existing.replaceWith(node);
    } else {
      body.insertBefore(node, tc.partialNode && tc.partialNode.parentNode === body ? tc.partialNode : null);
      appended = true;
    }
    tc.liveNodes[index] = node;
  }
  if (partial) {
    const node = buildLineNode(document, { text: partial, count: 1 }, { partial: true });
    if (tc.partialNode?.parentNode === body) tc.partialNode.replaceWith(node);
    else body.appendChild(node);
    tc.partialNode = node;
    appended = true;
  } else if (tc.partialNode) {
    tc.partialNode.remove();
    tc.partialNode = null;
  }
  afterContentChange(appended);
}

function feed(text) {
  tc.folded = tc.folder.feed(String(text ?? ''));
}

function prependEarlier(lines) {
  const { body, scroll } = elements();
  if (!body || !lines.length) return;
  const heightBefore = scroll ? scroll.scrollHeight : 0;
  const fragment = document.createDocumentFragment();
  const nodes = lines.map((line) => buildLineNode(document, line));
  for (const node of nodes) fragment.appendChild(node);
  body.insertBefore(fragment, body.firstChild);
  tc.earlierLines = [...lines, ...tc.earlierLines];
  tc.earlierNodes = [...nodes, ...tc.earlierNodes];
  // The reader stays on the line they were reading.
  if (scroll) scroll.scrollTop += scroll.scrollHeight - heightBefore;
  renderStatus();
}

function allLineNodes() {
  return [...tc.earlierNodes, ...tc.liveNodes];
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function outputUrl(params = '') {
  return `/api/conversation/${encodeURIComponent(tc.conversationId)}/background-task/${encodeURIComponent(tc.taskId)}/output${params}`;
}

function errorText(error) {
  if (error?.status === 404) return 'This task\'s output is no longer available.';
  if (error?.status === 409) return 'The session\'s worker is not connected, so the output cannot be read now.';
  return error?.message || 'The output could not be loaded.';
}

function applyAnswerMeta(data) {
  tc.kind = String(data?.kind || tc.kind || 'file');
  if (data?.health && typeof data.health === 'object') tc.health = data.health;
  if (data?.ended === true) tc.ended = true;
  if (data?.status !== undefined && data?.status !== null) tc.status = String(data.status);
  if (data?.exitCode !== undefined) tc.exitCode = data.exitCode;
  if (data?.task && typeof data.task === 'object') tc.answerTask = data.task;
}

/**
 * Read the tail and draw it from scratch (first open, a gap, a snapshot
 * tick). With `before`, the tail ends exactly where the task's room stands,
 * so the room's next chunk continues it byte for byte.
 */
async function fetchTail({ before = null } = {}) {
  if (!tc.open) return;
  const token = ++tc.fetchToken;
  const key = `${tc.conversationId}:${tc.taskId}`;
  tc.loading = true;
  if (!tc.pendingChunks) tc.pendingChunks = [];
  renderStatus();
  let data;
  try {
    const params = Number.isInteger(before) && before >= 0
      ? `?before=${before}&lines=${TAIL_LINES}`
      : `?lines=${TAIL_LINES}`;
    data = await apiFetchOrThrow(outputUrl(params));
  } catch (error) {
    if (token !== tc.fetchToken || !tc.open) return;
    tc.error = errorText(error);
    tc.loading = false;
    tc.pendingChunks = null;
    renderStatus();
    return;
  }
  if (token !== tc.fetchToken || !tc.open || key !== `${tc.conversationId}:${tc.taskId}`) return;
  tc.loading = false;
  tc.error = '';
  const pending = tc.pendingChunks || [];
  tc.pendingChunks = null;
  if (!data) {
    renderStatus();
    return;
  }
  applyAnswerMeta(data);
  clearLines();
  if (tc.kind === 'none') {
    tc.message = String(data.message || '');
    tc.hasMoreBefore = false;
    syncSnapshotPoll();
    renderEarlierButton();
    renderHeader();
    renderStatus();
    return;
  }
  tc.note = data.unavailable
    ? 'The output file can no longer be read.'
    : data.pending ? 'Waiting for the worker to send the output…' : '';
  tc.startOffset = Number(data.startOffset) || 0;
  tc.nextOffset = Number.isFinite(Number(data.endOffset)) ? Number(data.endOffset) : Number(data.size) || 0;
  tc.size = Number(data.size) || tc.nextOffset;
  tc.hasMoreBefore = data.hasMoreBefore === true;
  if (tc.openedAt === null) tc.openedAt = tc.nextOffset;
  if (typeof data.text === 'string') {
    feed(data.text);
    tc.loadedBytes = Math.max(0, tc.nextOffset - tc.startOffset) || data.text.length;
  } else {
    // No raw slice (an older relay or a snapshot answer): the line model.
    const lines = Array.isArray(data.lines) ? data.lines : [];
    tc.folded = { lines: lines.map((line) => ({ ...line })), partial: '' };
    tc.loadedBytes = Math.max(0, tc.nextOffset - tc.startOffset);
  }
  renderEarlierButton();
  renderHeader();
  renderLive();
  syncSnapshotPoll();
  // Chunks that came while the tail was read: those past it still count.
  for (const chunk of pending) applyChunk(chunk);
}

/**
 * Pages back. `reveal` (the header's button): the view goes to the lines
 * just loaded, at the top, instead of staying where the reader was.
 */
async function loadEarlier({ reveal = false } = {}) {
  if (!tc.open || tc.loadingEarlier || !tc.hasMoreBefore) return;
  if (loadEarlierState({ hasMoreBefore: true, loadedBytes: tc.loadedBytes }).disabled) return;
  const token = tc.fetchToken;
  tc.loadingEarlier = true;
  renderEarlierButton();
  try {
    const data = await apiFetchOrThrow(outputUrl(`?before=${encodeURIComponent(tc.startOffset)}&lines=${TAIL_LINES}`));
    if (token !== tc.fetchToken || !tc.open || !data) return;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const start = Number(data.startOffset);
    tc.loadedBytes += Number.isFinite(start) ? Math.max(0, tc.startOffset - start) : String(data.text || '').length;
    if (Number.isFinite(start)) tc.startOffset = start;
    tc.hasMoreBefore = data.hasMoreBefore === true;
    prependEarlier(lines);
    const { scroll } = elements();
    if (reveal && scroll && lines.length) {
      tc.following = false;
      scroll.scrollTop = 0;
    }
  } catch (error) {
    if (token === tc.fetchToken) {
      tc.note = errorText(error);
      renderStatus();
    }
  } finally {
    tc.loadingEarlier = false;
    renderEarlierButton();
  }
}

function syncSnapshotPoll() {
  const want = tc.open && tc.kind === 'snapshot' && !tc.ended;
  if (want && !tc.snapshotTimer) {
    tc.snapshotTimer = setInterval(() => {
      if (!tc.loading && document.visibilityState !== 'hidden') void fetchTail();
    }, SNAPSHOT_POLL_MS);
  }
  if (!want && tc.snapshotTimer) {
    clearInterval(tc.snapshotTimer);
    tc.snapshotTimer = null;
  }
}

/**
 * Join the task's room, then read the tail up to the offset the room stands
 * at. Chunks that arrive meanwhile wait and are sorted out after the read
 * (the ones already covered by it are dropped).
 */
async function syncWithRoom() {
  if (!tc.open) return;
  const { conversationId, taskId } = tc;
  tc.pendingChunks = tc.pendingChunks || [];
  let before = null;
  if (!tc.ended && tc.kind !== 'snapshot' && tc.kind !== 'none') {
    const answer = await consoleWatch.watch(conversationId, taskId);
    if (!tc.open || tc.taskId !== taskId || tc.conversationId !== conversationId) return;
    if (answer?.ok && Number.isInteger(answer.offset)) before = answer.offset;
  }
  await fetchTail({ before });
}

function refetchTail() {
  if (tc.refetching) return;
  tc.refetching = true;
  void syncWithRoom().finally(() => { tc.refetching = false; });
}

function applyChunk(chunk) {
  const action = chunkAction({ nextOffset: tc.nextOffset, size: tc.size }, chunk);
  if (action === 'ignore') return;
  if (action === 'refetch') {
    refetchTail();
    return;
  }
  const text = String(chunk.text ?? '');
  feed(text);
  const end = chunkEndOffset(chunk);
  tc.nextOffset = Number.isFinite(end) ? end : tc.nextOffset + text.length;
  const size = Number(chunk.size);
  if (Number.isFinite(size)) tc.size = Math.max(size, tc.nextOffset);
  tc.loadedBytes += text.length;
  if (chunk.ended === true && !tc.ended) {
    tc.ended = true;
    renderHeader();
  }
  renderLive();
}

// ─── Open / close ────────────────────────────────────────────────────────────

function resetState() {
  tc.kind = '';
  tc.message = '';
  tc.error = '';
  tc.note = '';
  tc.loading = false;
  tc.loadingEarlier = false;
  tc.startOffset = 0;
  tc.nextOffset = 0;
  tc.openedAt = null;
  tc.size = 0;
  tc.hasMoreBefore = false;
  tc.loadedBytes = 0;
  tc.health = null;
  tc.status = '';
  tc.exitCode = null;
  tc.ended = false;
  tc.answerTask = null;
  tc.following = true;
  tc.pendingChunks = null;
  tc.refetching = false;
}

export async function openTaskConsole({ conversationId = currentConvId, taskId } = {}) {
  const convId = String(conversationId || '').trim();
  const id = String(taskId || '').trim();
  if (!convId || !id) return;
  const { modal } = elements();
  if (!modal) return;
  if (tc.open && (tc.conversationId !== convId || tc.taskId !== id)) consoleWatch.unwatch();
  tc.conversationId = convId;
  tc.taskId = id;
  resetState();
  tc.ended = !!currentTask()?.ended;
  clearLines();
  if (!tc.open) {
    tc.open = true;
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('task-console-open');
    consoleHistory?.opened();
  }
  renderHeader();
  renderEarlierButton();
  renderStatus();
  syncTicker();
  modal.querySelector('.task-console-close')?.focus?.({ preventScroll: true });
  // Joined before the read, so nothing written in between is lost. An ended
  // task writes nothing more; its room is not needed.
  await syncWithRoom();
}

export function closeTaskConsole({ fromHistory = false } = {}) {
  if (!tc.open) return;
  tc.open = false;
  tc.fetchToken += 1;
  const { modal } = elements();
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('task-console-open');
  consoleWatch.unwatch();
  clearLines();
  resetState();
  syncLayout();
  renderHold();
  syncSnapshotPoll();
  syncTicker();
  if (!fromHistory) consoleHistory?.closed();
}

export function isTaskConsoleOpen() {
  return tc.open;
}

function jumpToFirstFailure() {
  const lines = [...tc.earlierLines, ...tc.folded.lines];
  const index = findFirstFailureIndex(lines);
  const node = index >= 0 ? allLineNodes()[index] : null;
  if (!node) {
    tc.note = tc.hasMoreBefore
      ? 'The first failure is in older output: load earlier lines to reach it.'
      : 'No failing test line found in the loaded output.';
    renderStatus();
    return;
  }
  tc.note = '';
  renderStatus();
  tc.following = false;
  for (const marked of elements().body?.querySelectorAll('.tc-line-target') || []) marked.classList.remove('tc-line-target');
  node.classList.add('tc-line-target');
  node.scrollIntoView({ block: 'center' });
}

async function stopTask() {
  const found = currentTask();
  if (!found || found.ended) return;
  const stopping = stopBackgroundTask(tc.conversationId, tc.taskId);
  renderHeader();
  await stopping;
  renderHeader();
}

// ─── Live updates ────────────────────────────────────────────────────────────

/** `task_output_chunk`: new bytes of the task on screen. */
export function handleTaskOutputChunk(payload) {
  if (!tc.open || tc.kind === 'none' || tc.kind === 'snapshot') return;
  if (String(payload?.taskId || '') !== tc.taskId) return;
  if (String(payload?.conversationId || '') && String(payload.conversationId) !== tc.conversationId) return;
  if (tc.pendingChunks) {
    tc.pendingChunks.push(payload);
    return;
  }
  applyChunk(payload);
}

/** The socket came back: watch the task again and read what was missed. */
export async function handleTaskConsoleReconnect() {
  if (!tc.open) return;
  refetchTail();
}

// One timer for the header's clock and stall hint, only while open.
function syncTicker() {
  if (tc.open && !tc.tickTimer) tc.tickTimer = setInterval(renderHeader, 1000);
  if (!tc.open && tc.tickTimer) {
    clearInterval(tc.tickTimer);
    tc.tickTimer = null;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

export function initTaskConsole() {
  if (initialized) return;
  initialized = true;
  consoleHistory = createViewerHistory({
    history: window.history,
    mark: 'oarTaskConsole',
    onBack: () => closeTaskConsole({ fromHistory: true }),
  });
  window.addEventListener('popstate', () => consoleHistory.onPopState());

  document.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-task-console]');
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    void openTaskConsole({ taskId: trigger.getAttribute('data-task-console') });
  });

  // The row's task moved to the ended set, its health changed, or Stop
  // settled: the header follows.
  subscribeBackgroundTasks((conversationId) => {
    if (!tc.open || String(conversationId || '') !== tc.conversationId) return;
    const found = currentTask();
    if (found?.ended && !tc.ended) {
      tc.ended = true;
      consoleWatch.unwatch();
      syncSnapshotPoll();
    }
    renderHeader();
  });

  const { modal, stop, scroll, jump, earlier, earlierTop, failure, chip } = elements();
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeTaskConsole();
  });
  modal?.querySelector('.task-console-close')?.addEventListener('click', () => closeTaskConsole());
  stop?.addEventListener('click', () => void stopTask());
  earlier?.addEventListener('click', () => void loadEarlier());
  earlierTop?.addEventListener('click', () => void loadEarlier({ reveal: true }));
  window.addEventListener('resize', () => {
    if (tc.open) syncLayout();
  });
  failure?.addEventListener('click', () => jumpToFirstFailure());
  chip?.addEventListener('click', () => jumpToFirstFailure());
  jump?.addEventListener('click', () => {
    tc.following = true;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    jump.hidden = true;
  });
  scroll?.addEventListener('scroll', () => {
    tc.following = isAtBottom(scroll);
    if (tc.following && jump) jump.hidden = true;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !tc.open) return;
    // Above the panel, Escape in the composer (or any field outside the
    // console) is that field's own.
    if (modal?.classList.contains('tc-above-panel') && !modal.contains(event.target)
      && event.target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    event.preventDefault();
    closeTaskConsole();
  });
  // The panel drew its rows again (a fold, a task set): the row may have moved.
  onBackgroundTasksPanelRendered(() => {
    if (tc.open) syncLayout();
  });
}
