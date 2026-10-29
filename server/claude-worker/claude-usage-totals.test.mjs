import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeSearchTotals, claudeTokenTotals, claudeToolRequests, claudeUsageTotals } from './claude-usage-totals.mjs';

const stripSuffix = (value) => String(value ?? '').replace(/\[1m\]$/i, '');

function entry(input, cacheRead, output, cacheCreation = 0) {
  return { inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, outputTokens: output, costUSD: 9.99 };
}

test('the CLI\'s spellings of one model are summed; hits, misses and output are split', () => {
  assert.deepEqual(claudeUsageTotals({
    'deepseek-flash[1m]': entry(1000, 9000, 100),
    'deepseek-flash': entry(50, 0, 10),
    'deepseek-v4-pro[1m]': entry(400, 2000, 80, 5),
  }, { modelKey: stripSuffix }), [
    { model: 'deepseek-flash', hitTokens: 9000, missTokens: 1050, outputTokens: 110 },
    { model: 'deepseek-v4-pro', hitTokens: 2000, missTokens: 405, outputTokens: 80 },
  ]);
});

test('without modelUsage the usage block counts under the turn\'s model; nothing usable is nothing', () => {
  const usage = { input_tokens: 70, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 30 };
  assert.deepEqual(claudeUsageTotals(null, { usage, model: 'deepseek-flash[1m]', modelKey: stripSuffix }), [
    { model: 'deepseek-flash', hitTokens: 900, missTokens: 70, outputTokens: 30 },
  ]);
  assert.deepEqual(claudeUsageTotals(null, { usage, model: '' }), []);
  assert.deepEqual(claudeUsageTotals(undefined), []);
  assert.deepEqual(claudeUsageTotals({ '': entry(1, 1, 1), 'deepseek-flash': null, 'deepseek-v4-pro': entry(0, 0, 0) }), []);
  // Negative or broken counts are zero.
  assert.deepEqual(claudeUsageTotals({ m: { inputTokens: -5, outputTokens: 'x', cacheReadInputTokens: 3 } }), [
    { model: 'm', hitTokens: 3, missTokens: 0, outputTokens: 0 },
  ]);
});

test('the turn\'s searches and fetches are summed per model under the relay\'s id; none is nothing', () => {
  assert.deepEqual(claudeToolRequests([
    { model: 'deepseek-flash[1m]', webSearchRequests: 2, webFetchRequests: 1 },
    { model: 'deepseek-flash', webSearchRequests: 1, webFetchRequests: 0 },
    { model: 'deepseek-v4-pro', webSearchRequests: 0, webFetchRequests: 0 },
    { model: '', webSearchRequests: 5, webFetchRequests: 5 },
    null,
    { model: 'm', webSearchRequests: -1, webFetchRequests: 'x' },
  ], { modelKey: stripSuffix }), [
    { model: 'deepseek-flash', searchRequests: 3, fetchRequests: 1 },
  ]);
  assert.deepEqual(claudeToolRequests([]), []);
  assert.deepEqual(claudeToolRequests(null), []);
  assert.deepEqual(claudeToolRequests({ model: 'deepseek-flash', webSearchRequests: 1 }), []);
});

test('the CLI\'s running search counts are read per model, zero included; no count reported is nothing', () => {
  assert.deepEqual(claudeSearchTotals({
    'deepseek-flash[1m]': { ...entry(1, 1, 1), webSearchRequests: 2 },
    'deepseek-flash': { ...entry(1, 1, 1), webSearchRequests: 1 },
    'deepseek-v4-pro[1m]': { ...entry(1, 1, 1), webSearchRequests: 0 },
    'claude-haiku-4-5': entry(1, 1, 1),
    '': { webSearchRequests: 9 },
    m: { webSearchRequests: -3 },
  }, { modelKey: stripSuffix }), [
    { model: 'deepseek-flash', searchRequests: 3 },
    { model: 'deepseek-v4-pro', searchRequests: 0 },
    { model: 'm', searchRequests: 0 },
  ]);
  assert.deepEqual(claudeSearchTotals({ 'deepseek-flash': entry(1, 1, 1) }), []);
  assert.deepEqual(claudeSearchTotals(null), []);
  assert.deepEqual(claudeSearchTotals([{ webSearchRequests: 1 }]), []);
});

test('the token totals keep fresh input, cache writes and cache reads apart; the misses stay as they were', () => {
  const modelUsage = {
    'claude-opus-5-5[1m]': { inputTokens: 120, cacheCreationInputTokens: 3000, cacheReadInputTokens: 50000, outputTokens: 900, costUSD: 1.25 },
    'Claude-Opus-5-5': { inputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1, costUSD: 0.01 },
    'claude-haiku-5-5': { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 2, costUSD: 0, costBasis: 'unknown' },
    'idle-model': { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
  };
  assert.deepEqual(claudeTokenTotals(modelUsage), [
    { model: 'claude-opus-5-5', inputTokens: 125, cacheWriteTokens: 3000, cacheReadTokens: 50000, outputTokens: 901, costUsd: 1.26, costUnknown: false },
    { model: 'claude-haiku-5-5', inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2, costUsd: 0, costUnknown: true },
  ]);
  // The existing totals still fold the writes into the misses.
  const folded = claudeUsageTotals({ 'claude-opus-5-5': modelUsage['claude-opus-5-5[1m]'] });
  assert.deepEqual(folded, [{ model: 'claude-opus-5-5', hitTokens: 50000, missTokens: 3120, outputTokens: 900 }]);
});

test('the token totals from a turn\'s usage alone carry no cost; modelKey maps the names', () => {
  const usage = { input_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13, output_tokens: 17 };
  assert.deepEqual(claudeTokenTotals(null, { usage, model: 'claude-opus-5-5' }), [
    { model: 'claude-opus-5-5', inputTokens: 7, cacheWriteTokens: 11, cacheReadTokens: 13, outputTokens: 17, costUsd: null, costUnknown: false },
  ]);
  const served = claudeTokenTotals({ 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1 } }, { modelKey: () => 'deepseek-v4-pro' });
  assert.equal(served[0].model, 'deepseek-v4-pro');
  assert.deepEqual(claudeTokenTotals(null, { usage: null, model: 'x' }), []);
});
