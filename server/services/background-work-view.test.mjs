// What the suspend check and the task panel see of background work whose
// details a relay runtime may not hold: it starts with an empty task store
// while the workers, and their tasks, keep running.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { backgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';
import { createBackgroundTaskStore } from './background-task-store.mjs';
import { createBackgroundWorkView } from './background-work-view.mjs';
import { BOOT_REPORTING_WINDOW_MS, UNREPORTED_BACKGROUND_TASK_ID, createSessionActivityTracker } from './session-activity-tracker.mjs';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';

const BOOT = Date.parse('2026-03-02T10:00:00.000Z');
const BUILDER = 'conv-fixture-builder';
const DOCS = 'conv-fixture-docs';
// A conversation whose worker has a session id of its own.
const RENDER = 'conv-fixture-render';
const RENDER_SESSION = 'sdk-fixture-render';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  for (const [id, title, sessionId, provider] of [[BUILDER, 'Orbit camera', BUILDER, 'claude'], [DOCS, 'Docs pass', DOCS, 'github'], [RENDER, 'Render queue', RENDER_SESSION, 'claude']]) {
    const at = new Date(BOOT).toISOString();
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, title, sessionId, at, at);
    db.prepare(`
      INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, created_at, last_used_at)
      VALUES (?, ?, ?, ?, 'claude-sonnet-5', ?, ?, ?)
    `).run(`rs-${id}`, id, sessionId, `key-${id}`, provider, at, at);
  }
  let clock = BOOT;
  const store = createBackgroundTaskStore({ now: () => clock });
  const registry = createSessionWorkerRegistry();
  const dead = new Set();
  let view = null;
  const edges = [];
  const tracker = createSessionActivityTracker({
    db,
    now: () => clock,
    setTimer: () => ({}),
    clearTimer: () => {},
    onEdge: (edge) => edges.push(edge),
    hasUnreportedBackgroundWork: (id) => view.hasUnreportedWork(id),
    listUnreportedBackgroundWork: () => view.listUnreportedConversationIds(),
    runListedByWorker: (id, row) => view.runListed(id, row),
  });
  view = createBackgroundWorkView({
    store,
    db,
    getRegistry: () => registry,
    getTracker: () => tracker,
    isWorkerAlive: (key) => {
      const worker = registry.getWorker(key) || registry.getWorkerByConversationId(key);
      return !!worker && !dead.has(worker.sdkSessionId) && ['starting', 'ready', 'processing'].includes(worker.status);
    },
    sessionIdOf: (id) => db.prepare(`SELECT sdk_session_id FROM runtime_sessions WHERE conversation_id = ?`).get(id)?.sdk_session_id,
    conversationIdOf: (id) => db.prepare(`SELECT id FROM conversations WHERE id = ? OR sdk_session_id = ?`).get(id, id)?.id,
    providerOf: (id) => db.prepare(`SELECT provider_type FROM runtime_sessions WHERE conversation_id = ?`).get(id)?.provider_type,
    titleOf: (id) => db.prepare(`SELECT title FROM conversations WHERE id = ?`).get(id)?.title || String(id).slice(0, 8),
  });
  return {
    db, store, registry, tracker, view, edges, dead,
    advance: (ms) => { clock += ms; },
    // A worker as its heartbeat registers it: by its session id, which it
    // also sends as its conversation id. `backgroundWork` is the Claude
    // worker's flag on the steering snapshot.
    worker(sessionId, { backgroundWork = null } = {}) {
      registry.upsertWorker({
        sdkSessionId: sessionId,
        conversationId: sessionId,
        status: 'ready',
        steering: backgroundWork === null ? null : { turnActive: false, autoCompactWindow: { active: null, backgroundWork } },
      });
    },
    blockers: () => view.blockers(),
  };
}

const shell = (extra = {}) => ({ taskId: 'task_fixture_shell', taskType: 'local_bash', description: 'npm run soak', startedAt: BOOT - 60_000, ...extra });

test('the store compares a worker\'s digest with the set it holds and remembers who reported', () => {
  const { store } = setup();
  const none = backgroundTaskDigest([]);
  const one = backgroundTaskDigest(['task_fixture_shell']);
  assert.deepEqual(none, { count: 0, digest: none.digest });
  assert.match(one.digest, /^[0-9a-f]{16}$/);
  assert.deepEqual(backgroundTaskDigest(['b', 'a', 'a', ' ']), backgroundTaskDigest(['a', 'b']), 'sorted ids only, each once');

  assert.equal(store.hasReport(BUILDER), false, 'a new runtime has heard from nobody');
  assert.equal(store.matches(one, BUILDER), false, 'the worker has a task, the relay holds none');
  assert.equal(store.hasReport(BUILDER), false, 'a mismatch is not a report');
  store.replace(BUILDER, [shell()]);
  assert.equal(store.matches(one, BUILDER), true);
  assert.equal(store.hasReport(BUILDER), true);
  // Details are not part of it; membership is.
  store.replace(BUILDER, [shell({ summary: 'suite 3 of 9', totalTokens: 1200 })]);
  assert.equal(store.matches(one, BUILDER), true);
  assert.equal(store.matches(none, BUILDER), false, 'the relay holds a set, the worker reports none');
  assert.equal(store.matches(backgroundTaskDigest(['task_fixture_shell', 'task_fixture_agent']), BUILDER), false);
  // Agreeing on "no tasks" is a report too.
  assert.equal(store.matches(none, DOCS), true);
  assert.equal(store.hasReport(DOCS), true);
  // The set may be held under the conversation id while the worker names its session id first.
  assert.equal(store.matches(one, 'sdk-fixture-builder', BUILDER), true);
});

test('a runtime that only just started blocks a suspend until the workers had time to report', () => {
  const t = setup();
  const blocker = { kind: 'boot', detail: 'the relay just started, sessions are still reporting' };
  assert.deepEqual(t.blockers(), [blocker]);
  t.advance(12_400);
  t.advance(BOOT_REPORTING_WINDOW_MS - 12_400 - 1);
  assert.deepEqual(t.blockers(), [blocker], 'the same text for as long as it stands: no state change every second');
  t.advance(1);
  assert.equal(t.view.bootBlocker(), null);
  assert.deepEqual(t.blockers(), []);
});

test('a task set sent again after a restart blocks a suspend, for a live worker only', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  t.worker(BUILDER);
  assert.deepEqual(t.blockers(), [], 'the restarted relay knows of no task yet');
  t.store.replace(BUILDER, [shell()]);
  t.tracker.noteTaskSet(BUILDER, [shell()], { resync: true });
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: BUILDER,
    title: 'Orbit camera',
    count: 1,
    detail: '1 background agent: npm run soak',
  }], 'the store and the tracker name the same task once');
  t.dead.add(BUILDER);
  assert.deepEqual(t.blockers(), []);
});

test('background work a live worker reports without a set is a placeholder and a blocker', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  t.worker(BUILDER, { backgroundWork: true });
  t.worker(DOCS, { backgroundWork: false });
  assert.equal(t.view.hasUnreportedWork(BUILDER), true);
  assert.equal(t.view.hasUnreportedWork(DOCS), false);
  assert.deepEqual(t.view.listUnreportedConversationIds(), [BUILDER]);
  assert.equal(t.tracker.describe(BUILDER).state, 'background_only');
  assert.equal(t.tracker.describe(DOCS).state, 'idle');
  assert.deepEqual(t.view.panelTasks(BUILDER), [{
    taskId: UNREPORTED_BACKGROUND_TASK_ID,
    taskType: 'unreported',
    description: 'background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)',
    startedAt: null,
    stoppable: false,
    placeholder: true,
  }]);
  assert.deepEqual(t.view.panelTasks(DOCS), []);
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: BUILDER,
    title: 'Orbit camera',
    count: 1,
    detail: '1 background agent: background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)',
  }]);

  // The flag goes false: gone, with nothing to say about an end.
  t.worker(BUILDER, { backgroundWork: false });
  assert.equal(t.view.hasUnreportedWork(BUILDER), false);
  assert.deepEqual(t.blockers(), []);
  // The worker is gone: gone.
  t.worker(BUILDER, { backgroundWork: true });
  t.dead.add(BUILDER);
  assert.equal(t.view.hasUnreportedWork(BUILDER), false);
  assert.equal(t.tracker.describe(BUILDER).state, 'idle');
  t.dead.clear();
  // The real set arrives: it replaces the placeholder.
  t.store.replace(BUILDER, [shell()]);
  t.tracker.noteTaskSet(BUILDER, [shell()]);
  assert.equal(t.view.hasUnreportedWork(BUILDER), false);
  assert.deepEqual(t.view.panelTasks(BUILDER).map((task) => task.taskId), ['task_fixture_shell']);
  assert.deepEqual(t.tracker.describe(BUILDER).tasks.map((task) => task.id), ['task_fixture_shell']);
  // The worker has reported since this runtime started: the flag alone (it
  // is also true while a continuation is about to start) is no placeholder.
  t.store.replace(BUILDER, []);
  t.tracker.noteTaskSet(BUILDER, []);
  assert.equal(t.view.hasUnreportedWork(BUILDER), false);
  assert.deepEqual(t.edges.map((edge) => edge.task.id), [], 'no start for the restored task; its end waits for the grace');
});

test('a worker that agrees it has no tasks gets no placeholder for the flag alone', () => {
  const t = setup();
  t.worker(BUILDER, { backgroundWork: true });
  assert.equal(t.view.hasUnreportedWork(BUILDER), true);
  assert.equal(t.store.matches(backgroundTaskDigest([]), BUILDER), true);
  assert.equal(t.view.hasUnreportedWork(BUILDER), false);
});

test('a running background sub-agent known only from the database blocks a suspend', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  const at = new Date(BOOT - 5 * 60_000).toISOString();
  const insert = t.db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES (?, 'q-fixture', ?, ?, 'running', ?, ?, ?)
  `);
  insert.run('toolu_fixture_orbit', BUILDER, 'M1 orbit camera', at, at, 1);
  // A run inside a turn is the turn's work, and a dead worker runs nothing.
  insert.run('toolu_fixture_inturn', BUILDER, 'lint pass', at, at, 0);
  insert.run('toolu_fixture_docs', DOCS, 'glossary sweep', at, at, 1);
  t.worker(BUILDER);
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: BUILDER,
    title: 'Orbit camera',
    count: 1,
    detail: '1 background agent: M1 orbit camera',
  }]);
});

// ─── A conversation id and its worker's session id are two ids ───────────────

test('a worker whose session id is not the conversation id: the placeholder shows under the conversation', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  t.worker(RENDER_SESSION, { backgroundWork: true });
  assert.equal(t.view.hasUnreportedWork(RENDER), true, 'asked by conversation id');
  assert.equal(t.view.hasUnreportedWork(RENDER_SESSION), true, 'asked by session id');
  assert.deepEqual(t.view.listUnreportedConversationIds(), [RENDER]);
  assert.equal(t.tracker.describe(RENDER).state, 'background_only');
  assert.deepEqual(t.tracker.describe(RENDER).tasks.map((task) => task.id), [UNREPORTED_BACKGROUND_TASK_ID]);
  assert.deepEqual(t.view.panelTasks(RENDER).map((task) => task.taskId), [UNREPORTED_BACKGROUND_TASK_ID]);
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: RENDER,
    title: 'Render queue',
    count: 1,
    detail: '1 background agent: background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)',
  }]);
  // Its set, posted under the session id, replaces it under the same conversation.
  t.store.replace(RENDER_SESSION, [shell()]);
  t.tracker.noteTaskSet(RENDER, [shell()]);
  assert.equal(t.view.hasUnreportedWork(RENDER), false);
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: RENDER,
    title: 'Render queue',
    count: 1,
    detail: '1 background agent: npm run soak',
  }]);
  t.dead.add(RENDER_SESSION);
  assert.deepEqual(t.blockers(), []);
});

test('a worker whose session id is not the conversation id: a database-only sub-agent blocks', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  const at = new Date(BOOT - 5 * 60_000).toISOString();
  t.db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES ('toolu_fixture_frames', 'q-fixture', ?, 'frame export', 'running', ?, ?, 1)
  `).run(RENDER, at, at);
  assert.deepEqual(t.blockers(), [], 'no worker, no blocker');
  t.worker(RENDER_SESSION);
  assert.deepEqual(t.blockers(), [{
    kind: 'background',
    conversationId: RENDER,
    title: 'Render queue',
    count: 1,
    detail: '1 background agent: frame export',
  }]);
});

// ─── The store's bookkeeping ─────────────────────────────────────────────────

test('the order of a worker\'s set posts: an overtaken post is refused, a new process starts over', () => {
  const { store } = setup();
  const order = (epoch, seq) => ({ epoch, seq });
  const yes = { accepted: true, reason: null };
  assert.deepEqual(store.acceptOrder(BUILDER, order(2_000, 2)), yes);
  assert.deepEqual(store.acceptOrder(BUILDER, order(2_000, 1)), { accepted: false, reason: 'older' }, 'overtaken on the way');
  assert.deepEqual(store.acceptOrder(BUILDER, order(2_000, 2)), { accepted: false, reason: 'older' }, 'the same post twice');
  assert.deepEqual(store.acceptOrder(BUILDER, order(2_000, 3)), yes);
  // The process whose heartbeat came last, with an epoch BELOW the last one
  // (the clock stepped back between two starts): a new process, not an old post.
  store.noteHolder(BUILDER, 41_002);
  assert.deepEqual(store.acceptOrder(BUILDER, order(1_000, 1), { pid: 41_002 }), yes);
  assert.deepEqual(store.acceptOrder(BUILDER, order(1_000, 2), { pid: 41_002 }), yes);
  // A post of a process that does not hold the session is a late one, whatever it carries.
  assert.deepEqual(store.acceptOrder(BUILDER, order(2_000, 9), { pid: 41_001 }), { accepted: false, reason: 'not-holder' });
  assert.deepEqual(store.acceptOrder(BUILDER, order(9_000, 1), { pid: 41_001 }), { accepted: false, reason: 'not-holder' });
  // A process the relay cannot place (no pid on the post): another epoch
  // starts over too, so nothing is turned away for good.
  assert.deepEqual(store.acceptOrder(BUILDER, order(500, 1)), yes);
  assert.deepEqual(store.acceptOrder(BUILDER, order(500, 1)), { accepted: false, reason: 'older' });
  // No order (a worker on older code), or a broken one: applied, and it changes nothing.
  assert.deepEqual(store.acceptOrder(BUILDER, undefined), yes);
  assert.deepEqual(store.acceptOrder(BUILDER, { epoch: 'soon', seq: 1 }), yes);
  assert.deepEqual(store.acceptOrder(BUILDER, order(500, 1)), { accepted: false, reason: 'older' });
  // Per worker.
  assert.deepEqual(store.acceptOrder(DOCS, order(2_000, 1)), yes);
});

test('a conversation that goes takes everything held for it', () => {
  const { store } = setup();
  store.replace(BUILDER, [shell()]);
  assert.equal(store.acceptOrder(BUILDER, { epoch: 1_000, seq: 5 }).accepted, true);
  assert.equal(store.announce(BUILDER, true), true);
  assert.equal(store.announce(BUILDER, true), false, 'told once');
  store.forget(BUILDER, 'sdk-fixture-builder');
  assert.deepEqual(store.get(BUILDER), []);
  assert.equal(store.hasReport(BUILDER), false);
  assert.equal(store.acceptOrder(BUILDER, { epoch: 1_000, seq: 1 }).accepted, true, 'the order starts over');
  assert.equal(store.announce(BUILDER, true), true);
});

// ─── A run row left `running` ────────────────────────────────────────────────

function seedQuietRun(t, conversationId, { id = 'toolu_fixture_orbit', quietMs = 16 * 60_000, taskId = null } = {}) {
  const at = new Date(BOOT + BOOT_REPORTING_WINDOW_MS - quietMs).toISOString();
  t.db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background, task_id)
    VALUES (?, 'q-fixture', ?, 'M1 orbit camera', 'running', ?, ?, 1, ?)
  `).run(id, conversationId, at, at, taskId);
}

test('a running background row the worker\'s set does not list, quiet for 15 minutes, is not running work', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  seedQuietRun(t, RENDER);
  t.worker(RENDER_SESSION);
  // The worker has said nothing about its tasks yet: the row counts.
  assert.equal(t.view.runListed(RENDER, { id: 'toolu_fixture_orbit' }), null);
  assert.equal(t.tracker.describe(RENDER).state, 'background_only');
  assert.equal(t.blockers().length, 1);
  // It reports a set (here: that it has no tasks). The row's end was never written.
  assert.equal(t.store.matches(backgroundTaskDigest([]), RENDER_SESSION), true);
  assert.equal(t.view.runListed(RENDER, { id: 'toolu_fixture_orbit' }), false);
  const view = t.tracker.describe(RENDER);
  assert.equal(view.state, 'idle', 'the session state');
  assert.equal(view.runningTaskCount, 0, 'what all_idle reads');
  assert.deepEqual(t.blockers(), [], 'the suspend blocker');
});

test('a quiet running row stays running work while the set lists it, while it is fresh, and for a provider whose sets list no runs', () => {
  const t = setup();
  t.advance(BOOT_REPORTING_WINDOW_MS);
  // Listed by its run id, and another by its task id.
  seedQuietRun(t, RENDER);
  seedQuietRun(t, RENDER, { id: 'toolu_fixture_export', taskId: 'task_fixture_export' });
  t.worker(RENDER_SESSION);
  t.store.replace(RENDER_SESSION, [
    { taskId: 'task_fixture_agent', taskType: 'local_agent', description: 'M1 orbit camera', toolUseId: 'toolu_fixture_orbit' },
    { taskId: 'task_fixture_export', taskType: 'local_agent', description: 'frame export' },
  ]);
  assert.equal(t.view.runListed(RENDER, { id: 'toolu_fixture_orbit' }), true);
  assert.equal(t.view.runListed(RENDER, { id: 'toolu_fixture_export', task_id: 'task_fixture_export' }), true);
  assert.equal(t.tracker.describe(RENDER).runningTaskCount, 2);
  // Not listed, but updated a minute ago: its first set may still be on its way.
  seedQuietRun(t, BUILDER, { id: 'toolu_fixture_fresh', quietMs: 60_000 });
  t.worker(BUILDER);
  t.store.replace(BUILDER, []);
  assert.equal(t.tracker.describe(BUILDER).state, 'background_only');
  // A provider whose background agents no set lists: the set says nothing about the row.
  seedQuietRun(t, DOCS, { id: 'toolu_fixture_docs' });
  t.worker(DOCS);
  t.store.replace(DOCS, [shell()]);
  assert.equal(t.view.runListed(DOCS, { id: 'toolu_fixture_docs' }), null);
  assert.deepEqual(t.tracker.describe(DOCS).tasks.filter((task) => task.status === 'running').map((task) => task.id), ['toolu_fixture_docs']);
});
