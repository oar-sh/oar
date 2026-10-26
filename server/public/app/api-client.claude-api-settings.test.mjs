import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { switchConversationBilling, updateClaudeApiSettings } = await import('./api-client.js');

// Invented, and not shaped like an Anthropic key.
const TEST_KEY = 'test-console-key-0000000000000000';

// What updateClaudeApiSettings posts for `input`.
async function posted(input) {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    bodies.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await updateClaudeApiSettings(input);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].url, /\/api\/settings\/claude-api$/);
  return bodies[0].body;
}

test('the Claude API tab\'s Save sends every field the tab shows', async () => {
  // As saveClaudeApiSettings builds it.
  const tab = { apiKey: TEST_KEY, model: 'claude-sonnet-5-5', monthlyCapUsd: 25.5, enabled: true };
  assert.deepEqual(await posted(tab), tab);
  // No key typed (one is saved) and an emptied cap: the key is left out,
  // the cap goes as null (no cap).
  assert.deepEqual(
    await posted({ ...tab, apiKey: '', monthlyCapUsd: null }),
    { model: 'claude-sonnet-5-5', monthlyCapUsd: null, enabled: true },
  );
});

test('the switch, the model picker and Remove send only their own field', async () => {
  assert.deepEqual(await posted({ enabled: false }), { enabled: false });
  assert.deepEqual(await posted({ enabledModels: ['claude-sonnet-5-5', 'claude-opus-5-5[1m]'] }), { enabledModels: ['claude-sonnet-5-5', 'claude-opus-5-5[1m]'] });
  assert.deepEqual(await posted({ remove: true, apiKey: TEST_KEY, monthlyCapUsd: 5 }), { remove: true });
  // A cap that is not a number is not sent at all.
  assert.deepEqual(await posted({ enabled: true, monthlyCapUsd: Number.NaN }), { enabled: true });
});

test('a refused save throws the relay\'s reason, never the key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'This is a Claude OAuth access token, not an API key.', code: 'claude-api-key-oauth-access-token' }),
  });
  try {
    await assert.rejects(
      () => updateClaudeApiSettings({ apiKey: TEST_KEY }),
      (error) => {
        assert.match(error.message, /not an API key/);
        assert.doesNotMatch(error.message, new RegExp(TEST_KEY));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('the billing switch posts the target and answers a refusal with its code', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: 'Claude API has no key.', code: 'CLAUDE_API_NOT_CONFIGURED' }),
    };
  };
  try {
    const result = await switchConversationBilling('conv-1', { to: 'claude-api' });
    assert.match(calls[0].url, /\/api\/conversation\/conv-1\/billing$/);
    assert.deepEqual(calls[0].body, { to: 'claude-api', by: 'user' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CLAUDE_API_NOT_CONFIGURED');
    assert.match(result.error, /no key/);
  } finally {
    globalThis.fetch = original;
  }
});
