import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCopilotProviderConfig,
  resolveOpenAiModelTokenLimits,
} from './copilot-byok-provider.mjs';
import { resolveModelTokenCeilings } from '../../shared/context-window-fallbacks.mjs';

const BYOK_ENV = {
  COPILOT_PROVIDER_TYPE: 'openai',
  COPILOT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
  COPILOT_PROVIDER_API_KEY: 'sk-test',
  COPILOT_PROVIDER_WIRE_API: 'responses',
  COPILOT_MODEL: 'gpt-5.4-mini',
};

test('a hosted session gets no provider config', () => {
  assert.equal(resolveCopilotProviderConfig({ env: {} }), null);
  assert.equal(
    resolveCopilotProviderConfig({ env: { COPILOT_PROVIDER_API_KEY: 'sk-test' } }),
    null,
  );
});

test('a provider type without an api key is not a usable BYOK session', () => {
  const env = { ...BYOK_ENV, COPILOT_PROVIDER_API_KEY: '   ' };
  assert.equal(resolveCopilotProviderConfig({ env }), null);
});

test('the openai env family becomes a ProviderConfig', () => {
  const provider = resolveCopilotProviderConfig({ env: BYOK_ENV });
  assert.equal(provider.type, 'openai');
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
  assert.equal(provider.apiKey, 'sk-test');
  assert.equal(provider.wireApi, 'responses');
});

test('modelId is never pinned, so setModel stays authoritative', () => {
  const provider = resolveCopilotProviderConfig({ env: BYOK_ENV, model: 'gpt-5.4-mini' });
  assert.equal('modelId' in provider, false);
  assert.equal('wireModel' in provider, false);
});

test('a missing base url falls back to the OpenAI default', () => {
  const env = { ...BYOK_ENV };
  delete env.COPILOT_PROVIDER_BASE_URL;
  assert.equal(resolveCopilotProviderConfig({ env }).baseUrl, 'https://api.openai.com/v1');
});

test('an unrecognised wireApi is dropped rather than forwarded', () => {
  const env = { ...BYOK_ENV, COPILOT_PROVIDER_WIRE_API: 'grpc' };
  assert.equal('wireApi' in resolveCopilotProviderConfig({ env }), false);
});

test('token ceilings are set explicitly for known model families', () => {
  // gpt-5.4-mini's window is 256k TOTAL (shared/context-window-fallbacks.mjs),
  // so the prompt ceiling is what is left once the completion is reserved.
  // The old local table claimed 272k here, which is ABOVE the whole window —
  // "too high" is the harmful direction: it turns what should have been early
  // compaction into a hard API rejection with the history intact.
  const provider = resolveCopilotProviderConfig({ env: BYOK_ENV });
  assert.equal(provider.maxOutputTokens, 128_000);
  assert.equal(provider.maxPromptTokens, 128_000);
  assert.ok(provider.maxPromptTokens + provider.maxOutputTokens <= 256_000);
});

test('ceilings come from the shared table, so they cannot drift from it', () => {
  // One module owns the numbers; this asserts the derivation rather than
  // restating a second copy of it here.
  for (const model of ['gpt-5.6-luna', 'gpt-5.4', 'gpt-4o', 'gpt-4.1']) {
    const ceilings = resolveModelTokenCeilings(model);
    assert.deepEqual(resolveOpenAiModelTokenLimits(model), {
      maxPromptTokens: ceilings.maxPromptTokens,
      maxOutputTokens: ceilings.maxOutputTokens,
    });
    assert.equal(ceilings.maxPromptTokens + ceilings.maxOutputTokens, ceilings.contextWindow);
  }
  // The 5.6 series has the wider window of the family, and it shows up here.
  assert.equal(resolveOpenAiModelTokenLimits('gpt-5.6-luna').maxPromptTokens, 144_000);
});

test('an unknown model leaves the ceilings to the runtime', () => {
  const env = { ...BYOK_ENV, COPILOT_MODEL: 'some-local-llama' };
  const provider = resolveCopilotProviderConfig({ env });
  assert.equal('maxPromptTokens' in provider, false);
  assert.equal('maxOutputTokens' in provider, false);
});

test('the live model wins over the configured default when picking ceilings', () => {
  const env = { ...BYOK_ENV, COPILOT_MODEL: 'gpt-4o' };
  const provider = resolveCopilotProviderConfig({ env, model: 'gpt-4.1' });
  assert.equal(provider.maxPromptTokens, 1_014_808);
});

test('explicit env ceilings override the table', () => {
  const env = {
    ...BYOK_ENV,
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '90000',
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '4096',
  };
  const provider = resolveCopilotProviderConfig({ env });
  assert.equal(provider.maxPromptTokens, 90_000);
  assert.equal(provider.maxOutputTokens, 4_096);
});

test('an exponent-notation override is honoured rather than truncated to 1', () => {
  // parseInt('1e6') is 1. A ceiling of ONE token silently bricks every turn,
  // and it is the exact shape a human reaches for when raising a limit.
  const env = { ...BYOK_ENV, COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '1e6' };
  assert.equal(resolveCopilotProviderConfig({ env }).maxPromptTokens, 1_000_000);
});

test('a fractional or garbage override is logged and ignored, not truncated', () => {
  // Falling through to the table is the safe answer; silently rounding a value
  // the user typed wrong is not.
  for (const raw of ['90000.5', 'lots', '-4096', '0', 'NaN', '  ']) {
    const logs = [];
    const provider = resolveCopilotProviderConfig({
      env: { ...BYOK_ENV, COPILOT_PROVIDER_MAX_PROMPT_TOKENS: raw },
      dbg: (message) => logs.push(message),
    });
    assert.equal(provider.maxPromptTokens, 128_000, `expected ${JSON.stringify(raw)} to fall through`);
    // A blank value is "unset", not "invalid", so it is the one that stays quiet.
    assert.equal(logs.length, raw.trim() ? 1 : 0, `unexpected logging for ${JSON.stringify(raw)}`);
    if (raw.trim()) assert.match(logs[0], /COPILOT_PROVIDER_MAX_PROMPT_TOKENS/);
  }
});

test('model ceilings match on the longest prefix and tolerate an openai/ prefix', () => {
  assert.deepEqual(resolveOpenAiModelTokenLimits('openai/gpt-4.1-mini'), {
    maxPromptTokens: 1_014_808,
    maxOutputTokens: 32_768,
  });
  assert.deepEqual(resolveOpenAiModelTokenLimits(''), {});
});
