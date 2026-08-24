import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { digestFromRunRecord, digestFromJournal, stripCommonPromptPrefix } from './workflow-progress-digest.mjs';

// The reference run record (conv 614d5014, run wf_d8a3315d-fd5): a real
// 7-agent ultracode workflow captured from CLI 2.1.226.
function fixtureRecord() {
  return JSON.parse(readFileSync(new URL('./fixtures/workflow-run-record.json', import.meta.url), 'utf8'));
}

test('the reference run record digests to the full tree without previews', () => {
  const digest = digestFromRunRecord(fixtureRecord());
  assert.ok(digest, 'the real record must digest');
  assert.equal(digest.runId, 'wf_d8a3315d-fd5');
  assert.equal(digest.workflowName, 'review-shared-model-modules');
  assert.equal(digest.status, 'completed');
  assert.equal(digest.agentCount, 7);
  assert.equal(digest.totalTokens, 321498);
  assert.equal(digest.durationMs, 927637, 'the record-level run duration rides the digest');
  assert.deepEqual(digest.phases, [
    { index: 1, title: 'Review' },
    { index: 2, title: 'Verify' },
  ]);
  assert.equal(digest.agents.length, 7);
  assert.equal(digest.agentsOmitted, 0);
  assert.deepEqual(digest.agents[0], {
    index: 1,
    label: 'review:logic',
    phaseIndex: 1,
    phaseTitle: 'Review',
    model: 'claude-sonnet-5',
    state: 'done',
    attempt: 1,
    lastToolName: 'StructuredOutput',
    tokens: 62208,
    toolCalls: 27,
    durationMs: 260054,
    startedAt: 1786980733726,
  });
  assert.ok(digest.logs.length >= 1 && digest.logs.length <= 5);
  // The multi-KB fields must be gone entirely, not merely truncated.
  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes('promptPreview'), 'promptPreview must be dropped');
  assert.ok(!serialized.includes('resultPreview'), 'resultPreview must be dropped');
  assert.ok(!serialized.includes('"script"'), 'the workflow script must never ride the digest');
});

test('oversized record strings are clamped to the contract limits', () => {
  const digest = digestFromRunRecord({
    runId: 'r'.repeat(200),
    workflowName: 'w'.repeat(500),
    status: 's'.repeat(100),
    agentCount: 1,
    totalTokens: 10,
    logs: Array.from({ length: 9 }, (_, i) => `log-${i + 1} ${'x'.repeat(400)}`),
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 't'.repeat(300) },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'l'.repeat(500),
        phaseIndex: 1,
        phaseTitle: 'p'.repeat(300),
        model: 'm'.repeat(200),
        state: 'z'.repeat(80),
        attempt: 1,
        lastToolName: 'n'.repeat(400),
        tokens: 1,
        toolCalls: 1,
        durationMs: 1,
        startedAt: 1,
      },
    ],
  });
  assert.equal(digest.runId.length, 64);
  assert.equal(digest.workflowName.length, 120);
  assert.equal(digest.status.length, 32);
  assert.equal(digest.phases[0].title.length, 120);
  assert.equal(digest.agents[0].label.length, 160);
  assert.equal(digest.agents[0].phaseTitle.length, 120);
  assert.equal(digest.agents[0].model.length, 80);
  assert.equal(digest.agents[0].state.length, 32);
  assert.equal(digest.agents[0].lastToolName.length, 160);
  assert.equal(digest.logs.length, 5, 'only the last five log lines survive');
  assert.match(digest.logs[0], /^log-5 /, 'the LAST five, not the first');
  for (const line of digest.logs) assert.ok(line.length <= 300);
});

test('garbage run-record inputs digest to null or degrade field-by-field, never throwing', () => {
  for (const garbage of [null, undefined, 42, 'text', [], {}, { runId: 42 }, { runId: '' }, { runId: '   ' }]) {
    assert.equal(digestFromRunRecord(garbage), null);
  }
  // A recognizable record with junk sub-fields degrades instead of dying.
  const digest = digestFromRunRecord({
    runId: 'wf_ok',
    workflowName: 7,
    status: {},
    agentCount: 'many',
    totalTokens: NaN,
    durationMs: 'twelve minutes',
    logs: { not: 'an array' },
    phases: 'nonsense',
    workflowProgress: [null, 5, 'junk', { type: 'workflow_agent' }, { type: 'workflow_phase' }],
  });
  assert.equal(digest.runId, 'wf_ok');
  assert.equal(digest.workflowName, null);
  assert.equal(digest.status, null);
  assert.equal(digest.totalTokens, null);
  assert.equal(digest.durationMs, null, 'a missing run duration degrades to null');
  assert.deepEqual(digest.logs, []);
  assert.equal(digest.phases.length, 1, 'a bare phase entry still counts');
  assert.equal(digest.agents.length, 1, 'a bare agent entry still counts');
  assert.equal(digest.agents[0].label, null);
  assert.equal(digest.agentCount, 1, 'a junk agentCount falls back to the observed total');
});

test('run-record agents cap at 100 with the overflow counted', () => {
  const digest = digestFromRunRecord({
    runId: 'wf_big',
    workflowProgress: Array.from({ length: 130 }, (_, i) => ({
      type: 'workflow_agent', index: i + 1, label: `agent-${i + 1}`, state: 'done',
    })),
  });
  assert.equal(digest.agents.length, 100);
  assert.equal(digest.agentsOmitted, 30);
  assert.equal(digest.agentCount, 130);
  assert.equal(digest.agents[99].label, 'agent-100', 'order is preserved, the tail is dropped');
});

test('a live journal digests running/done states with label fallback', () => {
  const entries = [
    { type: 'started', key: 'v2:aaa', agentId: 'agent-a' },
    { type: 'started', key: 'v2:bbb', agentId: 'agent-b' },
    { type: 'result', key: 'v2:aaa', agentId: 'agent-a', result: { findings: 2 } },
  ];
  const digest = digestFromJournal({
    entries,
    labelsByAgentId: new Map([['agent-a', 'Review the logic of shared/model-id.mjs']]),
    workflowName: 'live-run',
    runId: 'wf_live-1',
  });
  assert.equal(digest.status, 'running');
  assert.equal(digest.runId, 'wf_live-1');
  assert.equal(digest.workflowName, 'live-run');
  assert.equal(digest.agentCount, 2);
  assert.equal(digest.totalTokens, null);
  assert.equal(digest.durationMs, null, 'the journal knows no run duration');
  assert.deepEqual(digest.phases, []);
  assert.deepEqual(digest.logs, []);
  assert.deepEqual(digest.agents.map((agent) => [agent.label, agent.state]), [
    ['Review the logic of shared/model-id.mjs', 'done'],
    ['agent 2', 'running'],
  ]);
  // The journal carries no per-agent metrics; the digest must say so.
  for (const agent of digest.agents) {
    assert.equal(agent.tokens, null);
    assert.equal(agent.toolCalls, null);
    assert.equal(agent.durationMs, null);
    assert.equal(agent.model, null);
    assert.equal(agent.phaseIndex, null);
  }
  // Labels also work as a plain object (the Map is not required).
  const objectLabeled = digestFromJournal({ entries, labelsByAgentId: { 'agent-b': 'verify:x' } });
  assert.equal(objectLabeled.agents[1].label, 'verify:x');
  assert.equal(objectLabeled.agents[0].label, 'agent 1');
});

test('garbage journal inputs digest to null, junk lines are skipped', () => {
  assert.equal(digestFromJournal(), null);
  assert.equal(digestFromJournal({}), null);
  assert.equal(digestFromJournal({ entries: 'not-an-array' }), null);
  assert.equal(digestFromJournal({ entries: [] }), null);
  assert.equal(
    digestFromJournal({ entries: [null, 42, 'junk', { type: 'started' }, { type: 'other', agentId: 'x' }] }),
    null,
    'no derivable agent means nothing to render',
  );
  const digest = digestFromJournal({
    entries: [null, 'junk', { type: 'started', agentId: 'agent-a' }, { type: 'result' }],
  });
  assert.equal(digest.agents.length, 1);
  assert.equal(digest.agents[0].state, 'running');
});

// The live-verified failure mode: a workflow that prefixes every agent prompt
// with the same context note, so every prompt-preview label starts identically.
const BOILERPLATE = 'You are doing a READ-ONLY correctness review of this diff. Do not write code. ';

test('stripCommonPromptPrefix strips a long shared prefix down to the distinguishing tails', () => {
  assert.deepEqual(
    stripCommonPromptPrefix([
      `${BOILERPLATE}Review conversation-view.js for state bugs`,
      `${BOILERPLATE}Verify model-id.mjs effort parsing`,
      `${BOILERPLATE}Audit messages-routes for auth gaps`,
    ]),
    [
      'Review conversation-view.js for state bugs',
      'Verify model-id.mjs effort parsing',
      'Audit messages-routes for auth gaps',
    ],
  );
});

test('a short shared prefix, no shared prefix, or a single label leaves labels untouched', () => {
  const shortPrefix = ['review: logic pass', 'review: tests pass'];
  assert.deepEqual(stripCommonPromptPrefix(shortPrefix), shortPrefix, '"review: " is 8 chars — kept');
  const unrelated = ['alpha does one thing', 'beta does another thing entirely'];
  assert.deepEqual(stripCommonPromptPrefix(unrelated), unrelated);
  const single = [`${BOILERPLATE}the only agent`];
  assert.deepEqual(stripCommonPromptPrefix(single), single, 'one label has nothing to diff against');
  assert.deepEqual(stripCommonPromptPrefix([]), []);
  assert.deepEqual(stripCommonPromptPrefix('not-an-array'), []);
});

test('stripped tails are trimmed of leading whitespace/punctuation; degenerate tails keep the original', () => {
  assert.deepEqual(
    stripCommonPromptPrefix([
      'CONTEXT NOTE (read first): stay read-only. - review the parser',
      'CONTEXT NOTE (read first): stay read-only. · verify the renderer',
    ]),
    ['review the parser', 'verify the renderer'],
    'the divergent separators and their whitespace are trimmed off the tails',
  );
  const identical = [`${BOILERPLATE}same prompt`, `${BOILERPLATE}same prompt`];
  assert.deepEqual(
    stripCommonPromptPrefix(identical),
    identical,
    'a label that is nothing but the shared prefix keeps its original text',
  );
  assert.deepEqual(
    stripCommonPromptPrefix([`${BOILERPLATE}review A`, null, `${BOILERPLATE}verify B`]),
    ['review A', null, 'verify B'],
    'non-string entries pass through and do not join the prefix computation',
  );
});

test('digestFromJournal strips shared prompt boilerplate from live labels', () => {
  const digest = digestFromJournal({
    entries: [
      { type: 'started', agentId: 'agent-a' },
      { type: 'started', agentId: 'agent-b' },
      { type: 'started', agentId: 'agent-c' },
    ],
    labelsByAgentId: new Map([
      ['agent-a', `${BOILERPLATE}Review conversation-view.js for state bugs`],
      ['agent-b', `${BOILERPLATE}Verify model-id.mjs effort parsing`],
    ]),
  });
  assert.deepEqual(digest.agents.map((agent) => agent.label), [
    'Review conversation-view.js for state bugs',
    'Verify model-id.mjs effort parsing',
    'agent 3',
  ], 'labeled agents lose the boilerplate; the unlabeled one keeps its fallback');
});

test('digestFromJournal distinguishes labels whose shared boilerplate exceeds the label clamp', () => {
  // Boilerplate longer than MAX_LABEL_CHARS (160): clamping first would cut
  // every label to the same 160-char prefix — identical labels, and the
  // all-identical degenerate path would keep them that way. The strip must
  // run on the unclamped strings, with the clamp applied afterward.
  const longBoilerplate = `${'You are one reviewer inside a large fan-out workflow. '.repeat(4)}Your task: `;
  assert.ok(longBoilerplate.length >= 200, 'precondition: the shared prefix exceeds the 160-char clamp');
  const digest = digestFromJournal({
    entries: [
      { type: 'started', agentId: 'agent-a' },
      { type: 'started', agentId: 'agent-b' },
      { type: 'started', agentId: 'agent-c' },
    ],
    labelsByAgentId: new Map([
      ['agent-a', `${longBoilerplate}review the parser`],
      ['agent-b', `${longBoilerplate}verify the renderer`],
      ['agent-c', `${longBoilerplate}audit the routes`],
    ]),
  });
  assert.deepEqual(digest.agents.map((agent) => agent.label), [
    'review the parser',
    'verify the renderer',
    'audit the routes',
  ], 'each label keeps its distinguishing tail instead of N identical clamped prefixes');
  for (const agent of digest.agents) {
    assert.ok(agent.label.length <= 160, 'the label clamp still applies after the strip');
  }
});

test('journal agents cap at 100 with the overflow counted', () => {
  const digest = digestFromJournal({
    entries: Array.from({ length: 130 }, (_, i) => ({ type: 'started', agentId: `agent-${i + 1}` })),
  });
  assert.equal(digest.agents.length, 100);
  assert.equal(digest.agentsOmitted, 30);
  assert.equal(digest.agentCount, 130);
  assert.equal(digest.agents[99].label, 'agent 100');
});
