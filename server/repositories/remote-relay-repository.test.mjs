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

test('a relay whose agent started the conversation or wrote to it counts as having made contact', () => {
  const { db, repo } = setup();
  assert.equal(repo.hasContactFrom('c-1', 'r-9'), false);
  repo.setMessageOrigin('m-1', { relayId: 'r-9', relayName: 'win-test', hops: 1 });
  assert.equal(repo.hasContactFrom('c-1', 'r-9'), true);
  assert.equal(repo.hasContactFrom('c-1', 'r-8'), false, 'another relay made none');
  assert.equal(repo.hasContactFrom('c-2', 'r-9'), false, 'contact is per conversation');
  assert.equal(repo.hasContactFrom('c-1', ''), false);

  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c-3', 'sidebar polish', ?, ?)`)
    .run('2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z');
  repo.setConversationOrigin('c-3', { relayId: 'r-7', relayName: 'spare-test', hops: 1 });
  assert.equal(repo.hasContactFrom('c-3', 'r-7'), true);
});

test('the latest message of the user is one no agent sent', () => {
  const { db, repo } = setup();
  assert.equal(repo.latestHumanMessageId('c-1'), 'm-1');
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-2', 'c-1', 'user', 'from an agent', ?)`)
    .run('2026-09-20T10:05:00.000Z');
  repo.setMessageOrigin('m-2', { relayId: 'r-9', relayName: 'win-test', hops: 1 });
  assert.equal(repo.latestHumanMessageId('c-1'), 'm-1', 'an agent\'s prompt is not the user\'s');
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-3', 'c-1', 'user', 'go on', ?)`)
    .run('2026-09-20T10:06:00.000Z');
  assert.equal(repo.latestHumanMessageId('c-1'), 'm-3');
  assert.equal(repo.latestHumanMessageId('c-9'), null);
});

test('a damaged origin column reads as no origin', () => {
  assert.equal(parseRemoteRelayOriginJson('{not json'), null);
  assert.equal(parseRemoteRelayOriginJson(null), null);
  assert.equal(parseRemoteRelayOriginJson('{"relayName":"win-test"}').relayName, 'win-test');
});

test('the Allow for starting sessions on this relay is remembered per conversation, like an unlock', () => {
  const { repo } = setup();
  assert.equal(repo.hasLocalSessionApproval('c-1'), false);
  assert.equal(repo.recordLocalSessionApproval('c-1', 'm-1', '2026-09-20T10:00:01.000Z'), true);
  assert.equal(repo.recordLocalSessionApproval('c-1', 'm-2', '2026-09-20T10:00:02.000Z'), false, 'given once');
  assert.equal(repo.hasLocalSessionApproval('c-1'), true);
  assert.equal(repo.hasLocalSessionApproval('c-2'), false, 'per conversation');
  assert.equal(repo.recordLocalSessionApproval('', 'm-1'), false);
  // Stored under the local target's id, next to the paired relays' unlocks.
  assert.deepEqual(repo.listUnlocks('c-1'), [{ remoteRelayId: 'self', messageId: 'm-1', createdAt: '2026-09-20T10:00:01.000Z' }]);
  assert.equal(repo.hasUnlock('c-1', 'r-1'), false, 'it unlocks no paired relay');
  // Removing a paired relay leaves it; deleting the conversation forgets it.
  repo.recordUnlock('c-1', 'r-1');
  repo.forgetRelay('r-1');
  assert.equal(repo.hasLocalSessionApproval('c-1'), true);
  repo.forgetConversation('c-1');
  assert.equal(repo.hasLocalSessionApproval('c-1'), false);
});

test('a local origin round-trips with its flag and the creating conversation', () => {
  const { repo } = setup();
  const origin = { relayId: 'r-self', relayName: 'win-test', conversationId: 'c-0', conversationTitle: 'report builder', hops: 0, local: true };
  repo.setConversationOrigin('c-1', origin);
  const stored = repo.getConversationOrigin('c-1');
  assert.equal(stored.local, true);
  assert.equal(stored.conversationId, 'c-0');
  assert.equal(stored.conversationTitle, 'report builder');
  assert.equal(parseRemoteRelayOriginJson(JSON.stringify(origin)).local, true);
  repo.setConversationOrigin('c-1', { relayId: 'r-9', relayName: 'linux-test', conversationId: 'c-0', hops: 1 });
  assert.equal('local' in repo.getConversationOrigin('c-1'), false, 'a paired relay\'s origin has none');
});

test('active local sessions: created by that conversation here, with a turn queued or running', () => {
  const { db, repo } = setup();
  const now = '2026-09-20T10:00:00.000Z';
  const addConversation = (id, origin, status = 'active') => {
    db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, 'sidebar polish', ?, ?, ?)`).run(id, status, now, now);
    if (origin) repo.setConversationOrigin(id, origin);
  };
  const addQueueRow = (id, conversationId, status) => {
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'work', ?, ?)`).run(id, conversationId, status, now);
  };
  const local = (conversationId) => ({ relayId: 'r-self', relayName: 'win-test', conversationId, hops: 0, local: true });

  addConversation('s-pending', local('c-1'));
  addQueueRow('q-1', 's-pending', 'pending');
  addConversation('s-processing', local('c-1'));
  addQueueRow('q-2', 's-processing', 'processing');
  addQueueRow('q-2b', 's-processing', 'pending');
  addConversation('s-parked', local('c-1'));
  addQueueRow('q-3', 's-parked', 'parked');
  addConversation('s-done', local('c-1'));
  addQueueRow('q-4', 's-done', 'done');
  addConversation('s-idle', local('c-1'));
  addConversation('s-other-creator', local('c-2'));
  addQueueRow('q-5', 's-other-creator', 'processing');
  // Created from a paired relay by a conversation with the same id there.
  addConversation('s-remote', { relayId: 'r-9', relayName: 'linux-test', conversationId: 'c-1', hops: 1 });
  addQueueRow('q-6', 's-remote', 'processing');
  addConversation('s-deleted', local('c-1'), 'deleted');
  addQueueRow('q-7', 's-deleted', 'pending');
  addConversation('s-human', null);
  addQueueRow('q-8', 's-human', 'processing');

  assert.deepEqual(repo.listActiveLocalSessions('c-1').sort(), ['s-parked', 's-pending', 's-processing']);
  assert.deepEqual(repo.listActiveLocalSessions('c-2'), ['s-other-creator']);
  assert.deepEqual(repo.listActiveLocalSessions('c-3'), []);
  assert.deepEqual(repo.listActiveLocalSessions(''), []);
});
