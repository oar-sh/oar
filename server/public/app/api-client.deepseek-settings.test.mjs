import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { updateDeepSeekSettings } = await import('./api-client.js');

const TEST_KEY = 'sk-test-0000000000000000';

// What updateDeepSeekSettings posts for `input`.
async function posted(input) {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    bodies.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await updateDeepSeekSettings(input);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].url, /\/api\/settings\/deepseek$/);
  return bodies[0].body;
}

test('the DeepSeek tab\'s Save sends every field the tab shows', async () => {
  // As saveDeepSeekSettings builds it.
  const tab = {
    apiKey: TEST_KEY,
    model: 'deepseek-v4-pro',
    attribution: 'off',
    baseUrl: 'https://api.example.test',
    monthlyBudget: 20,
    monthlyBudgetCurrency: 'USD',
    startingBalance: 50,
    startingBalanceEdited: true,
    enabled: true,
  };
  assert.deepEqual(await posted(tab), tab);
  // Emptied fields go as null: no budget, the balance's currency, no
  // starting balance, DeepSeek's own endpoint.
  assert.deepEqual(
    await posted({ ...tab, apiKey: '', baseUrl: null, monthlyBudget: null, monthlyBudgetCurrency: null, startingBalance: null, startingBalanceEdited: false }),
    { model: 'deepseek-v4-pro', attribution: 'off', baseUrl: null, monthlyBudget: null, monthlyBudgetCurrency: null, startingBalance: null, startingBalanceEdited: false, enabled: true },
  );
  assert.equal((await posted({ monthlyBudgetCurrency: 'CNY' })).monthlyBudgetCurrency, 'CNY');
  assert.equal((await posted({ monthlyBudgetCurrency: '' })).monthlyBudgetCurrency, null);
});

test('the switch, the model picker and Remove send only their own field', async () => {
  assert.deepEqual(await posted({ enabled: false }), { enabled: false });
  assert.deepEqual(await posted({ enabledModels: ['deepseek-flash'] }), { enabledModels: ['deepseek-flash'] });
  assert.deepEqual(await posted({ remove: true, monthlyBudgetCurrency: 'USD' }), { remove: true });
});
