import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeepSeekApiError,
  createDeepSeekApiClient,
  deepseekAnthropicBaseUrl,
  normalizeDeepSeekBaseUrl,
} from './deepseek-api.mjs';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  deepseekModelAcceptsImages,
  deepseekModelLabel,
  isDeepSeekModelId,
} from './deepseek-models.mjs';

const TEST_KEY = 'sk-test-0000000000000000';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url) : response;
  };
  return { calls, fetchImpl };
}

test('the base URL takes https anywhere and http only on a loopback host', () => {
  assert.deepEqual(normalizeDeepSeekBaseUrl(''), { ok: true, baseUrl: DEFAULT_DEEPSEEK_BASE_URL });
  assert.deepEqual(normalizeDeepSeekBaseUrl('  https://api.deepseek.com/  '), { ok: true, baseUrl: 'https://api.deepseek.com' });
  assert.deepEqual(normalizeDeepSeekBaseUrl('https://proxy.example.com/deepseek//'), { ok: true, baseUrl: 'https://proxy.example.com/deepseek' });
  assert.deepEqual(normalizeDeepSeekBaseUrl('http://127.0.0.1:4011'), { ok: true, baseUrl: 'http://127.0.0.1:4011' });
  assert.deepEqual(normalizeDeepSeekBaseUrl('http://localhost:4011/'), { ok: true, baseUrl: 'http://localhost:4011' });
  assert.deepEqual(normalizeDeepSeekBaseUrl('http://[::1]:4011'), { ok: true, baseUrl: 'http://[::1]:4011' });
  for (const refused of [
    'http://api.deepseek.com',
    'ftp://api.deepseek.com',
    'not a url',
    'https://dev:hunter2@proxy.example.com',
    'https://api.deepseek.com/?x=1',
    'https://api.deepseek.com/#frag',
  ]) {
    assert.equal(normalizeDeepSeekBaseUrl(refused).ok, false, refused);
  }
});

test('Claude Code is pointed at the /anthropic path of the base URL', () => {
  assert.equal(deepseekAnthropicBaseUrl(), 'https://api.deepseek.com/anthropic');
  assert.equal(deepseekAnthropicBaseUrl('http://127.0.0.1:4011/'), 'http://127.0.0.1:4011/anthropic');
  // A value that would be refused never becomes a target.
  assert.equal(deepseekAnthropicBaseUrl('http://elsewhere.example.com'), 'https://api.deepseek.com/anthropic');
});

test('listModels sends the key as a bearer token to the base URL only and returns the ids', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    object: 'list',
    data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }, { id: '' }, {}],
  }));
  const client = createDeepSeekApiClient({ baseUrl: 'https://api.deepseek.com/', apiKey: ` ${TEST_KEY} `, fetchImpl });
  assert.deepEqual(await client.listModels(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.ok(calls[0].options.signal);
});

test('getBalance turns the string amounts into numbers', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '50.00', granted_balance: '0.00', topped_up_balance: '50.00' },
      { currency: 'usd', total_balance: 'n/a', granted_balance: '1.5', topped_up_balance: '0' },
      { total_balance: '1' },
    ],
  }));
  const client = createDeepSeekApiClient({ apiKey: TEST_KEY, fetchImpl });
  assert.deepEqual(await client.getBalance(), {
    isAvailable: true,
    balances: [
      { currency: 'CNY', total: 50, granted: 0, toppedUp: 50 },
      { currency: 'USD', total: null, granted: 1.5, toppedUp: 0 },
    ],
  });
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
});

test('failures carry a code and never the key, even when the body echoes it', async () => {
  const cases = [
    [401, 'unauthorized'],
    [402, 'insufficient_balance'],
    [429, 'rate_limited'],
    [503, 'transient'],
    [422, 'error'],
  ];
  for (const [status, code] of cases) {
    const { fetchImpl } = recordingFetch(jsonResponse(status, `{"error":{"message":"bad key ${TEST_KEY}"}}`));
    const client = createDeepSeekApiClient({ apiKey: TEST_KEY, fetchImpl });
    await assert.rejects(client.listModels(), (error) => {
      assert.ok(error instanceof DeepSeekApiError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message.includes(TEST_KEY), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  }
  const network = recordingFetch(new Error(`connect failed for ${TEST_KEY}`));
  await assert.rejects(
    createDeepSeekApiClient({ apiKey: TEST_KEY, fetchImpl: network.fetchImpl }).getBalance(),
    (error) => error.code === 'network' && !error.message.includes(TEST_KEY),
  );
  const invalid = recordingFetch({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => '' });
  await assert.rejects(
    createDeepSeekApiClient({ apiKey: TEST_KEY, fetchImpl: invalid.fetchImpl }).listModels(),
    (error) => error.code === 'invalid_response',
  );
});

test('nothing is sent without a key or with a refused base URL', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, { data: [] }));
  await assert.rejects(createDeepSeekApiClient({ apiKey: '', fetchImpl }).listModels(), (error) => error.code === 'not_configured');
  await assert.rejects(
    createDeepSeekApiClient({ apiKey: TEST_KEY, baseUrl: 'http://elsewhere.example.com', fetchImpl }).listModels(),
    (error) => error.code === 'invalid_base_url',
  );
  assert.equal(calls.length, 0);
});

test('model helpers: prefix, labels and image input', () => {
  assert.equal(isDeepSeekModelId('DeepSeek-Flash'), true);
  assert.equal(isDeepSeekModelId('gpt-5.5'), false);
  assert.equal(deepseekModelLabel('deepseek-flash'), 'DeepSeek Flash');
  assert.equal(deepseekModelLabel('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(deepseekModelLabel('deepseek-v9-ultra'), 'deepseek-v9-ultra');
  assert.equal(deepseekModelAcceptsImages('deepseek-flash'), true);
  assert.equal(deepseekModelAcceptsImages('deepseek-v4-pro'), false);
  // Unknown is text-only: an image to a model that refuses it fails the turn.
  assert.equal(deepseekModelAcceptsImages('deepseek-v9-ultra'), false);
});
