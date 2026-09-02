import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSdkSessionImportService } from './sdk-session-import-service.mjs';

function makeHarness({ eventsBySession = {}, failSessions = new Set(), sessionMetadata = {} } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'auto',
      sdk_session_id TEXT, configured_workspace_root_path TEXT, runtime_workspace_root_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, timestamp TEXT NOT NULL
    );
    CREATE TABLE deleted_sdk_sessions (sdk_session_id TEXT PRIMARY KEY);
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_type TEXT,
      created_at TEXT, last_used_at TEXT
    );
    CREATE TABLE relay_session_links (
      sdk_session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE sdk_session_imports (
      sdk_session_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT,
      source_started_at TEXT, source_modified_at TEXT, updated_at TEXT NOT NULL, last_error TEXT
    );
  `);
  const stmts = {
    getDeletedSdkSession: db.prepare(`SELECT sdk_session_id FROM deleted_sdk_sessions WHERE sdk_session_id = ?`),
    getRelaySessionLink: db.prepare(`SELECT * FROM relay_session_links WHERE sdk_session_id = ?`),
    getRuntimeSessionByConversation: db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ? ORDER BY last_used_at DESC LIMIT 1`),
    getConvBySdkSessionId: db.prepare(`SELECT * FROM conversations WHERE sdk_session_id = ? ORDER BY updated_at DESC LIMIT 1`),
    getSdkSessionImport: db.prepare(`SELECT * FROM sdk_session_imports WHERE sdk_session_id = ?`),
    upsertSdkSessionImport: db.prepare(`INSERT INTO sdk_session_imports (sdk_session_id, conversation_id, status, attempt_count, updated_at) VALUES (?, ?, 'pending', 0, ?) ON CONFLICT(sdk_session_id) DO NOTHING`),
    claimSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET status = 'processing', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?, last_error = NULL WHERE sdk_session_id = ? AND (? = 1 OR status != 'completed') AND status != 'processing'`),
    completeSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET conversation_id = ?, status = 'completed', completed_at = ?, source_started_at = ?, source_modified_at = ?, updated_at = ?, last_error = NULL WHERE sdk_session_id = ?`),
    failSdkSessionImport: db.prepare(`UPDATE sdk_session_imports SET status = 'failed', updated_at = ?, last_error = ? WHERE sdk_session_id = ?`),
    resetInterruptedSdkSessionImports: db.prepare(`UPDATE sdk_session_imports SET status = 'failed', updated_at = ?, last_error = 'Interrupted before import completion' WHERE status = 'processing'`),
  };
  const resumed = [];
  const resumeConfigs = [];
  const client = {
    async listSessions() {
      return Object.keys(eventsBySession).map((sessionId) => ({
        sessionId,
        metadata: {
          title: `Title ${sessionId}`,
          ...(sessionMetadata[sessionId] || {}),
        },
      }));
    },
    async resumeSession(sessionId, config) {
      resumed.push(sessionId);
      resumeConfigs.push(config);
      if (failSessions.has(sessionId)) throw new Error(`resume failed: ${sessionId}`);
      return { async getEvents() { return eventsBySession[sessionId]; }, async dispose() {} };
    },
  };
  const replaced = [];
  const service = createSdkSessionImportService({
    db,
    stmts,
    createClient: async () => ({ client, async dispose() {} }),
    parseSessionEventsToMessages: (events) => events.map((event) => ({ id: event.id, role: event.role, text: event.text })),
    replaceRetrievableHistory: (conversationId, messages) => replaced.push({ conversationId, messages }),
    ensureRuntimeSessionBinding: () => null,
    logger: { info() {} },
  });
  return { db, service, resumed, resumeConfigs, replaced, eventsBySession, sessionMetadata };
}

test('imports all SDK sessions sequentially and skips unchanged ledger rows', async () => {
  const { db, service, resumed, resumeConfigs, replaced } = makeHarness({
    eventsBySession: {
      first: [{ id: 'm1', role: 'user', text: 'first' }],
      second: [{ id: 'm2', role: 'user', text: 'second' }],
    },
  });
  const first = await service.runStartupImport();
  assert.deepEqual(first, { listed: 2, new: 2, changed: 0, unchanged: 0, failed: 0, tombstoned: 0, 'relay-owned': 0, 'bound-elsewhere': 0 });
  assert.deepEqual(resumed, ['first', 'second']);
  assert.deepEqual(resumeConfigs, [
    { suppressResumeEvent: true, availableTools: [] },
    { suppressResumeEvent: true, availableTools: [] },
  ]);
  assert.equal(replaced.length, 2);

  const second = await service.runStartupImport();
  assert.deepEqual(second, { listed: 2, new: 0, changed: 0, unchanged: 2, failed: 0, tombstoned: 0, 'relay-owned': 0, 'bound-elsewhere': 0 });
  assert.deepEqual(resumed, ['first', 'second']);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get().count, 2);
});

test('preserves SDK start and modified timestamps when importing', async () => {
  const { db, service } = makeHarness({
    eventsBySession: {
      dated: [{ id: 'm1', role: 'user', text: 'timestamp test' }],
    },
    sessionMetadata: {
      dated: {
        startTime: '2026-07-10T09:00:00.000Z',
        modifiedTime: '2026-07-11T10:30:00.000Z',
      },
    },
  });

  await service.runStartupImport();

  assert.deepEqual(
    db.prepare(`
      SELECT c.created_at, c.updated_at, i.source_started_at, i.source_modified_at
      FROM conversations c
      JOIN sdk_session_imports i ON i.sdk_session_id = c.id
      WHERE c.id = 'dated'
    `).get(),
    {
      created_at: '2026-07-10T09:00:00.000Z',
      updated_at: '2026-07-11T10:30:00.000Z',
      source_started_at: '2026-07-10T09:00:00.000Z',
      source_modified_at: '2026-07-11T10:30:00.000Z',
    },
  );
});

test('re-imports a newer SDK snapshot and preserves manual relay titles', async () => {
  const { db, service, resumed, replaced, eventsBySession, sessionMetadata } = makeHarness({
    eventsBySession: { changed: [{ id: 'm1', role: 'user', text: 'before' }] },
    sessionMetadata: {
      changed: {
        title: 'SDK title',
        startTime: new Date('2026-07-10T09:00:00.000Z'),
        modifiedTime: new Date('2026-07-11T10:30:00.000Z'),
      },
    },
  });
  await service.runStartupImport();
  db.prepare(`UPDATE conversations SET title = 'My title', title_source = 'manual' WHERE id = 'changed'`).run();
  eventsBySession.changed = [{ id: 'm2', role: 'user', text: 'after' }];
  sessionMetadata.changed.modifiedTime = '2026-07-12T10:30:00.000Z';

  const summary = await service.runStartupImport();

  assert.deepEqual(summary, { listed: 1, new: 0, changed: 1, unchanged: 0, failed: 0, tombstoned: 0, 'relay-owned': 0, 'bound-elsewhere': 0 });
  assert.deepEqual(resumed, ['changed', 'changed']);
  assert.deepEqual(replaced.at(-1), {
    conversationId: 'changed',
    messages: [{ id: 'm2', role: 'user', text: 'after' }],
  });
  assert.deepEqual(
    db.prepare(`SELECT title, title_source, updated_at FROM conversations WHERE id = 'changed'`).get(),
    { title: 'My title', title_source: 'manual', updated_at: '2026-07-12T10:30:00.000Z' },
  );
});

test('does not re-import older or malformed SDK modification timestamps', async () => {
  const { service, resumed, sessionMetadata } = makeHarness({
    eventsBySession: { stable: [{ id: 'm1', role: 'user', text: 'stable' }] },
    sessionMetadata: {
      stable: {
        modifiedTime: '2026-07-11T10:30:00.000Z',
      },
    },
  });
  await service.runStartupImport();
  sessionMetadata.stable.modifiedTime = '2026-07-10T10:30:00.000Z';
  assert.equal((await service.runStartupImport()).unchanged, 1);
  sessionMetadata.stable.modifiedTime = 'not-a-date';
  assert.equal((await service.runStartupImport()).unchanged, 1);
  assert.deepEqual(resumed, ['stable']);
});

test('records failures and retries them on a later startup pass', async () => {
  const failSessions = new Set(['broken']);
  const { db, service, resumed } = makeHarness({
    eventsBySession: { broken: [{ id: 'm1', role: 'user', text: 'retry me' }] },
    failSessions,
  });
  const failed = await service.runStartupImport();
  assert.equal(failed.failed, 1);
  assert.equal(db.prepare(`SELECT status FROM sdk_session_imports WHERE sdk_session_id = 'broken'`).get().status, 'failed');

  failSessions.delete('broken');
  const retried = await service.runStartupImport();
  assert.equal(retried.new, 1);
  assert.deepEqual(resumed, ['broken', 'broken']);
  const row = db.prepare(`SELECT status, attempt_count FROM sdk_session_imports WHERE sdk_session_id = 'broken'`).get();
  assert.deepEqual(row, { status: 'completed', attempt_count: 2 });
});

test('an empty changed snapshot preserves existing history and retries later', async () => {
  const { db, service, resumed, replaced, eventsBySession, sessionMetadata } = makeHarness({
    eventsBySession: { protected: [{ id: 'm1', role: 'user', text: 'first' }] },
    sessionMetadata: { protected: { modifiedTime: '2026-07-11T10:30:00.000Z' } },
  });
  await service.runStartupImport();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, timestamp)
    VALUES ('stored', 'protected', 'user', 'do not erase', '2026-07-11T10:30:00.000Z')
  `).run();
  eventsBySession.protected = [];
  sessionMetadata.protected.modifiedTime = '2026-07-12T10:30:00.000Z';

  const summary = await service.runStartupImport();

  assert.equal(summary.failed, 1);
  assert.equal(replaced.length, 1);
  assert.equal(db.prepare(`SELECT text FROM messages WHERE id = 'stored'`).get().text, 'do not erase');
  assert.equal(db.prepare(`SELECT status FROM sdk_session_imports WHERE sdk_session_id = 'protected'`).get().status, 'failed');
  assert.deepEqual(resumed, ['protected', 'protected']);
});

test('forced refresh bypasses the timestamp skip decision', async () => {
  const { service, resumed } = makeHarness({
    eventsBySession: { refresh: [{ id: 'm1', role: 'user', text: 'refresh' }] },
    sessionMetadata: { refresh: { modifiedTime: '2026-07-11T10:30:00.000Z' } },
  });
  await service.runStartupImport();

  const result = await service.importSession({
    sessionId: 'refresh',
    metadata: { modifiedTime: '2026-07-11T10:30:00.000Z' },
  }, { force: true });

  assert.equal(result.status, 'completed');
  assert.deepEqual(resumed, ['refresh', 'refresh']);
});

test('relay execution sessions are never imported as conversations', async () => {
  const { db, service, resumed } = makeHarness({
    eventsBySession: {
      'relay-vehicle': [{ id: 'm1', role: 'user', text: 'please proceed' }],
      'normal-cli': [{ id: 'm2', role: 'user', text: 'a real CLI session' }],
    },
  });
  // The relay reported that it created 'relay-vehicle' to execute turns for an
  // existing conversation.
  db.prepare(`INSERT INTO relay_session_links (sdk_session_id, conversation_id, created_at) VALUES (?, ?, ?)`)
    .run('relay-vehicle', 'existing-conversation', '2026-08-11T13:00:00.000Z');

  const summary = await service.runStartupImport();

  assert.equal(summary['relay-owned'], 1);
  assert.equal(summary.new, 1);
  assert.deepEqual(resumed, ['normal-cli']);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM conversations WHERE id = 'relay-vehicle'`).get().count, 0);
});

test('a conversation the relay executes under its own id is never re-imported', async () => {
  // The SDK-engine workers use the relay conversation id AS the CLI session
  // id, so the "different id" relay-vehicle guard above does not fire. The
  // runtime binding is the ownership signal (burn-in incident 2026-08-31:
  // the import overwrote relay history with the raw runtime transcript,
  // instruction preambles surfacing as user bubbles and titles).
  const { db, service, resumed } = makeHarness({
    eventsBySession: {
      'sdk-owned-conv': [{ id: 'm1', role: 'user', text: '[Relay mode: autopilot] preamble' }],
    },
  });
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at)
    VALUES ('sdk-owned-conv', 'Timer test', 'sdk-owned-conv', '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, provider_type, created_at, last_used_at)
    VALUES ('rs-owned-1', 'sdk-owned-conv', 'github', '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z')
  `).run();

  const summary = await service.runStartupImport();

  assert.equal(summary['relay-owned'], 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id = 'sdk-owned-conv'`).get().c, 0);
  assert.equal(db.prepare(`SELECT title FROM conversations WHERE id = 'sdk-owned-conv'`).get().title, 'Timer test');
  assert.deepEqual(resumed, []);
});

test('sessions bound to an existing conversation under another id are not duplicated', async () => {
  const { db, service, resumed } = makeHarness({
    eventsBySession: {
      'bound-session': [{ id: 'm1', role: 'user', text: 'already visible elsewhere' }],
    },
  });
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at)
    VALUES ('owning-conversation', 'Owner', 'bound-session', '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z')
  `).run();

  const summary = await service.runStartupImport();

  assert.equal(summary['bound-elsewhere'], 1);
  assert.deepEqual(resumed, []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM conversations WHERE id = 'bound-session'`).get().count, 0);
});
