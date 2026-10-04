// Full-width transcript break rows: once-per-day date separators and the
// Claude auto-compaction boundary. Both kinds go through ONE idempotent DOM
// pass (syncTranscriptSeparators), because every insertion path — a full
// render, an appended live message, a prepended older history page — can
// invalidate separators that are already in the DOM. The planning half
// (buildSeparatorPlan) is pure and carries the whole decision, so the rules
// are testable without a DOM.
//
// Separator rows deliberately carry neither the `msg` class nor
// data-message-id: the render bookkeeping (rendered-fingerprint collection,
// seen-message ids, the "first row" anchors) walks `.msg`, and a separator
// that answered those selectors would be mistaken for a message.
import { parseTimestampMs } from './store.js';

export const SEPARATOR_CLASS = 'transcript-separator';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyOf(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `Today` / `Yesterday` for the two most recent local days, `Mon, 18 Aug`
 * within the current calendar year, `Mon, 18 Aug 2025` before it.
 */
export function formatDayLabel(value, nowMs = Date.now()) {
  const timestampMs = typeof value === 'number' && Number.isFinite(value)
    ? value
    : parseTimestampMs(value);
  if (!timestampMs) return '';
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const dayStart = startOfLocalDay(timestampMs);
  const todayStart = startOfLocalDay(now);
  if (dayStart === todayStart) return 'Today';
  if (dayStart === startOfLocalDay(todayStart - DAY_MS)) return 'Yesterday';
  const date = new Date(timestampMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const base = date.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return base;
}

function formatCompactTokens(value) {
  if (value == null || value === '') return '';
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return '';
  if (count < 1000) return String(Math.round(count));
  return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

// Stamp of a compaction that is still running (the live bubble's
// `data-compact-boundary`).
export const COMPACT_PENDING_STAMP = 'pending';

/**
 * Parses the `data-compact-boundary` stamp (`"<pre>|<post>"`, either side
 * possibly empty, or `pending`) into token counts.
 */
export function parseCompactBoundaryValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (text === COMPACT_PENDING_STAMP) return { pending: true, preTokens: null, postTokens: null };
  const [rawPre, rawPost] = text.split('|');
  const toCount = (raw) => {
    const digits = String(raw || '').trim();
    if (!digits) return null;
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  };
  return { preTokens: toCount(rawPre), postTokens: toCount(rawPost) };
}

export function formatCompactBoundaryLabel(boundary) {
  if (boundary?.pending) return 'Compacting context…';
  const preTokens = formatCompactTokens(boundary?.preTokens);
  const postTokens = formatCompactTokens(boundary?.postTokens);
  if (preTokens && postTokens) return `Context compacted · ${preTokens} → ${postTokens} tokens`;
  // Auto-compact payloads carry no post_tokens — optional in the SDK type and
  // absent from the on-disk transcript of every compaction inspected — so the
  // pre-only count is the whole story the break can tell.
  if (preTokens) return `Context compacted · was ${preTokens} tokens`;
  return 'Context compacted';
}

/**
 * Pure planner: rows in transcript order →
 * `[{ key, kind, label, beforeIndex, messageId }]`, each separator keyed by
 * the row it precedes. A day separator opens the transcript and repeats on
 * every local-day rollover; a compaction separator sits immediately before
 * the message whose activities recorded the boundary (after that message's
 * day separator, when both land on the same row).
 *
 * The compaction key names the turn (`sourceMessageId`, else the row's own
 * id), not the token counts: the live bubble and the reply that replaces it
 * share it, so a running compaction's line is relabelled in place when the
 * boundary lands instead of being swapped for a second row.
 */
export function buildSeparatorPlan(rows, nowMs = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const plan = [];
  let previousDayKey = '';
  list.forEach((row, index) => {
    const messageId = String(row?.messageId || '').trim();
    const timestampMs = Number.isFinite(Number(row?.timestampMs)) && Number(row?.timestampMs)
      ? Number(row.timestampMs)
      : parseTimestampMs(row?.timestamp);
    if (timestampMs) {
      const dayKey = dayKeyOf(timestampMs);
      if (dayKey !== previousDayKey) {
        previousDayKey = dayKey;
        plan.push({
          key: `day:${dayKey}`,
          kind: 'day',
          label: formatDayLabel(timestampMs, nowMs),
          beforeIndex: index,
          messageId,
        });
      }
    }
    const boundary = row?.compactBoundary && typeof row.compactBoundary === 'object'
      ? row.compactBoundary
      : parseCompactBoundaryValue(row?.compactBoundary);
    if (boundary && (boundary.pending || boundary.preTokens != null || boundary.postTokens != null || row?.compactBoundary)) {
      const turnId = String(row?.sourceMessageId || '').trim() || messageId || index;
      plan.push({
        key: `compact:${turnId}`,
        kind: 'compact',
        label: formatCompactBoundaryLabel(boundary),
        pending: boundary.pending === true,
        beforeIndex: index,
        messageId,
      });
    }
  });
  return plan;
}

function readRowFromNode(node) {
  const dataset = node?.dataset || {};
  return {
    messageId: String(dataset.messageId || '').trim(),
    sourceMessageId: String(dataset.sourceMessageId || '').trim(),
    timestamp: String(dataset.messageTimestamp || '').trim(),
    compactBoundary: String(dataset.compactBoundary || '').trim(),
  };
}

// The animated dots of a running compaction sit after the label text.
function setSeparatorLabel(doc, node, separator) {
  const label = node.querySelector?.('.transcript-separator-label');
  if (!label) return;
  // textContent, never innerHTML: labels are generated here but the row sits
  // in the same container as user content.
  label.replaceChildren?.();
  label.textContent = separator.label;
  if (separator.pending) {
    const dots = doc.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i += 1) dots.appendChild(doc.createElement('span'));
    label.appendChild(dots);
  }
  node.classList.toggle('is-pending', !!separator.pending);
  node.setAttribute('aria-label', separator.label);
  node.dataset.separatorLabel = separator.label;
}

function createSeparatorNode(doc, separator) {
  const node = doc.createElement('div');
  node.className = separator.kind === 'compact'
    ? `${SEPARATOR_CLASS} is-compact`
    : `${SEPARATOR_CLASS} is-day`;
  node.dataset.separatorKey = separator.key;
  node.dataset.separatorKind = separator.kind;
  node.setAttribute('role', 'separator');
  const label = doc.createElement('span');
  label.className = 'transcript-separator-label';
  node.appendChild(label);
  setSeparatorLabel(doc, node, separator);
  return node;
}

function isSeparatorNode(node) {
  return node?.nodeType === 1 && node.classList?.contains(SEPARATOR_CLASS);
}

/**
 * Idempotent DOM pass: reconciles the separators already in `container`
 * against the plan for the messages it currently holds. Safe to call after
 * any insertion path; runs no DOM writes when nothing changed.
 */
export function syncTranscriptSeparators(container, nowMs = Date.now()) {
  if (!container || typeof container.querySelectorAll !== 'function') return 0;
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') return 0;
  // The live bubble carries no timestamp; it joins the plan only while it
  // stamps its turn's compaction.
  const nodes = Array.from(container.querySelectorAll('.msg[data-message-timestamp], .msg[data-compact-boundary]'))
    .filter((node) => node.parentNode === container);
  const plan = buildSeparatorPlan(nodes.map(readRowFromNode), nowMs);
  const planByIndex = new Map();
  for (const separator of plan) {
    const list = planByIndex.get(separator.beforeIndex) || [];
    list.push(separator);
    planByIndex.set(separator.beforeIndex, list);
  }
  const kept = new Set();
  let changed = 0;
  nodes.forEach((node, index) => {
    const desired = planByIndex.get(index) || [];
    const existing = [];
    let cursor = node.previousSibling;
    while (isSeparatorNode(cursor)) {
      existing.unshift(cursor);
      cursor = cursor.previousSibling;
    }
    const matches = existing.length === desired.length
      && existing.every((el, i) => el.dataset.separatorKey === desired[i].key);
    if (matches) {
      // Same rows, maybe a new label (a running compaction that finished):
      // relabel in place.
      existing.forEach((el, i) => {
        if (el.dataset.separatorLabel === desired[i].label) return;
        setSeparatorLabel(doc, el, desired[i]);
        changed += 1;
      });
      for (const el of existing) kept.add(el);
      return;
    }
    for (const el of existing) el.remove();
    for (const separator of desired) {
      const created = createSeparatorNode(doc, separator);
      container.insertBefore(created, node);
      kept.add(created);
      changed += 1;
    }
    changed += existing.length;
  });
  // Anything left over (a stale row above a removed message, or a separator
  // stranded at the tail) goes.
  for (const el of Array.from(container.querySelectorAll(`.${SEPARATOR_CLASS}`))) {
    if (kept.has(el)) continue;
    el.remove();
    changed += 1;
  }
  syncSeparatorRail(container);
  return changed;
}

export const RAIL_ID = 'transcript-separator-rail';

function ensureRail(container) {
  const parent = container.parentNode;
  const doc = container.ownerDocument;
  if (!parent || typeof parent.appendChild !== 'function' || typeof doc?.createElement !== 'function') return null;
  const existing = typeof parent.querySelector === 'function' ? parent.querySelector(`#${RAIL_ID}`) : null;
  if (existing) return existing;
  const rail = doc.createElement('div');
  rail.id = RAIL_ID;
  // Decoration only: the separators themselves carry the accessible labels.
  rail.setAttribute('aria-hidden', 'true');
  parent.appendChild(rail);
  return rail;
}

/**
 * One dot per separator, floated beside the scrollbar at the separator's
 * proportional position in the scroll content.
 *
 * The rail is a sibling of the scroll container, not a child: children of a
 * scroller scroll away with the content. Positions are read from the
 * separator rows this module already inserted, so there is no second source
 * of truth — and offsets only mean anything once the container is laid out,
 * which is why every read is guarded (the unit-test node model reports none).
 */
export function syncSeparatorRail(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return 0;
  const rail = ensureRail(container);
  if (!rail || typeof rail.replaceChildren !== 'function') return 0;
  const scrollHeight = Number(container.scrollHeight) || 0;
  const rows = Array.from(container.querySelectorAll(`.${SEPARATOR_CLASS}`))
    .filter((node) => node.parentNode === container);
  // A conversation with no boundaries gets no rail rather than an empty stripe.
  if (!rows.length || scrollHeight <= 0) {
    rail.replaceChildren();
    rail.hidden = true;
    return 0;
  }
  const doc = container.ownerDocument;
  rail.hidden = false;
  // The rail spans the scroll viewport, which is only part of the positioned
  // parent (the header and composer sit outside it).
  rail.style.top = `${Number(container.offsetTop) || 0}px`;
  rail.style.height = `${Number(container.clientHeight) || 0}px`;
  const fragment = doc.createDocumentFragment();
  for (const row of rows) {
    const dot = doc.createElement('div');
    const isCompact = row.dataset?.separatorKind === 'compact';
    dot.className = `transcript-rail-dot${isCompact ? ' is-compact' : ''}`;
    dot.style.top = `${((Number(row.offsetTop) || 0) / scrollHeight) * 100}%`;
    dot.title = row.dataset?.separatorLabel || '';
    fragment.appendChild(dot);
  }
  rail.replaceChildren(fragment);
  return rows.length;
}
