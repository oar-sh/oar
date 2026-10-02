'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_CLOUD_DEFAULT_MODEL_SETTING_KEY,
  CLAUDE_CLOUD_ENABLED_SETTING_KEY,
  CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY,
  DEFAULT_CLAUDE_CLOUD_MODEL,
  buildClaudeCloudModelList,
  createClaudeCloudSettingsService,
  parseClaudeCloudSettingsUpdateRequest,
} from './claude-cloud-settings-service.mjs';

const ENVIRONMENT_A = 'env_01EXAMPLEaaaaaaaaaaaaaaaa';
const ENVIRONMENT_B = 'env_01EXAMPLEbbbbbbbbbbbbbbbb';
const TOKEN = 'test-token-value';

function createHarness({
  stored = {},
  login = { source: 'file', hasToken: true, expiresAt: '2026-10-02T18:00:00.000Z', subscriptionType: 'max', rateLimitTier: 'tier-example' },
  environments = [
    { id: ENVIRONMENT_A, name: 'Default', kind: 'anthropic_cloud', state: 'active' },
    { id: ENVIRONMENT_B, name: 'Second', kind: 'anthropic_cloud', state: 'active' },
  ],
  status = { ok: true, loggedIn: true, email: 'dev@example.com', orgId: 'org-example', orgName: 'Example Org', subscriptionType: 'max' },
  claudeSettings = {
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-opus-5', 'claude-haiku-5'],
    availableModels: ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-opus-5', 'claude-haiku-5', 'claude-legacy-4'],
  },
} = {}) {
  const settings = new Map(Object.entries(stored));
  const events = [];
  const calls = { listEnvironments: 0, getStatus: 0 };
  let clock = Date.parse('2026-10-02T10:00:00.000Z');
  const state = { login, environments, status };
  const service = createClaudeCloudSettingsService({
    readSetting: (key) => settings.get(key) || '',
    writeSetting: (key, value) => settings.set(key, String(value)),
    deleteSetting: (key) => settings.delete(key),
    getClaudeProviderSettings: () => claudeSettings,
    claudeAuthService: {
      getStatus: async () => { calls.getStatus += 1; return state.status; },
      getCachedStatus: () => state.status,
    },
    credentials: {
      // What the real module answers, plus the one thing it never does: this
      // fake would hand out the token if asked, and the tests check nobody asks.
      describe: () => state.login,
      getAccessToken: async () => { throw new Error('the settings service must not read the token'); },
      redact: (text) => String(text).split(TOKEN).join('[redacted]'),
    },
    cloud: {
      listEnvironments: async () => {
        calls.listEnvironments += 1;
        if (state.environments instanceof Error) throw state.environments;
        return state.environments;
      },
    },
    emit: (event, payload) => events.push({ event, payload }),
    now: () => clock,
    logger: { log() {}, warn() {} },
  });
  return { service, settings, events, calls, state, advance: (ms) => { clock += ms; } };
}

test('the cloud model list is the Claude catalog without tiers, the default first', () => {
  assert.deepEqual(
    buildClaudeCloudModelList('claude-sonnet-5-5', ['claude-opus-5[1m]', 'claude-opus-5', 'Claude-Opus-5', 'claude-sonnet-5-5[1m]', '', 'bad id!']),
    ['claude-sonnet-5-5', 'claude-opus-5'],
  );
  assert.deepEqual(buildClaudeCloudModelList('claude-sonnet-5-5', undefined), ['claude-sonnet-5-5']);
});

test('update requests are parsed strictly', () => {
  assert.deepEqual(parseClaudeCloudSettingsUpdateRequest({ enabled: true }), { ok: true, enabled: true });
  assert.deepEqual(parseClaudeCloudSettingsUpdateRequest({ defaultModel: ' claude-opus-5[1m] ' }), { ok: true, defaultModel: 'claude-opus-5' });
  assert.deepEqual(parseClaudeCloudSettingsUpdateRequest({ environmentId: ` ${ENVIRONMENT_A} ` }), { ok: true, environmentId: ENVIRONMENT_A });
  assert.deepEqual(parseClaudeCloudSettingsUpdateRequest({ environmentId: null }), { ok: true, environmentId: '' });
  assert.equal(parseClaudeCloudSettingsUpdateRequest({}).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest(null).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest({ enabled: 'true' }).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest({ defaultModel: '' }).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest({ defaultModel: 'no spaces allowed' }).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest({ environmentId: '../other' }).ok, false);
  assert.equal(parseClaudeCloudSettingsUpdateRequest({ environmentId: 7 }).ok, false);
});

test('off by default: the stored defaults, and nothing asked of the cloud', async () => {
  const harness = createHarness();
  assert.deepEqual(harness.service.getSettings(), {
    enabled: false,
    defaultModel: DEFAULT_CLAUDE_CLOUD_MODEL,
    environmentId: '',
    models: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5'],
    providerType: 'claude-cloud',
  });
  assert.deepEqual(await harness.service.describe(), {
    enabled: false,
    defaultModel: 'claude-sonnet-5-5',
    environmentId: null,
    environments: null,
    environmentsError: null,
    account: { loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max' },
    token: { source: 'file', hasToken: true, expiresAt: '2026-10-02T18:00:00.000Z' },
    models: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5'],
  });
  assert.equal(harness.calls.listEnvironments, 0);
  assert.equal(harness.settings.size, 0, 'reading stores nothing while off');
});

test('the catalog falls back to every available Claude model when none is selected', () => {
  const harness = createHarness({
    claudeSettings: { model: 'claude-sonnet-5', models: [], availableModels: ['claude-opus-5[1m]', 'claude-opus-5'] },
  });
  assert.deepEqual(harness.service.getSettings().models, ['claude-sonnet-5-5', 'claude-opus-5']);
});

test('switching on lists the environments and stores the first active one', async () => {
  const harness = createHarness();
  const result = await harness.service.update({ enabled: true });
  assert.equal(result.ok, true);
  assert.equal(harness.settings.get(CLAUDE_CLOUD_ENABLED_SETTING_KEY), 'true');
  assert.equal(harness.settings.get(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY), ENVIRONMENT_A);
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.environmentId, ENVIRONMENT_A);
  assert.deepEqual(result.settings.environments, [
    { id: ENVIRONMENT_A, name: 'Default' },
    { id: ENVIRONMENT_B, name: 'Second' },
  ]);
  assert.equal(result.settings.environmentsError, null);
  assert.deepEqual(harness.events, [{ event: 'claude_cloud_settings_updated', payload: result.settings }]);
  assert.equal(harness.service.getSettings().environmentId, ENVIRONMENT_A);
});

test('a stored environment is kept, and inactive ones are not offered', async () => {
  const harness = createHarness({
    stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true', [CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY]: ENVIRONMENT_B },
    environments: [
      { id: ENVIRONMENT_A, name: 'Default', state: 'active' },
      { id: 'env_01EXAMPLEcccccccccccccccc', name: 'Old', state: 'archived' },
      { id: 'not an id', name: 'Broken', state: 'active' },
    ],
  });
  const described = await harness.service.describe();
  assert.equal(described.environmentId, ENVIRONMENT_B);
  assert.deepEqual(described.environments, [{ id: ENVIRONMENT_A, name: 'Default' }]);
});

test('the environments are read once a minute, not on every look at the tab', async () => {
  const harness = createHarness({ stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true' } });
  await harness.service.describe();
  await harness.service.describe();
  assert.equal(harness.calls.listEnvironments, 1);
  harness.advance(61_000);
  await harness.service.describe();
  assert.equal(harness.calls.listEnvironments, 2);
});

test('enabling without a login is refused with its code, and nothing is stored', async () => {
  const harness = createHarness({ login: { source: 'none', hasToken: false, expiresAt: null, subscriptionType: null, rateLimitTier: null } });
  const result = await harness.service.update({ enabled: true, defaultModel: 'claude-opus-5' });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.code, 'claude_cloud_login_missing');
  assert.match(result.error, /Claude CLI login/);
  assert.equal(harness.settings.size, 0);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.calls.listEnvironments, 0);

  // The model and the environment can still be set while it is off.
  const model = await harness.service.update({ defaultModel: 'claude-opus-5[1m]', environmentId: ENVIRONMENT_B });
  assert.equal(model.ok, true);
  assert.equal(harness.settings.get(CLAUDE_CLOUD_DEFAULT_MODEL_SETTING_KEY), 'claude-opus-5');
  assert.equal(model.settings.defaultModel, 'claude-opus-5');
  assert.equal(model.settings.environmentId, ENVIRONMENT_B);
  assert.deepEqual(model.settings.token, { source: 'none', hasToken: false, expiresAt: null });
});

test('switching off needs no login, and stops the calls to the cloud', async () => {
  const harness = createHarness({ stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true', [CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY]: ENVIRONMENT_A } });
  harness.state.login = { source: 'none', hasToken: false, expiresAt: null };
  const result = await harness.service.update({ enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.settings.enabled, false);
  assert.equal(result.settings.environments, null);
  assert.equal(harness.calls.listEnvironments, 0);
});

test('a cloud that cannot be asked is reported as text, without the token', async () => {
  const harness = createHarness({
    stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true' },
    environments: new Error(`The Claude login has expired (Bearer ${TOKEN}).`),
  });
  const described = await harness.service.describe();
  assert.equal(described.environments, null);
  assert.equal(described.environmentsError, 'The Claude login has expired (Bearer [redacted]).');
  assert.equal(described.environmentId, null);
  assert.equal(JSON.stringify(described).includes(TOKEN), false);
  assert.equal(await harness.service.resolveEnvironmentId(), '');
});

test('the settings body never carries the token, whatever the login module answers', async () => {
  const harness = createHarness({
    stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true' },
    login: { source: 'env', hasToken: true, expiresAt: null, subscriptionType: null, accessToken: TOKEN, token: TOKEN },
  });
  const described = await harness.service.describe();
  assert.deepEqual(described.token, { source: 'env', hasToken: true, expiresAt: null });
  assert.equal(JSON.stringify(described).includes(TOKEN), false);
  const updated = await harness.service.update({ defaultModel: 'claude-haiku-5' });
  assert.equal(JSON.stringify(updated).includes(TOKEN), false);
  assert.equal(JSON.stringify(harness.events).includes(TOKEN), false);
});

test('the account line is null when the CLI status is unknown, and falls back for the plan', async () => {
  const unknown = createHarness({ status: { ok: false, loggedIn: false, error: 'claude: command not found' } });
  assert.equal((await unknown.service.describe()).account, null);

  const noPlan = createHarness({ status: { ok: true, loggedIn: true, email: 'dev@example.com', orgName: null, subscriptionType: null } });
  assert.deepEqual((await noPlan.service.describe()).account, {
    loggedIn: true, email: 'dev@example.com', orgName: null, subscriptionType: 'max',
  });

  const service = createClaudeCloudSettingsService({});
  const bare = await service.describe();
  assert.equal(bare.account, null);
  assert.deepEqual(bare.token, { source: 'none', hasToken: false, expiresAt: null });
  assert.equal(bare.enabled, false);
});

test('clearing the environment picks the first active one again while on', async () => {
  const harness = createHarness({ stored: { [CLAUDE_CLOUD_ENABLED_SETTING_KEY]: 'true', [CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY]: ENVIRONMENT_B } });
  const result = await harness.service.update({ environmentId: '' });
  assert.equal(result.ok, true);
  assert.equal(result.settings.environmentId, ENVIRONMENT_A);
});

test('an update without storage is refused', async () => {
  const service = createClaudeCloudSettingsService({ credentials: { describe: () => ({ source: 'file', hasToken: true }) } });
  const result = await service.update({ defaultModel: 'claude-opus-5' });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 500);
  assert.equal((await service.update({})).statusCode, 400);
});
