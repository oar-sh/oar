import test from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_CLOUD_BASE_URL, createClaudeCloudClient } from './api-client.mjs';
import {
  CLAUDE_CLOUD_BASE_URL_ENV,
  loopbackBaseUrlOrNull,
  resolveClaudeCloudBaseUrl,
} from './base-url.mjs';

const USERINFO = 'dev:test-token-value';

test('the variable is the documented one and the default is the Anthropic API', () => {
  assert.equal(CLAUDE_CLOUD_BASE_URL_ENV, 'OAR_CLAUDE_CLOUD_API_BASE_URL');
  assert.equal(resolveClaudeCloudBaseUrl({}), CLAUDE_CLOUD_BASE_URL);
  assert.equal(resolveClaudeCloudBaseUrl(null), CLAUDE_CLOUD_BASE_URL);
  assert.equal(resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: '' }), CLAUDE_CLOUD_BASE_URL);
  assert.equal(resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: '   ' }), CLAUDE_CLOUD_BASE_URL);
});

test('a loopback URL is honoured, as its origin', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'],
    ['  http://127.0.0.1:4010/  ', 'http://127.0.0.1:4010'],
    ['http://127.0.0.1:4010/v1/code?x=1#top', 'http://127.0.0.1:4010'],
    ['http://localhost:4010', 'http://localhost:4010'],
    ['HTTP://LOCALHOST:4010', 'http://localhost:4010'],
    ['https://localhost:4443', 'https://localhost:4443'],
    ['http://[::1]:4010', 'http://[::1]:4010'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
  ]) {
    assert.equal(loopbackBaseUrlOrNull(input), expected, input);
    assert.equal(resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: input }), expected, input);
  }
});

test('any other host is ignored and the default stays', () => {
  for (const input of [
    'https://api.example.com',
    'http://192.168.1.20:4010',
    'http://10.0.0.5:4010',
    'http://0.0.0.0:4010',
    'http://127.0.0.2:4010',
    // Names that only look like loopback.
    'http://127.0.0.1.example.com:4010',
    'http://localhost.example.com:4010',
    'http://example.com.localhost:4010',
    'http://localhost.:4010',
    'http://notlocalhost:4010',
    // The loopback address as the user part, the real host behind it.
    'http://127.0.0.1@example.com:4010',
    'http://localhost:4010@example.com',
    'http://example.com:4010/?host=127.0.0.1',
    'http://example.com/127.0.0.1',
    'http://[::2]:4010',
    'http://[::ffff:192.168.1.20]:4010',
  ]) {
    assert.equal(loopbackBaseUrlOrNull(input), null, input);
    assert.equal(resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: input }), CLAUDE_CLOUD_BASE_URL, input);
  }
});

test('a fragment that names another host does not move the origin', () => {
  // The host of this URL is the loopback address; what follows the # is never sent.
  assert.equal(loopbackBaseUrlOrNull('http://127.0.0.1:4010#@example.com/'), 'http://127.0.0.1:4010');
});

test('a URL with a user or a password is refused, also on loopback', () => {
  assert.equal(loopbackBaseUrlOrNull(`http://${USERINFO}@127.0.0.1:4010`), null);
  assert.equal(loopbackBaseUrlOrNull('http://dev@localhost:4010'), null);
});

test('only http and https, and only a real URL', () => {
  for (const input of [
    'ftp://127.0.0.1:4010',
    'file:///tmp/fake-api',
    'ws://127.0.0.1:4010',
    'javascript:alert(1)',
    '127.0.0.1:4010',
    'localhost:4010',
    'localhost',
    '//127.0.0.1:4010',
    'http://',
    'not a url',
  ]) {
    assert.equal(loopbackBaseUrlOrNull(input), null, input);
  }
  for (const input of [null, undefined, 4010, {}, ['http://127.0.0.1:4010'], true]) {
    assert.equal(loopbackBaseUrlOrNull(input), null, String(input));
  }
});

test('the client built with the resolved URL calls the loopback API, and the default one Anthropic', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    return new Response(JSON.stringify({ organization: { uuid: 'org-example-0001' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const credentials = {
    getAccessToken: async () => 'test-token-value',
    redact: (text) => String(text).split('test-token-value').join('[redacted]'),
  };

  const local = createClaudeCloudClient({
    credentials,
    fetchImpl,
    baseUrl: resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: 'http://127.0.0.1:4010/' }),
  });
  await local.getOrganizationId();
  assert.equal(calls[0].url, 'http://127.0.0.1:4010/api/oauth/profile');

  // A variable that names another host changes nothing: the token goes where it always goes.
  const refused = createClaudeCloudClient({
    credentials,
    fetchImpl,
    baseUrl: resolveClaudeCloudBaseUrl({ [CLAUDE_CLOUD_BASE_URL_ENV]: 'https://api.example.com' }),
  });
  await refused.getOrganizationId();
  assert.equal(calls[1].url, `${CLAUDE_CLOUD_BASE_URL}/api/oauth/profile`);
  assert.equal(calls[1].authorization, 'Bearer test-token-value');
});
