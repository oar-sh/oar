import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveConversationTitle } from './sessions-helpers.mjs';

test('resolveConversationTitle ignores poisoned discovered title for auto source', () => {
  const resolved = resolveConversationTitle({
    title: 'Stored Title',
    titleSource: 'auto',
    discoveredTitle: 'Implement Relay Tool Guidance',
  });
  assert.equal(resolved, 'Stored Title');
});

test('resolveConversationTitle ignores relay mode discovered title', () => {
  const resolved = resolveConversationTitle({
    title: 'Fallback',
    titleSource: 'auto',
    discoveredTitle: '[Relay mode: agent] Proceed as an interactive coding agent',
  });
  assert.equal(resolved, 'Fallback');
});

test('resolveConversationTitle keeps safe discovered title', () => {
  const resolved = resolveConversationTitle({
    title: 'Stored Title',
    titleSource: 'auto',
    discoveredTitle: 'Fix websocket reconnect race',
  });
  assert.equal(resolved, 'Fix websocket reconnect race');
});

test('resolveConversationTitle keeps manual title precedence', () => {
  const resolved = resolveConversationTitle({
    title: 'My Manual Title',
    titleSource: 'manual',
    discoveredTitle: 'Fix websocket reconnect race',
  });
  assert.equal(resolved, 'My Manual Title');
});
