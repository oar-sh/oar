import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createSdkSessionImportService } from './sdk-session-import-service.mjs';

// The audit (#19) traced the frozen-after-first-import bug to a harness that
// stubbed binding creation to a no-op: production creates a real
// runtime_sessions row on import, and the old ownership guard then read that
// row as "the relay executes this conversation". This helper mirrors the
// import-relevant behavior of server-runtime's ensureRuntimeSessionBinding —
// reuse the conversation's binding or create one — so the tests see the same
// state production does.
function makeEnsureRuntimeSessionBinding(db) {
  const getByConversation = db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`);
  const touch = db.prepare(`UPDATE runtime_sessions SET model = ?, last_used_at = ?, status = 'active' WHERE id = ?`);
  const insert = db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id)
    VALUES (?, ?, 'isolated', ?, ?, 'active', ?, ?, ?)
  `);
  return (conversationId, model, nowIso, sdkSessionId = null) => {
    const existing = getByConversation.get(conversationId);
    if (existing?.id) {
      touch.run(model || null, nowIso, existing.id);
      return getByConversation.get(conversationId);
    }
    const id = `rs-${conversationId}`;
    insert.run(id, conversationId, id, model || null, nowIso, nowIso, sdkSessionId);
    return getByConversation.get(conversationId);
  };
}

function makeHarness({
  eventsBySession = {},
  failSessions = new Set(),
  sessionMetadata = {},
  hasRelayExecutionSignal = undefined,
  resumeGates = {},
  // Runs inside each runtime start: may wait on a gate or throw.
  beforeCreateClient = null,
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  const resumed = [];
  const resumeConfigs = [];
  const disconnected = [];
  const deletedSessions = [];
  let clientCreations = 0;
  let clientDisposals = 0;
  const client = {
    async deleteSession(sessionId) {
      deletedSessions.push(sessionId);
    },
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
      if (resumeGates[sessionId]) await resumeGates[sessionId];
      if (failSessions.has(sessionId)) throw new Error(`resume failed: ${sessionId}`);
      return {
        async getEvents() { return eventsBySession[sessionId]; },
        async disconnect() { disconnected.push(sessionId); },
      };
    },
  };
  const replaced = [];
  const service = createSdkSessionImportService({
    db,
    stmts,
    createClient: async () => {
      clientCreations += 1;
      await beforeCreateClient?.();
      return { client, async dispose() { clientDisposals += 1; } };
    },
    parseSessionEventsToMessages: (events) => events.map((event) => ({ id: event.id, role: event.role, text: event.text })),
    replaceRetrievableHistory: (conversationId, messages) => replaced.push({ conversationId, messages }),
    ensureRuntimeSessionBinding: makeEnsureRuntimeSessionBinding(db),
    ...(hasRelayExecutionSignal ? { hasRelayExecutionSignal } : {}),
    logger: { info() {} },
  });
  return {
    db,
    service,
    resumed,
    resumeConfigs,
    disconnected,
    deletedSessions,
    replaced,
    eventsBySession,
    sessionMetadata,
    counters: {
      get clientCreations() { return clientCreations; },
      get clientDisposals() { return clientDisposals; },
    },
  };
}

function importOrigin(db, sdkSessionId) {
  return db.prepare(`SELECT status, origin FROM sdk_session_imports WHERE sdk_session_id = ?`).get(sdkSessionId) || null;
}

test('imports all SDK sessions sequentially and skips unchanged ledger rows', async () => {
  const { db, service, resumed, resumeConfigs, replaced, disconnected } = makeHarness({
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
  // Every resumed session must be released with the SDK's disconnect() API.
  assert.deepEqual(disconnected, ['first', 'second']);
  // The import creates real runtime bindings and records that it owns them.
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM runtime_sessions`).get().c, 2);
  assert.deepEqual(importOrigin(db, 'first'), { status: 'completed', origin: 'imported' });

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

test('re-imports a newer SDK snapshot despite its own runtime binding', async () => {
  // Regression for audit #19: the first import creates a runtime binding, and
  // the old guard read ANY binding as relay ownership — so the source changing
  // upstream could never reach the relay again.
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
  assert.ok(db.prepare(`SELECT id FROM runtime_sessions WHERE conversation_id = 'changed'`).get());
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

test('forced refresh of an imported-only session re-imports through its real binding', async () => {
  const { db, service, resumed, replaced, eventsBySession } = makeHarness({
    eventsBySession: { refresh: [{ id: 'm1', role: 'user', text: 'refresh' }] },
    sessionMetadata: { refresh: { modifiedTime: '2026-07-11T10:30:00.000Z' } },
  });
  await service.runStartupImport();
  // The binding the first import created must not read as relay ownership.
  assert.ok(db.prepare(`SELECT id FROM runtime_sessions WHERE conversation_id = 'refresh'`).get());
  eventsBySession.refresh = [{ id: 'm2', role: 'user', text: 'refreshed upstream' }];

  const result = await service.refreshConversation({ id: 'refresh', sdk_session_id: 'refresh' });

  assert.equal(result.status, 'completed');
  assert.deepEqual(resumed, ['refresh', 'refresh']);
  assert.deepEqual(replaced.at(-1), {
    conversationId: 'refresh',
    messages: [{ id: 'm2', role: 'user', text: 'refreshed upstream' }],
  });
});

test('a failed refresh attempt does not surrender the session to the relay', async () => {
  // The ledger row flips to status 'failed' on a broken refresh while origin
  // stays 'imported' — ownership must follow origin, or one transient failure
  // would lock the conversation out of refresh forever.
  const failSessions = new Set();
  const { service, resumed } = makeHarness({
    eventsBySession: { flaky: [{ id: 'm1', role: 'user', text: 'imported' }] },
    failSessions,
  });
  await service.runStartupImport();
  failSessions.add('flaky');
  const failed = await service.refreshConversation({ id: 'flaky', sdk_session_id: 'flaky' });
  assert.equal(failed.status, 'failed');

  failSessions.delete('flaky');
  const retried = await service.refreshConversation({ id: 'flaky', sdk_session_id: 'flaky' });

  assert.equal(retried.status, 'completed');
  assert.deepEqual(resumed, ['flaky', 'flaky', 'flaky']);
});

test('a queued relay turn flips ownership durably and blocks re-import', async () => {
  const { db, service, resumed } = makeHarness({
    eventsBySession: { continued: [{ id: 'm1', role: 'user', text: 'imported' }] },
  });
  await service.runStartupImport();
  // The user continued the imported conversation in the relay.
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES ('q-1', 'continued', 'pending', 'continued', 'go on', '2026-07-12T10:00:00.000Z')
  `).run();

  const blocked = await service.refreshConversation({ id: 'continued', sdk_session_id: 'continued' });
  assert.equal(blocked.status, 'skipped');
  assert.equal(blocked.category, 'relay-owned');
  assert.deepEqual(importOrigin(db, 'continued'), { status: 'completed', origin: 'relay' });

  // The flip must outlive the queue row (rows are pruned): still relay-owned.
  db.prepare(`DELETE FROM queue WHERE id = 'q-1'`).run();
  const stillBlocked = await service.refreshConversation({ id: 'continued', sdk_session_id: 'continued' });
  assert.equal(stillBlocked.category, 'relay-owned');
  assert.deepEqual(resumed, ['continued']);
});

test('a live worker signal marks the session relay-owned', async () => {
  const liveWorkers = new Set();
  const { db, service, resumed } = makeHarness({
    eventsBySession: { worked: [{ id: 'm1', role: 'user', text: 'imported' }] },
    hasRelayExecutionSignal: (sdkSessionId) => liveWorkers.has(sdkSessionId),
  });
  await service.runStartupImport();
  liveWorkers.add('worked');

  const blocked = await service.refreshConversation({ id: 'worked', sdk_session_id: 'worked' });

  assert.equal(blocked.category, 'relay-owned');
  assert.deepEqual(importOrigin(db, 'worked'), { status: 'completed', origin: 'relay' });
  assert.deepEqual(resumed, ['worked']);
});

test('a session counts as imported-only until the relay runs it', async () => {
  // Deleting an imported-only conversation must leave its CLI session alone.
  // Continuing it in the relay writes nothing to the ledger, so the answer
  // has to come from the same evidence the import guard reads.
  const liveWorkers = new Set();
  const { db, service } = makeHarness({
    eventsBySession: {
      untouched: [{ id: 'm1', role: 'user', text: 'from the terminal' }],
      continued: [{ id: 'm2', role: 'user', text: 'from the terminal' }],
      launched: [{ id: 'm3', role: 'user', text: 'from the terminal' }],
    },
    hasRelayExecutionSignal: (sdkSessionId) => liveWorkers.has(sdkSessionId),
  });
  await service.runStartupImport();

  assert.equal(service.isImportedOnly('untouched'), true);
  assert.deepEqual(importOrigin(db, 'untouched'), { status: 'completed', origin: 'imported' });

  // A turn the relay queued, even one long finished, and the ledger flips
  // for good: pruning the row does not hand the session back.
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES ('q-1', 'continued', 'done', 'continued', 'go on', '2026-07-12T10:00:00.000Z')
  `).run();
  assert.equal(service.isImportedOnly('continued'), false);
  assert.deepEqual(importOrigin(db, 'continued'), { status: 'completed', origin: 'relay' });
  db.prepare(`DELETE FROM queue WHERE id = 'q-1'`).run();
  assert.equal(service.isImportedOnly('continued'), false);

  // A worker the relay started for it, before any turn.
  liveWorkers.add('launched');
  assert.equal(service.isImportedOnly('launched'), false);

  // A conversation the relay created has no ledger row.
  assert.equal(service.isImportedOnly('relay-born'), false);
  assert.equal(service.isImportedOnly(''), false);
});

test('a turn queued while the import reads events aborts the overwrite', async () => {
  const { db, service, replaced, eventsBySession } = makeHarness({
    eventsBySession: { raced: [{ id: 'm1', role: 'user', text: 'imported' }] },
    sessionMetadata: { raced: { modifiedTime: '2026-07-11T10:30:00.000Z' } },
  });
  await service.runStartupImport();
  // The relay enqueues while the import is reading SDK events: the
  // transaction-level re-check must refuse to replace relay history.
  eventsBySession.raced = {
    async *[Symbol.asyncIterator]() {
      db.prepare(`
        INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
        VALUES ('q-race', 'raced', 'pending', 'raced', 'racing turn', '2026-07-12T10:00:00.000Z')
      `).run();
      yield { id: 'm2', role: 'user', text: 'stale transcript' };
    },
  };

  const result = await service.refreshConversation({ id: 'raced', sdk_session_id: 'raced' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.category, 'relay-owned');
  assert.equal(result.reason, 'relay-claimed-during-import');
  assert.equal(replaced.length, 1);
  assert.deepEqual(importOrigin(db, 'raced'), { status: 'failed', origin: 'relay' });
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
  // id, so the "different id" relay-vehicle guard above does not fire. A
  // runtime binding with no completed import behind it means the relay created
  // it (burn-in incident 2026-08-31: the import overwrote relay history with
  // the raw runtime transcript, instruction preambles surfacing as user
  // bubbles and titles).
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
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, status, created_at, last_used_at, sdk_session_id)
    VALUES ('rs-owned-1', 'sdk-owned-conv', 'isolated', 'rs-owned-1', 'active', '2026-08-11T12:00:00.000Z', '2026-08-11T12:00:00.000Z', 'sdk-owned-conv')
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

test('shutdown during a multi-session import stops the sweep and never recreates the client', async () => {
  // Regression for audit #20: disposal used to clear the runtime without a
  // closing flag, so the next session in the active sweep observed
  // runtime = null and created a fresh SDK client while the server exited.
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const { service, resumed, counters } = makeHarness({
    eventsBySession: {
      one: [{ id: 'm1', role: 'user', text: 'one' }],
      two: [{ id: 'm2', role: 'user', text: 'two' }],
    },
    resumeGates: { one: firstGate },
  });

  const sweep = service.runStartupImport();
  // Wait until the first session's resume is actually in flight.
  while (resumed.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const disposal = service.dispose();
  releaseFirst();
  const summary = await sweep;
  await disposal;

  assert.equal(summary.new, 1);
  assert.deepEqual(resumed, ['one']);
  assert.equal(counters.clientCreations, 1);
  assert.equal(counters.clientDisposals, 1);

  // After disposal the importer must refuse work instead of reviving a client.
  const skipped = await service.importSession({ sessionId: 'two' });
  assert.equal(skipped.reason, 'importer-closing');
  const postShutdownSweep = await service.runStartupImport();
  assert.equal(postShutdownSweep.failed, 1);
  assert.match(String(postShutdownSweep.error), /shutting down/);
  assert.equal(counters.clientCreations, 1);
});

test('callers that arrive while the runtime starts share that one start', async () => {
  // A delete during the startup import, and deletes side by side, each used
  // to start a runtime of their own; only the last one was ever disposed.
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const { service, counters, deletedSessions, resumed } = makeHarness({
    eventsBySession: { listed: [{ id: 'm1', role: 'user', text: 'listed' }] },
    beforeCreateClient: () => startGate,
  });

  const sweep = service.runStartupImport();
  const deletes = [service.deleteSession('gone-1'), service.deleteSession('gone-2')];
  releaseStart();
  const [summary] = await Promise.all([sweep, ...deletes]);

  assert.equal(summary.new, 1);
  assert.deepEqual(resumed, ['listed']);
  assert.deepEqual([...deletedSessions].sort(), ['gone-1', 'gone-2']);
  assert.equal(counters.clientCreations, 1);
  await service.dispose();
  assert.equal(counters.clientDisposals, 1);
});

test('a runtime start that fails is not kept, so the next call starts again', async () => {
  const starts = ['fail', 'ok'];
  const { service, counters, deletedSessions } = makeHarness({
    beforeCreateClient: async () => {
      if (starts.shift() === 'fail') throw new Error('runtime unavailable');
    },
  });

  const outcomes = await Promise.allSettled([service.deleteSession('first'), service.deleteSession('second')]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
  assert.equal(counters.clientCreations, 1);

  await service.deleteSession('third');
  assert.equal(counters.clientCreations, 2);
  assert.deepEqual(deletedSessions, ['third']);
});

test('a runtime still starting at shutdown is disposed once it is up', async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const { service, counters } = makeHarness({ beforeCreateClient: () => startGate });

  const pendingDelete = service.deleteSession('late');
  const disposal = service.dispose();
  releaseStart();
  await Promise.allSettled([pendingDelete, disposal]);

  assert.equal(counters.clientCreations, 1);
  assert.equal(counters.clientDisposals, 1);
});
