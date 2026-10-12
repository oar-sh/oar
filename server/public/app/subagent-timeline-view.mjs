// The sub-agent viewer's timeline, without a DOM: the merge of fetched and
// live entries into one ordered record, gap detection, and the markup of each
// entry. subagent-viewer.mjs owns the modal and calls into this.

import { prefixToolActivityEmoji } from './tool-activity-emoji.mjs';
import { subagentRowHtml } from './subagent-row.mjs';

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** One run's record as the viewer holds it. */
export function createTimelineState(runId) {
  return { runId: String(runId || ''), entries: new Map(), lastSeq: 0, maxSeq: 0 };
}

/**
 * Fold entries (a fetched page or a live event) into the record. An entry the
 * record already has is replaced (open entries grow in place). Returns the
 * seqs that changed and whether the record now has a hole: the relay numbers
 * a run's entries 1, 2, 3…, so a missing number means an event was missed and
 * the viewer should fetch from `lastSeq`.
 */
export function mergeTimelineEntries(state, entries) {
  const changed = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const seq = Number(raw?.seq);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    const previous = state.entries.get(seq);
    // A closed entry never reopens: a late open snapshot is stale.
    if (previous?.done && raw.done === false) continue;
    state.entries.set(seq, { ...raw, seq });
    changed.push(seq);
    if (seq > state.maxSeq) state.maxSeq = seq;
  }
  while (state.entries.has(state.lastSeq + 1)) state.lastSeq += 1;
  return { changed, gap: state.lastSeq < state.maxSeq };
}

export function orderedTimelineEntries(state) {
  return [...state.entries.values()].sort((a, b) => a.seq - b.seq);
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  if (!value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Same list as shared/subagent-timeline.mjs (the relay's retention sweep
// keeps this line when it strips a call's input); a test keeps them in step.
export const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'notebook_path', 'skill'];

/** The one line a tool call is known by: its command, path, pattern… */
export function toolCallSummary(text) {
  const input = parseJsonObject(text);
  if (input) {
    for (const field of SUMMARY_FIELDS) {
      const value = input[field];
      if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    const keys = Object.keys(input);
    return keys.length ? keys.slice(0, 4).join(', ') : '';
  }
  return String(text || '').split('\n')[0].trim().slice(0, 200);
}

/** A tool call's input, readable: pretty JSON, or the text as it came. */
export function formatToolInput(text) {
  const input = parseJsonObject(text);
  return input ? JSON.stringify(input, null, 2) : String(text || '');
}

export function formatByteSize(length) {
  const n = Number(length);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "removed after 90 days": what the relay's retention sweep left a note of. */
function prunedLabel(entry, what) {
  const days = Number(entry?.metadata?.retentionDays);
  return Number.isFinite(days) && days > 0 ? `${what} removed after ${days} days` : `${what} removed`;
}

function firstLine(text, max = 140) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One entry's markup. `renderMarkdown(text)` renders reply text (and
 * thoughts); `children` maps a child run id to its header so a child entry
 * renders as a clickable row; `openDetails` keeps a fold the reader opened
 * open across re-renders.
 */
export function timelineEntryHtml(entry, { renderMarkdown = (text) => `<p>${escHtml(text)}</p>`, children = new Map(), openDetails = false, clickable = true, now = Date.now() } = {}) {
  const kind = String(entry?.kind || '');
  const seq = Number(entry?.seq) || 0;
  const open = entry?.done === false;
  const text = String(entry?.text || '');
  const wrap = (inner, extraClass = '') => `<div class="sav-entry sav-entry-${escHtml(kind)}${open ? ' is-open' : ''}${extraClass}" data-seq="${seq}">${inner}</div>`;
  const openAttr = openDetails ? ' open' : '';

  if (kind === 'thought') {
    const label = open && !text.trim() ? 'Thinking…' : (firstLine(text, 110) || 'Thought');
    return wrap(`<details class="sav-fold"${open || openDetails ? ' open' : ''}><summary><span class="sav-kind">💭</span> <span class="sav-summary-text">${escHtml(label)}</span></summary><div class="sav-thought-body markdown-body">${renderMarkdown(text)}</div></details>`);
  }

  if (kind === 'text') {
    return wrap(`<div class="sav-text markdown-body">${text.trim() ? renderMarkdown(text) : '<span class="sav-muted">Writing…</span>'}</div>`);
  }

  if (kind === 'tool_call') {
    const toolName = String(entry?.toolName || 'tool');
    const headline = prefixToolActivityEmoji(`Tool (${toolName}): x`).split(' Tool (')[0] || '🔧';
    const summary = toolCallSummary(text);
    const input = formatToolInput(text);
    const hasMore = input.trim() && input.trim() !== summary;
    const legacy = entry?.metadata?.legacy === true;
    if (entry?.metadata?.pruned === true) {
      return wrap(`<div class="sav-call-line"><span class="sav-kind">${escHtml(headline)}</span> <span class="sav-tool-name">${escHtml(toolName)}</span> <span class="sav-tool-summary">${escHtml(summary)}</span> <span class="sav-muted sav-pruned">· ${escHtml(prunedLabel(entry, 'Input'))}</span></div>`, ' is-pruned');
    }
    if (legacy || !hasMore) {
      return wrap(`<div class="sav-call-line"><span class="sav-kind">${escHtml(headline)}</span> <span class="sav-tool-name">${escHtml(toolName)}</span> <span class="sav-tool-summary">${escHtml(legacy ? text.replace(/^Tool \([^)]+\):?\s*/, '') : summary)}</span></div>`);
    }
    return wrap(`<details class="sav-fold"${openAttr}><summary><span class="sav-kind">${escHtml(headline)}</span> <span class="sav-tool-name">${escHtml(toolName)}</span> <span class="sav-tool-summary">${escHtml(summary)}</span></summary><pre class="sav-pre">${escHtml(input)}</pre></details>`);
  }

  if (kind === 'tool_result') {
    const isError = entry?.metadata?.isError === true;
    const cut = Number(entry?.metadata?.cut);
    const parts = [isError ? 'Error' : 'Result'];
    if (text) parts.push(formatByteSize(text.length));
    if (Number.isFinite(cut) && cut > text.length) parts.push(`cut from ${formatByteSize(cut)}`);
    const preview = firstLine(text, 120);
    if (entry?.metadata?.pruned === true) {
      const size = formatByteSize(entry.metadata.originalChars);
      const label = [isError ? 'Error' : 'Result', size, prunedLabel(entry, 'output')].filter(Boolean).join(' · ');
      return wrap(`<div class="sav-result-line"><span class="sav-kind">↳</span> <span class="sav-muted sav-pruned">${escHtml(label)}</span></div>`, `${isError ? ' is-error' : ''} is-pruned`);
    }
    if (!text.trim()) {
      return wrap(`<div class="sav-result-line"><span class="sav-kind">↳</span> <span class="sav-muted">${escHtml(parts.join(' · '))} · empty</span></div>`, isError ? ' is-error' : '');
    }
    return wrap(`<details class="sav-fold"${openAttr}><summary><span class="sav-kind">↳</span> <span class="sav-result-label">${escHtml(parts.join(' · '))}</span>${preview ? ` <span class="sav-summary-text sav-muted">${escHtml(preview)}</span>` : ''}</summary><pre class="sav-pre">${escHtml(text)}</pre></details>`, isError ? ' is-error' : '');
  }

  if (kind === 'child') {
    const childId = String(entry?.toolUseId || '');
    const child = children.get(childId) || {
      subagentRunId: childId,
      displayName: text || 'Subagent',
      subagentType: entry?.metadata?.subagentType || null,
      status: 'running',
    };
    return wrap(childId ? subagentRowHtml(child, { context: 'timeline', clickable, now }) : `<div class="sav-muted">🤖 ${escHtml(text)}</div>`);
  }

  // note
  const status = String(entry?.metadata?.status || '');
  return wrap(`<div class="sav-note${status ? ` sav-note-${escHtml(status)}` : ''}">${escHtml(text)}</div>`);
}

/** The header's meta line: model · type · status · tokens · time. */
export function headerMetaParts(run, { formatModel, formatTokens, formatDuration, statusLabel, now = Date.now() } = {}) {
  const parts = [];
  if (run?.model) parts.push(formatModel ? formatModel(run.model) : run.model);
  parts.push(String(run?.subagentType || 'Subagent'));
  parts.push(statusLabel ? statusLabel(run?.status) : String(run?.status || 'running'));
  if (run?.background) parts.push('background');
  const tokens = formatTokens ? formatTokens(run?.totalTokens) : '';
  if (tokens) parts.push(tokens);
  const running = ['running', 'pending', 'processing'].includes(String(run?.status || 'running'));
  const time = formatDuration ? formatDuration(run?.startedAt, running ? null : (run?.completedAt || run?.updatedAt), now) : '';
  if (time) parts.push(time);
  return parts.filter(Boolean);
}
