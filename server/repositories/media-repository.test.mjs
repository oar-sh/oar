import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMediaRepository, mediaSenderFor } from './media-repository.mjs';

const NOW = '2026-11-01T10:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, runtime_workspace_root_path) VALUES ('c1', 'Fixture', ?, ?, '/srv/demo')`).run(NOW, NOW);
  return db;
}

const item = (ordinal, identity) => ({
  ordinal, origin: 'embedded', locatorKind: 'local_path', locator: `/srv/demo/${identity}.png`,
  identityKey: `path:/srv/demo/${identity}.png`, category: 'media', mediaKind: 'image', mime: 'image/png',
  name: `${identity}.png`, alt: null, sizeBytes: null,
});

test('a queued message comes with what the indexer needs, in queue order', () => {
  const db = setup();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m2', 'c1', 'assistant', 'two', ?)`).run(NOW);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES ('m1', 'c1', 'user', 'one', ?, 'note')`).run(NOW);
  const repo = createMediaRepository(db);
  const entries = repo.nextQueueBatch(10);
  assert.deepEqual(entries.map((entry) => [entry.messageId, entry.bytes, 'text' in entry]), [['m2', 3, false], ['m1', 3, false]], 'ids and sizes, no bodies');
  const batch = entries.map((entry) => repo.loadQueuedMessage(entry));
  assert.deepEqual(batch.map((row) => [row.messageId, row.role, row.kind, row.workspaceRoot]), [
    ['m2', 'assistant', null, '/srv/demo'],
    ['m1', 'user', 'note', '/srv/demo'],
  ]);
  assert.equal(repo.pendingCount(), 2);
});

test('replacing the items of a message removes only the queue row it read', () => {
  const db = setup();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'c1', 'assistant', 'x', ?)`).run(NOW);
  const repo = createMediaRepository(db);
  const [row] = repo.nextQueueBatch(1).map((entry) => repo.loadQueuedMessage(entry));
  assert.equal(repo.replaceMessageItems(row, [item(0, 'a'), item(1, 'b')]), 2);
  assert.equal(repo.pendingCount(), 0);

  // Re-queued after it was read: the stale read leaves the newer queue row.
  db.prepare(`UPDATE messages SET text = 'y' WHERE id = 'm1'`).run();
  const [again] = repo.nextQueueBatch(1).map((entry) => repo.loadQueuedMessage(entry));
  db.prepare(`UPDATE messages SET text = 'z' WHERE id = 'm1'`).run();
  repo.replaceMessageItems(again, [item(0, 'c')]);
  assert.equal(repo.pendingCount(), 1);
  const rows = db.prepare(`SELECT ordinal, identity_key, sender, message_ts FROM media_items ORDER BY ordinal`).all();
  assert.deepEqual(rows, [{ ordinal: 0, identity_key: 'path:/srv/demo/c.png', sender: 'agent', message_ts: NOW }]);
});

test('sender: the owner, an agent, or the relay (events, notes, other relays)', () => {
  assert.equal(mediaSenderFor({ role: 'user' }), 'me');
  assert.equal(mediaSenderFor({ role: 'assistant' }), 'agent');
  assert.equal(mediaSenderFor({ role: 'user', kind: 'usage_limit' }), 'relay');
  assert.equal(mediaSenderFor({ role: 'user', originJson: '{"relay":"x"}' }), 'relay');
});

test('orphan queue rows are removed; without the migration the repository is empty and inert', () => {
  const db = setup();
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO media_index_queue (message_id, seq) VALUES ('gone', 0)`).run();
  const repo = createMediaRepository(db);
  assert.equal(repo.removeOrphanQueueRows(), 1);

  const bare = createMediaRepository(new Database(':memory:'));
  assert.equal(bare.available, false);
  assert.deepEqual(bare.nextQueueBatch(), []);
  assert.equal(bare.pendingCount(), 0);
});

test('a gallery page works on a database whose identity index is missing (repaired by hand)', () => {
  const db = setup();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m1', 'c1', 'assistant', 'x', ?)`).run(NOW);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m2', 'c1', 'assistant', 'y', '2026-11-01T11:00:00.000Z')`).run();
  const repo = createMediaRepository(db);
  for (const entry of repo.nextQueueBatch(10)) repo.replaceMessageItems(repo.loadQueuedMessage(entry), [item(0, 'same')]);
  db.exec('DROP INDEX idx_media_items_identity');
  const fresh = createMediaRepository(db);
  const page = fresh.listMedia({ limit: 60 });
  assert.deepEqual(page.map((row) => [row.messageId, row.occurrences]), [['m2', 2]]);
  assert.equal(fresh.listMedia({ limit: 60, conversationId: 'c1' }).length, 1);
});
test('the dedupe checks run on the identity index, for the whole relay and for one session', () => {
  const db = setup();
  let captured = '';
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/FROM media_items mi/.test(sql) && /NOT EXISTS/.test(sql)) captured = sql;
    return realPrepare(sql);
  };
  const repo = createMediaRepository(db);
  for (const filters of [{}, { conversationId: 'c1' }]) {
    captured = '';
    repo.listMedia({ limit: 60, ...filters });
    assert.ok(captured, 'the page query was prepared');
    const params = { category: 'media', limit: 60, ...(filters.conversationId ? { conversationId: 'c1' } : {}) };
    const plan = realPrepare(`EXPLAIN QUERY PLAN ${captured}`).all(params).map((row) => row.detail);
    for (const alias of ['n', 'o']) {
      assert.ok(plan.includes(`SEARCH ${alias} USING INDEX idx_media_items_identity (identity_key=?)`),
        `${JSON.stringify(filters)}: ${alias} on the identity index, not ${plan.find((line) => line.startsWith(`SEARCH ${alias} `))}`);
    }
  }
});