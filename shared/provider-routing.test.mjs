import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_WORKER_PROVIDER_TYPES,
  isSessionWorkerProviderType,
  sessionWorkerProviderSqlList,
} from './provider-routing.mjs';
import { REMOTE_RELAY_PROVIDERS } from './remote-relay-contract.mjs';
import { steerAgentLabelForProvider } from './steer-settle-failure.mjs';

test('every session-worker provider is listed and recognised in any case', () => {
  for (const provider of ['claude', 'cursor', 'grok', 'claude-cloud', 'deepseek', 'claude-api']) {
    assert.equal(SESSION_WORKER_PROVIDER_TYPES.includes(provider), true, provider);
    assert.equal(isSessionWorkerProviderType(provider), true, provider);
    assert.equal(isSessionWorkerProviderType(` ${provider.toUpperCase()} `), true, provider);
  }
});

test('claude-cloud is its own provider, not a spelling of claude', () => {
  assert.equal(SESSION_WORKER_PROVIDER_TYPES.filter((provider) => provider === 'claude-cloud').length, 1);
  assert.equal(isSessionWorkerProviderType('claude cloud'), false);
  assert.equal(isSessionWorkerProviderType('claudecloud'), false);
});

test('github is no session-worker provider', () => {
  assert.equal(isSessionWorkerProviderType('github'), false);
});

test('the SQL list names every session-worker provider, quoted', () => {
  assert.equal(sessionWorkerProviderSqlList(), `'claude', 'cursor', 'grok', 'claude-cloud', 'deepseek', 'claude-api'`);
});

test('the lists other modules keep per provider know claude-cloud too', () => {
  assert.equal(REMOTE_RELAY_PROVIDERS.includes('claude-cloud'), true);
  assert.equal(steerAgentLabelForProvider('claude-cloud'), 'Claude Cloud');
  // The Claude label stays the Claude provider's own.
  assert.equal(steerAgentLabelForProvider('claude'), 'Claude');
});

test('the lists other modules keep per provider know deepseek too', () => {
  assert.equal(REMOTE_RELAY_PROVIDERS.includes('deepseek'), true);
  assert.equal(steerAgentLabelForProvider('deepseek'), 'DeepSeek');
});

test('claude-api is its own provider, and the lists know it', () => {
  assert.equal(SESSION_WORKER_PROVIDER_TYPES.filter((provider) => provider === 'claude-api').length, 1);
  assert.equal(isSessionWorkerProviderType('claude api'), false);
  assert.equal(REMOTE_RELAY_PROVIDERS.includes('claude-api'), true);
  assert.equal(steerAgentLabelForProvider('claude-api'), 'Claude API');
  assert.equal(steerAgentLabelForProvider('claude'), 'Claude');
});
