import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createRemoteRelayRepository, parseRemoteRelayOriginJson } from './remote-relay-repository.mjs';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const now = '2026-09-20T10:00:00.000Z';
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c-1', 'report builder', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-1', 'c-1', 'user', 'ask linux-test', ?)`).run(now);
  return { db, repo: createRemoteRelayRepository(db) };
}

test('an unlock is recorded once and listed', () => {
  const { repo } = setup();
  assert.equal(repo.hasUnlock('c-1', 'r-1'), false);
  assert.equal(repo.recordUnlock('c-1', 'r-1', 'm-1', '2026-09-20T10:00:01.000Z'), true);
  assert.equal(repo.recordUnlock('c-1', 'r-1', 'm-2', '2026-09-20T10:00:02.000Z'), false, 'the first mention wins');
  assert.equal(repo.hasUnlock('c-1', 'r-1'), true);
  assert.equal(repo.hasUnlock('c-2', 'r-1'), false, 'unlocks are per conversation');
  assert.deepEqual(repo.listUnlocks('c-1'), [{ remoteRelayId: 'r-1', messageId: 'm-1', createdAt: '2026-09-20T10:00:01.000Z' }]);
  assert.equal(repo.recordUnlock('', 'r-1'), false);
});

test('removing a relay or a conversation forgets its unlocks', () => {
  const { repo } = setup();
  repo.recordUnlock('c-1', 'r-1');
  repo.recordUnlock('c-1', 'r-2');
  repo.recordUnlock('c-2', 'r-1');
  assert.equal(repo.forgetRelay('r-1'), 2);
  assert.deepEqual(repo.listUnlocks('c-1').map((row) => row.remoteRelayId), ['r-2']);
  assert.equal(repo.forgetConversation('c-1'), 1);
  assert.deepEqual(repo.listUnlocks('c-1'), []);
});

test('message and conversation origins round-trip normalised', () => {
  const { repo } = setup();
  const origin = { relayId: 'r-9', relayName: 'win-test', conversationId: 'src-1', conversationTitle: 'sidebar polish', model: 'claude-sonnet-5', provider: 'claude', hops: 1 };
  assert.equal(repo.setMessageOrigin('m-1', origin), true);
  assert.deepEqual(repo.getMessageOrigin('m-1'), { kind: 'agent', relayUrl: '', ...origin });
  assert.equal(repo.setConversationOrigin('c-1', origin), true);
  assert.equal(repo.getConversationOrigin('c-1').relayName, 'win-test');
  assert.equal(repo.getMessageOrigin('missing'), null);
  repo.setMessageOrigin('m-1', null);
  assert.equal(repo.getMessageOrigin('m-1'), null);
});

test('a damaged origin column reads as no origin', () => {
  assert.equal(parseRemoteRelayOriginJson('{not json'), null);
  assert.equal(parseRemoteRelayOriginJson(null), null);
  assert.equal(parseRemoteRelayOriginJson('{"relayName":"win-test"}').relayName, 'win-test');
});
