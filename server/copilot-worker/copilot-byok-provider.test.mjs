import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BYOK_PROVIDER_NAME,
  byokRebuildReason,
  resolveByokSession,
  copilotProviderSessionOptions,
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

const RESOLVED = Object.freeze({
  type: 'openai',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  wireApi: 'responses',
  maxPromptTokens: 128_000,
  maxOutputTokens: 64_000,
});

test('copilotProviderSessionOptions registers a named provider and the model ceilings', () => {
  assert.deepEqual(copilotProviderSessionOptions(RESOLVED, { model: 'gpt-x', reasoningEffort: 'high' }), {
    inference: {
      providers: [{
        name: BYOK_PROVIDER_NAME,
        type: 'openai',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        wireApi: 'responses',
      }],
      models: [{ id: 'gpt-x', provider: BYOK_PROVIDER_NAME, maxPromptTokens: 128_000, maxOutputTokens: 64_000 }],
      defaultProvider: BYOK_PROVIDER_NAME,
      reasoningEffort: 'high',
    },
    github: { capi: { enabled: false } },
  });
  // The whole-session `provider` the SDK refuses is never built.
  assert.equal('provider' in copilotProviderSessionOptions(RESOLVED, { model: 'gpt-x' }), false);
  // The name is a selection-id prefix (`<provider>/<id>`), so it must not hold a slash.
  assert.equal(BYOK_PROVIDER_NAME.includes('/'), false);
});

test('copilotProviderSessionOptions leaves out ceilings and models it does not know', () => {
  const bare = { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'test-key' };
  const withModel = copilotProviderSessionOptions(bare, { model: 'gpt-x' });
  assert.deepEqual(withModel.inference.models, [{ id: 'gpt-x', provider: BYOK_PROVIDER_NAME }]);
  const noModel = copilotProviderSessionOptions(bare);
  assert.equal('models' in noModel.inference, false);
  assert.equal('reasoningEffort' in noModel.inference, false);
  assert.equal(noModel.inference.defaultProvider, BYOK_PROVIDER_NAME);
});

test('copilotProviderSessionOptions adds nothing to a hosted session', () => {
  assert.deepEqual(copilotProviderSessionOptions(null, { model: 'gpt-x', reasoningEffort: 'high' }), {});
});

test('resolveByokSession remembers the provider and model, and is empty for hosted sessions', () => {
  const hosted = resolveByokSession({ env: {}, model: 'gpt-x', reasoningEffort: 'high' });
  assert.deepEqual(hosted, { provider: null, model: '', options: {} });
  const byok = resolveByokSession({
    env: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'test-key' },
    model: 'gpt-4o',
    reasoningEffort: 'high',
  });
  assert.equal(byok.model, 'gpt-4o');
  assert.equal(byok.provider.maxPromptTokens, 111_616);
  assert.deepEqual(Object.keys(byok.options).sort(), ['github', 'inference']);
  assert.equal(byok.options.inference.models[0].id, 'gpt-4o');
  assert.equal(byok.options.inference.reasoningEffort, 'high');
});

test('byokRebuildReason: other ceilings or another model rebuild; the same model stays in place', () => {
  const same = { ...RESOLVED };
  const wider = { ...RESOLVED, maxPromptTokens: 256_000 };
  const built = { provider: RESOLVED, model: 'gpt-5' };
  // Equal ceilings, other model: `inference.models` registers only the built one.
  assert.match(byokRebuildReason({ built, next: { provider: same, model: 'gpt-5.4' } }), /model/);
  // Same model (an effort change): in place.
  assert.equal(byokRebuildReason({ built, next: { provider: same, model: 'gpt-5' } }), '');
  // Other ceilings: a rebuild.
  assert.match(byokRebuildReason({ built, next: { provider: wider, model: 'gpt-5' } }), /ceilings/);
  assert.match(byokRebuildReason({ built, next: { provider: wider, model: 'gpt-5.4' } }), /ceilings/);
});
