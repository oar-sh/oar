import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_BILLING_SWAP_WAIT_TTL_MS,
  claudeWorkerReleaseHold,
  createClaudeBillingSwapService,
} from './claude-billing-swap-service.mjs';

const fence = (extra = {}) => ({
  requesterSessionId: 'sid-1',
  conversationId: 'conv-1',
  messageId: 'q-1',
  rowBilling: 'claude-api',
  workerKind: 'claude',
  reason: 'kind-mismatch',
  ...extra,
});

function setup({ worker = null, stop = async () => ({ ok: true }), launch = async () => ({ ok: true }) } = {}) {
  let clock = Date.parse('2026-10-25T12:00:00.000Z');
  const calls = [];
  const stuck = [];
  const pendingChanges = [];
  let currentWorker = worker;
  const service = createClaudeBillingSwapService({
    getWorker: () => currentWorker,
    stopWorker: async (sid) => { calls.push(['stop', sid]); return stop(sid); },
    launchWorker: async (sid) => { calls.push(['launch', sid]); return launch(sid); },
    onStuck: (info) => stuck.push(info),
    onPendingChange: (change) => pendingChanges.push(change),
    now: () => clock,
    retryBaseMs: 1000,
    stuckAfter: 2,
    logger: { log() {}, warn() {} },
  });
  return {
    service,
    calls,
    stuck,
    pendingChanges,
    tick: (ms) => { clock += ms; },
    setWorker: (next) => { currentWorker = next; },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('release holds: from the worker\'s own word, else read from an older snapshot', () => {
  assert.equal(claudeWorkerReleaseHold(null), null);
  assert.equal(claudeWorkerReleaseHold({ steering: { releasable: true } }), null);
  assert.equal(claudeWorkerReleaseHold({ steering: { releasable: false, releaseHold: 'background' } }), 'background');
  assert.equal(claudeWorkerReleaseHold({ steering: { releasable: false } }), 'turn');
  assert.equal(claudeWorkerReleaseHold({ steering: { turnActive: true } }), 'turn');
  assert.equal(claudeWorkerReleaseHold({ steering: { turnActive: true, holdReason: 'question' } }), 'question');
  assert.equal(claudeWorkerReleaseHold({ steering: { turnActive: false, autoCompactWindow: { backgroundWork: true } } }), 'background');
  assert.equal(claudeWorkerReleaseHold({ steering: { turnActive: false } }), null);
  assert.equal(claudeWorkerReleaseHold({ status: 'processing' }), 'turn');
  assert.equal(claudeWorkerReleaseHold({ status: 'ready' }), null);
});

test('a releasable worker is stopped first, then the new kind launched; the first delivery gets the note once', async () => {
  const app = setup({ worker: { steering: { releasable: true } } });
  assert.deepEqual(app.service.request(fence()), { state: 'swapping' });
  assert.deepEqual(app.service.request(fence()), { state: 'in-flight' });
  assert.deepEqual(app.service.pendingFor('sid-1'), { to: 'claude-api', waitingFor: null, backgroundTaskCount: 0, swapping: true });
  await flush();
  assert.deepEqual(app.calls, [['stop', 'sid-1'], ['launch', 'sid-1']]);
  assert.deepEqual(app.service.takeSwapNote('sid-1'), { from: 'claude', to: 'claude-api' });
  assert.equal(app.service.takeSwapNote('sid-1'), null);
  assert.equal(app.service.pendingFor('sid-1'), null);
  assert.equal(app.pendingChanges.at(-1).pending, null);
});

test('a worker with no CLI process is releasable at once (its snapshot says so)', async () => {
  const app = setup({ worker: { steering: { turnActive: false, releasable: true, releaseHold: null } } });
  assert.equal(app.service.request(fence()).state, 'swapping');
  await flush();
  assert.equal(app.calls.length, 2);
});

test('a busy worker is waited for, with what it waits for; nothing is stopped', () => {
  const app = setup({ worker: { steering: { releasable: false, releaseHold: 'background', backgroundTaskCount: 2 } } });
  assert.deepEqual(app.service.request(fence()), { state: 'waiting', waitingFor: 'background' });
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.pendingFor('sid-1'), { to: 'claude-api', waitingFor: 'background', backgroundTaskCount: 2, swapping: false });
  assert.equal(app.pendingChanges.length, 1);
  // The same wait again reports nothing new.
  app.service.request(fence());
  assert.equal(app.pendingChanges.length, 1);
  // Nobody asks any more (a switch back): the wait ages out.
  app.tick(CLAUDE_BILLING_SWAP_WAIT_TTL_MS + 1);
  assert.equal(app.service.pendingFor('sid-1'), null);
});

test('once the hold ends the swap runs', async () => {
  const app = setup({ worker: { steering: { releasable: false, releaseHold: 'turn' } } });
  assert.equal(app.service.request(fence()).state, 'waiting');
  app.setWorker({ steering: { releasable: true } });
  assert.equal(app.service.request(fence()).state, 'swapping');
  await flush();
  assert.deepEqual(app.calls.map(([step]) => step), ['stop', 'launch']);
});

test('an old worker that does not stop: no launch, backoff, then one note', async () => {
  const app = setup({ worker: { steering: { releasable: true } }, stop: async () => ({ ok: false, error: 'worker-survived-stop' }) });
  assert.equal(app.service.request(fence()).state, 'swapping');
  await flush();
  assert.deepEqual(app.calls, [['stop', 'sid-1']]);
  assert.equal(app.service.takeSwapNote('sid-1'), null);
  assert.equal(app.service.request(fence()).state, 'backoff');
  app.tick(1001);
  assert.equal(app.service.request(fence()).state, 'swapping');
  await flush();
  assert.equal(app.stuck.length, 1);
  assert.equal(app.stuck[0].attempts, 2);
  assert.equal(app.stuck[0].conversationId, 'conv-1');
  app.tick(10_000);
  app.service.request(fence());
  await flush();
  assert.equal(app.stuck.length, 1);
  assert.ok(app.calls.every(([step]) => step === 'stop'));
});

test('a launch that fails still counts as swapped: the supervisor\'s own note covers it', async () => {
  const app = setup({ worker: { steering: { releasable: true } }, launch: async () => ({ ok: false, error: 'claude-api-key-not-configured' }) });
  app.service.request(fence());
  await flush();
  assert.deepEqual(app.calls.map(([step]) => step), ['stop', 'launch']);
  assert.equal(app.service.pendingFor('sid-1'), null);
});

test('a fence without a session or a billing is ignored', () => {
  const app = setup();
  assert.deepEqual(app.service.request(fence({ requesterSessionId: '' })), { state: 'ignored' });
  assert.deepEqual(app.service.request(fence({ rowBilling: '' })), { state: 'ignored' });
});

test('a session that owns a running or just-delivered turn is never stopped, whatever its snapshot says', async () => {
  let running = true;
  const calls = [];
  const service = createClaudeBillingSwapService({
    // The snapshot lags: it still says releasable.
    getWorker: () => ({ steering: { releasable: true } }),
    hasRunningTurn: () => running,
    stopWorker: async (sid) => { calls.push(['stop', sid]); return { ok: true }; },
    launchWorker: async (sid) => { calls.push(['launch', sid]); return { ok: true }; },
    logger: { log() {}, warn() {} },
  });
  assert.deepEqual(service.request(fence()), { state: 'waiting', waitingFor: 'turn' });
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(service.pendingFor('sid-1').waitingFor, 'turn');
  // The turn finished: the swap goes ahead.
  running = false;
  assert.equal(service.request(fence()).state, 'swapping');
  await flush();
  assert.deepEqual(calls.map(([step]) => step), ['stop', 'launch']);
});

test('a running-turn probe that throws counts as a running turn', async () => {
  const calls = [];
  const service = createClaudeBillingSwapService({
    getWorker: () => ({ steering: { releasable: true } }),
    hasRunningTurn: () => { throw new Error('db busy'); },
    stopWorker: async () => { calls.push('stop'); return { ok: true }; },
    launchWorker: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  assert.equal(service.request(fence()).state, 'waiting');
  await flush();
  assert.deepEqual(calls, []);
});

test('a running-turn probe that keeps failing is logged (not on every fence) and reaches the chat as the stuck note once', async () => {
  let clock = 0;
  const warnings = [];
  const stuck = [];
  let failing = true;
  const service = createClaudeBillingSwapService({
    getWorker: () => ({ steering: { releasable: true } }),
    hasRunningTurn: () => { if (failing) throw new Error('database is locked'); return false; },
    stopWorker: async () => ({ ok: true }),
    launchWorker: async () => ({ ok: true }),
    onStuck: (info) => stuck.push(info),
    now: () => clock,
    stuckAfter: 3,
    probeLogEveryMs: 60_000,
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(service.request(fence()), { state: 'waiting', waitingFor: 'turn' });
    clock += 15_000;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot tell whether a turn runs \(1\): database is locked/);
  assert.equal(stuck.length, 1);
  assert.deepEqual({ reason: stuck[0].reason, attempts: stuck[0].attempts, conversationId: stuck[0].conversationId }, { reason: 'probe', attempts: 3, conversationId: 'conv-1' });
  clock += 60_000;
  service.request(fence());
  assert.equal(warnings.length, 2, 'logged again after the interval');
  // The probe answers again: the swap goes ahead.
  failing = false;
  assert.equal(service.request(fence()).state, 'swapping');
  await flush();
  assert.equal(stuck.length, 1);
});

function probeSetup({ stop = async () => ({ ok: true }) } = {}) {
  let clock = 0;
  const stuck = [];
  let failing = true;
  const service = createClaudeBillingSwapService({
    getWorker: () => ({ steering: { releasable: true } }),
    hasRunningTurn: () => { if (failing) throw new Error('database is locked'); return false; },
    stopWorker: stop,
    launchWorker: async () => ({ ok: true }),
    onStuck: (info) => stuck.push(info),
    now: () => clock,
    stuckAfter: 3,
    retryBaseMs: 1000,
    logger: { log() {}, warn() {} },
  });
  return {
    service,
    stuck,
    tick: (ms) => { clock += ms; },
    setFailing: (value) => { failing = value; },
  };
}

test('a brief probe hiccup (three failures within a second) says nothing to the chat', () => {
  const app = probeSetup();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(app.service.request(fence()).state, 'waiting');
    app.tick(200);
  }
  assert.deepEqual(app.stuck, []);
  // It lasts: the note comes once the streak is 30 s old.
  app.tick(30_000);
  app.service.request(fence());
  assert.equal(app.stuck.length, 1);
  assert.equal(app.stuck[0].reason, 'probe');
});

test('a probe episode does not silence a later stop note, nor a later probe episode', async () => {
  const app = probeSetup({ stop: async () => ({ ok: false, error: 'worker-survived-stop' }) });
  // A probe episode, noted.
  for (let index = 0; index < 3; index += 1) {
    app.service.request(fence());
    app.tick(20_000);
  }
  assert.deepEqual(app.stuck.map((info) => info.reason), ['probe']);
  // The probe answers; the stop then fails three times: its own note.
  app.setFailing(false);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(app.service.request(fence()).state, 'swapping');
    await flush();
    app.tick(60_000);
  }
  assert.deepEqual(app.stuck.map((info) => info.reason), ['probe', 'stop']);
  // A second probe episode is noted again.
  app.setFailing(true);
  for (let index = 0; index < 3; index += 1) {
    app.service.request(fence());
    app.tick(20_000);
  }
  assert.deepEqual(app.stuck.map((info) => info.reason), ['probe', 'stop', 'probe']);
});
