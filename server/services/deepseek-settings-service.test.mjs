import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_API_KEY_SETTING_KEY,
  DEEPSEEK_BASE_URL_SETTING_KEY,
  DEEPSEEK_ENABLED_MODELS_SETTING_KEY,
  DEEPSEEK_MODELS_SETTING_KEY,
  DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY,
  DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY,
  DEEPSEEK_STARTING_BALANCE_SETTING_KEY,
  DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY,
  createDeepSeekSettingsService,
  parseDeepSeekSettingsUpdateRequest,
} from './deepseek-settings-service.mjs';

const TEST_KEY = 'sk-test-1111111111111111';
const OTHER_KEY = 'sk-test-2222222222222222';

function createStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
    deleteSetting: (key) => { values.delete(key); },
  };
}

function modelsFetch(ids, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: ids.map((id) => ({ id })) }),
      text: async () => '',
    };
  };
}

function service(store, extra = {}) {
  return createDeepSeekSettingsService({ ...store, now: () => new Date('2026-10-24T12:00:00Z'), ...extra });
}

test('the parser takes each field on its own and refuses bad values', () => {
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({}), { ok: false, error: 'No DeepSeek settings update provided' });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ remove: true, apiKey: TEST_KEY }), { ok: true, remove: true, enabled: false });
  // A key alone switches the provider on.
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ apiKey: ` ${TEST_KEY} ` }), { ok: true, remove: false, apiKey: TEST_KEY, enabled: true });
  assert.deepEqual(
    parseDeepSeekSettingsUpdateRequest({ apiKey: TEST_KEY, enabled: false }),
    { ok: true, remove: false, apiKey: TEST_KEY, enabled: false },
  );
  assert.equal(parseDeepSeekSettingsUpdateRequest({ model: '' }).model, 'deepseek-flash');
  assert.equal(parseDeepSeekSettingsUpdateRequest({ model: 'gpt-5.5' }).ok, false);
  assert.equal(parseDeepSeekSettingsUpdateRequest({ model: 'deepseek-flash; rm -rf' }).ok, false);
  assert.deepEqual(
    parseDeepSeekSettingsUpdateRequest({ enabledModels: ['deepseek-v4-pro', 'gpt-5.5', 'deepseek-v4-pro'] }).enabledModels,
    ['deepseek-v4-pro'],
  );
  assert.equal(parseDeepSeekSettingsUpdateRequest({ baseUrl: 'http://api.example.com' }).ok, false);
  assert.equal(parseDeepSeekSettingsUpdateRequest({ baseUrl: 'http://127.0.0.1:4011/' }).baseUrl, 'http://127.0.0.1:4011');
  assert.equal(parseDeepSeekSettingsUpdateRequest({ baseUrl: null }).baseUrl, 'https://api.deepseek.com');
  assert.equal(parseDeepSeekSettingsUpdateRequest({ attribution: 'vanilla' }).ok, false);
  assert.equal(parseDeepSeekSettingsUpdateRequest({ attribution: 'OFF' }).attribution, 'off');
  assert.equal(parseDeepSeekSettingsUpdateRequest({ enabled: 'yes' }).ok, false);
  // A malformed key is refused without being quoted back.
  const badKey = parseDeepSeekSettingsUpdateRequest({ apiKey: 'sk short' });
  assert.equal(badKey.ok, false);
  assert.equal(badKey.error.includes('sk short'), false);
});

test('an empty relay: off, flash by default, the built-in models, the default endpoint', () => {
  const settings = service(createStore()).getSettings();
  assert.equal(settings.configured, false);
  assert.equal(settings.enabled, false);
  assert.equal(settings.model, 'deepseek-flash');
  assert.deepEqual(settings.availableModels, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(settings.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(settings.baseUrl, 'https://api.deepseek.com');
  assert.equal(settings.attribution, 'oar');
  assert.deepEqual(settings.efforts, ['low', 'high', 'max']);
  assert.equal(settings.providerType, 'deepseek');
});

test('saving a key stores it, switches the provider on and asks for discovery; describe never shows it', () => {
  const store = createStore();
  const settings = service(store);
  const result = settings.update(parseDeepSeekSettingsUpdateRequest({ apiKey: TEST_KEY }));
  assert.equal(result.ok, true);
  assert.equal(result.discover, true);
  // Nothing was running on an earlier key.
  assert.equal(result.keyChanged, false);
  assert.equal(store.values.get(DEEPSEEK_API_KEY_SETTING_KEY), TEST_KEY);
  assert.equal(settings.getSettings().enabled, true);
  const described = settings.describe();
  assert.equal(described.configured, true);
  assert.equal('apiKey' in described, false);
  assert.equal(JSON.stringify(described).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test('a rotated key is reported so the live workers can be stopped, and drops the discovered list', () => {
  const store = createStore({
    [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY,
    [DEEPSEEK_MODELS_SETTING_KEY]: JSON.stringify(['deepseek-flash']),
  });
  const result = service(store).update(parseDeepSeekSettingsUpdateRequest({ apiKey: OTHER_KEY }));
  assert.equal(result.keyChanged, true);
  assert.equal(result.discover, true);
  assert.equal(store.values.has(DEEPSEEK_MODELS_SETTING_KEY), false);
  // The same key again is no rotation.
  const again = service(store).update(parseDeepSeekSettingsUpdateRequest({ apiKey: OTHER_KEY }));
  assert.equal(again.keyChanged, false);
});

test('switching on without a key is refused', () => {
  const result = service(createStore()).update(parseDeepSeekSettingsUpdateRequest({ enabled: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test('the base URL is stored only when it is not the default', () => {
  const store = createStore({ [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY });
  service(store).update(parseDeepSeekSettingsUpdateRequest({ baseUrl: 'http://127.0.0.1:4011' }));
  assert.equal(store.values.get(DEEPSEEK_BASE_URL_SETTING_KEY), 'http://127.0.0.1:4011');
  assert.equal(service(store).getSettings().baseUrl, 'http://127.0.0.1:4011');
  service(store).update(parseDeepSeekSettingsUpdateRequest({ baseUrl: 'https://api.deepseek.com/' }));
  assert.equal(store.values.has(DEEPSEEK_BASE_URL_SETTING_KEY), false);
  // A value that would be refused today is not used even if it is stored.
  store.values.set(DEEPSEEK_BASE_URL_SETTING_KEY, 'http://elsewhere.example.com');
  assert.equal(service(store).getSettings().baseUrl, 'https://api.deepseek.com');
});

test('the composer list keeps the default model and only models that are offered', () => {
  const store = createStore({
    [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY,
    [DEEPSEEK_MODELS_SETTING_KEY]: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-preview']),
  });
  const settings = service(store);
  settings.update(parseDeepSeekSettingsUpdateRequest({ model: 'deepseek-v4-pro', enabledModels: ['deepseek-v5-preview', 'deepseek-retired'] }));
  assert.deepEqual(JSON.parse(store.values.get(DEEPSEEK_ENABLED_MODELS_SETTING_KEY)), ['deepseek-v5-preview', 'deepseek-retired']);
  const current = settings.getSettings();
  assert.equal(current.model, 'deepseek-v4-pro');
  assert.deepEqual(current.models, ['deepseek-v4-pro', 'deepseek-v5-preview']);
  // An empty choice means every offered model.
  settings.update(parseDeepSeekSettingsUpdateRequest({ enabledModels: [] }));
  assert.deepEqual(settings.getSettings().models, ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v5-preview']);
});

test('the key cannot be removed while a DeepSeek conversation has a message or a queued one', () => {
  const store = createStore({ [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY });
  const rows = [
    { provider_type: 'deepseek', message_count: 2, active_queue_count: 0 },
    { provider_type: 'DeepSeek', message_count: 0, active_queue_count: 1 },
    { provider_type: 'deepseek', message_count: 0, active_queue_count: 0 },
    { provider_type: 'cursor', message_count: 9, active_queue_count: 9 },
  ];
  const blocked = service(store, { listProviderCandidates: () => rows }).update({ remove: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'deepseek-key-removal-blocked');
  assert.equal(blocked.activeConversationCount, 2);
  assert.equal(blocked.startedConversationCount, 1);
  assert.equal(blocked.activeQueueConversationCount, 1);
  assert.equal(store.values.get(DEEPSEEK_API_KEY_SETTING_KEY), TEST_KEY);

  const removed = service(store, { listProviderCandidates: () => rows.slice(2) }).update({ remove: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.keyChanged, true);
  assert.equal(store.values.has(DEEPSEEK_API_KEY_SETTING_KEY), false);
  assert.equal(service(store).getSettings().enabled, false);
});

test('discovery stores the DeepSeek ids it is given and keeps the old list on failure', async () => {
  const calls = [];
  const store = createStore({
    [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY,
    [DEEPSEEK_BASE_URL_SETTING_KEY]: 'http://127.0.0.1:4011',
  });
  const ok = await service(store, { fetchImpl: modelsFetch(['deepseek-flash', 'deepseek-v4-pro', 'other-vendor-model'], calls) }).refreshModels();
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(calls[0].url, 'http://127.0.0.1:4011/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TEST_KEY}`);

  const failing = async () => ({ ok: false, status: 401, text: async () => `invalid key ${TEST_KEY}`, json: async () => ({}) });
  const failed = await service(store, { fetchImpl: failing }).refreshModels();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'unauthorized');
  assert.equal(failed.error.includes(TEST_KEY), false);
  assert.deepEqual(failed.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(JSON.parse(store.values.get(DEEPSEEK_MODELS_SETTING_KEY)), ['deepseek-flash', 'deepseek-v4-pro']);

  // An endpoint that lists nothing of DeepSeek's changes nothing.
  const none = await service(store, { fetchImpl: modelsFetch(['other-vendor-model']) }).refreshModels();
  assert.equal(none.ok, false);

  // Without a key nothing is sent.
  const noKeyCalls = [];
  const noKey = await service(createStore(), { fetchImpl: modelsFetch(['deepseek-flash'], noKeyCalls) }).refreshModels();
  assert.equal(noKey.ok, false);
  assert.equal(noKeyCalls.length, 0);
});

test('the monthly budget is an amount of its own: stored when set, cleared when empty or zero, never a bad value', () => {
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '12.5' }), { ok: true, remove: false, monthlyBudget: 12.5 });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: 20 }), { ok: true, remove: false, monthlyBudget: 20 });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: 0.004 }), { ok: true, remove: false, monthlyBudget: null });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '' }), { ok: true, remove: false, monthlyBudget: null });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: null }), { ok: true, remove: false, monthlyBudget: null });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: 0 }), { ok: true, remove: false, monthlyBudget: null });
  for (const bad of [-1, 'ten', '1e12', Infinity, {}, true]) {
    assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: bad }), { ok: false, error: 'monthlyBudget must be an amount of zero or more, or empty' }, String(bad));
  }

  const store = createStore({ [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY });
  assert.equal(service(store).getSettings().monthlyBudget, null);
  assert.equal(service(store).describe().monthlyBudget, null);
  const result = service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '12.5' }));
  assert.equal(result.ok, true);
  assert.equal(store.values.get(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY), '12.5');
  assert.equal(result.settings.monthlyBudget, 12.5);
  // Saving the other fields leaves the budget alone; the budget changes neither key nor discovery.
  service(store).update(parseDeepSeekSettingsUpdateRequest({ attribution: 'off' }));
  assert.equal(service(store).describe().monthlyBudget, 12.5);
  assert.equal(result.keyChanged, false);
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '' }));
  assert.equal(store.values.has(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY), false);
  assert.equal(service(store).describe().monthlyBudget, null);
  // A stored value that would be refused today is read as no budget.
  store.values.set(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY, '-5');
  assert.equal(service(store).getSettings().monthlyBudget, null);
});

test('the budget keeps its currency: USD or CNY stored with it, empty for the balance\'s, gone with the budget', () => {
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: 20, monthlyBudgetCurrency: 'cny' }), { ok: true, remove: false, monthlyBudget: 20, monthlyBudgetCurrency: 'CNY' });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: ' USD ' }), { ok: true, remove: false, monthlyBudgetCurrency: 'USD' });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: '' }), { ok: true, remove: false, monthlyBudgetCurrency: null });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: null }), { ok: true, remove: false, monthlyBudgetCurrency: null });
  for (const bad of ['EUR', 'yuan', 1, true, {}]) {
    assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: bad }), { ok: false, error: 'monthlyBudgetCurrency must be "USD", "CNY" or empty' }, String(bad));
  }

  const store = createStore({ [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY });
  // No budget: no currency, whatever was asked.
  assert.equal(service(store).describe().monthlyBudgetCurrency, null);
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: 'CNY' }));
  assert.equal(service(store).describe().monthlyBudgetCurrency, null);
  // A budget with its currency; the amount alone leaves the currency as it is.
  const result = service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '12.5', monthlyBudgetCurrency: 'cny' }));
  assert.equal(result.ok, true);
  assert.equal(store.values.get(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY), 'CNY');
  assert.deepEqual([result.settings.monthlyBudget, result.settings.monthlyBudgetCurrency], [12.5, 'CNY']);
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: 30 }));
  assert.deepEqual([service(store).describe().monthlyBudget, service(store).describe().monthlyBudgetCurrency], [30, 'CNY']);
  // Back to the balance's currency on request.
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: '' }));
  assert.equal(store.values.has(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY), false);
  assert.equal(service(store).describe().monthlyBudgetCurrency, null);
  // Clearing the budget clears the currency too, even when one is sent along.
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudgetCurrency: 'USD' }));
  assert.equal(service(store).describe().monthlyBudgetCurrency, 'USD');
  service(store).update(parseDeepSeekSettingsUpdateRequest({ monthlyBudget: '', monthlyBudgetCurrency: 'USD' }));
  assert.equal(store.values.has(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY), false);
  assert.equal(store.values.has(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY), false);
  // A budget saved before the currency was stored reads as none: the card uses the balance's.
  store.values.set(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY, '8');
  assert.deepEqual([service(store).getSettings().monthlyBudget, service(store).getSettings().monthlyBudgetCurrency], [8, null]);
  // A stored currency that would be refused today is read as none.
  store.values.set(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY, 'EUR');
  assert.equal(service(store).getSettings().monthlyBudgetCurrency, null);
});

test('the starting balance is stored with the time it was set; saved again unchanged it keeps that time, unless a top-up replaced it', () => {
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ startingBalance: '50' }), { ok: true, remove: false, startingBalance: 50 });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ startingBalance: '' }), { ok: true, remove: false, startingBalance: null });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ startingBalance: -1 }), { ok: false, error: 'startingBalance must be an amount of zero or more, or empty' });
  // The flag goes with the field only, and is a boolean.
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ startingBalance: 50, startingBalanceEdited: true }), { ok: true, remove: false, startingBalance: 50, startingBalanceEdited: true });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ attribution: 'off', startingBalanceEdited: true }), { ok: true, remove: false, attribution: 'off' });
  assert.deepEqual(parseDeepSeekSettingsUpdateRequest({ startingBalance: 50, startingBalanceEdited: 'yes' }), { ok: false, error: 'startingBalanceEdited must be true or false' });
  const store = createStore({ [DEEPSEEK_API_KEY_SETTING_KEY]: TEST_KEY });
  let clock = new Date('2026-10-25T08:00:00Z');
  const at = () => createDeepSeekSettingsService({ ...store, now: () => clock });
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [null, null]);
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: '50' }));
  assert.equal(store.values.get(DEEPSEEK_STARTING_BALANCE_SETTING_KEY), '50');
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [50, '2026-10-25T08:00:00.000Z']);
  // The tab saves every field at once: the same amount keeps its time.
  clock = new Date('2026-10-26T08:00:00Z');
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 50, attribution: 'off' }));
  assert.equal(at().describe().startingBalanceSetAt, '2026-10-25T08:00:00.000Z');
  // Another amount is set anew.
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 60 }));
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [60, '2026-10-26T08:00:00.000Z']);
  // Once a top-up has replaced it, the same amount saved again without the
  // field typed in (a Save of another field, or a tab opened before the
  // top-up was seen) leaves it replaced; typed in again, it is set anew and
  // applies again; saved again while it applies, it keeps that time.
  clock = new Date('2026-10-28T08:00:00Z');
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 60, monthlyBudget: 25 }), { startingBalanceReplaced: true });
  assert.equal(at().describe().startingBalanceSetAt, '2026-10-26T08:00:00.000Z');
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 60, startingBalanceEdited: false }), { startingBalanceReplaced: true });
  assert.equal(at().describe().startingBalanceSetAt, '2026-10-26T08:00:00.000Z');
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 60, startingBalanceEdited: true }), { startingBalanceReplaced: true });
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [60, '2026-10-28T08:00:00.000Z']);
  clock = new Date('2026-10-29T08:00:00Z');
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 60, startingBalanceEdited: true }), { startingBalanceReplaced: false });
  assert.equal(at().describe().startingBalanceSetAt, '2026-10-28T08:00:00.000Z');
  // Another amount needs no flag.
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: 70 }), { startingBalanceReplaced: true });
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [70, '2026-10-29T08:00:00.000Z']);
  // A save without the field leaves it as it is, replaced or not.
  at().update(parseDeepSeekSettingsUpdateRequest({ attribution: 'off' }), { startingBalanceReplaced: true });
  assert.equal(at().describe().startingBalanceSetAt, '2026-10-29T08:00:00.000Z');
  // Empty clears both.
  at().update(parseDeepSeekSettingsUpdateRequest({ startingBalance: null }));
  assert.equal(store.values.has(DEEPSEEK_STARTING_BALANCE_SETTING_KEY), false);
  assert.equal(store.values.has(DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY), false);
  assert.deepEqual([at().describe().startingBalance, at().describe().startingBalanceSetAt], [null, null]);
});
