// The sub-agent viewer: one sub-agent's whole record — thoughts, tool calls
// with their results, reply text, child agents — in the order it happened,
// live while the agent runs. Opened from a sub-agent row: the composer's
// background-task panel, a reply bubble, or a child row inside the viewer.
//
// The record comes from GET /api/conversation/:id/subagent/:runId (paged by
// seq) and grows through the `subagent_timeline` socket event, which the
// relay sends only to pages that watch the run (subagent-viewer-watch.mjs)
// and drops on a backed-up connection; a missed event shows up as a hole in
// the seq numbers and is fetched again, and so is the end of a run. Full-screen on
// phones; Escape, ×, a click outside and the system back close it.
//
// A shared view (and the owner's "Preview as shared") opens it read-only: the
// record comes filtered from the share's sub-agent route, without a socket, so
// a running agent's record is read again every few seconds; no Stop.

import { apiFetch, cancelSubagentRun, loadSharedSubagentRecord } from './api-client.js';
import { renderMarkdownPreview } from './router.js';
import { currentConvId, getSubagentRun, IS_SHARED_VIEW, upsertSubagentRun } from './store.js';
import { createViewerHistory } from './viewer-history.mjs';
import { getSocket } from './socket-handlers.js';
import { createSubagentViewerWatch } from './subagent-viewer-watch.mjs';
import { formatTaskModelLabel, formatTaskTokens } from './task-row-format.mjs';
import { getConversationBackgroundTasks, setSubagentStepCounter } from './background-tasks-view.mjs';
import { formatRunDuration, isRunningSubagentStatus, subagentRowHtml, subagentStatusLabel } from './subagent-row.mjs';
import {
  createTimelineState,
  headerMetaParts,
  mergeTimelineEntries,
  orderedTimelineEntries,
  timelineEntryHtml,
} from './subagent-timeline-view.mjs';

const PAGE_LIMIT = 500;
const MAX_PAGES = 10;
const STOP_PENDING_MS = 15_000;
const SHARED_POLL_MS = 3_000;

const viewer = {
  open: false,
  conversationId: '',
  run: null,
  state: null,
  children: new Map(),
  stack: [],
  fetchToken: 0,
  error: '',
  loading: false,
  stopping: false,
  stopTimer: null,
  tickTimer: null,
  sharedPollTimer: null,
  openFolds: new Set(),
};

let viewerHistory = null;
let initialized = false;
const viewerWatch = createSubagentViewerWatch({ getSocket });

function elements() {
  return {
    modal: document.getElementById('subagent-viewer-modal'),
    title: document.getElementById('subagent-viewer-title'),
    meta: document.getElementById('subagent-viewer-meta'),
    stop: document.getElementById('subagent-viewer-stop'),
    parent: document.getElementById('subagent-viewer-parent'),
    body: document.getElementById('subagent-viewer-body'),
    timeline: document.getElementById('subagent-viewer-timeline'),
    status: document.getElementById('subagent-viewer-status'),
    jump: document.getElementById('subagent-viewer-jump'),
  };
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderMarkdown(text) {
  try {
    return renderMarkdownPreview(String(text || ''), false);
  } catch {
    return `<p>${escHtml(text)}</p>`;
  }
}

function runIsRunning(run) {
  return isRunningSubagentStatus(run?.status);
}

// The live task a run is (the panel's row): its id is what Stop needs.
function liveTaskFor(run) {
  const runId = String(run?.subagentRunId || '');
  return getConversationBackgroundTasks(viewer.conversationId).find((task) => String(task?.toolUseId || '') === runId) || null;
}

function isAtBottom(body) {
  return body.scrollTop + body.clientHeight >= body.scrollHeight - 48;
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const { title, meta, stop, parent } = elements();
  const run = viewer.run;
  if (title) title.textContent = run?.displayName || 'Sub-agent';
  if (meta) {
    const parts = run ? headerMetaParts(run, {
      formatModel: formatTaskModelLabel,
      formatTokens: formatTaskTokens,
      formatDuration: formatRunDuration,
      statusLabel: subagentStatusLabel,
    }) : [];
    if (run?.truncated) parts.push('record cut at its limit');
    if (run?.legacy) parts.push('recorded before the full record existed');
    meta.textContent = parts.join(' · ');
  }
  if (stop) {
    const stoppable = !IS_SHARED_VIEW && runIsRunning(run) && (run?.stoppable === true || !!liveTaskFor(run));
    stop.hidden = !stoppable;
    stop.disabled = viewer.stopping;
    stop.textContent = viewer.stopping ? 'Stopping…' : 'Stop';
  }
  if (parent) {
    const top = viewer.stack[viewer.stack.length - 1];
    parent.hidden = !top;
    parent.textContent = top ? `‹ ${top.title || 'Parent agent'}` : '';
  }
}

function renderStatus() {
  const { status } = elements();
  if (!status) return;
  const count = viewer.state ? viewer.state.entries.size : 0;
  if (viewer.error) status.textContent = viewer.error;
  else if (viewer.loading && !count) status.textContent = 'Loading…';
  else if (!count) status.textContent = runIsRunning(viewer.run) ? 'Nothing recorded yet. Entries appear as the agent works.' : 'Nothing was recorded for this agent.';
  else status.textContent = '';
  status.hidden = !status.textContent;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

function entryElement(timeline, seq) {
  return timeline.querySelector(`.sav-entry[data-seq="${seq}"]`);
}

function buildEntryNode(entry) {
  const holder = document.createElement('div');
  holder.innerHTML = timelineEntryHtml(entry, {
    renderMarkdown,
    children: viewer.children,
    openDetails: viewer.openFolds.has(entry.seq),
    clickable: true,
  });
  return holder.firstElementChild;
}

/** Re-render the given seqs in place (new ones go where their seq says). */
function renderEntries(seqs) {
  const { timeline, body, jump } = elements();
  if (!timeline || !body || !viewer.state || !seqs.length) {
    renderStatus();
    return;
  }
  const following = isAtBottom(body);
  let appended = false;
  for (const seq of [...new Set(seqs)].sort((a, b) => a - b)) {
    const entry = viewer.state.entries.get(seq);
    if (!entry) continue;
    const node = buildEntryNode(entry);
    if (!node) continue;
    const existing = entryElement(timeline, seq);
    if (existing) {
      existing.replaceWith(node);
      continue;
    }
    // In seq order: usually the end, but a refetch can fill a hole.
    let before = null;
    for (const child of timeline.children) {
      if (Number(child.dataset.seq) > seq) { before = child; break; }
    }
    timeline.insertBefore(node, before);
    if (!before) appended = true;
  }
  renderStatus();
  if (following) {
    body.scrollTop = body.scrollHeight;
    if (jump) jump.hidden = true;
  } else if (appended && jump) {
    jump.hidden = false;
  }
}

function renderAllEntries() {
  const { timeline } = elements();
  if (!timeline) return;
  timeline.innerHTML = '';
  if (!viewer.state) return;
  const seqs = orderedTimelineEntries(viewer.state).map((entry) => entry.seq);
  renderEntries(seqs);
}

function rerenderChildEntries(childRunId) {
  if (!viewer.state) return;
  const seqs = orderedTimelineEntries(viewer.state)
    .filter((entry) => entry.kind === 'child' && String(entry.toolUseId || '') === childRunId)
    .map((entry) => entry.seq);
  if (seqs.length) renderEntries(seqs);
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function applyRunHeader(header) {
  if (!header || !viewer.state || String(header.subagentRunId || '') !== viewer.state.runId) return;
  viewer.run = { ...(viewer.run || {}), ...header };
  if (viewer.stopping && !runIsRunning(viewer.run)) {
    viewer.stopping = false;
    clearTimeout(viewer.stopTimer);
  }
  renderHeader();
  syncTicker();
  syncSharedPoll();
}

// Without a socket a running record is read again while it is on screen.
function syncSharedPoll() {
  const want = IS_SHARED_VIEW && viewer.open && runIsRunning(viewer.run);
  if (want && !viewer.sharedPollTimer) {
    viewer.sharedPollTimer = setInterval(() => {
      if (!viewer.loading && document.visibilityState !== 'hidden') void fetchRecord();
    }, SHARED_POLL_MS);
  }
  if (!want && viewer.sharedPollTimer) {
    clearInterval(viewer.sharedPollTimer);
    viewer.sharedPollTimer = null;
  }
}

/**
 * Fetch the record from `lastSeq` on (or from the start), page by page.
 * A newer fetch supersedes an older one; entries already shown stay.
 */
async function fetchRecord({ fromStart = false } = {}) {
  if (!viewer.open || !viewer.state) return;
  const token = ++viewer.fetchToken;
  const runId = viewer.state.runId;
  const conversationId = viewer.conversationId;
  let after = fromStart ? 0 : viewer.state.lastSeq;
  viewer.loading = true;
  renderStatus();
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = IS_SHARED_VIEW
        ? await loadSharedSubagentRecord(runId, { after, limit: PAGE_LIMIT })
        : await apiFetch(`/api/conversation/${encodeURIComponent(conversationId)}/subagent/${encodeURIComponent(runId)}?after=${after}&limit=${PAGE_LIMIT}`);
      if (token !== viewer.fetchToken || !viewer.open || viewer.state?.runId !== runId) return;
      if (!data) {
        viewer.error = viewer.state.entries.size ? '' : 'This agent\'s record could not be loaded.';
        return;
      }
      viewer.error = '';
      for (const child of Array.isArray(data.children) ? data.children : []) {
        if (child?.subagentRunId) viewer.children.set(String(child.subagentRunId), { ...(viewer.children.get(String(child.subagentRunId)) || {}), ...child });
      }
      applyRunHeader(data.run);
      const { changed } = mergeTimelineEntries(viewer.state, data.entries);
      renderEntries(changed);
      if (data.complete !== false) break;
      after = Number(data.nextAfter) || viewer.state.lastSeq;
    }
  } finally {
    if (token === viewer.fetchToken) {
      viewer.loading = false;
      renderStatus();
    }
  }
}

async function loadRun(runId) {
  const id = String(runId || '').trim();
  if (!id) return;
  viewer.state = createTimelineState(id);
  viewer.children = new Map();
  viewer.openFolds = new Set();
  viewer.error = '';
  viewer.stopping = false;
  clearTimeout(viewer.stopTimer);
  const known = getSubagentRun(id);
  viewer.run = known ? { ...known } : { subagentRunId: id, displayName: 'Sub-agent', status: 'running' };
  const { timeline, jump, body } = elements();
  if (timeline) timeline.innerHTML = '';
  if (jump) jump.hidden = true;
  renderHeader();
  renderStatus();
  // Joined before the read, so nothing sent in between is lost.
  if (!IS_SHARED_VIEW) await viewerWatch.watch(viewer.conversationId, id);
  if (!viewer.open || viewer.state?.runId !== id) return;
  await fetchRecord({ fromStart: true });
  // A finished record reads from the top; a running one follows its end.
  if (body && viewer.state?.runId === id) body.scrollTop = runIsRunning(viewer.run) ? body.scrollHeight : 0;
  syncTicker();
}

// ─── Open / close ────────────────────────────────────────────────────────────

export async function openSubagentViewer({ conversationId = currentConvId, runId } = {}) {
  const convId = String(conversationId || '').trim();
  const id = String(runId || '').trim();
  if (!convId || !id) return;
  const { modal } = elements();
  if (!modal) return;
  viewer.conversationId = convId;
  viewer.stack = [];
  if (!viewer.open) {
    viewer.open = true;
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('subagent-viewer-open');
    viewerHistory?.opened();
  }
  await loadRun(id);
  elements().modal?.querySelector('.subagent-viewer-close')?.focus?.({ preventScroll: true });
}

export function closeSubagentViewer({ fromHistory = false } = {}) {
  if (!viewer.open) return;
  viewer.open = false;
  viewer.fetchToken += 1;
  const { modal, timeline } = elements();
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('subagent-viewer-open');
  if (timeline) timeline.innerHTML = '';
  viewerWatch.unwatch();
  viewer.state = null;
  viewer.run = null;
  viewer.stack = [];
  viewer.children = new Map();
  clearTimeout(viewer.stopTimer);
  syncTicker();
  syncSharedPoll();
  if (!fromHistory) viewerHistory?.closed();
}

export function isSubagentViewerOpen() {
  return viewer.open;
}

async function openChild(childRunId) {
  if (!viewer.state || childRunId === viewer.state.runId) return;
  viewer.stack.push({ runId: viewer.state.runId, title: viewer.run?.displayName || '' });
  await loadRun(childRunId);
}

async function openParent() {
  const top = viewer.stack.pop();
  if (!top) return;
  await loadRun(top.runId);
}

async function stopRun() {
  const run = viewer.run;
  if (IS_SHARED_VIEW || !run || viewer.stopping || !runIsRunning(run)) return;
  viewer.stopping = true;
  renderHeader();
  const task = liveTaskFor(run);
  const taskId = String(task?.taskId || run.taskId || '').trim();
  const convId = viewer.conversationId;
  const result = (run.background || task) && taskId
    ? await apiFetch(`/api/conversation/${encodeURIComponent(convId)}/background-task/${encodeURIComponent(taskId)}/stop`, { method: 'POST', body: '{}' })
    : await cancelSubagentRun(convId, run.subagentRunId, { parentMessageId: run.messageId || undefined });
  if (!result) {
    viewer.stopping = false;
    renderHeader();
    return;
  }
  // The run's end arrives as a status event; until then the button waits.
  clearTimeout(viewer.stopTimer);
  viewer.stopTimer = setTimeout(() => {
    viewer.stopping = false;
    renderHeader();
  }, STOP_PENDING_MS);
}

// ─── Live updates ────────────────────────────────────────────────────────────

/** `subagent_timeline`: entries of the run on screen. */
export function handleSubagentTimelineEvent(payload) {
  if (!viewer.open || !viewer.state) return;
  if (String(payload?.subagentRunId || '') !== viewer.state.runId) return;
  if (String(payload?.conversationId || '') && String(payload.conversationId) !== viewer.conversationId) return;
  const { changed, gap } = mergeTimelineEntries(viewer.state, payload.entries);
  renderEntries(changed);
  if (payload.truncated && viewer.run && !viewer.run.truncated) {
    viewer.run = { ...viewer.run, truncated: true };
    renderHeader();
  }
  if (gap) void fetchRecord();
}

/** `subagent_status`: the run on screen, or one of its children, changed. */
export function handleSubagentStatusEventForViewer(payload) {
  if (!viewer.open || !viewer.state) return;
  const runId = String(payload?.subagentRunId || '');
  if (!runId) return;
  if (runId === viewer.state.runId) {
    const wasRunning = runIsRunning(viewer.run);
    applyRunHeader(payload);
    // The relay did not know this run when the viewer asked for it.
    if (viewerWatch.refused()) void viewerWatch.watch(viewer.conversationId, runId);
    // The last batches of a run can be dropped with nothing after them to
    // show the hole: its end reads the record once more.
    if (wasRunning && !runIsRunning(viewer.run)) void fetchRecord();
    return;
  }
  if (viewer.children.has(runId) || String(payload?.parentSubagentId || '') === viewer.state.runId) {
    viewer.children.set(runId, { ...(viewer.children.get(runId) || {}), ...payload });
    rerenderChildEntries(runId);
  }
}

/** The socket came back: watch the run again, then fetch what was missed. */
export async function handleSubagentViewerReconnect() {
  if (!viewer.open || !viewer.state) return;
  const runId = viewer.state.runId;
  await viewerWatch.watch(viewer.conversationId, runId);
  if (viewer.open && viewer.state?.runId === runId) void fetchRecord();
}

// ─── Rows elsewhere on the page ──────────────────────────────────────────────

/**
 * A run's status changed: every row showing it (reply bubbles, the viewer)
 * is drawn again from the store, which the status event already updated.
 */
export function refreshSubagentRows(runId) {
  const id = String(runId || '').trim();
  if (!id) return;
  const run = getSubagentRun(id);
  if (!run) return;
  for (const row of document.querySelectorAll(`.subagent-row[data-subagent-row="${CSS.escape(id)}"]`)) {
    if (row.closest('#subagent-viewer-modal')) continue;
    const context = row.classList.contains('subagent-row-timeline') ? 'timeline' : 'bubble';
    const clickable = !!row.querySelector('[data-subagent-open]');
    const holder = document.createElement('div');
    holder.innerHTML = subagentRowHtml(run, { context, clickable });
    if (holder.firstElementChild) row.replaceWith(holder.firstElementChild);
  }
  syncTicker();
}

// One timer for every running row's clock (bubbles and the viewer), only
// while one is on screen.
function tick() {
  const now = Date.now();
  let running = 0;
  for (const node of document.querySelectorAll('.subagent-row-time[data-started-at]')) {
    running += 1;
    node.textContent = formatRunDuration(node.getAttribute('data-started-at'), null, now);
  }
  if (viewer.open && runIsRunning(viewer.run)) {
    running += 1;
    renderHeader();
  }
  if (!running) syncTicker(false);
}

function syncTicker(wanted = null) {
  const want = wanted ?? (
    (viewer.open && runIsRunning(viewer.run))
    || !!document.querySelector('.subagent-row-time[data-started-at]')
  );
  if (want && !viewer.tickTimer) viewer.tickTimer = setInterval(tick, 1000);
  if (!want && viewer.tickTimer) {
    clearInterval(viewer.tickTimer);
    viewer.tickTimer = null;
  }
}

export function syncSubagentRowClock() {
  syncTicker();
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

export function initSubagentViewer() {
  if (initialized) return;
  initialized = true;
  // A sub-agent row without the worker's `steps` counts the run's activity
  // lines, the number its reply bubble shows.
  setSubagentStepCounter((runId) => {
    const activities = getSubagentRun(runId)?.activities;
    return Array.isArray(activities) ? activities.length : null;
  });
  viewerHistory = createViewerHistory({
    history: window.history,
    mark: 'oarSubagentViewer',
    onBack: () => closeSubagentViewer({ fromHistory: true }),
  });
  window.addEventListener('popstate', () => viewerHistory.onPopState());

  // Any sub-agent title on the page opens the viewer; one inside the viewer
  // (a child row) opens that child in place.
  document.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-subagent-open]');
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const runId = trigger.getAttribute('data-subagent-open');
    if (trigger.closest('#subagent-viewer-modal')) void openChild(runId);
    else void openSubagentViewer({ runId });
  });

  const { modal, stop, parent, body, jump, timeline } = elements();
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeSubagentViewer();
  });
  modal?.querySelector('.subagent-viewer-close')?.addEventListener('click', () => closeSubagentViewer());
  stop?.addEventListener('click', () => void stopRun());
  parent?.addEventListener('click', () => void openParent());
  jump?.addEventListener('click', () => {
    if (body) body.scrollTop = body.scrollHeight;
    jump.hidden = true;
  });
  body?.addEventListener('scroll', () => {
    if (jump && !jump.hidden && isAtBottom(body)) jump.hidden = true;
  }, { passive: true });
  // A fold the reader opened stays open while the entry keeps changing.
  timeline?.addEventListener('click', (event) => {
    const summary = event.target?.closest?.('summary');
    const entry = summary?.closest?.('.sav-entry');
    if (!entry) return;
    const seq = Number(entry.dataset.seq);
    setTimeout(() => {
      const details = summary.parentElement;
      if (details?.open) viewer.openFolds.add(seq);
      else viewer.openFolds.delete(seq);
    }, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !viewer.open) return;
    // The file viewer can sit on top (a path in the record); it closes first.
    if (document.getElementById('file-preview-modal')?.classList.contains('visible')) return;
    event.preventDefault();
    closeSubagentViewer();
  });
  syncTicker();
}

// For a run the store has not seen yet (a reply bubble built from the
// conversation payload): the row's header goes into the store, so status
// events merge onto it.
export function rememberSubagentRuns(runs) {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run?.subagentRunId) continue;
    const known = getSubagentRun(run.subagentRunId);
    // The payload is the relay's word: it fills a lane-made entry, and never
    // undoes a newer status event.
    if (known?.statusReported && String(known.updatedAt || '') > String(run.updatedAt || '')) continue;
    upsertSubagentRun({ ...run, timestamp: run.updatedAt || run.startedAt });
  }
}
