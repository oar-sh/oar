// A relay runtime starts with no background-task sets while the workers and
// their tasks keep running. The heartbeat route notices that it is out of
// step with a worker (the digest) and asks for the set again; the task route
// takes the answer without announcing a second start; and a worker that
// cannot answer yet but reports background work gets a placeholder.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { backgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';
import { createBackgroundTaskStore } from '../services/background-task-store.mjs';
import { createBackgroundWorkView } from '../services/background-work-view.mjs';
import { createHostSuspendService } from '../services/host-suspend-service.mjs';
import { BOOT_REPORTING_WINDOW_MS, TASK_END_GRACE_MS, UNREPORTED_BACKGROUND_TASK_ID, createSessionActivityTracker } from '../services/session-activity-tracker.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const BOOT = Date.parse('2026-03-02T10:00:00.000Z');
const SESSION = 'conv-fixture-builder';
const SHELL = { taskId: 'task_fixture_shell', taskType: 'local_bash', description: 'npm run soak', startedAt: BOOT - 60_000 };

// A conversation whose worker has a session id of its own.
const RENDER = 'conv-fixture-render';
const RENDER_SESSION = 'sdk-fixture-render';

function boot({ sessionId = SESSION, conversationId = SESSION } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(BOOT).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Render queue', ?, ?, ?)`)
    .run(conversationId, sessionId, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, created_at, last_used_at)
    VALUES ('rs-fixture', ?, ?, 'key-fixture', 'claude-sonnet-5', 'claude', ?, ?)
  `).run(conversationId, sessionId, at, at);
  const conversationIdOf = (id) => db.prepare(`SELECT id FROM conversations WHERE id = ? OR sdk_session_id = ?`).get(id, id)?.id;
  let clock = BOOT + 5_000;
  const timers = [];
  const store = createBackgroundTaskStore();
  const registry = createSessionWorkerRegistry();
  const emitted = [];
  const edges = [];
  let view = null;
  const tracker = createSessionActivityTracker({
    db,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.done = true; },
    onEdge: (edge) => edges.push(edge),
    hasUnreportedBackgroundWork: (id) => view.hasUnreportedWork(id),
    listUnreportedBackgroundWork: () => view.listUnreportedConversationIds(),
  });
  view = createBackgroundWorkView({
    store,
    db,
    getRegistry: () => registry,
    getTracker: () => tracker,
    isWorkerAlive: (key) => !!(registry.getWorker(key) || registry.getWorkerByConversationId(key)),
    sessionIdOf: (id) => db.prepare(`SELECT sdk_session_id FROM runtime_sessions WHERE conversation_id = ?`).get(id)?.sdk_session_id,
    conversationIdOf,
    titleOf: (id) => db.prepare(`SELECT title FROM conversations WHERE id = ?`).get(id)?.title || String(id).slice(0, 8),
  });
  const routes = captureRoutes(makeRouteDeps({
    backgroundTaskStore: store,
    backgroundWorkView: view,
    sessionWorkerRegistry: registry,
    sessionActivityTracker: tracker,
    resolveConversationRecord: ({ sdkSessionId }) => ({ id: conversationIdOf(sdkSessionId) || sdkSessionId }),
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    queueCounts: () => ({ pendingCount: 0 }),
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId: sid, conversationId: cid, pid } = {}) => {
        const id = String(sid || '').trim();
        return id ? { sessionId: id, conversationId: String(cid || '').trim() || null, pid: Number(pid) || null } : null;
      },
      observe() {},
    },
  }));
  // As the workers send them: the session id in both identity headers.
  const headers = { 'x-relay-session-id': sessionId, 'x-relay-conversation-id': sessionId };
  return {
    db, store, registry, tracker, view, emitted, edges,
    now: () => clock,
    advance(ms) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= clock) {
          timer.done = true;
          timer.fn();
        }
      }
    },
    // `pid`: the worker process the request comes from (its identity header).
    beat: async (body = {}, { pid = null } = {}) => (await invokeRoute(routes, 'POST', '/api/heartbeat', { body, headers: withPid(headers, pid) })).body,
    post: async (routePath, body, { pid = null } = {}) => (await invokeRoute(routes, 'POST', routePath, { body, headers: withPid(headers, pid) })).body,
    taskEvents: () => emitted.filter((entry) => entry.event === 'background_tasks').map((entry) => entry.payload),
  };
}

const withPid = (headers, pid) => (pid ? { ...headers, 'x-relay-process-pid': String(pid) } : headers);
const digestOf = (...ids) => backgroundTaskDigest(ids);

/** Runs `fn` and returns the console.log lines it wrote. */
async function logged(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test('a heartbeat digest that differs from the held set asks for the set again; an equal one does not', async () => {
  const fx = boot();
  // After a restart: the worker has a shell, the relay holds nothing.
  assert.equal((await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') })).resyncBackgroundTasks, true);
  // Still asked while the answer has not arrived: a failed post is retried by the next beat.
  assert.equal((await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') })).resyncBackgroundTasks, true);

  const answer = await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], resync: true });
  assert.deepEqual(answer, { ok: true, count: 1, resync: true });
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') }), false);

  const view = fx.tracker.describe(SESSION);
  assert.equal(view.state, 'background_only');
  assert.equal(view.tasks[0].startedAt, new Date(BOOT - 60_000).toISOString());
  assert.deepEqual(fx.edges, [], 'no second task_started');
  assert.deepEqual(fx.taskEvents().at(-1), { conversationId: SESSION, tasks: fx.store.get(SESSION), endedTasks: [] }, 'the pages get the set again');
  assert.equal(fx.store.get(SESSION)[0].taskId, 'task_fixture_shell');

  // The relay holds a set, the worker reports none: asked, and the empty answer clears it.
  assert.equal((await fx.beat({ backgroundTasks: digestOf() })).resyncBackgroundTasks, true);
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [], resync: true });
  assert.deepEqual(fx.store.get(SESSION), []);
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf() }), false);
});

test('a worker that sends no digest has no opinion and is never asked', async () => {
  const fx = boot();
  // Cursor, Grok and Claude Cloud workers never publish task sets, and a
  // worker on older code sends no digest: with or without a held set.
  assert.deepEqual(await fx.beat({}), { ok: true, pendingCount: 0 });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL] });
  assert.deepEqual(await fx.beat({}), { ok: true, pendingCount: 0 });
  assert.deepEqual(await fx.beat({ backgroundTasks: 'task_fixture_shell' }), { ok: true, pendingCount: 0 });
  assert.deepEqual(await fx.beat({ backgroundTasks: { count: 1 } }), { ok: true, pendingCount: 0 });
  assert.equal(fx.store.get(SESSION).length, 1);
});

test('no digest and backgroundWork on the heartbeat gives the placeholder, until the worker reports', async () => {
  const fx = boot();
  const steering = (backgroundWork) => ({ turnActive: false, autoCompactWindow: { active: null, backgroundWork } });
  await fx.beat({ steering: steering(false) });
  assert.equal(fx.tracker.describe(SESSION).state, 'idle');
  assert.deepEqual(fx.taskEvents(), []);

  await fx.beat({ steering: steering(true) });
  assert.equal(fx.tracker.describe(SESSION).state, 'background_only');
  assert.deepEqual(fx.tracker.describe(SESSION).tasks.map((task) => task.id), [UNREPORTED_BACKGROUND_TASK_ID]);
  assert.deepEqual(fx.taskEvents().map((payload) => payload.tasks.map((task) => task.taskId)), [[UNREPORTED_BACKGROUND_TASK_ID]], 'the pages are told once');
  await fx.beat({ steering: steering(true) });
  assert.equal(fx.taskEvents().length, 1, 'a quiet heartbeat tells them nothing new');

  // The flag goes false with no set ever sent: the pages are told it is gone.
  await fx.beat({ steering: steering(false) });
  assert.equal(fx.tracker.describe(SESSION).state, 'idle');
  assert.deepEqual(fx.taskEvents().at(-1), { conversationId: SESSION, tasks: [], endedTasks: [] });

  // Back, then replaced by the worker's own set (a progress update).
  await fx.beat({ steering: steering(true) });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL] });
  assert.deepEqual(fx.tracker.describe(SESSION).tasks.map((task) => task.id), ['task_fixture_shell']);
  assert.deepEqual(fx.taskEvents().at(-1).tasks.map((task) => task.taskId), ['task_fixture_shell']);
  // Its task ends: the worker has reported in this runtime, so the flag
  // alone (true again while the continuation is about to start) shows nothing.
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [] });
  const events = fx.taskEvents().length;
  await fx.beat({ steering: steering(true) });
  assert.equal(fx.view.hasUnreportedWork(SESSION), false);
  assert.equal(fx.taskEvents().length, events);
  assert.deepEqual(fx.edges.map((edge) => edge.type), [], 'the placeholder raised no event, and the restored task no start');
});

test('a worker that sends a digest gets no placeholder for the flag once it agrees', async () => {
  const fx = boot();
  const body = { steering: { turnActive: false, autoCompactWindow: { active: null, backgroundWork: true } }, backgroundTasks: digestOf() };
  assert.deepEqual(await fx.beat(body), { ok: true, pendingCount: 0 });
  assert.equal(fx.tracker.describe(SESSION).state, 'idle', 'a continuation about to start is not background work to show');
  assert.deepEqual(fx.taskEvents(), []);
});

test('the settle route passes on what the task was, when the worker says so', async () => {
  const fx = boot();
  await fx.post('/api/background-task-settled', {
    conversationId: SESSION, taskId: 'task_fixture_shell', status: 'failed', summary: 'Exit code 2',
    description: 'npm run soak', taskType: 'local_bash', startedAt: BOOT - 60_000,
  });
  assert.equal(fx.edges.length, 1);
  assert.equal(fx.edges[0].type, 'task_failed');
  assert.equal(fx.edges[0].task.description, 'npm run soak');
  assert.equal(fx.edges[0].task.kind, 'shell');
  assert.equal(fx.edges[0].task.startedAt, new Date(BOOT - 60_000).toISOString());
});

// ─── Posts that overtake each other ──────────────────────────────────────────

const BUILD = { taskId: 'task_fixture_build', taskType: 'local_bash', description: 'npm run build', startedAt: BOOT + 6_000 };
const order = (seq) => ({ epoch: BOOT - 3_600_000, seq });

test('a set older than the one applied is dropped: no task ends because a resync arrived late', async () => {
  const fx = boot();
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: order(1) });
  fx.advance(2_000);
  // The relay asks; before the answer arrives the worker starts a second
  // task and publishes, and that post overtakes the older answer.
  assert.deepEqual(await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL, BUILD], order: order(3) }), { ok: true, count: 2 });
  const late = await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: order(2), resync: true });
  assert.deepEqual(late, { ok: true, count: 1, stale: true, reason: 'older' });
  assert.deepEqual(fx.store.get(SESSION).map((task) => task.taskId), ['task_fixture_shell', 'task_fixture_build']);
  assert.equal(fx.taskEvents().at(-1).tasks.length, 2, 'the pages are not handed the older set');

  fx.advance(TASK_END_GRACE_MS + 1);
  assert.deepEqual(fx.edges.map((edge) => `${edge.type}:${edge.task.id}`), ['task_started:task_fixture_build'], 'no end for the task of the newer set');
  assert.equal(fx.tracker.describe(SESSION).runningTaskCount, 2);
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf('task_fixture_shell', 'task_fixture_build') }), false);
});

test('a worker that numbers no sets: a set that arrived out of turn ends a task by absence, and the next set brings it back', async () => {
  const fx = boot();
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL, BUILD] });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL] });
  fx.advance(TASK_END_GRACE_MS + 1);
  assert.deepEqual(fx.edges.map((edge) => `${edge.type}:${edge.task.id}`), ['task_started:task_fixture_build', 'task_finished:task_fixture_build']);
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL, BUILD] });
  assert.equal(fx.tracker.describe(SESSION).runningTaskCount, 2, 'the session state is right again');
  assert.equal(fx.edges.length, 2, 'and the task did not start twice');
});

// ─── A conversation id and its worker's session id are two ids ───────────────

test('a worker whose session id is not the conversation id: resync, placeholder and blockers land on the conversation', async () => {
  const fx = boot({ sessionId: RENDER_SESSION, conversationId: RENDER });
  fx.advance(BOOT_REPORTING_WINDOW_MS);
  // On older code first: the flag, no digest.
  await fx.beat({ steering: { turnActive: false, autoCompactWindow: { active: null, backgroundWork: true } } });
  assert.equal(fx.tracker.describe(RENDER).state, 'background_only');
  assert.deepEqual(fx.tracker.describe(RENDER).tasks.map((task) => task.id), [UNREPORTED_BACKGROUND_TASK_ID]);
  assert.deepEqual(fx.view.blockers().map((blocker) => [blocker.conversationId, blocker.title]), [[RENDER, 'Render queue']]);

  // Then with a digest: asked, and the answer is the conversation's set.
  assert.equal((await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') })).resyncBackgroundTasks, true);
  await fx.post('/api/background-tasks', { conversationId: RENDER_SESSION, tasks: [SHELL], resync: true, order: order(1) });
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') }), false);
  assert.deepEqual(fx.tracker.describe(RENDER).tasks.map((task) => task.id), ['task_fixture_shell']);
  assert.deepEqual(fx.view.panelTasks(RENDER, RENDER_SESSION).map((task) => task.taskId), ['task_fixture_shell']);
  assert.deepEqual(fx.view.blockers(), [{
    kind: 'background', conversationId: RENDER, title: 'Render queue', count: 1, detail: '1 background agent: npm run soak',
  }]);
  assert.deepEqual(fx.edges, []);
});

// ─── The suspend check, through the modules the runtime wires ────────────────

test('a queued host suspend waits out the boot window and a task sent again, then goes through', async () => {
  const fx = boot();
  const suspended = [];
  const states = [];
  let poll = null;
  // The collector as the runtime builds it for background work: the view's blockers.
  const service = createHostSuspendService({
    collectActivity: () => ({ blockers: fx.view.blockers() }),
    runSuspend: () => { suspended.push(fx.now()); return { ok: true }; },
    onStateChange: (state) => states.push(state),
    logger: { log() {}, warn() {} },
    now: fx.now,
    setIntervalImpl: (fn) => { poll = fn; return 1; },
    clearIntervalImpl: () => { poll = null; },
  });
  const step = (ms) => { for (let passed = 0; passed < ms; passed += 1_000) { fx.advance(1_000); poll?.(); } };

  // The relay has just restarted; the worker's shell is not known yet.
  assert.deepEqual(service.request({ requestedBy: 'fixture' }).state.blockers.map((blocker) => blocker.kind), ['boot']);
  step(10_000);
  assert.equal(states.length, 1, 'ten checks inside the boot window, one state: the blocker\'s text does not change');
  // The worker's heartbeat: asked, answered.
  assert.equal((await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') })).resyncBackgroundTasks, true);
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], resync: true, order: order(1) });
  step(BOOT_REPORTING_WINDOW_MS);
  assert.deepEqual(service.getState().blockers.map((blocker) => [blocker.kind, blocker.conversationId, blocker.detail]), [
    ['background', SESSION, '1 background agent: npm run soak'],
  ]);
  step(10 * 60_000);
  assert.deepEqual(suspended, [], 'the box stays up under the running shell');

  // The shell ends.
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [], order: order(2) });
  await fx.post('/api/background-task-settled', { conversationId: SESSION, taskId: 'task_fixture_shell', status: 'completed' });
  step(10 * 60_000);
  assert.equal(suspended.length, 1);
});

// ─── Which process a set comes from ──────────────────────────────────────────

const FIRST_PID = 41_001;
const SECOND_PID = 41_002;

test('a worker restarted with an earlier clock is not turned away: its sets apply from the first one', async () => {
  const fx = boot();
  await fx.beat({ backgroundTasks: digestOf() }, { pid: FIRST_PID });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: { epoch: BOOT, seq: 7 } }, { pid: FIRST_PID });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [], order: { epoch: BOOT, seq: 8 } }, { pid: FIRST_PID });

  // The session's worker is replaced; the host clock stepped back an hour
  // in between, so the new process's epoch is BELOW the old one's.
  const earlier = { epoch: BOOT - 3_600_000, seq: 1 };
  await fx.beat({ backgroundTasks: digestOf() }, { pid: SECOND_PID });
  const lines = await logged(async () => {
    assert.deepEqual(await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [BUILD], order: earlier }, { pid: SECOND_PID }), { ok: true, count: 1 });
  });
  assert.deepEqual(lines, []);
  assert.deepEqual(fx.store.get(SESSION).map((task) => task.taskId), ['task_fixture_build']);
  assert.equal(fx.tracker.describe(SESSION).state, 'background_only');
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf('task_fixture_build') }, { pid: SECOND_PID }), false, 'in step: the relay does not ask without end');
  assert.deepEqual(fx.view.backgroundBlockers().map((blocker) => blocker.detail), ['1 background agent: npm run build']);
});

test('a late post of the process before is dropped, logged and answered stale; the holder\'s next set applies', async () => {
  const fx = boot();
  await fx.beat({}, { pid: FIRST_PID });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: { epoch: BOOT, seq: 1 } }, { pid: FIRST_PID });
  await fx.beat({}, { pid: SECOND_PID });
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [BUILD], order: { epoch: BOOT + 60_000, seq: 1 } }, { pid: SECOND_PID });
  const lines = await logged(async () => {
    const late = await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [], order: { epoch: BOOT, seq: 2 } }, { pid: FIRST_PID });
    assert.deepEqual(late, { ok: true, count: 0, stale: true, reason: 'not-holder' });
  });
  assert.equal(lines.length, 1, 'one line per drop');
  assert.match(lines[0], /BG-TASKS set dropped \(not-holder\) session=conv-fix epoch=\d+ seq=2 tasks=0$/);
  assert.deepEqual(fx.store.get(SESSION).map((task) => task.taskId), ['task_fixture_build']);
  assert.deepEqual(await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [BUILD, SHELL], order: { epoch: BOOT + 60_000, seq: 2 } }, { pid: SECOND_PID }), { ok: true, count: 2 });
});

test('a new process whose set arrives before its first heartbeat is told stale, and is taken once it has beaten', async () => {
  const fx = boot();
  await fx.beat({}, { pid: FIRST_PID });
  const order = { epoch: BOOT - 3_600_000, seq: 1 };
  const lines = await logged(async () => {
    // The registry still names the process before it as the holder.
    assert.equal((await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order }, { pid: SECOND_PID })).stale, true);
  });
  assert.equal(lines.length, 1);
  // What the worker does on `stale`: a heartbeat. It makes it the holder, and the relay asks.
  assert.equal((await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') }, { pid: SECOND_PID })).resyncBackgroundTasks, true);
  assert.deepEqual(await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: { ...order, seq: 2 }, resync: true }, { pid: SECOND_PID }), { ok: true, count: 1, resync: true });
  assert.equal('resyncBackgroundTasks' in await fx.beat({ backgroundTasks: digestOf('task_fixture_shell') }, { pid: SECOND_PID }), false);
});

test('a process the relay cannot place (no pid on the request) is taken as a new one when its epoch changes', async () => {
  const fx = boot();
  await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [SHELL], order: { epoch: BOOT, seq: 3 } });
  assert.deepEqual(await fx.post('/api/background-tasks', { conversationId: SESSION, tasks: [BUILD], order: { epoch: BOOT - 3_600_000, seq: 1 } }), { ok: true, count: 1 });
  assert.deepEqual(fx.store.get(SESSION).map((task) => task.taskId), ['task_fixture_build']);
});
