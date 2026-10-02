import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_RELAY_PROVIDER_TYPES,
  SESSION_WORKER_PROVIDER_TYPES,
  isLegacyRelayProviderType,
  isSessionWorkerProviderType,
  sessionWorkerProviderSqlList,
} from './provider-routing.mjs';
import { REMOTE_RELAY_PROVIDERS } from './remote-relay-contract.mjs';
import { steerAgentLabelForProvider } from './steer-settle-failure.mjs';

test('every session-worker provider is kept away from the legacy relay', () => {
  for (const provider of ['claude', 'cursor', 'grok', 'claude-cloud']) {
    assert.equal(SESSION_WORKER_PROVIDER_TYPES.includes(provider), true, provider);
    assert.equal(isSessionWorkerProviderType(provider), true, provider);
    assert.equal(isSessionWorkerProviderType(` ${provider.toUpperCase()} `), true, provider);
    assert.equal(isLegacyRelayProviderType(provider), false, provider);
    assert.equal(LEGACY_RELAY_PROVIDER_TYPES.includes(provider), false, provider);
  }
});

test('claude-cloud is its own provider, not a spelling of claude', () => {
  assert.equal(SESSION_WORKER_PROVIDER_TYPES.filter((provider) => provider === 'claude-cloud').length, 1);
  assert.equal(isSessionWorkerProviderType('claude cloud'), false);
  assert.equal(isSessionWorkerProviderType('claudecloud'), false);
});

test('the legacy relay still takes github, openai and an unbound row', () => {
  assert.equal(isLegacyRelayProviderType('github'), true);
  assert.equal(isLegacyRelayProviderType('openai'), true);
  assert.equal(isLegacyRelayProviderType(''), true);
  assert.equal(isSessionWorkerProviderType('github'), false);
});

test('the SQL list names every session-worker provider, quoted', () => {
  assert.equal(sessionWorkerProviderSqlList(), `'claude', 'cursor', 'grok', 'claude-cloud'`);
});

test('the lists other modules keep per provider know claude-cloud too', () => {
  assert.equal(REMOTE_RELAY_PROVIDERS.includes('claude-cloud'), true);
  assert.equal(steerAgentLabelForProvider('claude-cloud'), 'Claude Cloud');
  // The Claude label stays the Claude provider's own.
  assert.equal(steerAgentLabelForProvider('claude'), 'Claude');
});
