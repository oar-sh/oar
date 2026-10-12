// One sub-agent as a row: the same look as a background-task row in the
// composer panel (icon, title, detail line, model, type badge, tokens, time),
// used in the finished reply bubble and inside the sub-agent viewer for child
// agents. The title opens the agent's record in the viewer.
//
// Pure: markup in, markup out, so the bubble renderer and the viewer share it
// and tests run without a DOM.

import { formatTaskModelLabel, formatTaskTokens } from './task-row-format.mjs';

const STATUS_LABELS = {
  running: 'Running',
  pending: 'Starting',
  processing: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const STATUS_ICONS = {
  completed: '✓',
  failed: '✗',
  cancelled: '■',
};

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return Date.parse(String(value));
}

/** "42s", "3m 5s", "1h 4m": how long a run ran, or has been running. */
export function formatRunDuration(startedAt, endedAt = null, now = Date.now()) {
  const start = parseTime(startedAt);
  if (!Number.isFinite(start)) return '';
  const end = Number.isFinite(parseTime(endedAt)) ? parseTime(endedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function subagentStatusLabel(status) {
  const key = String(status || 'running').trim().toLowerCase();
  return STATUS_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Running');
}

export function isRunningSubagentStatus(status) {
  const key = String(status || 'running').trim().toLowerCase();
  return key === 'running' || key === 'pending' || key === 'processing';
}

/**
 * The row for one run. `clickable` makes the title the button that opens the
 * viewer (`data-subagent-open`); a shared view, which cannot read the record,
 * passes false. `context` lands in a class so the bubble and the viewer can
 * size the row differently.
 */
export function subagentRowHtml(run, { context = 'bubble', clickable = true, now = Date.now() } = {}) {
  const runId = String(run?.subagentRunId || '').trim();
  if (!runId) return '';
  const status = String(run?.status || 'running').trim().toLowerCase() || 'running';
  const running = isRunningSubagentStatus(status);
  const title = String(run?.displayName || '').trim() || `Subagent ${runId.slice(0, 8)}`;
  const modelLabel = formatTaskModelLabel(run?.model);
  const modelTitle = run?.modelInherited === true ? `${run.model} (inherited from the session)` : (run?.model || '');
  const kind = String(run?.subagentType || '').trim() || 'Subagent';
  const tokens = formatTaskTokens(run?.totalTokens);
  const time = formatRunDuration(run?.startedAt, running ? null : (run?.completedAt || run?.updatedAt), now);
  const statusIcon = STATUS_ICONS[status] ? `${STATUS_ICONS[status]} ` : '';
  const detailParts = [`${statusIcon}${subagentStatusLabel(status)}`];
  if (run?.background) detailParts.push('in the background');
  if (run?.truncated) detailParts.push('record cut');
  const titleHtml = clickable
    ? `<button type="button" class="subagent-open bg-task-desc" data-subagent-open="${escHtml(runId)}" title="Open this sub-agent's thoughts, tool calls and reply">${escHtml(title)}</button>`
    : `<span class="bg-task-desc">${escHtml(title)}</span>`;
  return `
    <div class="bg-task-row subagent-row subagent-row-${escHtml(context)}${running ? ' is-running' : ''}" data-subagent-row="${escHtml(runId)}" data-status="${escHtml(status)}">
      <span class="bg-task-icon" title="Sub-agent">🤖</span>
      <span class="bg-task-main">
        ${titleHtml}
        <span class="bg-task-detail subagent-row-status subagent-status-${escHtml(status)}">${escHtml(detailParts.join(' · '))}</span>
      </span>
      <span class="bg-task-side">
        <span class="bg-task-side-head">
          ${modelLabel ? `<span class="bg-task-model" title="${escHtml(modelTitle)}">${escHtml(modelLabel)}</span>` : ''}
          <span class="bg-task-badge">${escHtml(kind)}</span>
        </span>
        <span class="bg-task-side-status">
          ${tokens ? `<span class="bg-task-tokens">${escHtml(tokens)}</span>` : ''}
          ${time ? `<span class="bg-task-elapsed subagent-row-time"${running ? ` data-started-at="${escHtml(run?.startedAt || '')}"` : ''}>${escHtml(time)}</span>` : ''}
        </span>
      </span>
    </div>`;
}

/**
 * A run from the conversation payload, brought up to date with what the page
 * has learned since (the store, fed by status events). Only what the store
 * actually knows wins: an entry a live lane created has no header yet, and
 * its status is a guess unless a status event reported it.
 */
export function mergeLiveSubagentRun(base, live) {
  if (!live) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(live)) {
    if (key === 'status' || key === 'statusReported' || key === 'activities' || key === 'thoughts' || key === 'streamText') continue;
    if (value === null || value === undefined || value === '') continue;
    merged[key] = value;
  }
  if (live.statusReported && live.status) merged.status = live.status;
  return merged;
}

/**
 * The runs a reply bubble lists: top-level runs only (a child shows inside
 * its parent's record), in the order they were spawned.
 */
export function topLevelSubagentRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run && String(run.subagentRunId || '').trim() && !run.parentSubagentId)
    .sort((a, b) => (parseTime(a.startedAt) || 0) - (parseTime(b.startedAt) || 0));
}

/** The bubble's list of sub-agent rows, or '' when it spawned none. */
export function subagentRowsMarkup(runs, { clickable = true, now = Date.now() } = {}) {
  const roots = topLevelSubagentRuns(runs);
  if (!roots.length) return '';
  return `<div class="subagent-rows" data-subagent-rows>${roots.map((run) => subagentRowHtml(run, { context: 'bubble', clickable, now })).join('')}</div>`;
}
