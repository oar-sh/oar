import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_CLI_PINNED_ENV,
  createDeepSeekClaudeBackend,
  deepseekCliModel,
  deepseekPinnedEnv,
  deepseekRelayModel,
  describeDeepSeekFailure,
} from './deepseek-claude-backend.mjs';
import { createClaudeTurnPublisher } from '../claude-worker/claude-turn-publisher.mjs';

const TEST_KEY = 'sk-test-5555555555555555';
const WORKER_ENV = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/home/dev',
  DEEPSEEK_API_KEY: TEST_KEY,
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:4011',
  DEEPSEEK_CLAUDE_CONFIG_DIR: '/srv/oar/data/deepseek-claude',
});

test('the CLI is pointed at DeepSeek with the key as its bearer token and a state directory of its own', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  const env = backend.spawnEnv({
    ...WORKER_ENV,
    BASH_DEFAULT_TIMEOUT_MS: '7200000',
    // What the host may carry, none of which may reach a CLI talking to DeepSeek.
    ANTHROPIC_API_KEY: 'sk-ant-host-key',
    ANTHROPIC_AUTH_TOKEN: 'host-token',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_MODEL: 'claude-opus-5',
    CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_GATEWAY: '1',
    CLAUDE_CODE_USE_MANTLE: '1',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
    CLAUDE_CONFIG_DIR: '/home/dev/.claude',
    // A relay started from inside a Claude Code session: the CLI must not read
    // itself as a child of that session.
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'host-session-0000',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host-claude.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'host-messaging-token',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_EXECPATH: '/opt/claude/claude',
    CLAUDE_PID: '4321',
    CLAUDE_EFFORT: 'max',
    // The relay's bound CLI binary is configuration, not a session marker.
    CLAUDE_CODE_EXECUTABLE: '/srv/oar/bin/claude',
  }, { effort: 'high', model: 'deepseek-v4-pro' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4011/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, TEST_KEY);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]', 'the host\'s Claude model is replaced by the session\'s');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/srv/oar/data/deepseek-claude');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '7200000');
  assert.equal(env.PATH, '/usr/bin');
  for (const key of [
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_GATEWAY',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'DEEPSEEK_API_KEY',
    'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_PID', 'CLAUDE_EFFORT',
  ]) {
    assert.equal(key in env, false, key);
  }
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, '/srv/oar/bin/claude');
  const serialized = JSON.stringify(env);
  for (const secret of ['sk-ant-host-key', 'host-token', 'host-oauth-token', 'host-messaging-token', 'host-session-0000']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('the CLI gets none of the relay\'s settings for its worker, and no host session variable a fixed list would miss', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  // What a Windows worker without tmux had in the live check (names only),
  // and the rest of what the launcher hands a worker.
  const relayInternal = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek',
    COPILOT_ALLOW_ALL: 'true',
    COPILOT_WEB_RELAY_TOOLS: '/srv/oar/server/relay-tools.md',
    COPILOT_WEB_RELAY_SERVER_DIR: '/srv/oar/server',
    COPILOT_WEB_RELAY_ROOT: '/srv/oar',
    COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
    COPILOT_WEB_RELAY_LOG_DIR: '/srv/oar/server/logs',
    COPILOT_WEB_RELAY_DATA_DIR: '/srv/oar/data',
    COPILOT_WEB_RELAY_WORKER_LOG_FILE: '/srv/oar/server/logs/worker-session-3.log',
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
    COPILOT_SDK_PATH: '/srv/oar/node_modules/@github/copilot-sdk',
    EXTENSION_PATH: '/srv/oar/.github/extensions/web-relay/extension.mjs',
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_MODEL: 'gpt-5.4',
    COPILOT_RELAY_MODEL: 'gpt-5.4',
    DEEPSEEK_RELAY_MODEL: 'deepseek-flash',
    CLAUDE_RELAY_MODEL: 'claude-opus-5',
    GROK_CLI_COMMAND: 'grok',
    OAR_MCP_SERVER: '1',
    OAR_TURN_STALL_IDLE_MS: '1000',
    SESSION_ID: 'session-3',
    COPILOT_WORKSPACE_ROOT: '/workspace',
    INIT_CWD: '/srv/oar',
  };
  const hostSession = {
    CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: '120000',
    CLAUDE_AGENT_SDK_VERSION: '0.0.0',
    CLAUDE_CODE_HOST_SESSION_ID: 'host-session-0001',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'host-access-token',
  };
  const env = backend.spawnEnv({
    ...WORKER_ENV,
    ...relayInternal,
    ...hostSession,
    // What the CLI and the agent's commands do read stays.
    CLAUDE_CODE_GIT_BASH_PATH: '/opt/git/bin/bash',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
    CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS: '1',
    CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT: '1',
    CLAUDE_CODE_SESSION_LOG: '/tmp/claude-session.log',
    GH_TOKEN: 'gh-test-token',
    LANG: 'C.UTF-8',
  });
  for (const key of [...Object.keys(relayInternal), ...Object.keys(hostSession)]) assert.equal(key in env, false, key);
  for (const key of [
    'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS',
    'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS', 'CLAUDE_AGENT_SDK_MCP_NO_PREFIX', 'CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS',
    'CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT', 'CLAUDE_CODE_SESSION_LOG', 'GH_TOKEN', 'LANG', 'PATH', 'HOME',
  ]) {
    assert.ok(key in env, key);
  }
  assert.equal(JSON.stringify(env).includes('host-access-token'), false);
});

test('every model alias is pinned to the session\'s model, the helper alias to flash, so no sub-agent leaves the locked model', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  const env = backend.spawnEnv({
    ...WORKER_ENV,
    // The host's own pins and sub-agent settings must not reach the CLI.
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5-20251001',
    CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5',
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: 'claude-sonnet-5-5',
  }, { model: 'deepseek-flash' });
  // What Claude Code reads when the Agent tool asks for "opus", "sonnet" or
  // "fable", for a sub-agent or workflow agent without a model, and as the
  // session's own model: all the locked model, with the CLI's 1M suffix.
  for (const key of [
    'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  ]) {
    assert.equal(env[key], 'deepseek-flash[1m]', key);
  }
  // "haiku" and the small helper calls stay on flash; the force switch, which
  // would move them onto the session's model too, is not set.
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-flash');
  assert.equal('CLAUDE_CODE_SUBAGENT_MODEL_FORCE' in env, false);
  // The pin follows the session's model; the CLI's own spelling is accepted.
  assert.equal(backend.spawnEnv(WORKER_ENV, { model: 'deepseek-v4-pro[1m]' }).ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]');
  // No model, or one that is not DeepSeek's: the default model, never a Claude id.
  assert.equal(backend.spawnEnv(WORKER_ENV).ANTHROPIC_MODEL, 'deepseek-flash[1m]');
  assert.equal(backend.spawnEnv(WORKER_ENV, { model: 'opus' }).CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash[1m]');
  // A model change respawns the CLI like an effort change; a spelling change does not.
  assert.notEqual(backend.spawnKey({ reasoningEffort: 'high' }, { model: 'deepseek-flash' }), backend.spawnKey({ reasoningEffort: 'high' }, { model: 'deepseek-v4-pro' }));
  assert.equal(backend.spawnKey({ reasoningEffort: 'high' }, { model: 'deepseek-flash' }), backend.spawnKey({ reasoningEffort: 'medium' }, { model: 'deepseek-flash[1m]' }));
  assert.equal(backend.spawnKey({ reasoningEffort: 'high' }, { model: '' }), backend.spawnKey({ reasoningEffort: 'high' }, { model: 'deepseek-flash' }));
});

test('a Claude model id the CLI names is read as the DeepSeek model that served it', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  // DeepSeek's Anthropic endpoint runs claude-opus* on V4 Pro and the Sonnet
  // and Haiku ids on Flash: a usage report or a badge naming them means those.
  assert.equal(backend.relayModel('claude-opus-5-5'), 'deepseek-v4-pro');
  assert.equal(backend.relayModel('claude-opus-4-8[1m]'), 'deepseek-v4-pro');
  assert.equal(backend.relayModel('claude-sonnet-5-5'), 'deepseek-flash');
  assert.equal(backend.relayModel('claude-haiku-4-5-20251001'), 'deepseek-flash');
  assert.equal(backend.relayModel('deepseek-v4-pro[1m]'), 'deepseek-v4-pro');
  // Unknown names pass as they are, without the suffix.
  assert.equal(backend.relayModel('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(backend.relayModel('gpt-5[1m]'), 'gpt-5');
  // A Claude id is still not a model to request from DeepSeek.
  assert.equal(backend.isModel('claude-opus-5-5'), false);
  assert.equal(backend.acceptsImages('claude-sonnet-5-5'), true);
  // A sub-agent's badge: its frames' model, else the spawn's alias ("haiku"
  // is the helper, any other alias the session's model), else the session's.
  assert.equal(backend.subagentModel('claude-opus-5-5', 'deepseek-flash'), 'deepseek-v4-pro');
  assert.equal(backend.subagentModel('deepseek-flash[1m]', 'deepseek-v4-pro'), 'deepseek-flash');
  assert.equal(backend.subagentModel('opus', 'deepseek-flash'), 'deepseek-flash');
  assert.equal(backend.subagentModel('sonnet', 'deepseek-v4-pro[1m]'), 'deepseek-v4-pro');
  assert.equal(backend.subagentModel('haiku', 'deepseek-v4-pro'), 'deepseek-flash');
  assert.equal(backend.subagentModel('', 'deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(backend.subagentModel('opus', ''), '');
});

test('a subprocess env scrub the host exports does not reach the CLI, so plan mode and the agent\'s Bash stay as they are', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  // Claude Code forces the permission mode to default when it is set, and
  // runs every Bash command in a bubblewrap sandbox.
  const env = backend.spawnEnv({ ...WORKER_ENV, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, { effort: 'high' });
  assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in env, false);
  assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in backend.spawnEnv(WORKER_ENV), false);
});

test('the default endpoint is DeepSeek\'s own', () => {
  const backend = createDeepSeekClaudeBackend({ env: { ...WORKER_ENV, DEEPSEEK_BASE_URL: '' } });
  assert.equal(backend.spawnEnv(WORKER_ENV).ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

test('the endpoint and the key are pinned again in the CLI\'s flag layer, the other credentials blanked, over the folder\'s settings', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  const live = backend.liveFlagSettings(backend.spawnEnv(WORKER_ENV));
  assert.deepEqual(Object.keys(live).sort(), ['apiKeyHelper', 'env']);
  assert.equal(live.apiKeyHelper, '');
  assert.equal(live.env.ANTHROPIC_BASE_URL, backend.spawnEnv(WORKER_ENV).ANTHROPIC_BASE_URL);
  assert.match(live.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:4011\//);
  assert.equal(live.env.ANTHROPIC_AUTH_TOKEN, TEST_KEY);
  // Every pin is there, and nothing else: the worker sets none of the others,
  // so each is blanked, but for the two whose blank is not unset.
  assert.deepEqual(
    Object.keys(live.env).sort(),
    DEEPSEEK_CLI_PINNED_ENV.filter((name) => !['SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(name)).sort(),
  );
  for (const [name, value] of Object.entries(live.env)) {
    if (name !== 'ANTHROPIC_BASE_URL' && name !== 'ANTHROPIC_AUTH_TOKEN') assert.equal(value, '', name);
  }
  // Called without the CLI's environment it builds it from the worker's.
  assert.deepEqual(backend.liveFlagSettings(), live);
  // The key never goes on the command line: no argv flag settings of its own.
  assert.equal(typeof backend.flagSettings, 'undefined');
});

test('the pinned names cover the routing, trust and credential variables, and the list is frozen', () => {
  assert.equal(Object.isFrozen(DEEPSEEK_CLI_PINNED_ENV), true);
  assert.equal(new Set(DEEPSEEK_CLI_PINNED_ENV).size, DEEPSEEK_CLI_PINNED_ENV.length);
  for (const name of [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_GATEWAY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY',
    'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CERT_STORE', 'SSL_CERT_FILE',
  ]) assert.ok(DEEPSEEK_CLI_PINNED_ENV.includes(name), name);
  // Left to the folder: the model choice, and NODE_OPTIONS (see the list).
  for (const name of ['ANTHROPIC_MODEL', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR']) assert.equal(DEEPSEEK_CLI_PINNED_ENV.includes(name), false, name);
});

test('a pin holds the CLI\'s own value: the worker\'s proxy and CA, a proxy in the other case, SSL_CERT_* only when set', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  const cliEnv = backend.spawnEnv({
    ...WORKER_ENV,
    https_proxy: 'http://127.0.0.1:3128',
    NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/worker-ca.pem',
    SSL_CERT_DIR: '/etc/ssl/certs',
    NODE_OPTIONS: '--max-old-space-size=512',
    // The host's provider switch does not reach the CLI, so it is blanked.
    CLAUDE_CODE_USE_MANTLE: '1',
  });
  assert.equal('CLAUDE_CODE_USE_MANTLE' in cliEnv, false);
  const { env } = backend.liveFlagSettings(cliEnv);
  assert.equal(env.https_proxy, 'http://127.0.0.1:3128');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.no_proxy, 'localhost');
  assert.equal(env.HTTP_PROXY, '');
  assert.equal(env.ALL_PROXY, '');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/worker-ca.pem');
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '');
  assert.equal(env.SSL_CERT_DIR, '/etc/ssl/certs');
  assert.equal('SSL_CERT_FILE' in env, false);
  assert.equal(env.CLAUDE_CODE_USE_MANTLE, '');
  assert.equal('NODE_OPTIONS' in env, false);
  // An ANTHROPIC_* of the worker's never becomes a pin: spawnEnv drops it.
  assert.equal(backend.liveFlagSettings({ ...cliEnv, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }).env.ANTHROPIC_BASE_URL, cliEnv.ANTHROPIC_BASE_URL);
  assert.deepEqual(deepseekPinnedEnv({ http_proxy: 'http://127.0.0.1:1' }).HTTP_PROXY, 'http://127.0.0.1:1');
});

test('without its key or state directory the backend refuses to build a CLI environment', () => {
  assert.throws(() => createDeepSeekClaudeBackend({ env: { ...WORKER_ENV, DEEPSEEK_API_KEY: '' } }).spawnEnv({}), /deepseek-api-key-not-configured/);
  assert.throws(() => createDeepSeekClaudeBackend({ env: { ...WORKER_ENV, DEEPSEEK_API_KEY: '' } }).liveFlagSettings(), /deepseek-api-key-not-configured/);
  assert.throws(
    () => createDeepSeekClaudeBackend({ env: { ...WORKER_ENV, DEEPSEEK_CLAUDE_CONFIG_DIR: '' } }).spawnEnv({}),
    /deepseek-config-dir-not-configured/,
  );
});

test('effort: DeepSeek\'s levels, none read as low, thinking always on, and a respawn key', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  assert.equal(backend.effortFor(''), 'high');
  assert.equal(backend.effortFor('medium'), 'high');
  assert.equal(backend.effortFor('max'), 'max');
  // Claude Code cannot switch DeepSeek's thinking off: none is the lowest level.
  assert.equal(backend.effortFor('none'), 'low');
  assert.equal(backend.effortOption('none'), 'low');
  assert.equal(backend.thinkingEnabled('none'), true);
  assert.equal(backend.spawnEnv(WORKER_ENV, { effort: 'none' }).CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(backend.spawnEnv(WORKER_ENV, { effort: 'max' }).CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.equal('MAX_THINKING_TOKENS' in backend.spawnEnv(WORKER_ENV, { effort: 'none' }), false);
  assert.equal(backend.spawnKey({ reasoningEffort: 'medium' }), backend.spawnKey({ reasoningEffort: 'high' }));
  assert.notEqual(backend.spawnKey({ reasoningEffort: 'low' }), backend.spawnKey({ reasoningEffort: 'high' }));
});

test('models: the CLI gets the 1M suffix, the relay the bare id; images only where the model takes them', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  assert.equal(deepseekCliModel('deepseek-flash'), 'deepseek-flash[1m]');
  assert.equal(deepseekCliModel('deepseek-flash[1m]'), 'deepseek-flash[1m]');
  assert.equal(deepseekCliModel(''), '');
  assert.equal(deepseekRelayModel('deepseek-v4-pro[1M]'), 'deepseek-v4-pro');
  assert.equal(backend.isModel('deepseek-v4-pro'), true);
  assert.equal(backend.isModel('claude-sonnet-5'), false);
  assert.equal(backend.acceptsImages('deepseek-flash'), true);
  assert.equal(backend.acceptsImages('deepseek-v4-pro[1m]'), false);
  assert.equal(backend.reportsPlanUsage, false);
  assert.equal(backend.reportsUsageLimit, false);
});

test('usage: its own route, by the relay\'s model ids', () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  assert.equal(backend.usageRoute, '/api/deepseek-plan-usage');
  assert.equal(backend.relayModel('deepseek-v4-pro[1m]'), 'deepseek-v4-pro');
  assert.equal('createUsageLedger' in backend, false);
});

test('a usage report keys the searches and fetches like the tokens: under the DeepSeek model that served a Claude name', async () => {
  const backend = createDeepSeekClaudeBackend({ env: WORKER_ENV });
  const bodies = [];
  // Wired as the runner wires it (claude-session-process.mjs).
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { bodies.push({ routePath, body }); return { ok: true }; },
    reportsPlanUsage: backend.reportsPlanUsage,
    usageRoute: backend.usageRoute,
    usageModelKey: backend.relayModel,
    relayModel: backend.relayModel,
  });
  // A sub-agent asked for as "opus" ran on V4 Pro under its Claude name; it
  // searched twice. The chat's own turn on Flash fetched once.
  const state = {
    result: {
      sessionId: 'native-1',
      modelUsage: {
        'deepseek-flash[1m]': { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1 },
        'claude-opus-5-5': { inputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 2 },
      },
      usage: {},
      model: 'deepseek-flash[1m]',
      serverToolUse: [
        { model: 'claude-opus-5-5', webSearchRequests: 2, webFetchRequests: 0 },
        { model: 'deepseek-flash[1m]', webSearchRequests: 0, webFetchRequests: 1 },
      ],
    },
    planUsage: null,
    modelUsage: null,
  };
  await publisher.publishPlanUsage({ message: { id: 'q-1', conversationId: 'conv-ds' }, state, sdkSessionId: 'conv-ds', runId: 'run-a' });
  assert.deepEqual(bodies.map((entry) => entry.routePath), ['/api/deepseek-plan-usage']);
  const { body } = bodies[0];
  assert.deepEqual(body.totals.map((entry) => entry.model).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual([...body.requests].sort((a, b) => a.model.localeCompare(b.model)), [
    { model: 'deepseek-flash', searchRequests: 0, fetchRequests: 1 },
    { model: 'deepseek-v4-pro', searchRequests: 2, fetchRequests: 0 },
  ]);
});

test('DeepSeek failures get DeepSeek\'s advice, by status or by the CLI\'s words', () => {
  assert.equal(describeDeepSeekFailure('', { status: 402 }).code, 'deepseek-balance');
  assert.match(describeDeepSeekFailure('API Error: 402 {"error":{"message":"Insufficient Balance"}}').guidance, /platform\.deepseek\.com\/top_up/);
  assert.equal(describeDeepSeekFailure('API Error: 401 authentication_error').code, 'deepseek-api-key');
  assert.equal(describeDeepSeekFailure('', { status: 429 }).code, 'deepseek-rate-limit');
  assert.equal(describeDeepSeekFailure('API Error: 500 upstream'), null);
  assert.equal(describeDeepSeekFailure(''), null);
});
