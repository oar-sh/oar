import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_API_KEY_SOURCE_CODE,
  checkClaudeApiInit,
  claudeApiCliEnv,
  claudeApiFlagSettings,
  claudeApiLiveFlagSettings,
  createClaudeApiClaudeBackend,
  describeClaudeApiFailure,
} from './claude-api-backend.mjs';
import { CLAUDE_CLI_PINNED_ENV } from '../claude-worker/claude-cli-pinned-env.mjs';
import { FAKE_ANTHROPIC_REFUSALS, fakeAnthropicCliErrorText } from '../../tests/fake-anthropic-api.mjs';

// Placeholders only: no value here is a key of any account.
const KEY = 'sk-ant-api03-test-0000';

const hostEnv = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/someone',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude',
  CLAUDE_CODE_EXECUTABLE: '/opt/claude/claude',
  OAR_CLAUDE_API_KEY: KEY,
  CLAUDE_API_RELAY_MODEL: 'claude-sonnet-5',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-placeholder',
  ANTHROPIC_API_KEY: 'sk-ant-api03-test-9999',
  ANTHROPIC_AUTH_TOKEN: 'bearer-placeholder',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/elsewhere',
  ANTHROPIC_MODEL: 'claude-haiku-5',
  ANTHROPIC_CUSTOM_HEADERS: 'x-test: 1',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5',
  DEEPSEEK_API_KEY: 'sk-test-deepseek-0000',
  COPILOT_WEB_RELAY_WORKER_KIND: 'claude-api',
  CURSOR_API_KEY: 'cursor-placeholder',
  oar_lowercase_switch: 'x',
});

test('the CLI environment carries the key and the Anthropic API, and nothing foreign', () => {
  const env = claudeApiCliEnv(hostEnv, { apiKey: KEY });
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.deepEqual(Object.keys(env).filter((name) => name.startsWith('ANTHROPIC_')).sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
  for (const name of [
    'OAR_CLAUDE_API_KEY', 'CLAUDE_API_RELAY_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SUBAGENT_MODEL', 'DEEPSEEK_API_KEY',
    'COPILOT_WEB_RELAY_WORKER_KIND', 'CURSOR_API_KEY', 'oar_lowercase_switch',
  ]) {
    assert.equal(name in env, false, name);
  }
  // The host's Claude Code state directory and executable stay.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/someone/.claude');
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, '/opt/claude/claude');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/someone');
});

test('an inherited CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is dropped, and the backend never sets one', () => {
  const inherited = claudeApiCliEnv({ PATH: '/bin', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, { apiKey: KEY });
  assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in inherited, false);
  const plain = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: KEY } }).spawnEnv({ PATH: '/bin' });
  assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in plain, false);
});

test('only a loopback OAR_ANTHROPIC_API_BASE_URL replaces the Anthropic API', () => {
  const loopback = claudeApiCliEnv({ OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4567' }, { apiKey: KEY });
  assert.equal(loopback.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
  assert.equal('OAR_ANTHROPIC_API_BASE_URL' in loopback, false);
  const remote = claudeApiCliEnv({ OAR_ANTHROPIC_API_BASE_URL: 'https://api.example.com' }, { apiKey: KEY });
  assert.equal(remote.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  const backend = createClaudeApiClaudeBackend({
    env: { OAR_CLAUDE_API_KEY: KEY, OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4567' },
  });
  assert.equal(backend.spawnEnv({}).ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
  assert.equal(backend.flagSettings().env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4567');
});

test('without a key there is no CLI environment', () => {
  assert.throws(() => claudeApiCliEnv(hostEnv, { apiKey: '  ' }), /claude-api-key-not-configured/);
  const backend = createClaudeApiClaudeBackend({ env: { PATH: '/bin' } });
  assert.throws(() => backend.spawnEnv({ PATH: '/bin' }), /claude-api-key-not-configured/);
});

test('the flag settings turn hooks off, pin the base URL and blank the bearer token and the key helper, without the key', () => {
  const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: KEY } });
  assert.deepEqual(backend.flagSettings(), {
    disableAllHooks: true,
    env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: '' },
    apiKeyHelper: '',
  });
  assert.doesNotMatch(JSON.stringify(backend.flagSettings()), new RegExp(KEY));
  assert.deepEqual(claudeApiFlagSettings(' http://127.0.0.1:1 ').env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
});

test('the live flag settings pin the key as well, over a settings file\'s ANTHROPIC_API_KEY', () => {
  const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: KEY } });
  const live = backend.liveFlagSettings();
  assert.equal(live.disableAllHooks, true);
  assert.equal(live.apiKeyHelper, '');
  assert.equal(live.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(live.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(live.env.ANTHROPIC_API_KEY, KEY);
  // The command line's layer stays without it.
  assert.equal('ANTHROPIC_API_KEY' in backend.flagSettings().env, false);
  assert.equal(claudeApiLiveFlagSettings('http://127.0.0.1:1', ` ${KEY} `).env.ANTHROPIC_API_KEY, KEY);
  assert.throws(() => claudeApiLiveFlagSettings('http://127.0.0.1:1', ' '), /claude-api-key-not-configured/);
  assert.throws(() => createClaudeApiClaudeBackend({ env: { PATH: '/bin' } }).liveFlagSettings(), /claude-api-key-not-configured/);
});

test('the live flag settings hold every routing and trust variable at the CLI\'s own value, or blank it', () => {
  const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: KEY } });
  const cliEnv = backend.spawnEnv({
    ...hostEnv,
    https_proxy: 'http://127.0.0.1:3128',
    NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/test-ca.pem',
  });
  const { env } = backend.liveFlagSettings(cliEnv);
  // SSL_CERT_FILE and SSL_CERT_DIR only when the CLI has them: '' empties the
  // system store.
  const always = CLAUDE_CLI_PINNED_ENV.filter((name) => !['SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(name));
  assert.deepEqual(Object.keys(env).sort(), [...always].sort());
  // The worker's own proxy (either case) and CA hold; nothing of the host's
  // other providers, headers or credentials does.
  assert.equal(env.https_proxy, 'http://127.0.0.1:3128');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.no_proxy, 'localhost');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/test-ca.pem');
  for (const name of [
    'HTTP_PROXY', 'ALL_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN',
  ]) {
    assert.equal(env[name], '', name);
  }
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(backend.liveFlagSettings({ ...cliEnv, SSL_CERT_FILE: '/etc/ssl/cert.pem' }).env.SSL_CERT_FILE, '/etc/ssl/cert.pem');
  // The command line's layer carries only blanks besides the endpoint.
  assert.doesNotMatch(JSON.stringify(backend.flagSettings()), /127\.0\.0\.1:3128|test-ca/);
});

test('the init check lets the saved key through and stops any other source', () => {
  assert.equal(checkClaudeApiInit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }), null);
  // Not an init: nothing to check.
  assert.equal(checkClaudeApiInit({ type: 'assistant', apiKeySource: 'none' }), null);
  assert.equal(checkClaudeApiInit({ type: 'system', subtype: 'status' }), null);
  for (const source of ['apiKeyHelper', '/login managed key', 'none', 'user', 'oauth']) {
    const error = checkClaudeApiInit({ type: 'system', subtype: 'init', apiKeySource: source });
    assert.ok(error instanceof Error, source);
    assert.equal(error.code, CLAUDE_API_KEY_SOURCE_CODE);
    assert.equal(error.apiKeySource, source);
    assert.ok(error.message.includes(`"${source}"`), source);
    assert.doesNotMatch(error.message, /At most one request/);
    assert.match(error.guidance, /Settings → Providers → Claude API/);
  }
});

test('the init check never quotes a source it does not know, and says when a request may have gone out', () => {
  const unknown = checkClaudeApiInit({ type: 'system', subtype: 'init', apiKeySource: 'sk-ant-api03-test-odd-0000' });
  assert.equal(unknown.apiKeySource, null);
  assert.match(unknown.message, /a source this relay does not know/);
  assert.doesNotMatch(unknown.message, /sk-ant/);
  const missing = checkClaudeApiInit({ type: 'system', subtype: 'init' });
  assert.match(missing.message, /no source/);
  const late = checkClaudeApiInit({ type: 'system', subtype: 'init', apiKeySource: 'apiKeyHelper' }, { afterTraffic: true });
  assert.match(late.message, /At most one request may have gone out on that credential\.$/);
});

test('describeFailure names each Claude API refusal', () => {
  const cases = [
    ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', {}, 'claude-api-credit'],
    ['API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01.', {}, 'claude-api-spend-limit'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}', {}, 'claude-api-spend-limit'],
    ['API Error: 402 billing_error', {}, 'claude-api-billing'],
    ['request failed', { status: 402 }, 'claude-api-billing'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', {}, 'claude-api-key'],
    ['API Error: 403 permission_error', {}, 'claude-api-key'],
    ['request failed', { status: 401 }, 'claude-api-key'],
    ['API Error: 429 rate_limit_error', {}, 'claude-api-rate-limit'],
    ['API Error: 529 overloaded_error', {}, 'claude-api-rate-limit'],
    ['request failed', { status: 529 }, 'claude-api-rate-limit'],
  ];
  for (const [errorText, options, code] of cases) {
    const failure = describeClaudeApiFailure(errorText, options);
    assert.equal(failure?.code, code, errorText);
    assert.ok(failure.guidance.length > 0);
    assert.doesNotMatch(failure.guidance, /\[|button/i, 'plain words, no buttons');
  }
  assert.match(describeClaudeApiFailure('Your credit balance is too low').guidance, /platform\.claude\.com\/settings\/billing/);
  assert.match(describeClaudeApiFailure('API usage limits').guidance, /platform\.claude\.com\/settings\/limits/);
  assert.match(describeClaudeApiFailure('API Error: 401').guidance, /Settings → Providers → Claude API/);
  assert.equal(describeClaudeApiFailure('The folder is gone'), null);
  assert.equal(describeClaudeApiFailure(''), null);
});

test('describeFailure reads every refusal of the fake Anthropic API as the docs describe it', () => {
  for (const [name, entry] of Object.entries(FAKE_ANTHROPIC_REFUSALS)) {
    const failure = describeClaudeApiFailure(fakeAnthropicCliErrorText(name));
    assert.equal(failure?.code ?? null, entry.failure, name);
  }
});

test('describeFailure takes the key-source stop from the error the turn ended with', () => {
  const error = checkClaudeApiInit({ type: 'system', subtype: 'init', apiKeySource: 'apiKeyHelper' });
  const failure = describeClaudeApiFailure(error.message, { error });
  assert.equal(failure.code, CLAUDE_API_KEY_SOURCE_CODE);
  assert.equal(failure.guidance, error.guidance);
});

test('the backend: Claude models, no plan usage, no usage limit, no usage route', () => {
  const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: KEY } });
  assert.equal(backend.id, 'claude-api');
  assert.equal(backend.providerType, 'claude-api');
  assert.equal(backend.label, 'Claude API');
  assert.equal(backend.claudeModels, true);
  assert.equal(backend.reportsPlanUsage, false);
  assert.equal(backend.reportsUsageLimit, false);
  assert.equal(backend.usageRoute, null);
  assert.equal(backend.describeFailure, describeClaudeApiFailure);
  assert.equal(backend.checkInit, checkClaudeApiInit);
  // The model knobs the DeepSeek backend has are not there: the runner and
  // the adapter keep Claude's.
  for (const name of ['isModel', 'cliModel', 'relayModel', 'effortFor', 'effortOption', 'thinkingEnabled', 'spawnKey', 'acceptsImages', 'subagentModel']) {
    assert.equal(name in backend, false, name);
  }
  assert.equal(backend.spawnEnv(hostEnv).ANTHROPIC_API_KEY, KEY);
});
