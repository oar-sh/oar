import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createDeleteArchiveService } from './delete-archive-service.mjs';
import { createCacheRebuildService } from './cache-rebuild-service.mjs';
import { createTokenUsageService } from './token-usage-service.mjs';
import { normalizeTurnTokenUsageReport } from '../../shared/turn-token-usage.mjs';

// The two hard deletes outside the conversation routes drop a chat's turn
// tokens with its rows; the day sums behind Check Usage stay. Titles invented.

const NOW = '2026-11-02T10:00:00.000Z';

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.prepare(`INSERT INTO conversations (id, title, title_source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const conv = (id, titleSource = 'auto', status = 'active') => insert.run(id, id, titleSource, status, NOW, NOW);
  const tokens = createTokenUsageService({ db, now: () => Date.parse(NOW), timeZone: 'UTC', logger: { warn() {} } });
  const book = (conversationId, inputTokens) => {
    const { report } = normalizeTurnTokenUsageReport({ conversationId, turnId: `turn-${conversationId}`, models: [{ model: 'composer-2', inputTokens }] });
    tokens.recordTurn({ conversationId, provider: 'cursor', report });
  };
  const turnOwners = () => db.prepare(`SELECT conversation_id FROM turn_token_usage ORDER BY conversation_id`).all().map((row) => row.conversation_id);
  const dayInput = () => db.prepare(`SELECT SUM(input_tokens) AS n FROM token_usage_days`).get().n;
  return { db, conv, book, turnOwners, dayInput };
}

function rebuildService(db) {
  return createCacheRebuildService({
    db,
    stmts: {},
    io: { emit() {} },
    fs: null,
    path: null,
    uploadsDir: '',
    bootstrapRuntimeSessionBindings: () => 0,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
  });
}

test('the startup delete retry drops the tombstoned chat\'s turn tokens', async () => {
  const { db, conv, book, turnOwners, dayInput } = boot();
  conv('conv-gone', 'auto', 'deleted');
  conv('conv-kept');
  book('conv-gone', 5);
  book('conv-kept', 7);
  const service = createDeleteArchiveService(db, null);
  await service.retryPendingDeletesOnStartup();
  assert.deepEqual(turnOwners(), ['conv-kept']);
  assert.equal(dayInput(), 12);
});

test('a reconcile drops the turn tokens of the chats it purges', () => {
  const { db, conv, book, turnOwners, dayInput } = boot();
  conv('conv-legacy');
  conv('conv-bound');
  db.prepare(`UPDATE conversations SET sdk_session_id = 'sdk-bound' WHERE id = 'conv-bound'`).run();
  book('conv-legacy', 1);
  book('conv-bound', 2);
  const { summary } = rebuildService(db).rebuildCache({ mode: 'reconcile' });
  assert.deepEqual(summary.purgedConversationIds, ['conv-legacy']);
  assert.deepEqual(turnOwners(), ['conv-bound']);
  assert.equal(dayInput(), 3);
});

test('a full wipe keeps the turn tokens of the hand-titled chats it keeps', () => {
  const { db, conv, book, turnOwners, dayInput } = boot();
  conv('conv-auto');
  conv('conv-manual', 'manual');
  conv('conv-deleted-manual', 'manual', 'deleted');
  book('conv-auto', 1);
  book('conv-manual', 2);
  book('conv-deleted-manual', 4);
  rebuildService(db).rebuildCache({ mode: 'wipe' });
  assert.deepEqual(turnOwners(), ['conv-manual']);
  assert.equal(dayInput(), 7);
});
