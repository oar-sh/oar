import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_LONG_CONTEXT_LIMIT_TOKENS } from '../../../shared/model-id.mjs';
import {
  buildContextTierOptions,
  resolveContextTierValue,
} from './context-tier-options.mjs';

// The catalog the live app reports: opus ships as "[1m]" only, fable as both.
const CLAUDE_TIERS = {
  'claude-sonnet-5': [{ value: 'default' }],
  'claude-opus-5': [{ value: 'long_context' }],
  'claude-fable-5': [
    { value: 'default' },
    { value: 'long_context' },
  ],
  'claude-haiku-4-5-20251001': [{ value: 'default' }],
};

// Copilot's own row for the same model id, which must not leak into Claude.
const COPILOT_OPUS_METADATA = {
  provider: 'github-copilot',
  defaultContextLimitTokens: 264000,
  longContextLimitTokens: 1000000,
};

test('the browser mirror of the 1M limit matches shared/model-id.mjs', () => {
  const [longTier] = buildContextTierOptions({
    modelId: 'claude-opus-5',
    providerType: 'claude',
    metadata: {},
    claudeTiers: CLAUDE_TIERS,
  });
  assert.equal(longTier.label, `${Math.round(CLAUDE_LONG_CONTEXT_LIMIT_TOKENS / 1000)}K`);
});

test('a claude model shipped only as [1m] offers long context alone', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-opus-5',
      providerType: 'claude',
      metadata: COPILOT_OPUS_METADATA,
      claudeTiers: CLAUDE_TIERS,
    }),
    [{ value: 'long_context', label: '1000K' }],
  );
});

test('a claude model shipped as both ids offers both tiers', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-fable-5',
      providerType: 'claude',
      metadata: { defaultContextLimitTokens: 200000 },
      claudeTiers: CLAUDE_TIERS,
    }),
    [
      { value: 'default', label: '—' },
      { value: 'long_context', label: '1000K' },
    ],
  );
});

test('a claude model with no [1m] variant offers the default tier alone', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-sonnet-5',
      providerType: 'claude',
      metadata: {},
      claudeTiers: CLAUDE_TIERS,
    }),
    [{ value: 'default', label: '—' }],
  );
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-haiku-4-5-20251001',
      providerType: 'claude',
      metadata: { defaultContextLimitTokens: 200000 },
      claudeTiers: CLAUDE_TIERS,
    }),
    [{ value: 'default', label: '—' }],
  );
});

test('a claude default tier never borrows the copilot window for the same model id', () => {
  // Copilot serves claude-opus-5 with a 264000 default and the server keeps
  // that number in the merged metadata, so a Claude conversation would read
  // "264K" for a window the SDK does not have.
  const [defaultTier] = buildContextTierOptions({
    modelId: 'claude-opus-5',
    providerType: 'claude',
    metadata: COPILOT_OPUS_METADATA,
    claudeTiers: { 'claude-opus-5': [{ value: 'default' }, { value: 'long_context' }] },
  });
  assert.deepEqual(defaultTier, { value: 'default', label: '—' });
});

test('claude tiers are matched case-insensitively', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'Claude-Opus-5',
      providerType: 'CLAUDE',
      metadata: {},
      claudeTiers: CLAUDE_TIERS,
    }),
    [{ value: 'long_context', label: '1000K' }],
  );
});

test('the same model id under copilot keeps the copilot windows', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-opus-5',
      providerType: 'github-copilot',
      metadata: COPILOT_OPUS_METADATA,
      claudeTiers: CLAUDE_TIERS,
    }),
    [
      { value: 'default', label: '264K' },
      { value: 'long_context', label: '1000K' },
    ],
  );
});

test('providers other than claude ignore the claude tier map', () => {
  // Only the Claude SDK reports per-provider tiers; every other provider must
  // keep reading its own metadata even for a model id Claude also serves.
  for (const providerType of ['openai', 'cursor', 'grok']) {
    assert.deepEqual(
      buildContextTierOptions({
        modelId: 'claude-opus-5',
        providerType,
        metadata: COPILOT_OPUS_METADATA,
        claudeTiers: CLAUDE_TIERS,
      }),
      [
        { value: 'default', label: '264K' },
        { value: 'long_context', label: '1000K' },
      ],
      providerType,
    );
  }
});

test('a model with no metadata offers an unknown default tier only', () => {
  assert.deepEqual(
    buildContextTierOptions({ modelId: 'gpt-5.4-mini', providerType: 'github' }),
    [{ value: 'default', label: '—' }],
  );
});

test('a claude model missing from the tier map falls back to metadata', () => {
  assert.deepEqual(
    buildContextTierOptions({
      modelId: 'claude-opus-5',
      providerType: 'claude',
      metadata: COPILOT_OPUS_METADATA,
      claudeTiers: {},
    }),
    [
      { value: 'default', label: '264K' },
      { value: 'long_context', label: '1000K' },
    ],
  );
});

test('the current tier survives a rebuild when it is still offered', () => {
  const options = buildContextTierOptions({
    modelId: 'claude-fable-5',
    providerType: 'claude',
    metadata: {},
    claudeTiers: CLAUDE_TIERS,
  });
  assert.equal(resolveContextTierValue(options, 'long_context'), 'long_context');
  assert.equal(resolveContextTierValue(options, 'default'), 'default');
});

test('a dropped tier falls back to the first offered one, not to default', () => {
  const opusOptions = buildContextTierOptions({
    modelId: 'claude-opus-5',
    providerType: 'claude',
    metadata: {},
    claudeTiers: CLAUDE_TIERS,
  });
  assert.equal(resolveContextTierValue(opusOptions, 'default'), 'long_context');
  const sonnetOptions = buildContextTierOptions({
    modelId: 'claude-sonnet-5',
    providerType: 'claude',
    metadata: {},
    claudeTiers: CLAUDE_TIERS,
  });
  assert.equal(resolveContextTierValue(sonnetOptions, 'long_context'), 'default');
});

test('a leftover openai image size clamps to the default tier', () => {
  // The same <select> holds image sizes for image models, so its value can
  // still be "1024x1024" when the composer switches back to a chat model.
  const options = buildContextTierOptions({
    modelId: 'gpt-5.4-mini',
    providerType: 'github-copilot',
    metadata: { defaultContextLimitTokens: 128000 },
  });
  assert.equal(resolveContextTierValue(options, '1024x1024'), 'default');
});

test('resolveContextTierValue yields an empty value when nothing is offered', () => {
  assert.equal(resolveContextTierValue([], 'default'), '');
  assert.equal(resolveContextTierValue(), '');
});
