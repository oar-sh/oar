import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Minimal DOM stand-in (same pattern as conversation-view.thoughts.test.mjs):
// enough for the panel's innerHTML row markup plus the createElement/
// textContent tree the workflow renderer builds.
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this._text = '';
    this._innerHTML = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  click() { for (const handler of this.listeners.click || []) handler({ preventDefault() {} }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

// The list stub materializes the workflow tree holders and fold buttons the
// row template emits, so renderBackgroundTasksPanel's post-innerHTML wiring
// (tree fill + chevron listeners) runs against real fake elements.
class FakeListElement extends FakeElement {
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.treeHolders = [];
    this.foldButtons = [];
    for (const match of this._innerHTML.matchAll(/<div class="bg-task-tree" data-task-id="([^"]*)"( hidden)?>/g)) {
      const holder = new FakeElement('div');
      holder.className = 'bg-task-tree';
      holder.setAttribute('data-task-id', match[1]);
      if (match[2]) holder.setAttribute('hidden', '');
      this.treeHolders.push(holder);
    }
    for (const match of this._innerHTML.matchAll(/<button type="button" class="bg-task-fold" data-task-id="([^"]*)"/g)) {
      const button = new FakeElement('button');
      button.className = 'bg-task-fold';
      button.dataset.taskId = match[1];
      this.foldButtons.push(button);
    }
  }
  get innerHTML() { return this._innerHTML; }
  querySelectorAll(selector) {
    if (selector === '.bg-task-tree') return this.treeHolders || [];
    if (selector === '.bg-task-fold') return this.foldButtons || [];
    return [];
  }
}

const summaryEl = new FakeElement('summary');
const listEl = new FakeListElement('div');
const panelEl = new FakeElement('details');
panelEl.querySelector = (selector) => {
  if (selector === '#background-tasks-summary') return summaryEl;
  if (selector === '#background-tasks-list') return listEl;
  return null;
};

const listenerTarget = { addEventListener() {} };
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById(id) { return id === 'background-tasks-panel' ? panelEl : listenerTarget; },
  createElement(tag) { return new FakeElement(tag); },
};
globalThis.sessionStorage = {
  getItem() { return ''; },
  setItem() {},
};
globalThis.CSS = { escape: (value) => String(value) };
// The panel starts a 1s elapsed-label interval on every render; a real
// interval would keep the test process alive forever.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const {
  setConversationBackgroundTasks,
  setBackgroundTasksConversation,
  renderWorkflowTreeInto,
  toggleWorkflowTreeFold,
  formatTaskTokens,
  workflowRunCardTitle,
  buildWorkflowRunCard,
} = await import('./background-tasks-view.mjs');

// Normalized digest shape (values lifted from the reference run record in
// server/claude-worker/fixtures/workflow-run-record.json).
function makeDigest(overrides = {}) {
  return {
    runId: 'wf_d8a3315d-fd5',
    workflowName: 'code-review',
    status: 'running',
    agentCount: 3,
    totalTokens: 321498,
    phases: [{ index: 1, title: 'Review' }, { index: 2, title: 'Verify' }],
    logs: ['4 raw findings from 3 reviewers, verifying each...'],
    agents: [
      { index: 1, label: 'review:logic', phaseIndex: 1, phaseTitle: 'Review', model: 'claude-sonnet-5', state: 'done', attempt: 1, lastToolName: 'StructuredOutput', tokens: 62208, toolCalls: 27, durationMs: 260054, startedAt: 1786980733726 },
      { index: 2, label: 'review:edge-cases-data', phaseIndex: 1, phaseTitle: 'Review', model: 'claude-sonnet-5', state: 'running', attempt: 1, lastToolName: 'Read', tokens: 39063, toolCalls: 17, durationMs: 119228, startedAt: 1786980733728 },
      { index: 3, label: 'verify:model-id.mjs', phaseIndex: 2, phaseTitle: 'Verify', model: 'claude-sonnet-5', state: 'queued', attempt: 1, lastToolName: null, tokens: null, toolCalls: null, durationMs: null, startedAt: null },
    ],
    agentsOmitted: 0,
    ...overrides,
  };
}

function makeWorkflowTask(overrides = {}) {
  return {
    taskId: 'wic26ymi4',
    taskType: 'local_workflow',
    description: 'Ultracode review workflow',
    startedAt: Date.now() - 5000,
    totalTokens: 321498,
    workflowProgress: makeDigest(),
    ...overrides,
  };
}

function collectByClass(element, className, found = []) {
  if (String(element.className || '').split(/\s+/).includes(className)) found.push(element);
  for (const child of element.children || []) collectByClass(child, className, found);
  return found;
}

test('workflow tree renders logs, phase groups, and two-line agent rows from a digest', () => {
  const container = new FakeElement('div');
  renderWorkflowTreeInto(container, makeWorkflowTask());

  const logs = collectByClass(container, 'bg-task-tree-log');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].textContent, '4 raw findings from 3 reviewers, verifying each...');
  assert.equal(container.children[0], logs[0], 'narrator logs come first');

  const phases = collectByClass(container, 'bg-task-tree-phase');
  assert.deepEqual(phases.map((phase) => phase.textContent), ['Review', 'Verify']);

  const agentRows = collectByClass(container, 'bg-task-tree-agent');
  assert.equal(agentRows.length, 3);
  // Line 1 carries only the label; line 2 is the muted metrics element, so
  // tokens never compete with the label for width.
  const doneRow = agentRows[0];
  assert.equal(collectByClass(doneRow, 'bg-task-agent-state')[0].textContent, '✓');
  assert.equal(collectByClass(doneRow, 'bg-task-agent-label')[0].textContent, 'review:logic');
  assert.equal(
    collectByClass(doneRow, 'bg-task-agent-meta')[0].textContent,
    'sonnet-5 · 62.2k tok · 27 tools · 4m20s',
  );
  // Null tokens/tools/duration are simply omitted, and queued renders ○.
  const queuedRow = agentRows[2];
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-state')[0].textContent, '○');
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-label')[0].textContent, 'verify:model-id.mjs');
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-meta')[0].textContent, 'sonnet-5');
  // Grouping: Review header precedes its two agents, Verify precedes the third.
  const order = container.children.map((child) => child.className);
  assert.deepEqual(order, [
    'bg-task-tree-log',
    'bg-task-tree-phase', 'bg-task-tree-agent', 'bg-task-tree-agent',
    'bg-task-tree-phase', 'bg-task-tree-agent',
  ]);
});

test('the running agent shows its last tool as a muted activity segment on the metrics line', () => {
  const container = new FakeElement('div');
  renderWorkflowTreeInto(container, makeWorkflowTask());
  const agentRows = collectByClass(container, 'bg-task-tree-agent');
  const runningRow = agentRows[1];
  assert.equal(collectByClass(runningRow, 'bg-task-agent-state')[0].textContent, '◐');
  assert.ok(collectByClass(runningRow, 'bg-task-agent-state-running').length, 'running icon gets the spinner class');
  assert.equal(collectByClass(runningRow, 'bg-task-agent-activity')[0].textContent, '— using Read');
  const runningLabel = collectByClass(runningRow, 'bg-task-agent-label')[0];
  assert.equal(
    collectByClass(runningLabel, 'bg-task-agent-activity').length,
    0,
    'the activity must not ride the 2-line-clamped label, where a long label would hide it',
  );
  assert.equal(runningLabel.textContent, 'review:edge-cases-data');
  const runningMeta = collectByClass(runningRow, 'bg-task-agent-meta')[0];
  assert.ok(
    collectByClass(runningMeta, 'bg-task-agent-activity').length,
    'the activity is the always-visible metrics line\'s last segment',
  );
  assert.equal(runningMeta.textContent, 'sonnet-5 · 39.1k tok · 17 tools · 1m59s — using Read');
  assert.equal(collectByClass(agentRows[0], 'bg-task-agent-activity').length, 0, 'done agents show no activity');
});

test('a running agent with no metrics still gets a metrics line carrying just the activity', () => {
  const container = new FakeElement('div');
  renderWorkflowTreeInto(container, makeWorkflowTask({
    workflowProgress: makeDigest({
      phases: [],
      logs: [],
      agents: [
        { index: 1, label: 'lone-agent', phaseIndex: null, phaseTitle: null, model: null, state: 'running', attempt: null, lastToolName: 'Bash', tokens: null, toolCalls: null, durationMs: null, startedAt: null },
      ],
    }),
  }));
  const meta = collectByClass(container, 'bg-task-agent-meta')[0];
  assert.ok(meta, 'the metrics line exists solely to carry the activity');
  assert.equal(meta.textContent, '— using Bash');
});

test('ungrouped agents land last under no header, and agentsOmitted renders a trailing line', () => {
  const container = new FakeElement('div');
  const task = makeWorkflowTask({
    workflowProgress: makeDigest({
      logs: [],
      agents: [
        { index: 1, label: 'review:logic', phaseIndex: 1, phaseTitle: 'Review', model: 'claude-sonnet-5', state: 'done', tokens: 62208, toolCalls: 27, durationMs: 260054 },
        { index: 2, label: 'stray-agent', phaseIndex: null, phaseTitle: null, model: 'claude-sonnet-5', state: 'done', tokens: 1000, toolCalls: 2, durationMs: 4000 },
      ],
      agentsOmitted: 3,
    }),
  });
  renderWorkflowTreeInto(container, task);

  assert.deepEqual(container.children.map((child) => child.className), [
    'bg-task-tree-phase', 'bg-task-tree-agent',
    'bg-task-tree-agent',
    'bg-task-tree-omitted',
  ]);
  assert.match(collectByClass(container, 'bg-task-tree-agent')[1].textContent, /stray-agent/);
  assert.equal(collectByClass(container, 'bg-task-tree-omitted')[0].textContent, '+3 more agents');
});

test('workflow rows get a chevron and default to an expanded, populated tree while running', () => {
  setBackgroundTasksConversation('conv-expand');
  setConversationBackgroundTasks('conv-expand', [makeWorkflowTask({ taskId: 'wf-task-run' })]);

  assert.match(listEl.innerHTML, /bg-task-fold/, 'workflow row has a fold chevron');
  assert.match(listEl.innerHTML, /bg-task-badge/, 'flat summary row is preserved');
  assert.match(listEl.innerHTML, /Ultracode review workflow/);
  assert.match(listEl.innerHTML, /bg-task-stop/, 'Stop button is preserved');
  const holder = listEl.treeHolders[0];
  assert.equal(holder.hasAttribute('hidden'), false, 'running digest starts expanded');
  assert.ok(collectByClass(holder, 'bg-task-tree-phase').length >= 2, 'tree content is populated');
});

test('a manual fold survives the ~2s background_tasks replace re-renders', () => {
  const task = makeWorkflowTask({ taskId: 'wf-task-fold' });
  setBackgroundTasksConversation('conv-fold');
  setConversationBackgroundTasks('conv-fold', [task]);
  assert.equal(listEl.treeHolders[0].hasAttribute('hidden'), false);

  // User collapses via the chevron; the toggle re-renders immediately.
  listEl.foldButtons[0].click();
  assert.equal(listEl.treeHolders[0].hasAttribute('hidden'), true, 'chevron click collapses');

  // Simulate the next background_tasks replace: the fold must stick.
  setConversationBackgroundTasks('conv-fold', [makeWorkflowTask({ taskId: 'wf-task-fold' })]);
  assert.equal(listEl.treeHolders[0].hasAttribute('hidden'), true, 'manual collapse survives a replace');

  // And an explicit re-expand sticks the same way.
  toggleWorkflowTreeFold('wf-task-fold');
  setConversationBackgroundTasks('conv-fold', [makeWorkflowTask({ taskId: 'wf-task-fold' })]);
  assert.equal(listEl.treeHolders[0].hasAttribute('hidden'), false, 'manual expand survives a replace');
});

test('settled workflows default to a collapsed tree', () => {
  setBackgroundTasksConversation('conv-settled');
  setConversationBackgroundTasks('conv-settled', [
    makeWorkflowTask({ taskId: 'wf-task-done', workflowProgress: makeDigest({ status: 'completed' }) }),
  ]);
  assert.equal(listEl.treeHolders[0].hasAttribute('hidden'), true);
});

test('rows without a workflow digest render the flat row unchanged', () => {
  setBackgroundTasksConversation('conv-flat');
  setConversationBackgroundTasks('conv-flat', [
    { taskId: 'bash-1', taskType: 'local_bash', description: 'npm test', startedAt: Date.now(), totalTokens: 0 },
    { taskId: 'wf-no-digest', taskType: 'local_workflow', description: 'Workflow without digest', startedAt: Date.now() },
  ]);

  assert.doesNotMatch(listEl.innerHTML, /bg-task-fold/, 'no chevron without a digest');
  assert.doesNotMatch(listEl.innerHTML, /bg-task-tree/, 'no tree holder without a digest');
  assert.match(listEl.innerHTML, /npm test/);
  assert.match(listEl.innerHTML, /Workflow without digest/);
  assert.match(listEl.innerHTML, /bg-task-stop/);
  assert.doesNotMatch(listEl.innerHTML, /bg-task-tokens/, 'no tokens element without usage');
});

test('the flat row renders tokens as their own element that a long summary cannot crowd out', () => {
  setBackgroundTasksConversation('conv-tokens');
  setConversationBackgroundTasks('conv-tokens', [{
    taskId: 'wf-tokens',
    taskType: 'local_workflow',
    description: 'Ultracode review workflow',
    startedAt: Date.now() - 5000,
    model: 'claude-opus-4-6',
    totalTokens: 82_400,
    summary: 'reviewing conversation-view and the shared model modules for state bugs, '
      + 'then verifying every finding against the live relay before reporting',
  }]);

  assert.match(listEl.innerHTML, /<span class="bg-task-tokens">82\.4k tok<\/span>/);
  const detail = /<span class="bg-task-detail">([^<]*)<\/span>/.exec(listEl.innerHTML)?.[1] ?? '';
  assert.match(detail, /reviewing conversation-view/, 'detail keeps the summary');
  assert.match(detail, /opus-4-6/, 'detail keeps the model');
  assert.doesNotMatch(detail, /tok/, 'token usage no longer rides the detail concat');
});

// ---------------------------------------------------------------------------
// The transcript's "Finished background task" card (Phase 4)

test('formatTaskTokens covers the raw, k, and M tiers', () => {
  assert.equal(formatTaskTokens(0), '');
  assert.equal(formatTaskTokens(812), '812 tok');
  assert.equal(formatTaskTokens(62_208), '62.2k tok');
  assert.equal(formatTaskTokens(321_498), '321k tok');
  assert.equal(formatTaskTokens(1_160_000), '1.2M tok');
  assert.equal(formatTaskTokens('junk'), '');
});

test('workflowRunCardTitle joins the present fields and omits the absent ones', () => {
  assert.equal(
    workflowRunCardTitle({
      workflowName: 'review-shared-modules',
      status: 'completed',
      agentCount: 20,
      totalTokens: 1_160_000,
      durationMs: 28 * 60_000,
    }),
    '🧩 Finished background task — review-shared-modules · 20 agents · 1.2M tok · 28m',
  );
  assert.equal(
    workflowRunCardTitle({ status: 'completed', agentCount: 1 }),
    '🧩 Finished background task — 1 agent',
  );
  assert.equal(workflowRunCardTitle({}), '🧩 Finished background task');
});

test('workflowRunCardTitle surfaces a non-completed outcome', () => {
  assert.equal(
    workflowRunCardTitle({ workflowName: 'review', status: 'failed', agentCount: 3 }),
    '🧩 Finished background task (failed) — review · 3 agents',
  );
  assert.match(workflowRunCardTitle({ status: 'stopped' }), /^🧩 Finished background task \(stopped\)/);
});

test('workflowRunCardTitle maps a still-running-ish buffered status to (unconfirmed)', () => {
  // A run persisted without its terminal task_notification keeps the last
  // buffered status; "Finished background task (running)" would contradict
  // itself, so the label admits the outcome is unknown instead.
  for (const status of ['running', 'pending', 'queued', ' Running ']) {
    assert.equal(
      workflowRunCardTitle({ workflowName: 'review', status, agentCount: 2 }),
      '🧩 Finished background task (unconfirmed) — review · 2 agents',
      `status "${status}" renders as (unconfirmed)`,
    );
  }
  // Terminal statuses keep rendering raw.
  assert.match(workflowRunCardTitle({ status: 'failed' }), /\(failed\)/);
  assert.doesNotMatch(workflowRunCardTitle({ status: 'completed' }), /\(/);
});

test('buildWorkflowRunCard renders a collapsed details card that carries the full tree', () => {
  const digest = makeDigest({ status: 'completed', durationMs: 927_637 });
  const card = buildWorkflowRunCard(digest);
  assert.equal(card.tagName, 'DETAILS');
  assert.ok(!card.hasAttribute('open'), 'collapsed by default — the summary click is the fold');
  assert.match(card.className, /msg-workflow-run/);
  const [summary, tree] = card.children;
  assert.equal(summary.tagName, 'SUMMARY');
  assert.equal(
    summary.textContent,
    '🧩 Finished background task — code-review · 3 agents · 321k tok · 15m',
  );
  assert.match(tree.className, /bg-task-tree/);
  // The unfolding body is the SAME tree the live panel renders.
  assert.deepEqual(
    collectByClass(tree, 'bg-task-tree-phase').map((phase) => phase.textContent),
    ['Review', 'Verify'],
  );
  assert.equal(collectByClass(tree, 'bg-task-tree-agent').length, 3);
  assert.equal(collectByClass(tree, 'bg-task-agent-label')[0].textContent, 'review:logic');
});

test('buildWorkflowRunCard never injects digest text as markup and rejects junk', () => {
  const digest = makeDigest({ workflowName: '<img src=x onerror=alert(1)>' });
  const card = buildWorkflowRunCard(digest);
  const [summary] = card.children;
  assert.match(summary.textContent, /<img src=x onerror=alert\(1\)>/, 'markup renders as literal text');
  assert.equal(card.innerHTML, '', 'the card is built without innerHTML');
  assert.equal(buildWorkflowRunCard(null), null);
  assert.equal(buildWorkflowRunCard('junk'), null);
});

test('the 2-line clamp rule covers the desc, detail, log, and agent-label classes', () => {
  // The unit DOM cannot compute styles, so pin the CSS contract itself: one
  // clamp rule in index.html must target every class the renderer emits for
  // long text (this is what keeps phone rows readable instead of "Re…").
  const css = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const rules = [];
  for (let at = css.indexOf('-webkit-line-clamp: 2'); at !== -1; at = css.indexOf('-webkit-line-clamp: 2', at + 1)) {
    const open = css.lastIndexOf('{', at);
    const selector = css.slice(css.lastIndexOf('}', open) + 1, open);
    rules.push({ selector, body: css.slice(open + 1, css.indexOf('}', at)) });
  }
  const rule = rules.find((entry) => entry.selector.includes('.bg-task-desc'));
  assert.ok(rule, 'a 2-line clamp rule targets .bg-task-desc');
  for (const cls of ['.bg-task-desc', '.bg-task-detail', '.bg-task-tree-log', '.bg-task-agent-label']) {
    assert.ok(rule.selector.includes(cls), `${cls} shares the 2-line clamp rule`);
  }
  assert.match(rule.body, /overflow-wrap:\s*anywhere/, 'clamped text breaks anywhere, no overflow');
  assert.doesNotMatch(rule.body, /white-space:\s*nowrap/, 'clamp replaces nowrap, not stacks on it');
});
