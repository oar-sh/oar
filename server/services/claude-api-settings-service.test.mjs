import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_API_CARRIED_MODEL_SETTING_KEY,
  CLAUDE_API_ENABLED_MODELS_SETTING_KEY,
  CLAUDE_API_KEY_SETTING_KEY,
  CLAUDE_API_MODELS_SETTING_KEY,
  CLAUDE_API_MODEL_SETTING_KEY,
  CLAUDE_API_MONTHLY_CAP_SETTING_KEY,
  classifyClaudeApiKey,
  createClaudeApiSettingsService,
  parseClaudeApiMonthlyCap,
  parseClaudeApiSettingsUpdateRequest,
} from './claude-api-settings-service.mjs';

// Invented placeholders, short enough not to look like real keys.
const TEST_KEY = 'sk-ant-api03-test-1111';
const OTHER_KEY = 'sk-ant-api03-test-2222';

// What the Claude tab offers on a relay that has not discovered its models.
const CLAUDE_SETTINGS = Object.freeze({
  enabled: true,
  model: 'claude-sonnet-5',
  availableModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-haiku-4-5'],
  effortsByModel: {
    'claude-sonnet-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    'claude-haiku-4-5': ['none', 'low', 'high'],
  },
});

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
    deleteSetting: (key) => { values.delete(key); },
  };
}

function modelsFetch(data, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, has_more: false, last_id: data.at(-1)?.id || null }),
      text: async () => '',
    };
  };
}

function service(store, extra = {}) {
  return createClaudeApiSettingsService({
    ...store,
    getClaudeProviderSettings: () => CLAUDE_SETTINGS,
    env: {},
    now: () => new Date('2026-10-24T12:00:00Z'),
    ...extra,
  });
}

const DISCOVERED = [
  {
    id: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      image_input: { supported: true },
      effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
      thinking: { supported: true },
    },
  },
  {
    id: 'claude-sonnet-5-5',
    display_name: 'Claude Sonnet 5.5',
    max_input_tokens: 200000,
    max_tokens: 64000,
    capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, high: { supported: true } } },
  },
  { id: 'claude-haiku-5-5', max_input_tokens: 200000, capabilities: { effort: false } },
  // Not something the Claude provider would run.
  { id: 'other-vendor-model' },
  { id: 'claude-bad id' },
];

test('Anthropic keys pass; OAuth tokens, admin keys, session tokens and other vendors\' keys are refused by prefix', () => {
  // Any sk-ant- key but the refused kinds: a Console key need not start with sk-ant-api.
  for (const key of [TEST_KEY, 'SK-ANT-API03-FAKE-TEST', 'sk-ant-usr01-fake-key', 'sk-ant-svc01-fake-key', 'sk-ant-xyz01-fake-key', 'sk-ant-ap-FAKE-short', 'sk-ant-ccx-fake-tok']) {
    assert.deepEqual(classifyClaudeApiKey(key), { ok: true, kind: 'api-key' }, key);
  }
  const refusals = [
    // Not an Anthropic key at all: another vendor's, or a typo.
    ['plain-test-key-1234', 'not-console-key', /does not look like a Claude API key/],
    ['sk-proj-fake-not-a-key', 'not-console-key', /does not look like a Claude API key/],
    ['sk-FAKE0123456789abcdef', 'not-console-key', /does not look like a Claude API key/],
    ['ant-api03-FAKE-no-sk', 'not-console-key', /does not look like a Claude API key/],
    ['sk-ant-oat01-fake-xx', 'oauth-access-token', /OAuth access token/],
    ['sk-ant-ort01-fake-xx', 'oauth-refresh-token', /OAuth refresh token/],
    ['sk-ant-admin01-fake-x', 'admin-key', /Admin API key/],
    ['SK-ANT-OAT01-FAKE-XX', 'oauth-access-token', /OAuth access token/],
    ['sk-ant-sid01-fake-xx', 'session-token', /session key/],
    ['sk-ant-si-fake-token', 'session-token', /session token/],
    ['sk-ant-cc-fake-token', 'session-access-token', /Claude Code session access token/],
    ['sk-ant-ccsr-fake-tok', 'remote-session-credential', /Claude Code remote session credential/],
  ];
  for (const [value, kind, text] of refusals) {
    const result = classifyClaudeApiKey(value);
    assert.equal(result.ok, false, value);
    assert.equal(result.kind, kind, value);
    assert.match(result.error, text);
    assert.match(result.error, /Console/);
    assert.match(result.error, /Claude login tokens and Admin keys are refused/);
    assert.doesNotMatch(result.error, /sk-ant-api/);
    assert.equal(result.error.toLowerCase().includes(value.toLowerCase()), false, 'the value is never quoted back');
  }
});

test('the parser takes each field on its own, refuses bad values and never echoes the key', () => {
  assert.deepEqual(parseClaudeApiSettingsUpdateRequest({}), { ok: false, error: 'No Claude API settings update provided' });
  assert.deepEqual(parseClaudeApiSettingsUpdateRequest({ remove: true, apiKey: TEST_KEY }), { ok: true, remove: true, enabled: false });
  assert.deepEqual(parseClaudeApiSettingsUpdateRequest({ apiKey: ` ${TEST_KEY} ` }), { ok: true, remove: false, apiKey: TEST_KEY, enabled: true });
  assert.deepEqual(
    parseClaudeApiSettingsUpdateRequest({ apiKey: TEST_KEY, enabled: false }),
    { ok: true, remove: false, apiKey: TEST_KEY, enabled: false },
  );
  const oauth = parseClaudeApiSettingsUpdateRequest({ apiKey: 'sk-ant-oat01-fake-xx' });
  assert.equal(oauth.ok, false);
  assert.equal(oauth.code, 'claude-api-key-oauth-access-token');
  assert.equal(oauth.error.includes('sk-ant-oat01-fake-xx'), false);
  const otherVendor = parseClaudeApiSettingsUpdateRequest({ apiKey: 'sk-proj-fake-not-a-key' });
  assert.equal(otherVendor.ok, false);
  assert.equal(otherVendor.code, 'claude-api-key-not-console-key');
  assert.match(otherVendor.error, /platform\.claude\.com → API keys/);
  const otherPrefix = parseClaudeApiSettingsUpdateRequest({ apiKey: 'sk-ant-xyz01-fake-key' });
  assert.deepEqual(otherPrefix, { ok: true, remove: false, apiKey: 'sk-ant-xyz01-fake-key', enabled: true });
  assert.equal(otherVendor.error.includes('sk-proj-fake'), false);
  const badKey = parseClaudeApiSettingsUpdateRequest({ apiKey: 'sk short' });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.error.includes('sk short'), false);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ apiKey: 42 }).ok, false);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ model: 'claude-opus-5-5[1m]' }).model, 'claude-opus-5-5[1m]');
  assert.equal(parseClaudeApiSettingsUpdateRequest({ model: '' }).model, '');
  assert.equal(parseClaudeApiSettingsUpdateRequest({ model: 'gpt-5.5' }).ok, false);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ model: 'claude-x; rm -rf' }).ok, false);
  assert.deepEqual(
    parseClaudeApiSettingsUpdateRequest({ enabledModels: ['claude-opus-5-5', 'gpt-5.5', 'Claude-Opus-5-5', 'claude-opus-5-5[1m]'] }).enabledModels,
    ['claude-opus-5-5', 'claude-opus-5-5[1m]'],
  );
  assert.equal(parseClaudeApiSettingsUpdateRequest({ enabledModels: 'claude-opus-5-5' }).ok, false);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ enabled: 'yes' }).ok, false);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ monthlyCapUsd: 25.5 }).monthlyCapUsd, 25.5);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ monthlyCapUsd: null }).monthlyCapUsd, null);
  assert.equal(parseClaudeApiSettingsUpdateRequest({ monthlyCapUsd: -1 }).ok, false);
});

test('the monthly cap: empty is no cap, else a positive amount with at most two decimals', () => {
  for (const empty of [null, undefined, '', '  ']) assert.deepEqual(parseClaudeApiMonthlyCap(empty), { ok: true, capUsd: null });
  assert.deepEqual(parseClaudeApiMonthlyCap(50), { ok: true, capUsd: 50 });
  assert.deepEqual(parseClaudeApiMonthlyCap('12.34'), { ok: true, capUsd: 12.34 });
  assert.deepEqual(parseClaudeApiMonthlyCap(' 0.5 '), { ok: true, capUsd: 0.5 });
  assert.deepEqual(parseClaudeApiMonthlyCap(1000000), { ok: true, capUsd: 1000000 });
  for (const refused of [0, '0', '0.00', -5, '1.234', 1.005, '1e3', 'ten', '1,000', '$10', '05', 1000000.01, Number.NaN, Infinity, true, {}]) {
    assert.equal(parseClaudeApiMonthlyCap(refused).ok, false, String(refused));
  }
});

test('before any discovery the Claude tab stands in: its list, its default model and its efforts', () => {
  const settings = service(createStore()).getSettings();
  assert.equal(settings.configured, false);
  assert.equal(settings.enabled, false);
  assert.equal(settings.discovered, false);
  assert.equal(settings.model, 'claude-sonnet-5');
  assert.deepEqual(settings.availableModels, CLAUDE_SETTINGS.availableModels);
  assert.deepEqual(settings.models, CLAUDE_SETTINGS.availableModels);
  assert.deepEqual(settings.effortsByModel['claude-sonnet-5'], ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  assert.deepEqual(settings.effortsByModel['claude-haiku-4-5'], ['none', 'low', 'high']);
  // A model the Claude tab has no levels for gets the full Claude ladder.
  assert.deepEqual(settings.effortsByModel['claude-opus-5'], ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  assert.equal(settings.contextWindowsByModel['claude-opus-5[1m]'], 1000000);
  assert.equal(settings.monthlyCapUsd, null);
  assert.equal(settings.providerType, 'claude-api');
  assert.equal(settings.label, 'Claude API');
});

test('the default model: the Claude tab\'s when offered, else the first Sonnet, else the first', () => {
  const store = createStore({
    [CLAUDE_API_MODELS_SETTING_KEY]: JSON.stringify([{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }]),
  });
  assert.equal(service(store).getSettings().model, 'claude-sonnet-5-5');
  const claudeDefaultOffered = service(store, {
    getClaudeProviderSettings: () => ({ ...CLAUDE_SETTINGS, model: 'Claude-Opus-5-5' }),
  });
  assert.equal(claudeDefaultOffered.getSettings().model, 'claude-opus-5-5');
  store.values.set(CLAUDE_API_MODELS_SETTING_KEY, JSON.stringify([{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }]));
  assert.equal(service(store).getSettings().model, 'claude-opus-5-5');
  // A stored choice wins.
  store.values.set(CLAUDE_API_MODEL_SETTING_KEY, 'claude-haiku-5-5');
  assert.equal(service(store).getSettings().model, 'claude-haiku-5-5');
});

test('saving a key stores it, switches the provider on and asks for discovery; describe never shows it', () => {
  const store = createStore();
  const settings = service(store);
  const result = settings.update(parseClaudeApiSettingsUpdateRequest({ apiKey: TEST_KEY, monthlyCapUsd: '40' }));
  assert.equal(result.ok, true);
  assert.equal(result.discover, true);
  assert.equal(result.keyChanged, false, 'nothing ran on an earlier key');
  assert.equal(store.values.get(CLAUDE_API_KEY_SETTING_KEY), TEST_KEY);
  assert.equal(store.values.get(CLAUDE_API_MONTHLY_CAP_SETTING_KEY), '40');
  const described = settings.describe();
  assert.equal(described.configured, true);
  assert.equal(described.enabled, true);
  assert.equal(described.monthlyCapUsd, 40);
  assert.equal('apiKey' in described, false);
  assert.equal(JSON.stringify(described).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  // Clearing the cap removes the row.
  settings.update(parseClaudeApiSettingsUpdateRequest({ monthlyCapUsd: '' }));
  assert.equal(store.values.has(CLAUDE_API_MONTHLY_CAP_SETTING_KEY), false);
  assert.equal(settings.getSettings().monthlyCapUsd, null);
});

test('a rotated key is reported, drops the discovered list, and switching off is reported too', () => {
  const store = createStore({
    [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY,
    [CLAUDE_API_MODELS_SETTING_KEY]: JSON.stringify([{ id: 'claude-sonnet-5-5' }]),
  });
  const rotated = service(store).update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY }));
  assert.equal(rotated.keyChanged, true);
  assert.equal(rotated.discover, true);
  assert.equal(store.values.has(CLAUDE_API_MODELS_SETTING_KEY), false);
  assert.equal(service(store).update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY })).keyChanged, false);

  const off = service(store).update(parseClaudeApiSettingsUpdateRequest({ enabled: false }));
  assert.equal(off.ok, true);
  assert.equal(off.disabled, true);
  assert.equal(off.discover, false);
  // Back on: discovery runs again.
  const on = service(store).update(parseClaudeApiSettingsUpdateRequest({ enabled: true }));
  assert.equal(on.disabled, false);
  assert.equal(on.discover, true);
});

test('a new key Anthropic refuses keeps the default the old key gave, while the fallback list has it', async () => {
  // The Claude tab's own default is another model of its list.
  const claudeTab = { ...CLAUDE_SETTINGS, model: 'claude-opus-5', availableModels: ['claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] };
  const store = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY });
  const env = { OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012' };
  const svc = (extra = {}) => service(store, { getClaudeProviderSettings: () => claudeTab, env, ...extra });
  assert.equal((await svc({ fetchImpl: modelsFetch(DISCOVERED) }).refreshModels()).ok, true);
  assert.equal(svc().getSettings().model, 'claude-sonnet-5-5');

  const rotated = svc().update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY }));
  assert.equal(rotated.previousModel, 'claude-sonnet-5-5');
  const refused = async () => ({ ok: false, status: 401, text: async () => 'invalid x-api-key', json: async () => ({}) });
  assert.equal((await svc({ fetchImpl: refused }).refreshModels()).ok, false);
  // The fallback list has it: still the default, not the Claude tab's.
  assert.equal(svc().getSettings().discovered, false);
  assert.equal(svc().getSettings().model, 'claude-sonnet-5-5');
  assert.equal(store.values.has(CLAUDE_API_MODEL_SETTING_KEY), false);

  // The new key's own list decides once it is read.
  assert.equal((await svc({ fetchImpl: modelsFetch(DISCOVERED.slice(0, 1)) }).refreshModels()).ok, true);
  assert.equal(store.values.has(CLAUDE_API_CARRIED_MODEL_SETTING_KEY), false);
  assert.equal(svc().getSettings().model, 'claude-opus-5-5');

  // A default the fallback list lacks gives way, and a picked one is never carried.
  const lacking = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY, [CLAUDE_API_MODELS_SETTING_KEY]: JSON.stringify([{ id: 'claude-sonnet-6' }]) });
  const lackingSvc = () => service(lacking, { getClaudeProviderSettings: () => claudeTab });
  assert.equal(lackingSvc().update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY })).previousModel, 'claude-sonnet-6');
  assert.equal(lackingSvc().getSettings().model, 'claude-opus-5');
  const picked = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY, [CLAUDE_API_MODEL_SETTING_KEY]: 'claude-haiku-4-5' });
  service(picked).update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY }));
  assert.equal(picked.values.has(CLAUDE_API_CARRIED_MODEL_SETTING_KEY), false);
});

test('switching on without a key is refused', () => {
  const result = service(createStore()).update(parseClaudeApiSettingsUpdateRequest({ enabled: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test('the composer list keeps the default model and only models that are offered', () => {
  const store = createStore({
    [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY,
    [CLAUDE_API_MODELS_SETTING_KEY]: JSON.stringify([{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }]),
  });
  const settings = service(store);
  settings.update(parseClaudeApiSettingsUpdateRequest({ model: 'claude-opus-5-5', enabledModels: ['claude-haiku-5-5', 'claude-retired-4'] }));
  assert.deepEqual(JSON.parse(store.values.get(CLAUDE_API_ENABLED_MODELS_SETTING_KEY)), ['claude-haiku-5-5', 'claude-retired-4']);
  const current = settings.getSettings();
  assert.equal(current.model, 'claude-opus-5-5');
  assert.deepEqual(current.models, ['claude-opus-5-5', 'claude-haiku-5-5']);
  settings.update(parseClaudeApiSettingsUpdateRequest({ enabledModels: [] }));
  assert.deepEqual(settings.getSettings().models, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  // An empty model goes back to the derived default.
  settings.update(parseClaudeApiSettingsUpdateRequest({ model: '' }));
  assert.equal(store.values.has(CLAUDE_API_MODEL_SETTING_KEY), false);
  assert.equal(settings.getSettings().model, 'claude-sonnet-5-5');
});

test('the key cannot be removed while a Claude API conversation has a message or a queued one', () => {
  const store = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY });
  const rows = [
    { provider_type: 'claude-api', message_count: 2, active_queue_count: 0 },
    { provider_type: 'Claude-API', message_count: 0, active_queue_count: 1 },
    { provider_type: 'claude-api', message_count: 0, active_queue_count: 0 },
    { provider_type: 'claude', message_count: 9, active_queue_count: 9 },
  ];
  const blocked = service(store, { listProviderCandidates: () => rows }).update({ remove: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'claude-api-key-removal-blocked');
  assert.equal(blocked.activeConversationCount, 2);
  assert.equal(blocked.startedConversationCount, 1);
  assert.equal(blocked.activeQueueConversationCount, 1);
  assert.equal(store.values.get(CLAUDE_API_KEY_SETTING_KEY), TEST_KEY);

  const removed = service(store, { listProviderCandidates: () => rows.slice(2) }).update({ remove: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.keyChanged, true);
  assert.equal(removed.disabled, true);
  assert.equal(store.values.has(CLAUDE_API_KEY_SETTING_KEY), false);
  assert.equal(service(store).getSettings().enabled, false);
});

test('discovery stores the Claude models with their details, adds [1m] ids and keeps the old list on failure', async () => {
  const calls = [];
  const store = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY });
  const env = { OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012' };
  const ok = await service(store, { env, fetchImpl: modelsFetch(DISCOVERED, calls) }).refreshModels();
  assert.equal(ok.ok, true);
  // Opus has a 1M window; Sonnet 5.5 is not on the Claude tab with [1m].
  assert.deepEqual(ok.models, ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-haiku-5-5']);
  assert.equal(calls[0].url, 'http://127.0.0.1:4012/v1/models?limit=1000');
  assert.equal(calls[0].options.headers['x-api-key'], TEST_KEY);

  const settings = service(store).getSettings();
  assert.equal(settings.discovered, true);
  assert.equal(settings.model, 'claude-sonnet-5-5');
  assert.deepEqual(settings.modelDetails['claude-opus-5-5'], {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    contextWindow: 1000000,
    maxOutput: 128000,
    imageInput: true,
    effort: true,
    thinking: true,
  });
  // Efforts from Anthropic's answer, with Ultracode where xhigh is there.
  assert.deepEqual(settings.effortsByModel['claude-opus-5-5'], ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  assert.deepEqual(settings.effortsByModel['claude-sonnet-5-5'], ['none', 'low', 'high']);
  assert.deepEqual(settings.effortsByModel['claude-haiku-5-5'], ['none']);
  // The base of a [1m] model runs on the default window, the variant on 1M.
  assert.equal(settings.contextWindowsByModel['claude-opus-5-5'], 200000);
  assert.equal(settings.contextWindowsByModel['claude-opus-5-5[1m]'], 1000000);
  assert.equal(settings.contextWindowsByModel['claude-sonnet-5-5'], 200000);
  assert.equal(service(store).contextWindowFor('Claude-Opus-5-5[1m]'), 1000000);

  const failing = async () => ({ ok: false, status: 401, text: async () => `invalid x-api-key ${TEST_KEY}`, json: async () => ({}) });
  const failed = await service(store, { env, fetchImpl: failing }).refreshModels();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'unauthorized');
  assert.equal(failed.error.includes(TEST_KEY), false);
  assert.deepEqual(failed.models, ok.models);
  assert.equal(JSON.parse(store.values.get(CLAUDE_API_MODELS_SETTING_KEY)).length, 3);

  // A list without a Claude model changes nothing.
  const none = await service(store, { env, fetchImpl: modelsFetch([{ id: 'other-vendor-model' }]) }).refreshModels();
  assert.equal(none.ok, false);
  assert.equal(JSON.parse(store.values.get(CLAUDE_API_MODELS_SETTING_KEY)).length, 3);

  // Without a key nothing is sent.
  const noKeyCalls = [];
  const noKey = await service(createStore(), { env, fetchImpl: modelsFetch(DISCOVERED, noKeyCalls) }).refreshModels();
  assert.equal(noKey.ok, false);
  assert.equal(noKeyCalls.length, 0);
});

test('discovery drops an answer for a key that was changed or removed while it ran', async () => {
  const env = { OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012' };
  // A models request that answers only when the test lets it.
  function heldFetch() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const answer = modelsFetch(DISCOVERED, calls);
    return { calls, release, fetchImpl: async (url, options) => { await gate; return answer(url, options); } };
  }

  for (const change of ['rotated', 'removed']) {
    const store = createStore();
    const held = heldFetch();
    const settings = service(store, { env, fetchImpl: held.fetchImpl });
    assert.equal(settings.update(parseClaudeApiSettingsUpdateRequest({ apiKey: TEST_KEY })).ok, true);
    const running = settings.refreshModels();
    if (change === 'rotated') assert.equal(settings.update(parseClaudeApiSettingsUpdateRequest({ apiKey: OTHER_KEY })).ok, true);
    else assert.equal(settings.update({ remove: true }).ok, true);
    held.release();
    const result = await running;
    assert.equal(held.calls[0].options.headers['x-api-key'], TEST_KEY, change);
    assert.equal(result.ok, false, change);
    assert.equal(result.stale, true, change);
    assert.equal(result.code, 'claude-api-key-changed', change);
    assert.equal(result.error.includes(TEST_KEY) || result.error.includes(OTHER_KEY), false, change);
    // Nothing was stored: the first key's models are not offered under the second, or under none.
    assert.equal(store.values.has(CLAUDE_API_MODELS_SETTING_KEY), false, change);
    assert.equal(settings.getSettings().discovered, false, change);
    assert.deepEqual(result.models, CLAUDE_SETTINGS.availableModels, change);
  }

  // The same key throughout: the answer is stored.
  const store = createStore({ [CLAUDE_API_KEY_SETTING_KEY]: TEST_KEY });
  const held = heldFetch();
  const settings = service(store, { env, fetchImpl: held.fetchImpl });
  const running = settings.refreshModels();
  settings.update(parseClaudeApiSettingsUpdateRequest({ monthlyCapUsd: 10 }));
  held.release();
  assert.equal((await running).ok, true);
  assert.equal(settings.getSettings().discovered, true);
});

test('a stored list that is not JSON or holds junk falls back to the Claude tab', () => {
  const broken = service(createStore({ [CLAUDE_API_MODELS_SETTING_KEY]: '{not json' })).getSettings();
  assert.equal(broken.discovered, false);
  assert.deepEqual(broken.availableModels, CLAUDE_SETTINGS.availableModels);
  const junk = service(createStore({ [CLAUDE_API_MODELS_SETTING_KEY]: JSON.stringify([null, 7, { id: 'gpt-5.5' }, 'claude-sonnet-5-5']) })).getSettings();
  assert.deepEqual(junk.availableModels, ['claude-sonnet-5-5']);
  const noClaude = createClaudeApiSettingsService({ ...createStore(), getClaudeProviderSettings: () => { throw new Error('no db'); } });
  assert.deepEqual(noClaude.getSettings().availableModels, []);
});
