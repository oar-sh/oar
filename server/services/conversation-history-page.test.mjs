import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createConversationHistoryPageStatements } from './conversation-history-page.mjs';
import { selectConversationHistoryPage } from '../routes/sessions-routes.mjs';

const CONV = 'conv-paging-fixture';

// Deterministic ids in the relay's alphabet: lowercase hex and dashes.
function fixtureId(index) {
  const hex = ((index * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function seed(db, count, { hiddenEvery = 0 } = {}) {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Paging chat', ?, ?)`)
    .run(CONV, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const insert = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, timestamp, hidden_from_shares)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    // Every third pair shares a timestamp, so ties are ordered by id.
    const second = Math.floor(index / 3) * 2;
    const timestamp = new Date(Date.UTC(2026, 0, 2, 0, 0, second)).toISOString();
    const row = {
      id: fixtureId(index),
      role: index % 2 ? 'assistant' : 'user',
      text: `message ${index}`,
      timestamp,
      hidden: hiddenEvery && index % hiddenEvery === 0 ? 1 : 0,
    };
    insert.run(row.id, CONV, row.role, row.text, row.timestamp, row.hidden);
    rows.push(row);
  }
  return rows;
}

function freshDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function cursorsFor(rows) {
  const cursors = [{}];
  for (const row of rows) {
    cursors.push({ beforeMessageId: row.id, beforeTimestamp: row.timestamp });
    cursors.push({ beforeMessageId: row.id });
    cursors.push({ beforeTimestamp: row.timestamp });
    cursors.push({ afterMessageId: row.id, afterTimestamp: row.timestamp });
    cursors.push({ afterMessageId: row.id });
    cursors.push({ afterTimestamp: row.timestamp });
    cursors.push({ aroundMessageId: row.id });
  }
  const last = rows[rows.length - 1];
  cursors.push(
    { beforeMessageId: 'missing-id', beforeTimestamp: rows[5].timestamp },
    { beforeMessageId: 'missing-id' },
    { afterMessageId: 'missing-id' },
    { afterMessageId: 'missing-id', afterTimestamp: rows[5].timestamp },
    { afterTimestamp: last.timestamp },
    { aroundMessageId: 'missing-id' },
    { aroundMessageId: rows[4].id, afterMessageId: rows[2].id },
    { beforeTimestamp: '2026-01-02 00:00:10' },
    { afterTimestamp: '2026-01-02T00:00:10Z' },
    { beforeTimestamp: 'not a time' },
    { afterTimestamp: 'not a time' },
  );
  return cursors;
}

function assertSamePages(pager, rows, { sharedOnly = false } = {}) {
  const visible = sharedOnly ? rows.filter((row) => !row.hidden) : rows;
  const messages = visible.map((row) => ({ id: row.id, timestamp: row.timestamp }));
  for (const limit of [1, 2, 5, 8, 20, 250]) {
    for (const cursor of cursorsFor(rows)) {
      const expected = selectConversationHistoryPage(messages, { limit, ...cursor });
      const actual = pager.selectConversationHistoryPage(CONV, { limit, ...cursor, sharedOnly });
      const label = JSON.stringify({ limit, ...cursor, sharedOnly });
      assert.ok(actual, `paged in SQL: ${label}`);
      assert.deepEqual(actual.rows.map((row) => row.id), expected.messages.map((message) => message.id), label);
      assert.deepEqual(actual.pageInfo, expected.pageInfo, label);
    }
  }
}

test('every cursor gives the page and pageInfo of the in-memory selector', () => {
  const db = freshDb();
  const rows = seed(db, 41);
  assertSamePages(createConversationHistoryPageStatements(db), rows);
});

test('a shared view pages over the rows not hidden from shares', () => {
  const db = freshDb();
  const rows = seed(db, 29, { hiddenEvery: 4 });
  assertSamePages(createConversationHistoryPageStatements(db), rows, { sharedOnly: true });
});

test('an empty conversation gives an empty page', () => {
  const db = freshDb();
  const page = createConversationHistoryPageStatements(db).selectConversationHistoryPage('conv-without-rows', {});
  assert.deepEqual(page.rows, []);
  assert.deepEqual(page.pageInfo, selectConversationHistoryPage([], {}).pageInfo);
});

test('rows SQL cannot order like the selector leave the page to the caller', () => {
  for (const [id, timestamp] of [
    ['Upper-Case-Id', '2026-01-03T00:00:00.000Z'],
    ['id_with_underscore', '2026-01-03T00:00:00.000Z'],
    ['plain-id', '2026-01-03 00:00:00'],
    ['plain-id', '2026-01-03T00:00:00Z'],
  ]) {
    const db = freshDb();
    seed(db, 6);
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', 'odd row', ?)`)
      .run(id, CONV, timestamp);
    assert.equal(createConversationHistoryPageStatements(db).selectConversationHistoryPage(CONV, {}), null, `${id} ${timestamp}`);
  }
  const db = freshDb();
  seed(db, 6);
  const pager = createConversationHistoryPageStatements(db);
  assert.equal(pager.selectConversationHistoryPage(CONV, { beforeMessageId: 'Odd_Id', beforeTimestamp: '2026-01-02T00:00:02.000Z' }), null);
  assert.ok(pager.selectConversationHistoryPage(CONV, { beforeMessageId: 'odd-id', beforeTimestamp: '2026-01-02T00:00:02.000Z' }));
});

test('the page query reads the conversation-order index', () => {
  const db = freshDb();
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC, id DESC LIMIT 20
  `).all(CONV).map((row) => row.detail).join(' ');
  assert.match(plan, /idx_messages_conv_order/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});
