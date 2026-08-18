import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createMessageRepository } from './message-repository.mjs';
import { dequeuePendingMessage, resolveExecutedProviderForResponse } from '../routes/messages-routes.mjs';
import { mapUsageSnapshotRow } from '../routes/sessions-routes.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT,
      sdk_session_id TEXT
    );

    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      sdk_session_id TEXT,
      status TEXT,
      provider_type TEXT NOT NULL DEFAULT 'github'
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      role TEXT,
      text TEXT,
      model TEXT,
      mode TEXT,
      attachments TEXT,
      model_requested TEXT,
      model_actual TEXT,
      model_origin TEXT,
      executed_provider TEXT,
      hidden_from_shares INTEGER NOT NULL DEFAULT 0,
      share_hidden_at TEXT,
      kind TEXT,
      timestamp TEXT
    );

    CREATE VIRTUAL TABLE messages_fts USING fts5(text);

    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      runtime_session_id TEXT,
      is_new_conversation INTEGER,
      model TEXT,
      model_variant_id TEXT,
      reasoning_effort TEXT,
      context_tier TEXT,
      relay_mode TEXT,
      text TEXT,
      attachments TEXT,
      status TEXT,
      timestamp TEXT,
      processing_at TEXT,
      response_message_id TEXT,
      response TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      owner_sdk_session_id TEXT,
      owner_assigned_at TEXT,
      owner_lease_expires_at TEXT,
      owner_last_claimed_at TEXT,
      parked_at TEXT,
      parked_target_session_id TEXT,
      parked_transaction_id TEXT,
      parked_reason TEXT,
      kind TEXT
    );

    CREATE TABLE message_usage_snapshots (
      response_message_id TEXT PRIMARY KEY,
      queue_message_id TEXT,
      conversation_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'live',
      stale INTEGER NOT NULL DEFAULT 0,
      premium_remaining REAL,
      premium_entitlement REAL,
      premium_used_percent REAL,
      premium_delta_used REAL,
      chat_remaining REAL,
      chat_entitlement REAL,
      chat_used_percent REAL,
      chat_delta_used REAL,
      plan_remaining REAL,
      plan_entitlement REAL,
      plan_used_percent REAL,
      plan_delta_used REAL,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE relay_questions (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE uploaded_files (
      sha256 TEXT PRIMARY KEY,
      original_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at TEXT
    );

    CREATE TABLE upload_refs (
      file_sha256 TEXT,
      conversation_id TEXT,
      message_id TEXT,
      created_at TEXT
    );
  `);
  return db;
}

test('message share visibility preserves owner history and filters shared history', () => {
  const db = createTestDb();
  const repository = createMessageRepository(db);
  db.prepare('INSERT INTO conversations (id, title, status) VALUES (?, ?, ?)').run('conv-1', 'Demo', 'active');
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, text, hidden_from_shares, timestamp
    ) VALUES (?, ?, ?, ?, 0, ?)
  `).run('msg-1', 'conv-1', 'user', 'private detail', '2026-01-01T00:00:00.000Z');

  repository.setMessageShareVisibility.run(1, '2026-01-01T00:01:00.000Z', 'msg-1', 'conv-1');
  assert.equal(repository.getMessages.all('conv-1').length, 1);
  assert.equal(repository.getSharedMessages.all('conv-1').length, 0);
  assert.equal(repository.getMessageByConversation.get('msg-1', 'conv-1')?.hidden_from_shares, 1);

  repository.setMessageShareVisibility.run(0, null, 'msg-1', 'conv-1');
  assert.equal(repository.getSharedMessages.all('conv-1').length, 1);
});

test('routed worker dequeue uses runtime session binding when queue owner is empty', () => {
  const db = createTestDb();
  const findPendingForWorker = db.prepare(`
    SELECT q.*
    FROM queue q
    LEFT JOIN runtime_sessions rs
      ON rs.id = q.runtime_session_id
    LEFT JOIN conversations c
      ON c.id = q.conversation_id
    WHERE q.status = 'pending'
      AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
      AND (
        COALESCE(
          NULLIF(q.owner_sdk_session_id, ''),
          NULLIF(rs.sdk_session_id, ''),
          NULLIF(c.sdk_session_id, '')
        ) IS NULL
        OR COALESCE(
          NULLIF(q.owner_sdk_session_id, ''),
          NULLIF(rs.sdk_session_id, ''),
          NULLIF(c.sdk_session_id, '')
        ) = ?
      )
    ORDER BY
      CASE
        WHEN COALESCE(
          NULLIF(q.owner_sdk_session_id, ''),
          NULLIF(rs.sdk_session_id, ''),
          NULLIF(c.sdk_session_id, '')
        ) = ? THEN 0
        ELSE 1
      END ASC,
      q.retry_count ASC,
      CASE WHEN q.next_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
      COALESCE(q.next_attempt_at, q.timestamp) ASC,
      q.timestamp ASC
    LIMIT 1
  `);
  const now = '2026-06-11T20:00:00.000Z';

  db.prepare('INSERT INTO conversations (id, title, status, sdk_session_id) VALUES (?, ?, ?, ?)').run(
    'conv-a',
    'Conversation A',
    'active',
    'sdk-a',
  );
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id) VALUES (?, ?, ?)').run(
    'runtime-a',
    'conv-a',
    'sdk-a',
  );
  db.prepare(`
    INSERT INTO queue (
      id, conversation_id, runtime_session_id, is_new_conversation, model,
      model_variant_id, reasoning_effort, relay_mode, text, attachments,
      status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id
    ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, NULL, 'pending', ?, 0, NULL, ?)
  `).run(
    'message-a',
    'conv-a',
    'runtime-a',
    'gpt-5.4-mini',
    'gpt-5.4-mini',
    'agent',
    'test',
    now,
    '',
  );

  const matchingWorkerRow = findPendingForWorker.get(now, 'sdk-a', 'sdk-a');
  assert.equal(matchingWorkerRow?.id, 'message-a');

  const wrongWorkerRow = findPendingForWorker.get(now, 'sdk-b', 'sdk-b');
  assert.equal(wrongWorkerRow, undefined);
});

test('repository lists pending worker owners including rows still in retry backoff', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);
  const now = '2026-06-11T20:00:00.000Z';

  db.prepare('INSERT INTO conversations (id, title, status, sdk_session_id) VALUES (?, ?, ?, ?)').run(
    'conv-owned',
    'Owned',
    'active',
    'conv-sdk',
  );
  db.prepare('INSERT INTO conversations (id, title, status, sdk_session_id) VALUES (?, ?, ?, ?)').run(
    'conv-runtime',
    'Runtime',
    'active',
    '',
  );
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id) VALUES (?, ?, ?)').run(
    'runtime-owned',
    'conv-owned',
    'runtime-sdk-ignored',
  );
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id) VALUES (?, ?, ?)').run(
    'runtime-bound',
    'conv-runtime',
    'runtime-sdk',
  );

  const insert = db.prepare(`
    INSERT INTO queue (
      id, conversation_id, runtime_session_id, is_new_conversation, model,
      model_variant_id, reasoning_effort, relay_mode, text, attachments,
      status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id
    ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?, NULL, ?, ?, 0, ?, ?)
  `);
  insert.run('message-owned', 'conv-owned', 'runtime-owned', 'gpt-5.4-mini', 'gpt-5.4-mini', 'agent', 'owned', 'pending', now, null, 'owner-sdk');
  insert.run('message-runtime', 'conv-runtime', 'runtime-bound', 'gpt-5.4-mini', 'gpt-5.4-mini', 'agent', 'runtime', 'pending', '2026-06-11T20:00:01.000Z', null, '');
  insert.run('message-later', 'conv-runtime', 'runtime-bound', 'gpt-5.4-mini', 'gpt-5.4-mini', 'agent', 'later', 'pending', now, '2026-06-11T21:00:00.000Z', 'later-sdk');
  insert.run('message-processing', 'conv-runtime', 'runtime-bound', 'gpt-5.4-mini', 'gpt-5.4-mini', 'agent', 'processing', 'processing', now, null, 'processing-sdk');

  // 'later-sdk' sits in a retry backoff window (next_attempt_at in the future)
  // and must still be listed: its worker needs to be warm before the backoff
  // matures, or the relay's faster poll claims the row first.
  const owners = repo.listPendingWorkerOwnerSessionIds.all(10).map((row) => row.sdk_session_id);
  assert.deepEqual([...owners].sort(), ['later-sdk', 'owner-sdk', 'runtime-sdk']);
});

// ─── Legacy-relay dequeue scoping ─────────────────────────────────────────────
// The Copilot relay CLI polls /api/pending without a session identity and used
// to fall through to the unscoped global queue. That let it claim and execute
// cursor/claude/grok conversations' turns on the Copilot plan (the model id is
// passed verbatim, and ids like claude-opus-5 exist on both sides).

function seedProviderConversation(db, { key, providerType, ownerSdkSessionId = '', timestamp }) {
  db.prepare('INSERT INTO conversations (id, title, status, sdk_session_id) VALUES (?, ?, ?, ?)')
    .run(`conv-${key}`, key, 'active', ownerSdkSessionId);
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, provider_type) VALUES (?, ?, ?, ?)')
    .run(`runtime-${key}`, `conv-${key}`, ownerSdkSessionId, providerType);
  db.prepare(`
    INSERT INTO queue (
      id, conversation_id, runtime_session_id, is_new_conversation, model,
      model_variant_id, reasoning_effort, relay_mode, text, attachments,
      status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id
    ) VALUES (?, ?, ?, 0, 'claude-opus-5', 'claude-opus-5', NULL, 'agent', ?, NULL, 'pending', ?, 0, NULL, ?)
  `).run(`message-${key}`, `conv-${key}`, `runtime-${key}`, key, timestamp, ownerSdkSessionId);
}

test('legacy-relay dequeue never returns rows bound to a session-worker provider', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);
  const now = '2026-08-11T13:00:00.000Z';

  seedProviderConversation(db, { key: 'cursor', providerType: 'cursor', ownerSdkSessionId: 'conv-cursor', timestamp: '2026-08-11T12:00:00.000Z' });
  seedProviderConversation(db, { key: 'claude', providerType: 'claude', ownerSdkSessionId: 'conv-claude', timestamp: '2026-08-11T12:00:01.000Z' });
  seedProviderConversation(db, { key: 'grok', providerType: 'grok', ownerSdkSessionId: 'conv-grok', timestamp: '2026-08-11T12:00:02.000Z' });

  // The cursor/claude/grok rows are older, but the relay must skip them all.
  assert.equal(repo.findPendingForLegacyRelay.get(now), undefined);

  // An owned github row is a session worker's job too: the worker is starting
  // up, and the relay polls far faster than a worker boots.
  seedProviderConversation(db, { key: 'github-owned', providerType: 'github', ownerSdkSessionId: 'copilot-sdk', timestamp: '2026-08-11T12:00:03.000Z' });
  assert.equal(repo.findPendingForLegacyRelay.get(now), undefined);

  // Unowned (routing disabled, or no worker responsible) is the relay's work.
  seedProviderConversation(db, { key: 'github', providerType: 'github', timestamp: '2026-08-11T12:00:04.000Z' });
  assert.equal(repo.findPendingForLegacyRelay.get(now)?.id, 'message-github');
});

test('legacy-relay dequeue leaves an owned openai row to its worker', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);
  const now = '2026-08-11T13:00:00.000Z';

  // The live regression: an OpenAI image turn owned by a booting worker was
  // grabbed by the relay ~0.3s after the worker spawned, failed (gpt-image-*
  // is not a Copilot model) and burned a retry plus a 60s backoff.
  seedProviderConversation(db, { key: 'openai-owned', providerType: 'openai', ownerSdkSessionId: 'conv-openai-owned', timestamp: '2026-08-11T12:00:00.000Z' });
  assert.equal(repo.findPendingForLegacyRelay.get(now), undefined);

  // The owning worker still claims it through the routed path.
  const claimed = dequeuePendingMessage({
    db,
    stmts: repo,
    nowIso: now,
    routingEnabled: true,
    requesterSessionId: 'conv-openai-owned',
  });
  assert.equal(claimed?.id, 'message-openai-owned');
});

test('legacy-relay dequeue serves openai rows and rows with no runtime session', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);
  const now = '2026-08-11T13:00:00.000Z';

  seedProviderConversation(db, { key: 'openai', providerType: 'openai', timestamp: '2026-08-11T12:00:00.000Z' });
  assert.equal(repo.findPendingForLegacyRelay.get(now)?.id, 'message-openai');

  // No runtime session at all (brand-new conversation): defaults to github.
  db.prepare('INSERT INTO conversations (id, title, status, sdk_session_id) VALUES (?, ?, ?, ?)')
    .run('conv-fresh', 'fresh', 'active', '');
  db.prepare(`
    INSERT INTO queue (
      id, conversation_id, runtime_session_id, is_new_conversation, model,
      model_variant_id, reasoning_effort, relay_mode, text, attachments,
      status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id
    ) VALUES ('message-fresh', 'conv-fresh', NULL, 1, 'gpt-5.4-mini', 'gpt-5.4-mini', NULL, 'agent', 'fresh', NULL, 'pending', '2026-08-11T11:00:00.000Z', 0, NULL, '')
  `).run();
  assert.equal(repo.findPendingForLegacyRelay.get(now)?.id, 'message-fresh');
});

test('anonymous dequeue skips provider-worker rows but the owning worker still gets them', () => {
  const db = createTestDb();
  const stmts = createMessageRepository(db);
  const now = '2026-08-11T13:00:00.000Z';

  seedProviderConversation(db, { key: 'cursor', providerType: 'cursor', ownerSdkSessionId: 'conv-cursor', timestamp: '2026-08-11T12:00:00.000Z' });

  // The relay CLI: routing on, no x-relay-session-id. Must come up empty even
  // though a pending row exists.
  const stolen = dequeuePendingMessage({
    db,
    stmts,
    nowIso: now,
    routingEnabled: true,
    requesterSessionId: null,
  });
  assert.equal(stolen, null);
  assert.equal(db.prepare(`SELECT status FROM queue WHERE id = 'message-cursor'`).get().status, 'pending');

  // The cursor worker itself claims it normally.
  const claimed = dequeuePendingMessage({
    db,
    stmts,
    nowIso: now,
    routingEnabled: true,
    requesterSessionId: 'conv-cursor',
  });
  assert.equal(claimed?.id, 'message-cursor');
  assert.equal(claimed?.status, 'processing');
});

test('executed provider derives from responder identity, never from the response payload', () => {
  const db = createTestDb();
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, provider_type) VALUES (?, ?, ?, ?)')
    .run('runtime-cursor', 'conv-cursor', 'cursor-session', 'cursor');
  const stmts = {
    getRuntimeSessionBySdkSessionId: db.prepare('SELECT * FROM runtime_sessions WHERE sdk_session_id = ?'),
  };

  // A cursor worker answering: its bridge identity resolves to its provider.
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: { sessionId: 'cursor-session' },
  }), 'cursor');

  // No bridge identity = the legacy Copilot relay, which owns github turns.
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: null,
    conversationProvider: 'github',
  }), 'github');
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: { sessionId: '' },
    conversationProvider: '',
  }), 'github');

  // A bridge session id that names no runtime row proves nothing: it must not
  // fabricate a mismatch by claiming github.
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: { sessionId: 'never-registered' },
    conversationProvider: 'github',
  }), 'unknown');
});

test('a server-executed image operation is credited to the conversation provider', () => {
  const db = createTestDb();
  const stmts = {
    getRuntimeSessionBySdkSessionId: db.prepare('SELECT * FROM runtime_sessions WHERE sdk_session_id = ?'),
  };

  // The OpenAI BYOK image path: this server calls the OpenAI API with the
  // conversation's own key, then finalizes through a self-post that carries no
  // bridge headers. Flagging that as a github crossover was the false alarm.
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: null,
    conversationProvider: 'openai',
    serverExecutedOperation: true,
  }), 'openai');
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: null,
    conversationProvider: 'OpenAI ',
    serverExecutedOperation: true,
  }), 'openai');
});

test('an identity-less response for a non-github conversation still reports github', () => {
  const db = createTestDb();
  const stmts = {
    getRuntimeSessionBySdkSessionId: db.prepare('SELECT * FROM runtime_sessions WHERE sdk_session_id = ?'),
  };

  // The theft case. server/relay.mjs is the only identity-less responder for a
  // normal turn and it is launched with plain env, so it runs on the Copilot plan
  // whatever the conversation is bound to. openai belongs in this list: a BYOK
  // chat turn answered without an identity did NOT use the BYOK key.
  for (const provider of ['cursor', 'claude', 'grok', 'openai']) {
    assert.equal(resolveExecutedProviderForResponse({
      stmts,
      responseBridgeIdentity: null,
      conversationProvider: provider,
    }), 'github', `expected ${provider} theft to be reported as github`);
  }

  // An OpenAI BYOK chat turn from its properly configured worker carries an
  // identity and resolves through the runtime row instead.
  db.prepare('INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, provider_type) VALUES (?, ?, ?, ?)')
    .run('runtime-openai', 'conv-openai', 'openai-session', 'openai');
  assert.equal(resolveExecutedProviderForResponse({
    stmts,
    responseBridgeIdentity: { sessionId: 'openai-session' },
    conversationProvider: 'openai',
  }), 'openai');
});

test('legacy-relay dequeue respects retry backoff windows', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);

  seedProviderConversation(db, { key: 'github', providerType: 'github', timestamp: '2026-08-11T12:00:00.000Z' });
  db.prepare(`UPDATE queue SET next_attempt_at = '2026-08-11T14:00:00.000Z' WHERE id = 'message-github'`).run();

  assert.equal(repo.findPendingForLegacyRelay.get('2026-08-11T13:00:00.000Z'), undefined);
  assert.equal(repo.findPendingForLegacyRelay.get('2026-08-11T14:00:01.000Z')?.id, 'message-github');
});

test('mapUsageSnapshotRow exposes turn delta credits and monthly remaining context', () => {
  const mapped = mapUsageSnapshotRow({
    source: 'live',
    stale: 0,
    captured_at: '2026-07-05T12:00:00.000Z',
    premium_remaining: 980,
    premium_entitlement: 1000,
    premium_used_percent: 2,
    premium_delta_used: 20,
    chat_remaining: null,
    chat_entitlement: null,
    chat_used_percent: null,
    chat_delta_used: null,
    plan_remaining: 90,
    plan_entitlement: 100,
    plan_used_percent: 10,
    plan_delta_used: 5,
  });

  assert.equal(mapped.premium.deltaCredits, 20);
  assert.equal(mapped.plan.deltaMonthlyPercent, 5);
  assert.equal(mapped.plan.percentRemaining, 90);
});

// ─── Stale-turn recovery ──────────────────────────────────────────────────────
// Staleness is inactivity (worker heartbeats refresh owner_last_claimed_at), not
// elapsed turn time. Before this, the sweep compared processing_at — the moment
// the turn started — so any turn running longer than the window was requeued
// mid-flight and its in-flight reply bubble was torn down client-side.

const RECOVERY_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const RECOVERY_HOUR_MS = 60 * 60_000;

function recoveryIsoAgo(ms) {
  return new Date(RECOVERY_NOW_MS - ms).toISOString();
}

function createRecoveryFixture() {
  const db = createTestDb();
  const stmts = createMessageRepository(db);
  const insertTurn = db.prepare(`
    INSERT INTO queue (id, conversation_id, status, timestamp, processing_at, owner_sdk_session_id, owner_last_claimed_at)
    VALUES (@id, 'conv-1', 'processing', @timestamp, @processingAt, @owner, @lastClaimedAt)
  `);
  return {
    db,
    stmts,
    addTurn({ id, startedMsAgo, lastHeartbeatMsAgo = null, owned = true }) {
      insertTurn.run({
        id,
        timestamp: recoveryIsoAgo(startedMsAgo),
        processingAt: recoveryIsoAgo(startedMsAgo),
        owner: owned ? 'session-1' : null,
        lastClaimedAt: lastHeartbeatMsAgo === null ? null : recoveryIsoAgo(lastHeartbeatMsAgo),
      });
    },
    askQuestion(queueId, status = 'pending') {
      db.prepare(`INSERT INTO relay_questions (id, queue_id, status) VALUES (?, ?, ?)`)
        .run(`question-${queueId}`, queueId, status);
    },
    recoverable({ inactiveMinutes = 10, ceilingMinutes = null } = {}) {
      return stmts.listRecoverableProcessing.all({
        inactiveBefore: recoveryIsoAgo(inactiveMinutes * 60_000),
        ceilingBefore: ceilingMinutes === null ? null : recoveryIsoAgo(ceilingMinutes * 60_000),
      }).map((row) => row.id);
    },
  };
}

test('a long turn survives as long as its worker keeps heartbeating', () => {
  const fixture = createRecoveryFixture();
  // The exact regression: 90 minutes of work, last heartbeat 5 seconds ago.
  fixture.addTurn({ id: 'q-live', startedMsAgo: 90 * 60_000, lastHeartbeatMsAgo: 5_000 });
  assert.deepEqual(fixture.recoverable(), []);
});

test('a turn whose worker went silent is recovered', () => {
  const fixture = createRecoveryFixture();
  fixture.addTurn({ id: 'q-dead', startedMsAgo: 90 * 60_000, lastHeartbeatMsAgo: 30 * 60_000 });
  assert.deepEqual(fixture.recoverable(), ['q-dead']);
});

test('an unowned turn still falls back to its start time', () => {
  const fixture = createRecoveryFixture();
  // Session-worker routing disabled: no heartbeat ever names the message.
  fixture.addTurn({ id: 'q-unowned-old', startedMsAgo: 30 * 60_000, owned: false });
  fixture.addTurn({ id: 'q-unowned-new', startedMsAgo: 60_000, owned: false });
  assert.deepEqual(fixture.recoverable(), ['q-unowned-old']);
});

test('a turn waiting on an unanswered question is never recovered', () => {
  const fixture = createRecoveryFixture();
  // Silent for hours and far past any ceiling — but it is waiting on the human,
  // and relay_questions carries its own (8 hour) expiry.
  fixture.addTurn({ id: 'q-interview', startedMsAgo: 5 * RECOVERY_HOUR_MS, lastHeartbeatMsAgo: 5 * RECOVERY_HOUR_MS });
  fixture.askQuestion('q-interview');
  assert.deepEqual(fixture.recoverable({ inactiveMinutes: 10, ceilingMinutes: 60 }), []);
});

test('once the question is answered the turn is eligible again', () => {
  const fixture = createRecoveryFixture();
  fixture.addTurn({ id: 'q-answered', startedMsAgo: 5 * RECOVERY_HOUR_MS, lastHeartbeatMsAgo: 5 * RECOVERY_HOUR_MS });
  fixture.askQuestion('q-answered', 'answered');
  assert.deepEqual(fixture.recoverable(), ['q-answered']);
});

test('the ceiling catches a turn that is hung but still heartbeating', () => {
  const fixture = createRecoveryFixture();
  fixture.addTurn({ id: 'q-hung', startedMsAgo: 3 * RECOVERY_HOUR_MS, lastHeartbeatMsAgo: 5_000 });
  assert.deepEqual(fixture.recoverable({ ceilingMinutes: 60 }), ['q-hung']);
  // A ceiling longer than the turn leaves it alone.
  assert.deepEqual(fixture.recoverable({ ceilingMinutes: 600 }), []);
});

test('a null ceiling disables the elapsed-time cap entirely', () => {
  const fixture = createRecoveryFixture();
  fixture.addTurn({ id: 'q-marathon', startedMsAgo: 9 * RECOVERY_HOUR_MS, lastHeartbeatMsAgo: 5_000 });
  assert.deepEqual(fixture.recoverable({ ceilingMinutes: null }), []);
});

test('recovery keeps ownership and requeues exactly the stale rows', () => {
  const fixture = createRecoveryFixture();
  fixture.addTurn({ id: 'q-live', startedMsAgo: 90 * 60_000, lastHeartbeatMsAgo: 5_000 });
  fixture.addTurn({ id: 'q-dead', startedMsAgo: 90 * 60_000, lastHeartbeatMsAgo: 30 * 60_000 });
  const requeueAt = recoveryIsoAgo(0);

  fixture.stmts.recoverProcessingBefore.run({
    inactiveBefore: recoveryIsoAgo(10 * 60_000),
    ceilingBefore: null,
    requeueAt,
  });

  const rows = fixture.db
    .prepare(`SELECT id, status, processing_at, owner_sdk_session_id, next_attempt_at FROM queue ORDER BY id`)
    .all();
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [['q-dead', 'pending'], ['q-live', 'processing']]);

  const dead = rows.find((row) => row.id === 'q-dead');
  assert.equal(dead.processing_at, null);
  // The owner survives recovery: the row stays routed to its provider worker
  // (which the primer respawns) instead of becoming claimable by the global
  // relay poll — that steal is how a Cursor turn once ran on the Copilot plan.
  assert.equal(dead.owner_sdk_session_id, 'session-1');
  assert.equal(dead.next_attempt_at, requeueAt);

  const live = rows.find((row) => row.id === 'q-live');
  assert.notEqual(live.processing_at, null);
  assert.equal(live.owner_sdk_session_id, 'session-1');
});

test('active-turn lookup reports only conversations with live queue rows', () => {
  const db = createTestDb();
  const repo = createMessageRepository(db);
  const insert = db.prepare(`
    INSERT INTO queue (id, conversation_id, status, timestamp) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
  `);
  insert.run('q-processing', 'conv-busy', 'processing');
  insert.run('q-pending', 'conv-queued', 'pending');
  insert.run('q-parked', 'conv-parked', 'parked');
  insert.run('q-done', 'conv-idle', 'done');
  insert.run('q-failed', 'conv-failed', 'failed');
  // A second live row must not duplicate its conversation.
  insert.run('q-processing-2', 'conv-busy', 'processing');

  const ids = repo.listConversationIdsWithActiveQueue.all().map((row) => row.conversation_id).sort();
  assert.deepEqual(ids, ['conv-busy', 'conv-parked', 'conv-queued']);
});

// ─── Background-continuation rows ─────────────────────────────────────────────
// Synthetic turns for the Claude worker's background-task continuations: born
// 'processing' and owned by their session worker. They must never be handed
// out as deliverable work — a replay would send the CLI's own continuation
// text back to the CLI as a user prompt — so recovery tears them down instead.

function insertContinuationRow(stmts, { id = 'q-cont', lastClaimedAgoMs = 0 } = {}) {
  const now = recoveryIsoAgo(lastClaimedAgoMs);
  stmts.insertContinuationQ.run(
    id,
    'conv-1',
    null,
    null,
    'agent',
    '[background continuation]',
    now,
    now,
    'session-1',
    now,
    now,
    now,
  );
}

test('a continuation row is born processing, owned, and never deliverable', () => {
  const db = createTestDb();
  const stmts = createMessageRepository(db);
  insertContinuationRow(stmts, { id: 'q-cont' });

  const row = db.prepare(`SELECT * FROM queue WHERE id = 'q-cont'`).get();
  assert.equal(row.status, 'processing');
  assert.equal(row.kind, 'continuation');
  assert.equal(row.owner_sdk_session_id, 'session-1');

  // Even if something flips it to pending, no delivery path may return it.
  db.prepare(`UPDATE queue SET status = 'pending' WHERE id = 'q-cont'`).run();
  const nowIso = recoveryIsoAgo(-60_000);
  assert.equal(stmts.findPending.get(nowIso) || null, null);
  assert.equal(stmts.findPendingForWorker.get(nowIso, 'session-1', 'session-1') || null, null);
  assert.equal(stmts.findPendingForSessionAffinity.get(nowIso, 'session-1') || null, null);
  assert.equal(stmts.findPendingForLegacyRelay.get(nowIso) || null, null);
});

test('the stale sweep tears down continuations instead of requeueing them', () => {
  const db = createTestDb();
  const stmts = createMessageRepository(db);
  insertContinuationRow(stmts, { id: 'q-cont-stale', lastClaimedAgoMs: RECOVERY_HOUR_MS });

  const params = {
    inactiveBefore: recoveryIsoAgo(10 * 60_000),
    ceilingBefore: null,
  };
  // The recovery statements skip it entirely...
  assert.deepEqual(stmts.listRecoverableProcessing.all(params), []);
  stmts.recoverProcessingBefore.run({ ...params, requeueAt: recoveryIsoAgo(0) });
  assert.equal(db.prepare(`SELECT status FROM queue WHERE id = 'q-cont-stale'`).get().status, 'processing');

  // ...and the companion teardown statements own it.
  const stale = stmts.listStaleProcessingContinuations.all(params).map((row) => row.id);
  assert.deepEqual(stale, ['q-cont-stale']);
  stmts.dropStaleContinuation.run('q-cont-stale');
  assert.equal(db.prepare(`SELECT status FROM queue WHERE id = 'q-cont-stale'`).get().status, 'failed');
});

test('recoverStale never revives a continuation row', () => {
  const db = createTestDb();
  const stmts = createMessageRepository(db);
  insertContinuationRow(stmts, { id: 'q-cont-old', lastClaimedAgoMs: RECOVERY_HOUR_MS });
  db.prepare(`UPDATE queue SET processing_at = ? WHERE id = 'q-cont-old'`).run(recoveryIsoAgo(RECOVERY_HOUR_MS));

  stmts.recoverStale.run(recoveryIsoAgo(0), recoveryIsoAgo(10 * 60_000));
  assert.equal(db.prepare(`SELECT status FROM queue WHERE id = 'q-cont-old'`).get().status, 'processing');
});
