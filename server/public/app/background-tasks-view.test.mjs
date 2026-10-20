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
  formatTaskModelLabel,
  taskActivityText,
  setConversationTaskHealth,
  setConversationTaskStallMinutes,
  setConversationEndedBackgroundTasks,
  onBackgroundTasksPanelRendered,
  dismissEndedBackgroundTask,
  findBackgroundTask,
  setSubagentStepCounter,
  panelSummaryText,
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
    'Sonnet 5 · 62.2k tok · 27 tools · 4m20s',
  );
  // Null tokens/tools/duration are simply omitted, and queued renders ○.
  const queuedRow = agentRows[2];
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-state')[0].textContent, '○');
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-label')[0].textContent, 'verify:model-id.mjs');
  assert.equal(collectByClass(queuedRow, 'bg-task-agent-meta')[0].textContent, 'Sonnet 5');
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
  assert.equal(runningMeta.textContent, 'Sonnet 5 · 39.1k tok · 17 tools · 1m59s — using Read');
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
  const detail = /<span class="bg-task-detail"[^>]*>([^<]*)<\/span>/.exec(listEl.innerHTML)?.[1] ?? '';
  assert.match(detail, /reviewing conversation-view/, 'detail keeps the summary');
  assert.doesNotMatch(detail, /tok|Opus/, 'tokens and model live on the side, not the detail line');
});

test('the model sits beside the kind pill as a readable version label', () => {
  setBackgroundTasksConversation('conv-model');
  setConversationBackgroundTasks('conv-model', [{
    taskId: 'agent-model',
    taskType: 'local_agent',
    subagentType: 'general-purpose',
    description: 'T-219 client door interaction',
    startedAt: Date.now(),
    model: 'claude-opus-5-5',
  }]);
  const head = /<span class="bg-task-side-head">([\s\S]*?)<\/span>\s*<span class="bg-task-side-status">/.exec(listEl.innerHTML)?.[1] ?? '';
  assert.match(head, /<span class="bg-task-model" title="claude-opus-5-5">Opus 5\.5<\/span>\s*<span class="bg-task-badge">general-purpose<\/span>/);
});

test('a live tool call rides the detail line with its transcript emoji, marked for one-line cropping', () => {
  setBackgroundTasksConversation('conv-toolcall');
  setConversationBackgroundTasks('conv-toolcall', [{
    taskId: 'agent-tool',
    taskType: 'local_agent',
    description: 'yaw fix',
    startedAt: Date.now(),
    model: 'claude-opus-5-5',
    lastToolName: 'PowerShell',
    summary: 'older progress summary',
    lastToolCall: 'Tool (PowerShell): cd C:\\Users\\dev\\repo; Get-Content package.json | Select-String -Pattern "(test|lint)"',
  }]);
  const detail = /<span class="bg-task-detail bg-task-toolcall"[^>]*>([^<]*)<\/span>/.exec(listEl.innerHTML)?.[1] ?? '';
  assert.match(detail, /^🪓 Tool \(PowerShell\): cd C:\\Users\\dev\\repo; Get-Content package\.json \| Select-String -Pattern &quot;\(test\|lint\)&quot;$/);
});

test('model labels humanize full ids and capitalize bare spawn aliases', () => {
  assert.equal(formatTaskModelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(formatTaskModelLabel('claude-opus-5-5[1m]'), 'Opus 5.5 [1m]');
  assert.equal(formatTaskModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(formatTaskModelLabel('opus'), 'Opus');
  assert.equal(formatTaskModelLabel(''), '');
});

test('the detail line prefers the tool call, then the summary, then the bare tool name', () => {
  assert.deepEqual(taskActivityText({ lastToolCall: 'Tool (Bash): npm test', summary: 's', lastToolName: 'Bash' }), { text: '🔧 Tool (Bash): npm test', toolCall: true });
  assert.deepEqual(taskActivityText({ summary: 'reading files', lastToolName: 'Read' }), { text: 'reading files', toolCall: false });
  assert.deepEqual(taskActivityText({ lastToolName: 'Read' }), { text: 'using Read', toolCall: false });
  assert.deepEqual(taskActivityText({}), { text: '', toolCall: false });
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

test('a non-stoppable task (Copilot detached shell) renders without a Stop button', () => {
  setBackgroundTasksConversation('conv-nostop');
  setConversationBackgroundTasks('conv-nostop', [
    { taskId: 'shell-1', taskType: 'local_bash', description: 'npm test (detached)', startedAt: Date.now(), stoppable: false },
    { taskId: 'bash-2', taskType: 'local_bash', description: 'stoppable one', startedAt: Date.now() },
  ]);

  assert.match(listEl.innerHTML, /npm test \(detached\)/);
  // Exactly one Stop button: the stoppable task's. The detached shell has none
  // (the Copilot runtime offers no host-side shell stop).
  assert.equal((listEl.innerHTML.match(/bg-task-stop/g) || []).length, 1);
  assert.match(listEl.innerHTML, /data-task-id="bash-2"[^>]*>Stop</);
});

// ─── Task console rows ───────────────────────────────────────────────────────

function rowHtml(taskId) {
  const html = listEl.innerHTML;
  const at = html.indexOf(`data-task-id="${taskId}"`);
  if (at === -1) return '';
  const from = html.lastIndexOf('<div class="bg-task-row', at);
  const next = html.indexOf('<div class="bg-task-row', at);
  return html.slice(from, next === -1 ? html.length : next);
}

test('shell and Monitor rows open the console; a provider without output keeps a plain title', () => {
  setBackgroundTasksConversation('conv-console');
  setConversationBackgroundTasks('conv-console', [
    { taskId: 'shell-a', taskType: 'local_bash', description: 'npm run build <fast>', startedAt: Date.now(), outputKind: 'file' },
    { taskId: 'monitor-b', taskType: 'monitor', description: 'watch the queue', startedAt: Date.now() },
    { taskId: 'shell-c', taskType: 'local_bash', description: 'cloud shell', startedAt: Date.now(), outputKind: 'none' },
    { taskId: 'agent-d', taskType: 'local_agent', description: 'Survey the parser', startedAt: Date.now(), toolUseId: 'toolu_fixture_d' },
  ]);
  assert.match(rowHtml('shell-a'), /<button type="button" class="task-console-open bg-task-desc" data-task-console="shell-a"[^>]*>npm run build &lt;fast&gt;<\/button>/);
  assert.match(rowHtml('monitor-b'), /data-task-console="monitor-b"/);
  const none = rowHtml('shell-c');
  assert.doesNotMatch(none, /data-task-console/);
  // The relay's `none` answer says the same sentence (TASK_OUTPUT_NONE_MESSAGES).
  assert.match(none, /<span class="bg-task-desc bg-task-desc-no-output" title="Output is not available for this provider\.">cloud shell<\/span>/);
  assert.doesNotMatch(rowHtml('agent-d'), /data-task-console/, 'a sub-agent opens its record instead');
  assert.match(rowHtml('agent-d'), /data-subagent-open="toolu_fixture_d"/);
});

test('a command piped into tail says on its quiet hint why it is quiet', () => {
  setBackgroundTasksConversation('conv-tail');
  setConversationBackgroundTasks('conv-tail', [
    { taskId: 'tail-a', taskType: 'local_bash', description: 'npm test 2>&1 | tail -40', startedAt: Date.now(), outputKind: 'file' },
    { taskId: 'follow-b', taskType: 'local_bash', description: 'tail -f server.log | grep error', startedAt: Date.now(), outputKind: 'file' },
    { taskId: 'cmd-c', taskType: 'local_bash', description: 'Run the unit tests', command: 'npm test 2>&1 | tail -n 20', startedAt: Date.now(), outputKind: 'file' },
  ]);
  assert.match(rowHtml('tail-a'), /<span class="bg-task-stall" title="This command pipes into tail, so its output arrives when it ends\. Logging to a file instead \(&gt; run\.log 2&gt;&amp;1\) and following that file shows it live\." hidden><\/span>/);
  assert.doesNotMatch(rowHtml('follow-b'), /bg-task-stall" title=/, 'tail -f streams');
  assert.match(rowHtml('cmd-c'), /bg-task-stall" title="This command pipes into tail,/, 'the command line, not the prose description');
  setConversationBackgroundTasks('conv-tail', []);
});

test('the panel tells its listeners when it drew its rows, and when it went away', () => {
  let renders = 0;
  const stop = onBackgroundTasksPanelRendered(() => { renders += 1; });
  setBackgroundTasksConversation('conv-render');
  const drawnEmpty = renders;
  assert.ok(drawnEmpty >= 1, 'an empty panel hides, and says so');
  setConversationBackgroundTasks('conv-render', [{ taskId: 'r1', taskType: 'local_bash', description: 'npm test', startedAt: Date.now() }]);
  assert.ok(renders > drawnEmpty);
  stop();
  const before = renders;
  setConversationBackgroundTasks('conv-render', []);
  assert.equal(renders, before, 'an unsubscribed listener hears nothing');
});

test('ended rows stay dimmed with ✓/✘, no Stop, a dismiss ×, and still open', () => {
  setBackgroundTasksConversation('conv-ended');
  setConversationBackgroundTasks('conv-ended', [
    { taskId: 'live-1', taskType: 'local_bash', description: 'dev server', startedAt: Date.now() },
  ], {
    endedTasks: [
      { taskId: 'ended-fail', taskType: 'local_bash', description: 'unit run', startedAt: 1_000, endedAt: 66_000, status: 'failed', exitCode: 1, outputKind: 'file' },
      { taskId: 'ended-ok', taskType: 'monitor', description: 'log tail', startedAt: 1_000, endedAt: 3_000, status: 'completed', exitCode: 0 },
    ],
  });
  const failed = rowHtml('ended-fail');
  assert.match(failed, /class="bg-task-row bg-task-row-ended"/);
  assert.match(failed, /<span class="bg-task-outcome bg-task-outcome-fail" title="failed, exit code 1">✘<\/span>/);
  assert.match(failed, /<span class="bg-task-elapsed">1m 5s<\/span>/);
  assert.match(failed, /data-task-console="ended-fail"/, 'still opens');
  assert.doesNotMatch(failed, /bg-task-stop/);
  assert.match(failed, /<button type="button" class="bg-task-dismiss" data-task-id="ended-fail"/);
  assert.match(rowHtml('ended-ok'), /bg-task-outcome-ok[^>]*>✓</);
  assert.match(summaryEl.innerHTML, /1 background task running · 2 finished$/);
  assert.deepEqual(findBackgroundTask('conv-ended', 'ended-fail')?.ended, true);
  assert.deepEqual(findBackgroundTask('conv-ended', 'live-1')?.ended, false);

  // An older relay's event without endedTasks leaves them alone.
  setConversationBackgroundTasks('conv-ended', []);
  assert.match(listEl.innerHTML, /ended-fail/);
  assert.equal(panelEl.hidden, false, 'the panel stays up for ended rows');
  assert.match(summaryEl.innerHTML, /^2 finished$/, 'no spinner without a live task');

  dismissEndedBackgroundTask('ended-fail');
  assert.doesNotMatch(listEl.innerHTML, /ended-fail/);
  assert.match(summaryEl.innerHTML, /^1 finished$/);
  setConversationEndedBackgroundTasks('conv-ended', []);
  assert.equal(panelEl.hidden, true);
});

test('the panel summary counts only live tasks as running', () => {
  assert.equal(panelSummaryText(2, 0, 1), '2 background tasks running · 1 finished');
  assert.equal(panelSummaryText(1, 1, 0), '1 background task running · 1 preview');
  assert.equal(panelSummaryText(0, 0, 3), '3 finished');
});

test('health brings the stall hint (amber at the threshold) and the runner chip', () => {
  const now = Date.now();
  setBackgroundTasksConversation('conv-health');
  setConversationBackgroundTasks('conv-health', [
    { taskId: 'quiet', taskType: 'local_bash', description: 'long build', startedAt: now - 3_600_000, health: { lastOutputAt: now - 4 * 60_000 } },
    { taskId: 'tests', taskType: 'local_bash', description: 'test run', startedAt: now },
  ]);
  assert.match(rowHtml('quiet'), /<span class="bg-task-stall">no output for 4 min<\/span>/, 'below the default 10 min: muted');
  assert.match(rowHtml('tests'), /<span class="bg-task-stall" hidden><\/span>/, 'no health yet: hidden holder');

  setConversationTaskStallMinutes('conv-health', 3);
  assert.match(rowHtml('quiet'), /<span class="bg-task-stall bg-task-stall-warn">no output for 4 min<\/span>/);

  setConversationTaskHealth('conv-health', { tests: { lastOutputAt: now, counts: { passed: 412, failed: 2, skipped: 0 }, runner: 'vitest' } });
  assert.match(rowHtml('tests'), /<span class="bg-task-chip bg-task-chip-fail" title="vitest: 412 passed, 2 failed">✓ 412 ✘ 2<\/span>/);
  assert.match(rowHtml('quiet'), /bg-task-stall-warn/, 'health of one task leaves the other alone');
  setConversationTaskHealth('conv-health', { tests: { lastOutputAt: now, counts: { passed: 414, failed: 0 } } });
  assert.match(rowHtml('tests'), /<span class="bg-task-chip" title="414 passed, 0 failed">✓ 414<\/span>/);
});

test('sub-agent rows show their steps, from the worker or the run record', () => {
  setBackgroundTasksConversation('conv-steps');
  setSubagentStepCounter((runId) => (runId === 'toolu_fixture_counted' ? 7 : null));
  setConversationBackgroundTasks('conv-steps', [
    { taskId: 'a1', taskType: 'local_agent', description: 'Map the routes', startedAt: Date.now(), steps: 22, toolUseId: 'toolu_fixture_counted' },
    { taskId: 'a2', taskType: 'local_agent', description: 'Check the fixtures', startedAt: Date.now(), toolUseId: 'toolu_fixture_counted' },
    { taskId: 'a3', taskType: 'local_agent', description: 'No record', startedAt: Date.now(), toolUseId: 'toolu_fixture_unknown' },
    { taskId: 'a4', taskType: 'agent', description: 'Copilot agent', startedAt: Date.now(), steps: 1 },
  ]);
  assert.match(rowHtml('a1'), /<span class="bg-task-steps">22 steps<\/span>/, 'the worker count wins');
  assert.match(rowHtml('a2'), /<span class="bg-task-steps">7 steps<\/span>/, 'fallback: the run record');
  assert.doesNotMatch(rowHtml('a3'), /bg-task-steps/);
  assert.match(rowHtml('a4'), /<span class="bg-task-steps">1 step<\/span>/);
  setSubagentStepCounter(null);
});
