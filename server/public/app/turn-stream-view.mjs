// The stream view of one agent turn, without a DOM: its thoughts, tool calls
// and reply as one list in the order they happened. The order is the turn's
// shared number on every thought and tool line (turnSeq, migration 0038).
// A turn with a row that has none (recorded before, or by an older relay)
// returns null and keeps the grouped layout. Main thread only: a sub-agent's
// rows stay in its own row and viewer.

import {
  isOmittedActivityMarker,
  normalizeRelayActivityEntry,
  normalizeTurnSeq,
} from './activity-replay-state.mjs';

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** A '● ' line is a progress note: it stays where the grouped layout puts it. */
export function isProgressActivityText(text) {
  return String(text || '').startsWith('● ');
}

function firstLine(text, max = 110) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The turn's main-thread entries in order, the reply last:
 * `[{ kind: 'thought'|'tool'|'omitted'|'reply', turnSeq, … }]`, or null when
 * the turn cannot be ordered (a main-thread thought or tool line without a
 * turnSeq) or has no thought or tool line at all. `activities` are the
 * bubble's visible ones (the promoted compaction boundary already taken out);
 * progress lines ('● ') are left out here. The "… earlier tool lines
 * omitted" row the relay's cap adds goes where the first line it stands for
 * was (`metadata.fromTurnSeq`), else right before the first tool line kept
 * after it.
 */
export function turnStreamEntries({ thoughts = [], activities = [], text = '' } = {}) {
  const entries = [];
  let missing = false;
  for (const thought of Array.isArray(thoughts) ? thoughts : []) {
    if (!thought || thought.subagentRunId || !String(thought.text || '').trim()) continue;
    const turnSeq = normalizeTurnSeq(thought.turnSeq);
    if (turnSeq === null) { missing = true; break; }
    entries.push({
      kind: 'thought',
      turnSeq,
      order: turnSeq,
      reasoningId: String(thought.reasoningId || ''),
      text: String(thought.text),
    });
  }
  if (missing) return null;

  let pendingMarkers = [];
  for (const item of Array.isArray(activities) ? activities : []) {
    const entry = normalizeRelayActivityEntry(item);
    if (!entry || entry.subagentRunId) continue;
    if (isOmittedActivityMarker(entry)) {
      const marker = { kind: 'omitted', turnSeq: null, text: entry.text, count: Number(entry.metadata.count) || 0 };
      // Where the first line it stands for was; else before the next line kept.
      const from = normalizeTurnSeq(entry.metadata.fromTurnSeq);
      if (from !== null) entries.push({ ...marker, order: from });
      else pendingMarkers.push(marker);
      continue;
    }
    if (isProgressActivityText(entry.text)) continue;
    if (entry.turnSeq === undefined) return null;
    for (const [index, marker] of pendingMarkers.entries()) {
      entries.push({ ...marker, order: entry.turnSeq - 0.5 + index * 0.001 });
    }
    pendingMarkers = [];
    entries.push({
      kind: 'tool',
      turnSeq: entry.turnSeq,
      order: entry.turnSeq,
      text: entry.text,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
  }
  if (!entries.length) return null;
  const lastOrder = Math.max(...entries.map((entry) => entry.order));
  for (const [index, marker] of pendingMarkers.entries()) {
    entries.push({ ...marker, order: lastOrder + 0.5 + index * 0.001 });
  }
  entries.sort((a, b) => a.order - b.order);
  const ordered = entries.map(({ order, ...entry }) => entry);
  if (String(text || '').trim()) ordered.push({ kind: 'reply', turnSeq: null, text: String(text) });
  return ordered;
}

/**
 * The list's markup. `renderMarkdown(text)` renders a thought and the reply;
 * `decorate(text)` is the tool line's display text (its emoji);
 * `thoughtsOpen` opens the thought folds (closed on a finished turn).
 */
export function renderTurnStreamMarkup(entries, {
  thoughtsOpen = false,
  renderMarkdown = (text) => `<p>${escHtml(text)}</p>`,
  decorate = (text) => text,
} = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => {
    const seqAttr = entry.turnSeq != null ? ` data-turn-seq="${escHtml(entry.turnSeq)}"` : '';
    if (entry.kind === 'thought') {
      return `<details class="msg-stream-thought"${seqAttr}${entry.reasoningId ? ` data-reasoning-id="${escHtml(entry.reasoningId)}"` : ''}${thoughtsOpen ? ' open' : ''}>`
        + `<summary>💭 ${escHtml(firstLine(entry.text) || 'Thought')}</summary>`
        + `<div class="msg-stream-thought-body">${renderMarkdown(entry.text)}</div></details>`;
    }
    if (entry.kind === 'tool') {
      return `<div class="msg-activity-item msg-stream-tool"${seqAttr}>${escHtml(decorate(entry.text))}</div>`;
    }
    if (entry.kind === 'omitted') {
      return `<div class="msg-stream-omitted">${escHtml(entry.text)}</div>`;
    }
    if (entry.kind === 'reply') {
      return `<div class="msg-stream-reply">${renderMarkdown(entry.text)}</div>`;
    }
    return '';
  });
  return `<div class="msg-turn-stream">${rows.join('')}</div>`;
}
