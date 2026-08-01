import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextUsageView } from './context-usage-view.mjs';

const claudeUsage = {
  model: 'claude-opus-5[1m]',
  totalTokens: 247100,
  maxTokens: 1000000,
  percentage: 24.71,
  categories: [
    { name: 'System prompt', tokens: 4800, color: 'gray' },
    { name: 'System tools', tokens: 19200, color: 'blue' },
    { name: 'Skills', tokens: 1800, color: 'green' },
    { name: 'Messages', tokens: 221300, color: 'orange' },
  ],
  isAutoCompactEnabled: false,
};

test('Claude categories pass through with per-category percentages', () => {
  const view = buildContextUsageView({ contextUsage: claudeUsage, snapshot: null });
  assert.equal(view.model, 'claude-opus-5[1m]');
  assert.equal(view.totalTokens, 247100);
  assert.equal(view.maxTokens, 1000000);
  assert.equal(view.percentage, 24.71);
  assert.deepEqual(view.categories.map((c) => c.percent), [0.48, 1.92, 0.18, 22.13]);
  assert.equal(view.freeTokens, 752900);
  assert.equal(view.freePercent, 75.29);
  assert.equal(view.isEstimate, false);
});

test('categories plus free space account for the whole window', () => {
  const view = buildContextUsageView({ contextUsage: claudeUsage, snapshot: null });
  const total = view.categories.reduce((sum, c) => sum + c.percent, 0) + view.freePercent;
  assert.ok(Math.abs(total - 100) < 0.05, `expected ~100, got ${total}`);
});

test('Copilot snapshots synthesize categories', () => {
  const view = buildContextUsageView({
    snapshot: {
      model: 'gpt-5.4',
      used_total_tokens: 64000,
      max_context_tokens: 256000,
      used_percent: 25,
      free_tokens: 192000,
      system_tools_tokens: 14000,
      messages_tokens: 50000,
      buffer_tokens: null,
    },
    contextUsage: null,
  });
  assert.deepEqual(view.categories.map((c) => c.name), ['System/Tools', 'Messages']);
  assert.equal(view.categories[0].tokens, 14000);
  assert.equal(view.percentage, 25);
  assert.equal(view.freeTokens, 192000);
});

test('zero-token categories are dropped rather than rendered empty', () => {
  const view = buildContextUsageView({
    snapshot: {
      max_context_tokens: 256000,
      used_total_tokens: 1000,
      system_tools_tokens: 0,
      messages_tokens: 1000,
    },
    contextUsage: null,
  });
  assert.deepEqual(view.categories.map((c) => c.name), ['Messages']);
});

test('estimated snapshots are flagged and clamped to 100%', () => {
  const view = buildContextUsageView({
    snapshot: {
      model: 'gpt-5.4',
      used_total_tokens: 900000,
      max_context_tokens: 256000,
      used_percent: 340,
      estimate_kind: 'assistant-output-lower-bound',
    },
    contextUsage: null,
  });
  assert.equal(view.percentage, 100, 'an occupancy gauge must not exceed full');
  assert.equal(view.isEstimate, true);
  assert.equal(view.estimateKind, 'assistant-output-lower-bound');
});

test('nothing to render yields null', () => {
  assert.equal(buildContextUsageView({}), null);
  assert.equal(buildContextUsageView({ snapshot: null, contextUsage: null }), null);
  assert.equal(buildContextUsageView({ snapshot: { model: 'gpt-5.4' } }), null);
});
