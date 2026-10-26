import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTHROPIC_API_BASE_URL,
  ANTHROPIC_API_BASE_URL_ENV,
  AnthropicApiError,
  createAnthropicApiClient,
  mapAnthropicModel,
  resolveAnthropicApiBaseUrl,
} from './anthropic-api.mjs';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_ANTHROPIC_REFUSALS,
  startFakeAnthropicApi,
} from '../tests/fake-anthropic-api.mjs';

// An invented placeholder, short enough not to look like a real key.
const TEST_KEY = 'sk-ant-api03-test-0001';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (respond instanceof Error) throw respond;
    return typeof respond === 'function' ? respond(url, options, calls.length) : respond;
  };
  return { calls, fetchImpl };
}

test('the base URL is Anthropic unless the override names a loopback http(s) URL', () => {
  assert.equal(ANTHROPIC_API_BASE_URL_ENV, 'OAR_ANTHROPIC_API_BASE_URL');
  assert.equal(resolveAnthropicApiBaseUrl({}), 'https://api.anthropic.com');
  assert.equal(resolveAnthropicApiBaseUrl({ OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012/v1/' }), 'http://127.0.0.1:4012');
  assert.equal(resolveAnthropicApiBaseUrl({ OAR_ANTHROPIC_API_BASE_URL: 'http://localhost:4012' }), 'http://localhost:4012');
  assert.equal(resolveAnthropicApiBaseUrl({ OAR_ANTHROPIC_API_BASE_URL: 'https://[::1]:4012' }), 'https://[::1]:4012');
  for (const refused of [
    'https://api.example.com',
    'http://127.0.0.2:4012',
    'http://localhost.example.com',
    'http://dev:hunter2@127.0.0.1:4012',
    'file:///tmp/x',
    'not a url',
  ]) {
    assert.equal(resolveAnthropicApiBaseUrl({ OAR_ANTHROPIC_API_BASE_URL: refused }), ANTHROPIC_API_BASE_URL, refused);
  }
});

test('listModels sends the key, the API version and limit=1000 to the Anthropic API', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, {
    data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }],
    has_more: false,
    last_id: 'claude-sonnet-5-5',
  }));
  const client = createAnthropicApiClient({ apiKey: ` ${TEST_KEY} `, env: {}, fetchImpl });
  const models = await client.listModels();
  assert.deepEqual(models.map((model) => model.id), ['claude-sonnet-5-5']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[0].options.headers['x-api-key'], TEST_KEY);
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal('Authorization' in calls[0].options.headers, false);
  assert.ok(calls[0].options.signal);
});

test('listModels follows has_more / last_id with after_id and drops duplicates', async () => {
  const pages = [
    { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], has_more: true, last_id: 'claude-sonnet-5-5' },
    { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }, {}], has_more: true, last_id: 'claude-haiku-5-5' },
    { data: [{ id: 'claude-fable-5-1' }], has_more: false, last_id: 'claude-fable-5-1' },
  ];
  const { calls, fetchImpl } = recordingFetch((_url, _options, count) => jsonResponse(200, pages[count - 1]));
  const client = createAnthropicApiClient({ apiKey: TEST_KEY, env: { OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012' }, fetchImpl });
  const models = await client.listModels();
  assert.deepEqual(models.map((model) => model.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:4012/v1/models?limit=1000',
    'http://127.0.0.1:4012/v1/models?limit=1000&after_id=claude-sonnet-5-5',
    'http://127.0.0.1:4012/v1/models?limit=1000&after_id=claude-haiku-5-5',
  ]);
});

test('a cursor that repeats or never ends stops the walk', async () => {
  const repeating = recordingFetch(jsonResponse(200, { data: [{ id: 'claude-sonnet-5-5' }], has_more: true, last_id: 'same' }));
  await createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl: repeating.fetchImpl }).listModels();
  assert.equal(repeating.calls.length, 2);

  const endless = recordingFetch((_url, _options, count) => jsonResponse(200, { data: [], has_more: true, last_id: `page-${count}` }));
  await createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl: endless.fetchImpl }).listModels();
  assert.equal(endless.calls.length, 20);

  const noCursor = recordingFetch(jsonResponse(200, { data: [], has_more: true }));
  await createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl: noCursor.fetchImpl }).listModels();
  assert.equal(noCursor.calls.length, 1);
});

test('a model maps defensively: objects with supported, plain booleans, or nothing', () => {
  assert.deepEqual(mapAnthropicModel({
    id: 'claude-opus-5-5',
    display_name: 'Claude Opus 5.5',
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      image_input: { supported: true },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: null,
        max: { supported: false },
      },
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
    },
  }), {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    contextWindow: 1000000,
    maxOutput: 128000,
    imageInput: true,
    effort: true,
    effortLevels: ['low', 'medium', 'high'],
    thinking: true,
    thinkingTypes: ['adaptive'],
  });
  assert.deepEqual(mapAnthropicModel({
    id: 'claude-haiku-5-5',
    max_input_tokens: 'many',
    capabilities: { image_input: false, effort: false, thinking: true },
  }), {
    id: 'claude-haiku-5-5',
    displayName: 'claude-haiku-5-5',
    contextWindow: null,
    maxOutput: null,
    imageInput: false,
    effort: false,
    effortLevels: [],
    thinking: true,
    thinkingTypes: [],
  });
  assert.deepEqual(mapAnthropicModel({ id: 'claude-sonnet-5-5', capabilities: null }), {
    id: 'claude-sonnet-5-5',
    displayName: 'claude-sonnet-5-5',
    contextWindow: null,
    maxOutput: null,
    imageInput: null,
    effort: null,
    effortLevels: [],
    thinking: null,
    thinkingTypes: [],
  });
  assert.equal(mapAnthropicModel({ display_name: 'no id' }), null);
  assert.equal(mapAnthropicModel(null), null);
});

test('failures carry a code and never the key, even when the body echoes it', async () => {
  const cases = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [402, 'billing'],
    [429, 'rate_limited'],
    [529, 'transient'],
    [400, 'error'],
  ];
  for (const [status, code] of cases) {
    const body = `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ${TEST_KEY}"}}`;
    const { fetchImpl } = recordingFetch(jsonResponse(status, body));
    await assert.rejects(createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl }).listModels(), (error) => {
      assert.ok(error instanceof AnthropicApiError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message.includes(TEST_KEY), false);
      assert.match(error.message, /authentication_error: invalid x-api-key \[redacted\]/);
      return true;
    });
  }
  const network = recordingFetch(new Error(`connect failed for ${TEST_KEY}`));
  await assert.rejects(
    createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl: network.fetchImpl }).listModels(),
    (error) => error.code === 'network' && !error.message.includes(TEST_KEY),
  );
  const invalid = recordingFetch({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => '' });
  await assert.rejects(
    createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl: invalid.fetchImpl }).listModels(),
    (error) => error.code === 'invalid_response',
  );
});

test('a request that outlives the timeout is aborted and reported as such', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(
    createAnthropicApiClient({ apiKey: TEST_KEY, env: {}, fetchImpl, timeoutMs: 20 }).listModels(),
    (error) => {
      assert.equal(error.code, 'timeout');
      assert.match(error.message, /timed out after 20 ms/);
      return true;
    },
  );
});

test('nothing is sent without a key', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse(200, { data: [] }));
  await assert.rejects(createAnthropicApiClient({ apiKey: '  ', env: {}, fetchImpl }).listModels(), (error) => error.code === 'not_configured');
  assert.equal(calls.length, 0);
});

test('against the fake Anthropic API: both pages of models, then each refusal with its code and without the key', async () => {
  const refusingKeys = Object.fromEntries(Object.keys(FAKE_ANTHROPIC_REFUSALS).map((name, index) => [`${FAKE_ANTHROPIC_KEY}-r${index}`, name]));
  const fake = await startFakeAnthropicApi({ refusingKeys });
  try {
    const env = { OAR_ANTHROPIC_API_BASE_URL: fake.baseUrl };
    const models = await createAnthropicApiClient({ apiKey: FAKE_ANTHROPIC_KEY, env }).listModels();
    assert.deepEqual(models.map((model) => model.id), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001']);
    assert.equal(models[0].contextWindow, 1000000);
    assert.deepEqual(models[1].effortLevels, ['low', 'medium', 'high']);
    assert.deepEqual(fake.seen.map((call) => call.afterId), [null, 'claude-opus-5-5']);
    assert.ok(fake.seen.every((call) => call.version === '2023-06-01'));
    for (const [key, name] of Object.entries(refusingKeys)) {
      const entry = FAKE_ANTHROPIC_REFUSALS[name];
      await assert.rejects(createAnthropicApiClient({ apiKey: key, env }).listModels(), (error) => {
        assert.equal(error.code, entry.discovery, name);
        assert.equal(error.status, entry.status, name);
        assert.ok(error.message.includes(entry.body.error.message.slice(0, 40)), name);
        assert.equal(error.message.includes(key), false);
        return true;
      });
    }
  } finally {
    await fake.close();
  }
});
