import test from 'node:test';
import assert from 'node:assert/strict';

// transcript-separators.mjs reuses store.js's tolerant parseTimestampMs (SQLite
// "YYYY-MM-DD HH:MM:SS" rows have no timezone and must be read as UTC), and
// store.js touches window/document at import time — the same browser-global
// stub the other conversation-view suites install.
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById() { return { addEventListener() {} }; },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };

const {
  buildSeparatorPlan,
  formatDayLabel,
  formatCompactBoundaryLabel,
  parseCompactBoundaryValue,
} = await import('./transcript-separators.mjs');

// Local-time anchors: the separators bucket by the viewer's calendar day, so
// the fixtures are built from local Date parts rather than fixed UTC strings.
function localIso(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

const NOW = new Date(2026, 7, 20, 15, 0, 0, 0).getTime(); // Thu 20 Aug 2026, local

test('labels the two most recent days by name and older days by date', () => {
  assert.equal(formatDayLabel(localIso(2026, 8, 20, 9), NOW), 'Today');
  assert.equal(formatDayLabel(localIso(2026, 8, 20, 23, 59), NOW), 'Today');
  assert.equal(formatDayLabel(localIso(2026, 8, 19, 23, 59), NOW), 'Yesterday');

  const thisYear = formatDayLabel(localIso(2026, 8, 18, 10), NOW);
  assert.match(thisYear, /18/);
  assert.doesNotMatch(thisYear, /2026/);

  const older = formatDayLabel(localIso(2025, 8, 18, 10), NOW);
  assert.match(older, /18/);
  assert.match(older, /2025/);
});

test('reads SQLite-style timestamps without a timezone as UTC', () => {
  const utcNoon = Date.UTC(2026, 7, 20, 12, 0, 0);
  assert.equal(
    formatDayLabel('2026-08-20 12:00:00', utcNoon + 1000),
    formatDayLabel(new Date(utcNoon).toISOString(), utcNoon + 1000),
  );
});

test('opens the transcript with one day separator and repeats it only on rollover', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 19, 9) },
    { messageId: 'm2', timestamp: localIso(2026, 8, 19, 18) },
    { messageId: 'm3', timestamp: localIso(2026, 8, 20, 8) },
    { messageId: 'm4', timestamp: localIso(2026, 8, 20, 9) },
  ], NOW);

  assert.deepEqual(
    plan.map((entry) => [entry.kind, entry.beforeIndex, entry.label]),
    [['day', 0, 'Yesterday'], ['day', 2, 'Today']],
  );
});

test('messages that all share one day get exactly one separator', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) },
    { messageId: 'm2', timestamp: localIso(2026, 8, 20, 10) },
    { messageId: 'm3', timestamp: localIso(2026, 8, 20, 11) },
  ], NOW);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'day');
  assert.equal(plan[0].beforeIndex, 0);
});

test('a compaction between two same-day messages breaks the run without a new day row', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) },
    { messageId: 'm2', timestamp: localIso(2026, 8, 20, 10), compactBoundary: '120000|40000' },
  ], NOW);

  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((entry) => entry.kind), ['day', 'compact']);
  // Anchored on the assistant message the compaction was recorded against, so
  // the break renders immediately above that bubble.
  assert.equal(plan[1].beforeIndex, 1);
  assert.equal(plan[1].messageId, 'm2');
  assert.equal(plan[1].label, 'Context compacted · 120k → 40k tokens');
});

test('a compaction on the first message of a new day renders under that day row', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 19, 9) },
    { messageId: 'm2', timestamp: localIso(2026, 8, 20, 10), compactBoundary: '9000|3000' },
  ], NOW);

  assert.deepEqual(
    plan.map((entry) => [entry.kind, entry.beforeIndex]),
    [['day', 0], ['day', 1], ['compact', 1]],
  );
});

test('a prepended older page re-plans: the day row moves to the new first message', () => {
  const newerOnly = buildSeparatorPlan([
    { messageId: 'm3', timestamp: localIso(2026, 8, 20, 8) },
    { messageId: 'm4', timestamp: localIso(2026, 8, 20, 9) },
  ], NOW);
  assert.deepEqual(newerOnly.map((entry) => [entry.key, entry.beforeIndex]), [
    [`day:2026-08-20`, 0],
  ]);

  // Older page prepended, same calendar day: still one separator, now above
  // the older message rather than the previously-first one.
  const sameDayPrepend = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 20, 1) },
    { messageId: 'm3', timestamp: localIso(2026, 8, 20, 8) },
    { messageId: 'm4', timestamp: localIso(2026, 8, 20, 9) },
  ], NOW);
  assert.deepEqual(sameDayPrepend.map((entry) => [entry.key, entry.beforeIndex]), [
    [`day:2026-08-20`, 0],
  ]);

  // Older page from the previous day: two separators, and the "Today" row
  // stays anchored to the first message of today.
  const rolloverPrepend = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 19, 22) },
    { messageId: 'm3', timestamp: localIso(2026, 8, 20, 8) },
    { messageId: 'm4', timestamp: localIso(2026, 8, 20, 9) },
  ], NOW);
  assert.deepEqual(rolloverPrepend.map((entry) => [entry.label, entry.beforeIndex]), [
    ['Yesterday', 0],
    ['Today', 1],
  ]);
});

test('rows without a usable timestamp get no day separator', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: '' },
    { messageId: 'm2', timestamp: localIso(2026, 8, 20, 9) },
  ], NOW);

  assert.deepEqual(plan.map((entry) => [entry.kind, entry.beforeIndex]), [['day', 1]]);
});

test('compaction labels degrade to prose when the SDK omitted the token counts', () => {
  assert.equal(parseCompactBoundaryValue(''), null);
  assert.deepEqual(parseCompactBoundaryValue('120000|40000'), { preTokens: 120000, postTokens: 40000 });
  assert.deepEqual(parseCompactBoundaryValue('|'), { preTokens: null, postTokens: null });
  assert.equal(formatCompactBoundaryLabel({ preTokens: null, postTokens: null }), 'Context compacted');
  assert.equal(formatCompactBoundaryLabel({ preTokens: 900, postTokens: 400 }), 'Context compacted · 900 → 400 tokens');
  // Every auto-compact payload seen live omits post_tokens; the break must
  // still report what it knows rather than collapsing to bare prose.
  assert.equal(formatCompactBoundaryLabel({ preTokens: 614117, postTokens: null }), 'Context compacted · was 614.1k tokens');
  assert.deepEqual(parseCompactBoundaryValue('614117|'), { preTokens: 614117, postTokens: null });
});

test('a boundary with only preTokens still plans a break row', () => {
  const plan = buildSeparatorPlan([
    { messageId: 'm1', timestamp: localIso(2026, 8, 20, 9), compactBoundary: { preTokens: 614117, postTokens: null } },
  ], NOW);
  assert.deepEqual(
    plan.map((entry) => [entry.kind, entry.label]),
    [['day', 'Today'], ['compact', 'Context compacted · was 614.1k tokens']],
  );
});

// ---------------------------------------------------------------------------
// The DOM half. There is no jsdom in this repo, so the reconcile pass runs
// against a hand-rolled node model carrying only what syncTranscriptSeparators
// touches: ordered children, insertBefore/remove, previousSibling, dataset,
// classList, and the two class selectors it queries.
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(doc, tag = 'div') {
    this.nodeType = 1;
    this.tagName = tag;
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.style = {};
    this.hidden = false;
    // Layout is inert unless a test sets it, which is what keeps the rail a
    // no-op in the separator tests that only care about rows.
    this.offsetTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      contains: (name) => this._classes.has(name),
    };
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(' ');
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  appendChild(node) {
    node.parentNode?.removeChildNode(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, ref) {
    node.parentNode?.removeChildNode(node);
    const index = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }

  removeChildNode(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
  }

  remove() { this.parentNode?.removeChildNode(this); }

  get previousSibling() {
    const siblings = this.parentNode?.childNodes || [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChildNode(child);
    for (const node of nodes) {
      // A document fragment contributes its children, not itself.
      if (node?.nodeType === 11) {
        for (const child of [...node.childNodes]) this.appendChild(child);
        continue;
      }
      this.appendChild(node);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const raw = String(selector);
    if (raw.startsWith('#')) {
      const id = raw.slice(1);
      return this.childNodes.filter((node) => node.id === id);
    }
    const [classPart, attrPart] = raw.split('[');
    const className = classPart.replace(/^\./, '');
    const attrName = attrPart ? attrPart.replace(']', '') : '';
    const datasetKey = attrName.replace(/^data-/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return this.childNodes.filter((node) => node._classes.has(className)
      && (!datasetKey || String(node.dataset[datasetKey] || '')));
  }
}

function makeContainer() {
  const doc = { createElement: (tag) => new FakeNode(doc, tag) };
  const container = new FakeNode(doc);
  container.appendMessageRow = ({ messageId, timestamp, compactBoundary = '' }) => {
    const node = new FakeNode(doc);
    node.className = 'msg assistant';
    node.dataset.messageId = messageId;
    node.dataset.messageTimestamp = timestamp;
    if (compactBoundary) node.dataset.compactBoundary = compactBoundary;
    container.appendChild(node);
    return node;
  };
  return container;
}

function rowSummary(container) {
  return container.childNodes.map((node) => (node._classes.has('transcript-separator')
    ? `sep:${node.dataset.separatorLabel}`
    : `msg:${node.dataset.messageId}`));
}

test('the sync pass inserts break rows in place and is idempotent', async () => {
  const { syncTranscriptSeparators } = await import('./transcript-separators.mjs');
  const container = makeContainer();
  container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 19, 9) });
  container.appendMessageRow({ messageId: 'm2', timestamp: localIso(2026, 8, 20, 9) });
  container.appendMessageRow({ messageId: 'm3', timestamp: localIso(2026, 8, 20, 10), compactBoundary: '120000|40000' });

  assert.equal(syncTranscriptSeparators(container, NOW) > 0, true);
  assert.deepEqual(rowSummary(container), [
    'sep:Yesterday',
    'msg:m1',
    'sep:Today',
    'msg:m2',
    'sep:Context compacted · 120k → 40k tokens',
    'msg:m3',
  ]);

  // Second pass changes nothing: no churn on every append/render tick.
  assert.equal(syncTranscriptSeparators(container, NOW), 0);
  assert.deepEqual(rowSummary(container), [
    'sep:Yesterday',
    'msg:m1',
    'sep:Today',
    'msg:m2',
    'sep:Context compacted · 120k → 40k tokens',
    'msg:m3',
  ]);
});

test('separator rows are invisible to the message selectors', async () => {
  const { syncTranscriptSeparators } = await import('./transcript-separators.mjs');
  const container = makeContainer();
  container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) });
  syncTranscriptSeparators(container, NOW);

  const separator = container.childNodes[0];
  assert.equal(separator._classes.has('msg'), false);
  assert.equal(separator.dataset.messageId, undefined);
  assert.equal(container.querySelectorAll('.msg[data-message-timestamp]').length, 1);
});

test('a stale separator is retired when its message goes away', async () => {
  const { syncTranscriptSeparators } = await import('./transcript-separators.mjs');
  const container = makeContainer();
  const yesterday = container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 19, 9) });
  container.appendMessageRow({ messageId: 'm2', timestamp: localIso(2026, 8, 20, 9) });
  syncTranscriptSeparators(container, NOW);
  assert.deepEqual(rowSummary(container), ['sep:Yesterday', 'msg:m1', 'sep:Today', 'msg:m2']);

  yesterday.remove();
  syncTranscriptSeparators(container, NOW);
  assert.deepEqual(rowSummary(container), ['sep:Today', 'msg:m2']);
});

// ─── Scrollbar rail ──────────────────────────────────────────────────────────

function makeLaidOutContainer({ scrollHeight, clientHeight = 400, offsetTop = 60 }) {
  const container = makeContainer();
  const doc = container.ownerDocument;
  doc.createDocumentFragment = () => {
    const fragment = new FakeNode(doc, '#fragment');
    fragment.nodeType = 11;
    return fragment;
  };
  const parent = new FakeNode(doc);
  parent.appendChild(container);
  container.scrollHeight = scrollHeight;
  container.clientHeight = clientHeight;
  container.offsetTop = offsetTop;
  return { container, parent };
}

function railDots(parent) {
  const rail = parent.querySelector('#transcript-separator-rail');
  return (rail?.childNodes || []).map((dot) => ({
    top: dot.style.top,
    compact: dot._classes.has('is-compact'),
    title: dot.title,
  }));
}

test('the rail places one dot per separator at its share of the scroll height', async () => {
  const { syncTranscriptSeparators } = await import('./transcript-separators.mjs');
  const { container, parent } = makeLaidOutContainer({ scrollHeight: 1000 });
  container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 19, 9) });
  container.appendMessageRow({
    messageId: 'm2',
    timestamp: localIso(2026, 8, 20, 9),
    compactBoundary: '120000|30000',
  });
  syncTranscriptSeparators(container, NOW);

  // Lay the rows out the way a browser would, then re-sync: the dots follow
  // the separator rows this module inserted, so offsets come from one source.
  container.childNodes.forEach((node, index) => { node.offsetTop = index * 250; });
  syncTranscriptSeparators(container, NOW);

  const dots = railDots(parent);
  assert.equal(dots.length, 3, 'one day dot, one later day dot, one compaction dot');
  assert.deepEqual(dots.map((dot) => dot.top), ['0%', '50%', '75%']);
  assert.deepEqual(dots.map((dot) => dot.compact), [false, false, true]);
  assert.equal(dots[0].title, 'Yesterday');
});

test('the rail spans the scroll viewport, not the whole positioned parent', async () => {
  const { syncTranscriptSeparators } = await import('./transcript-separators.mjs');
  const { container, parent } = makeLaidOutContainer({ scrollHeight: 800, clientHeight: 320, offsetTop: 64 });
  container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) });
  syncTranscriptSeparators(container, NOW);

  const rail = parent.querySelector('#transcript-separator-rail');
  assert.equal(rail.style.top, '64px');
  assert.equal(rail.style.height, '320px');
  assert.equal(rail.attributes['aria-hidden'], 'true');
});

test('a conversation with no boundaries hides the rail instead of showing an empty stripe', async () => {
  const { syncTranscriptSeparators, syncSeparatorRail } = await import('./transcript-separators.mjs');
  const { container, parent } = makeLaidOutContainer({ scrollHeight: 600 });
  container.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) });
  container.appendMessageRow({ messageId: 'm2', timestamp: localIso(2026, 8, 20, 11) });
  syncTranscriptSeparators(container, NOW);
  // One day separator exists for the first row, so drop it to reach the
  // no-boundary case a same-day conversation hits before today's rollover.
  for (const node of container.querySelectorAll('.transcript-separator')) node.remove();
  syncSeparatorRail(container);

  const rail = parent.querySelector('#transcript-separator-rail');
  assert.equal(rail.hidden, true);
  assert.equal(rail.childNodes.length, 0);
});

test('the rail is skipped when the container is not laid out or has no parent', async () => {
  const { syncTranscriptSeparators, syncSeparatorRail } = await import('./transcript-separators.mjs');
  const orphan = makeContainer();
  orphan.appendMessageRow({ messageId: 'm1', timestamp: localIso(2026, 8, 20, 9) });
  // No parent to hang a rail on, and no layout: must not throw, must not
  // disturb the separator rows.
  assert.doesNotThrow(() => syncTranscriptSeparators(orphan, NOW));
  assert.equal(syncSeparatorRail(orphan), 0);
  assert.deepEqual(rowSummary(orphan), ['sep:Today', 'msg:m1']);
});
