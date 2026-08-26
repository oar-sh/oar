import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextUsageView, splitFreeAndBufferTokens } from './context-usage-view.mjs';

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

test('auto-compact fields pass through as tokens, not percentages', () => {
  // Measured from a live runtime_sessions row on claude-opus-5: the threshold
  // is a token count and carries its own provenance string.
  const view = buildContextUsageView({
    snapshot: null,
    contextUsage: {
      ...claudeUsage,
      maxTokens: 1000000,
      rawMaxTokens: 1000000,
      autoCompactThreshold: 967000,
      autocompactSource: 'auto',
      isAutoCompactEnabled: true,
    },
  });
  assert.equal(view.autoCompactThreshold, 967000);
  assert.equal(view.rawMaxTokens, 1000000);
  assert.equal(view.autocompactSource, 'auto');
  assert.equal(view.isAutoCompactEnabled, true);
});

test('a provider without auto-compact reports the fields as absent', () => {
  const view = buildContextUsageView({ contextUsage: claudeUsage, snapshot: null });
  assert.equal(view.autoCompactThreshold, null);
  assert.equal(view.rawMaxTokens, null);
  assert.equal(view.autocompactSource, null);
  assert.equal(view.isAutoCompactEnabled, false);
});

test('free space and buffer are disjoint slices of the unused window', () => {
  // The measured Claude shape: a 1M window, 967k auto-compact threshold, so a
  // 33k reserve carved out of the free space rather than added beside it.
  const view = buildContextUsageView({
    snapshot: {
      max_context_tokens: 1000000,
      used_total_tokens: 400000,
      free_tokens: 600000,
      // What buildClaudeContextSnapshot stamps: this free space was derived
      // from `max - used`, so the reserve is inside it.
      free_tokens_includes_buffer: true,
      buffer_tokens: 33000,
      system_tools_tokens: 100000,
      messages_tokens: 300000,
    },
  });

  assert.equal(view.freeTokens, 567000);
  assert.equal(view.bufferTokens, 33000);
  // The reserve is not a category — it is unused window, reported beside free
  // space so the table still accounts for every token. Occupied + free +
  // reserve partitions the window exactly; this is what the ASCII grid scaled
  // down (and thereby misdrew) when free space and buffer overlapped.
  const slices = view.categories.reduce((sum, entry) => sum + entry.tokens, 0)
    + view.freeTokens + view.bufferTokens;
  assert.equal(slices, 1000000);
});

test('a buffer larger than the remaining window consumes it rather than overflowing', () => {
  // Usage past the auto-compact threshold: 20k left, a 33k nominal reserve.
  const { freeTokens, bufferTokens } = splitFreeAndBufferTokens({
    free_tokens: 20000,
    buffer_tokens: 33000,
    free_tokens_includes_buffer: true,
  });
  assert.equal(freeTokens, 0);
  assert.equal(bufferTokens, 20000);
});

test('a snapshot without a buffer leaves free space untouched', () => {
  assert.deepEqual(
    splitFreeAndBufferTokens({ free_tokens: 120000, buffer_tokens: null }),
    { freeTokens: 120000, bufferTokens: null },
  );
  assert.deepEqual(
    splitFreeAndBufferTokens({}),
    { freeTokens: null, bufferTokens: null },
  );
});

test('a provider-reported remainder is left alone; only a derived one is split', () => {
  // Copilot reports remainingTokens alongside its own buffer, so that number is
  // already net of the reserve — subtracting again would understate free space.
  assert.deepEqual(
    splitFreeAndBufferTokens({ free_tokens: 90000, buffer_tokens: 20000 }),
    { freeTokens: 90000, bufferTokens: 20000 },
  );
  assert.deepEqual(
    splitFreeAndBufferTokens({
      free_tokens: 90000,
      buffer_tokens: 20000,
      free_tokens_includes_buffer: true,
    }),
    { freeTokens: 70000, bufferTokens: 20000 },
  );
});

test('a Claude session accounts for its reserve even though the SDK sends no buffer category', () => {
  // Regression (2026-08-20): splitting the buffer out of free space without a
  // row to show it left 33k of a 1M window simply missing from the table.
  const view = buildContextUsageView({
    contextUsage: {
      ...claudeUsage,
      totalTokens: 397413,
      categories: [{ name: 'Messages', tokens: 376622, color: 'orange' }],
    },
    snapshot: {
      max_context_tokens: 1000000,
      used_total_tokens: 397413,
      free_tokens: 602587,
      free_tokens_includes_buffer: true,
      buffer_tokens: 33000,
    },
  });
  assert.equal(view.freeTokens, 569587);
  assert.equal(view.bufferTokens, 33000);
  assert.equal(view.totalTokens + view.freeTokens + view.bufferTokens, 1000000);
});
