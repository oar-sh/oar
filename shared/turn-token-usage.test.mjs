import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TURN_TOKEN_MAX_MODELS,
  addNullable,
  normalizeTurnTokenBilling,
  normalizeTurnTokenEntries,
  normalizeTurnTokenUsageReport,
  tokenCount,
  tokenUsageModel,
} from './turn-token-usage.mjs';

const base = { conversationId: 'conv-1', turnId: 'turn-1' };

test('token counts: missing, negative and non-finite are null; 0 stays 0', () => {
  assert.equal(tokenCount(undefined), null);
  assert.equal(tokenCount(null), null);
  assert.equal(tokenCount(-1), null);
  assert.equal(tokenCount(Number.NaN), null);
  assert.equal(tokenCount(Number.POSITIVE_INFINITY), null);
  assert.equal(tokenCount('12'), null);
  assert.equal(tokenCount(0), 0);
  assert.equal(tokenCount(12.9), 12);
  assert.equal(tokenCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(tokenCount(Number.MAX_SAFE_INTEGER + 2), null);
  assert.equal(tokenCount(1e300), null);
});

test('the caps hold for a model named twice, summed', () => {
  const [entry] = normalizeTurnTokenEntries([
    { model: 'x', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, costUsd: 6e8 },
    { model: 'x', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2, costUsd: 6e8 },
  ]);
  assert.equal(entry.inputTokens, null);
  assert.equal(entry.outputTokens, 3);
  assert.equal(entry.costUsd, null);
});

test('a cost above a billion dollars is a broken report, not a cost', () => {
  assert.equal(normalizeTurnTokenEntries([{ model: 'x', costUsd: 1e9 }])[0].costUsd, 1e9);
  assert.equal(normalizeTurnTokenEntries([{ model: 'x', costUsd: 1e9 + 1 }])[0].costUsd, null);
});

test('model ids: lower case, without [1m]', () => {
  assert.equal(tokenUsageModel(' Claude-Opus-5-5[1m] '), 'claude-opus-5-5');
  assert.equal(tokenUsageModel('gpt-5.5'), 'gpt-5.5');
  assert.equal(tokenUsageModel(''), '');
});

test('addNullable is null only when both are', () => {
  assert.equal(addNullable(null, null), null);
  assert.equal(addNullable(null, 0), 0);
  assert.equal(addNullable(3, null), 3);
  assert.equal(addNullable(3, 4), 7);
});

test('billing: empty or byok-<type>', () => {
  assert.equal(normalizeTurnTokenBilling(undefined), '');
  assert.equal(normalizeTurnTokenBilling('BYOK-OpenAI'), 'byok-openai');
  assert.equal(normalizeTurnTokenBilling('plan'), null);
  assert.equal(normalizeTurnTokenBilling('byok-'), null);
});

test('entries: the same model twice is summed, null-aware', () => {
  assert.deepEqual(normalizeTurnTokenEntries([
    { model: 'claude-opus-5-5', inputTokens: 10, cacheWriteTokens: 2, costUsd: 0.1, costSource: 'claude-code' },
    { model: 'claude-opus-5-5[1m]', inputTokens: 5, outputTokens: 3, costUnknown: true },
    { model: '', inputTokens: 99 },
    { inputTokens: 99 },
  ]), [{
    model: 'claude-opus-5-5',
    inputTokens: 15,
    outputTokens: 3,
    cacheWriteTokens: 2,
    cacheReadTokens: null,
    reasoningTokens: null,
    costUsd: 0.1,
    costSource: 'claude-code',
    costUnknown: true,
  }]);
  assert.equal(normalizeTurnTokenEntries([{ model: 'x', costSource: 'made-up', costUsd: -1 }])[0].costSource, null);
  assert.equal(normalizeTurnTokenEntries([{ model: 'x', costUsd: -1 }])[0].costUsd, null);
});

test('a report: ids, provider, billing, at, and models or session totals', () => {
  const ok = normalizeTurnTokenUsageReport({
    ...base, runId: ' run-1 ', provider: 'Cursor', billing: '', nativeSessionId: 'n1', responseMessageId: 'r1',
    at: '2026-11-02T10:00:00+01:00', models: [{ model: 'composer-2', inputTokens: 1 }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.runId, 'run-1');
  assert.equal(ok.report.provider, 'cursor');
  assert.equal(ok.report.at, '2026-11-02T09:00:00.000Z');
  assert.equal(ok.report.nativeSessionId, 'n1');
  assert.equal(ok.report.models.length, 1);

  const bare = normalizeTurnTokenUsageReport({ ...base, models: [{ model: 'grok-5' }] });
  assert.equal(bare.ok, true);
  assert.equal(bare.report.runId, '');
  assert.equal(bare.report.at, null);
  assert.equal(bare.report.nativeSessionId, null);
  assert.equal(bare.report.models[0].inputTokens, null);

  const cloud = normalizeTurnTokenUsageReport({ ...base, nativeSessionId: 'cloud-1', sessionTotals: [{ model: 'claude-opus-5-5', inputTokens: 1 }] });
  assert.equal(cloud.ok, true);
  assert.equal(cloud.report.sessionTotals.length, 1);
  assert.equal(cloud.report.models, undefined);
});

test('a report is refused for what it cannot be booked by', () => {
  const error = (body) => normalizeTurnTokenUsageReport(body).error;
  const models = [{ model: 'm', inputTokens: 1 }];
  assert.equal(error({ turnId: 't', models }), 'Missing conversationId');
  assert.equal(error({ conversationId: 'c', models }), 'Missing turnId');
  assert.equal(error({ ...base, runId: 'x'.repeat(201), models }), 'Invalid runId');
  assert.equal(error({ ...base, provider: 'openai', models }), 'Unknown provider');
  assert.equal(error({ ...base, billing: 'free', models }), 'Invalid billing');
  assert.equal(error({ ...base, at: 'yesterday', models }), 'Invalid at');
  assert.equal(error({ ...base }), 'Send either models or sessionTotals');
  assert.equal(error({ ...base, models, sessionTotals: models }), 'Send either models or sessionTotals');
  assert.equal(error({ ...base, models: [] }), 'Missing models');
  assert.equal(error({ ...base, models: [{ inputTokens: 1 }] }), 'Missing models');
  assert.equal(error({ ...base, models: Array.from({ length: TURN_TOKEN_MAX_MODELS + 1 }, (_, i) => ({ model: `m${i}` })) }), `More than ${TURN_TOKEN_MAX_MODELS} models`);
  assert.equal(error({ ...base, sessionTotals: models }), 'Missing nativeSessionId');
});
