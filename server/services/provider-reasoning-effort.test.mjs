import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_ULTRACODE_EFFORT,
  resolveProviderReasoningEffort,
  supportedReasoningEffortsForProviderModel,
  withClaudeUltracodeTier,
} from './provider-reasoning-effort.mjs';

test('cursor tiers come from discovery and stay unknown when undiscovered', () => {
  const cursorSettings = { effortsByModel: { 'grok-4.5': ['none', 'low', 'high'] } };
  assert.deepEqual(
    supportedReasoningEffortsForProviderModel({ providerType: 'cursor', model: 'Grok-4.5', cursorSettings }),
    ['none', 'low', 'high'],
  );
  assert.equal(
    supportedReasoningEffortsForProviderModel({ providerType: 'cursor', model: 'composer-2.5', cursorSettings }),
    null,
  );
});

test('claude and grok fall back to their full ladders', () => {
  assert.deepEqual(
    supportedReasoningEffortsForProviderModel({ providerType: 'claude', model: 'claude-opus-5' }),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  );
  assert.deepEqual(
    supportedReasoningEffortsForProviderModel({ providerType: 'grok', model: 'grok-4.5' }),
    ['none', 'low', 'medium', 'high'],
  );
});

test('ultracode is derived from xhigh capability, never from discovery', () => {
  // The SDK's supportedModels() never reports 'ultracode'; the tier exists
  // exactly for models that can run xhigh (the flag's own requirement).
  assert.deepEqual(
    withClaudeUltracodeTier(['none', 'low', 'medium', 'high', 'xhigh']),
    ['none', 'low', 'medium', 'high', 'xhigh', CLAUDE_ULTRACODE_EFFORT],
  );
  assert.deepEqual(
    withClaudeUltracodeTier(['none', 'low', 'medium', 'high']),
    ['none', 'low', 'medium', 'high'],
  );
  // Idempotent: augmenting an already-augmented ladder must not double it.
  assert.deepEqual(
    withClaudeUltracodeTier(['xhigh', CLAUDE_ULTRACODE_EFFORT]),
    ['xhigh', CLAUDE_ULTRACODE_EFFORT],
  );
  assert.deepEqual(withClaudeUltracodeTier(null), []);
});

test('ultracode never leaks into non-claude ladders', () => {
  assert.ok(
    !supportedReasoningEffortsForProviderModel({ providerType: 'grok', model: 'grok-4.5' }).includes('ultracode'),
  );
  const cursorSettings = { effortsByModel: { 'composer-2.5': ['none', 'low', 'high', 'xhigh'] } };
  assert.ok(
    !supportedReasoningEffortsForProviderModel({ providerType: 'cursor', model: 'composer-2.5', cursorSettings })
      .includes('ultracode'),
  );
});

test('a supported effort survives and an unsupported one clamps to the provider default', () => {
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: 'HIGH', supportedEfforts: ['none', 'high'] }).effort,
    'high',
  );
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: 'high', supportedEfforts: ['none'] }).effort,
    'none',
  );
  // No off switch: the first tier is the default, matching the per-turn path.
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: 'high', supportedEfforts: ['low', 'medium'] }).effort,
    'low',
  );
});

test('strict providers refuse an unsupported effort instead of clamping', () => {
  // OpenAI answers the first send with a 400, so bootstrap must not store a
  // value that send would reject.
  const strict = resolveProviderReasoningEffort({
    requestedEffort: 'xhigh',
    supportedEfforts: ['low', 'medium', 'high'],
    strict: true,
  });
  assert.equal(strict.ok, false);
  assert.equal(strict.effort, '');
  assert.match(String(strict.error), /"xhigh" is not supported/);
});

test('an unknown tier list passes the request through untouched', () => {
  // Clamping here would disable thinking on a model the relay simply has not
  // discovered yet; the worker validates it against the live model params.
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: 'high', supportedEfforts: null }).effort,
    'high',
  );
});

test('no requested effort takes the same default the first send would', () => {
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: '', supportedEfforts: ['none', 'high'] }).effort,
    'none',
  );
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: '', supportedEfforts: ['low', 'high'] }).effort,
    'low',
  );
  assert.equal(
    resolveProviderReasoningEffort({ requestedEffort: '', supportedEfforts: null }).effort,
    '',
  );
});
