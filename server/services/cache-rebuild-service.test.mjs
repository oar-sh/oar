import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createCacheRebuildService } from './cache-rebuild-service.mjs';
import { createPreviewRegistry, normalizePreviewsConfig } from './preview-registry-service.mjs';
import { createMemoryPreviewStore } from './preview-store.mjs';

// A cache rebuild hard-deletes conversations; their public preview links go
// with them, as with a delete from the UI. A conversation it archives or keeps
// keeps its previews.

function setup({ gone = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.prepare(`
    INSERT INTO conversations (id, sdk_session_id, title, title_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z')
  `);
  insert.run('conv-legacy', null, 'Legacy', 'auto');
  insert.run('conv-busy', null, 'Busy legacy', 'auto');
  insert.run('conv-bound', 'sdk-bound', 'Bound', 'auto');
  insert.run('conv-manual', 'sdk-manual', 'Named', 'manual');
  db.prepare(`
    INSERT INTO queue (conversation_id, text, status, timestamp)
    VALUES ('conv-busy', 'still queued', 'pending', '2026-10-01T10:00:00.000Z')
  `).run();

  const store = createMemoryPreviewStore();
  const registry = createPreviewRegistry({
    config: normalizePreviewsConfig({ enabled: true, publicBaseUrl: 'https://preview.example.com' }, { env: {}, relayPort: 3333 }),
    store,
    logger: { log() {}, warn() {} },
  });
  const tokens = {};
  for (const id of ['conv-legacy', 'conv-busy', 'conv-bound', 'conv-manual']) {
    tokens[id] = registry.createStatic({ conversationId: id, rootDir: `/home/dev/${id}` }).preview.token;
  }
  tokens.none = registry.createStatic({ rootDir: '/home/dev/loose' }).preview.token;

  const service = createCacheRebuildService({
    db,
    stmts: {},
    io: { emit() {} },
    fs: null,
    path: null,
    uploadsDir: '',
    bootstrapRuntimeSessionBindings: () => 0,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => {},
    closeConversationPreviews: (id) => registry.closeForConversation(id),
    ...(gone ? { onConversationGone: (id, options) => gone.push([id, options]) } : {}),
  });
  const live = () => Object.entries(tokens).filter(([, token]) => registry.resolve(token)).map(([id]) => id).sort();
  const stored = () => store.list().map((row) => row.conversationId || 'none').sort();
  return { service, live, stored };
}

test('a reconcile closes the previews of the conversations it purges and keeps those it archives', () => {
  const fx = setup();
  const result = fx.service.rebuildCache({ mode: 'reconcile' });
  assert.deepEqual(result.summary.purgedConversationIds, ['conv-legacy']);
  assert.deepEqual(result.summary.archivedConversationIds, ['conv-busy']);
  assert.deepEqual(fx.live(), ['conv-bound', 'conv-busy', 'conv-manual', 'none']);
  assert.deepEqual(fx.stored(), ['conv-bound', 'conv-busy', 'conv-manual', 'none']);
});

test('a full wipe closes the previews of every conversation it removes and keeps the named ones', () => {
  const fx = setup();
  fx.service.rebuildCache({ mode: 'full' });
  assert.deepEqual(fx.live(), ['conv-manual', 'none']);
  assert.deepEqual(fx.stored(), ['conv-manual', 'none']);
});

test('a failing preview hook does not fail the rebuild', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES ('conv-legacy', 'Legacy', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z')
  `).run();
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(String(line));
  try {
    const service = createCacheRebuildService({
      db,
      stmts: {},
      io: { emit() {} },
      bootstrapRuntimeSessionBindings: () => 0,
      collectOrphanedUploadsFromConversation: () => [],
      deleteOrphanedUploads: () => {},
      closeConversationPreviews: () => { throw new Error('registry gone'); },
    });
    assert.deepEqual(service.rebuildCache({ mode: 'reconcile' }).summary.purgedConversationIds, ['conv-legacy']);
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((line) => /purged conversation failed: registry gone/.test(line)));
});

test('the conversations a rebuild archives or removes are passed on (their relay schedules end)', () => {
  const reconciled = [];
  setup({ gone: reconciled }).service.rebuildCache({ mode: 'reconcile' });
  assert.deepEqual(reconciled, [['conv-busy', { deleted: false }], ['conv-legacy', { deleted: true }]]);
  const wiped = [];
  setup({ gone: wiped }).service.rebuildCache({ mode: 'full' });
  assert.deepEqual(wiped.map(([id, options]) => [id, options.deleted]).sort(), [['conv-bound', true], ['conv-busy', true], ['conv-legacy', true]]);
  // A hook that throws does not fail the rebuild.
  const fx = setup({ gone: { push() { throw new Error('hook failed'); } } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => fx.service.rebuildCache({ mode: 'reconcile' }));
  } finally {
    console.warn = warn;
  }
});
