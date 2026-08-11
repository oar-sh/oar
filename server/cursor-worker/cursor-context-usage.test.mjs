import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCursorContextUsage } from './cursor-context-usage.mjs';
import {
  buildClaudeContextSnapshot,
  normalizeClaudeContextUsage,
} from '../services/claude-context-usage.mjs';

const USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  totalTokens: 999999, // run-cumulative; must never leak into occupancy
};

test('occupancy sums the four token fields, ignoring cumulative totalTokens', () => {
  const { contextUsage } = buildCursorContextUsage({ usage: USAGE, model: 'cursor-composer-1' });
  assert.equal(contextUsage.totalTokens, 1350);
  assert.equal(contextUsage.model, 'cursor-composer-1');
});

test('maxTokens and percentage appear only with a positive context window', () => {
  const withWindow = buildCursorContextUsage({
    usage: USAGE,
    model: 'cursor-composer-1',
    contextWindow: 200000,
  }).contextUsage;
  assert.equal(withWindow.maxTokens, 200000);
  assert.equal(withWindow.percentage, Math.round((1350 / 200000) * 10000) / 100);

  for (const contextWindow of [undefined, null, 0, -5, 'big']) {
    const without = buildCursorContextUsage({
      usage: USAGE,
      model: 'cursor-composer-1',
      contextWindow,
    }).contextUsage;
    assert.equal('maxTokens' in without, false);
    assert.equal('percentage' in without, false);
  }
});

test('multi-call turns divide the prompt aggregate and are labeled estimates', () => {
  // 4 model calls, each re-sending ~325k of context: the aggregate is 1.3M
  // but real occupancy is ~325k + output.
  const { contextUsage } = buildCursorContextUsage({
    usage: { inputTokens: 600000, outputTokens: 4000, cacheReadTokens: 500000, cacheWriteTokens: 200000 },
    model: 'grok-4.5',
    contextWindow: 400000,
    modelCallCount: 4,
  });
  assert.equal(contextUsage.totalTokens, 325000 + 4000);
  assert.equal(contextUsage.estimateKind, 'cursor-per-call-average');
  assert.equal(contextUsage.percentage, Math.round(((325000 + 4000) / 400000) * 10000) / 100);
});

test('single-call turns keep the exact sum and carry no estimate label', () => {
  const { contextUsage } = buildCursorContextUsage({
    usage: USAGE,
    model: 'cursor-composer-1',
    modelCallCount: 1,
  });
  assert.equal(contextUsage.totalTokens, 1350);
  assert.equal('estimateKind' in contextUsage, false);
});

test('percentage is clamped to 100 even when the estimate exceeds the window', () => {
  const { contextUsage } = buildCursorContextUsage({
    usage: { inputTokens: 5151392, outputTokens: 9091, cacheReadTokens: 4728751, cacheWriteTokens: 422591 },
    model: 'claude-opus-5',
    contextWindow: 1000000,
    modelCallCount: 1,
  });
  assert.equal(contextUsage.percentage, 100);
});

test('bogus modelCallCount values fall back to a single call', () => {
  for (const modelCallCount of [undefined, null, 0, -3, 'many', NaN]) {
    const { contextUsage } = buildCursorContextUsage({
      usage: USAGE,
      model: 'cursor-composer-1',
      modelCallCount,
    });
    assert.equal(contextUsage.totalTokens, 1350, `count ${String(modelCallCount)}`);
  }
});

test('categories are always empty and no skills/autoCompact keys exist', () => {
  const { contextUsage } = buildCursorContextUsage({ usage: USAGE, model: 'cursor-composer-1' });
  assert.deepEqual(contextUsage.categories, []);
  assert.equal('skills' in contextUsage, false);
  assert.equal('autoCompactThreshold' in contextUsage, false);
  assert.equal('isAutoCompactEnabled' in contextUsage, false);
});

test('apiUsage maps onto the snake_case Anthropic field names', () => {
  const { contextUsage } = buildCursorContextUsage({ usage: USAGE, model: 'cursor-composer-1' });
  assert.deepEqual(contextUsage.apiUsage, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200,
  });
});

test('modelUsage carries the window only when known', () => {
  const withWindow = buildCursorContextUsage({
    usage: USAGE,
    model: 'cursor-composer-1',
    contextWindow: 200000,
  }).modelUsage;
  assert.deepEqual(withWindow, {
    'cursor-composer-1': {
      contextWindow: 200000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 200,
    },
  });

  const without = buildCursorContextUsage({ usage: USAGE, model: 'cursor-composer-1' }).modelUsage;
  assert.equal('contextWindow' in without['cursor-composer-1'], false);
});

test('missing token fields default to zero in the occupancy sum', () => {
  const { contextUsage } = buildCursorContextUsage({
    usage: { inputTokens: 40, outputTokens: 2 },
    model: 'cursor-composer-1',
  });
  assert.equal(contextUsage.totalTokens, 42);
  assert.deepEqual(contextUsage.apiUsage, {
    input_tokens: 40,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test('returns null for falsy usage or usage without numeric token fields', () => {
  assert.equal(buildCursorContextUsage({ usage: null, model: 'm' }), null);
  assert.equal(buildCursorContextUsage({ usage: undefined, model: 'm' }), null);
  assert.equal(buildCursorContextUsage({ usage: {}, model: 'm' }), null);
  assert.equal(buildCursorContextUsage({ usage: { inputTokens: 'lots' }, model: 'm' }), null);
  assert.equal(buildCursorContextUsage(), null);
});

test('output satisfies the Claude context-usage pipeline unchanged', () => {
  const built = buildCursorContextUsage({
    usage: USAGE,
    model: 'cursor-composer-1',
    contextWindow: 200000,
  });
  assert.ok(normalizeClaudeContextUsage(built.contextUsage));
  const snapshot = buildClaudeContextSnapshot({
    contextUsage: built.contextUsage,
    modelUsage: built.modelUsage,
    model: 'cursor-composer-1',
  });
  assert.ok(snapshot);
  assert.equal(snapshot.model, 'cursor-composer-1');
  assert.equal(snapshot.used_total_tokens, 1350);
  assert.equal(snapshot.max_context_tokens, 200000);
  assert.equal(snapshot.used_percent, Math.round((1350 / 200000) * 10000) / 100);
  assert.equal(snapshot.used_prompt_tokens, 100);
  assert.equal(snapshot.used_completion_tokens, 50);
  assert.equal(snapshot.cache_read_tokens, 1000);
  assert.equal(snapshot.cache_write_tokens, 200);

  // The estimate label survives normalization into the snapshot contract, so
  // the modal renders the cursor caveat instead of presenting it as measured.
  const estimated = buildCursorContextUsage({
    usage: USAGE,
    model: 'cursor-composer-1',
    contextWindow: 200000,
    modelCallCount: 2,
  });
  const estimatedSnapshot = buildClaudeContextSnapshot({
    contextUsage: estimated.contextUsage,
    modelUsage: estimated.modelUsage,
    model: 'cursor-composer-1',
  });
  assert.equal(estimatedSnapshot.estimate_kind, 'cursor-per-call-average');

  // Without an explicit window, the snapshot recovers it from modelUsage.
  const windowless = buildCursorContextUsage({ usage: USAGE, model: 'cursor-composer-1' });
  const fromModelUsage = buildClaudeContextSnapshot({
    contextUsage: windowless.contextUsage,
    modelUsage: { 'cursor-composer-1': { contextWindow: 128000, inputTokens: 100 } },
    model: 'cursor-composer-1',
  });
  assert.equal(fromModelUsage.max_context_tokens, 128000);
});
