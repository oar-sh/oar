import test from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_ASK_REMOTE_PATHS } from './relay-ask-link-service.mjs';
import { REMOTE_INBOX_CHANGED_EVENT, createRemoteInboxWatchService } from './remote-inbox-watch-service.mjs';

// The watch of paired relays' Inboxes: one push per card, from the
// relay that claimed it just now; a socket event when the pending set changes;
// nothing at all with no one to tell.

const RELAY_B = { id: 'r-b', name: 'relay-b', url: 'https://relay-b.example.test', lastStatus: 'online' };
const RELAY_C = { id: 'r-c', name: 'relay-c', url: 'https://relay-c.example.test', lastStatus: 'online' };

function card(id, extra = {}) {
  return {
    id,
    kind: 'approval',
    session: { id: `conv-${id}`, title: `Session ${id}` },
    status: 'pending',
    createdAt: '2026-03-02T10:00:00.000Z',
    question: '',
    summary: `New session requested by 'Lead': ${id}`,
    variant: 'create_session',
    notice: 'you',
    claimed: 'now',
    ...extra,
  };
}

function setup({ relays = [RELAY_B], subscribers = true, sockets = false, inbox = {} } = {}) {
  const calls = [];
  const pushes = [];
  const emitted = [];
  const state = { relays, subscribers, sockets, inbox };
  const service = createRemoteInboxWatchService({
    registry: { list: () => state.relays },
    client: {
      async request(relay, method, path, options) {
        calls.push({ relay: relay.id, method, path, timeoutMs: options?.timeoutMs });
        const answer = state.inbox[relay.id];
        if (answer instanceof Error) throw answer;
        return { ok: true, items: typeof answer === 'function' ? answer() : (answer || []) };
      },
    },
    push: {
      hasQuestionSubscribers: () => state.subscribers,
      notifyRemoteCard: async ({ relay, item }) => { pushes.push(`${relay.id}:${item.id}`); return { outcome: 'dispatched', sent: 1 }; },
    },
    hasSockets: () => state.sockets,
    emit: (event) => emitted.push(event),
    logger: { warn() {}, log() {} },
  });
  return { service, state, calls, pushes, emitted };
}

test('a card claimed just now is pushed once; the same card claimed before is not pushed again', async () => {
  const fx = setup({ inbox: { 'r-b': [card('c1')] } });
  await fx.service.sweep();
  assert.deepEqual(fx.pushes, ['r-b:c1']);
  assert.deepEqual(fx.calls, [{ relay: 'r-b', method: 'GET', path: `${RELAY_ASK_REMOTE_PATHS.inbox}?push=1`, timeoutMs: 5000 }]);
  fx.state.inbox['r-b'] = [card('c1', { claimed: 'before' })];
  await fx.service.sweep();
  // Even if the card relay said `now` again (it restarted), this relay remembers it pushed.
  fx.state.inbox['r-b'] = [card('c1')];
  await fx.service.sweep();
  assert.deepEqual(fx.pushes, ['r-b:c1']);
});

test('no push for a card its relay reached a device for, is still pushing, or another relay claimed; nor for plans and asks', async () => {
  const fx = setup({
    inbox: {
      'r-b': [
        card('here', { notice: 'here', claimed: undefined }),
        card('wait', { notice: 'wait', claimed: undefined }),
        card('other', { notice: 'other', claimed: undefined }),
        card('none', { notice: undefined, claimed: undefined }),
        card('plan', { kind: 'plan' }),
        card('ask', { kind: 'ask' }),
        card('done', { status: 'answered' }),
        card('question', { kind: 'ask_user', question: 'Which theme?' }),
      ],
    },
  });
  await fx.service.sweep();
  assert.deepEqual(fx.pushes, ['r-b:question']);
});

test('offline and unauthorized relays are not asked; a relay that fails keeps what it listed', async () => {
  const fx = setup({
    relays: [RELAY_B, { ...RELAY_C, lastStatus: 'offline' }, { id: 'r-d', name: 'relay-d', lastStatus: 'unauthorized' }],
    inbox: { 'r-b': [card('c1', { notice: 'here', claimed: undefined })] },
  });
  await fx.service.sweep();
  assert.deepEqual(fx.calls.map((call) => call.relay), ['r-b']);
  assert.deepEqual(fx.emitted, [REMOTE_INBOX_CHANGED_EVENT]);
  fx.state.inbox['r-b'] = new Error('timeout');
  await fx.service.sweep();
  assert.deepEqual(fx.emitted, [REMOTE_INBOX_CHANGED_EVENT], 'an unanswered read changes nothing');
});

test('at most 3 pushes per relay and sweep; the cards held back go on the next sweep, once', async () => {
  const cards = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => card(id));
  const fx = setup({ relays: [RELAY_B, RELAY_C], inbox: { 'r-b': cards, 'r-c': [card('x1')] } });
  await fx.service.sweep();
  assert.deepEqual(fx.pushes.sort(), ['r-b:c1', 'r-b:c2', 'r-b:c3', 'r-c:x1']);
  // The card relay recorded the claims: the held-back cards now come back `before`.
  fx.state.inbox['r-b'] = cards.map((item) => ({ ...item, claimed: 'before' }));
  await fx.service.sweep();
  assert.deepEqual(fx.pushes.filter((key) => key.startsWith('r-b:')).sort(), ['r-b:c1', 'r-b:c2', 'r-b:c3', 'r-b:c4', 'r-b:c5']);
  await fx.service.sweep();
  assert.equal(fx.pushes.length, 6);
});

test('after a restart here, a card claimed before is not pushed again; one nobody claimed is pushed at any age', async () => {
  const old = '2026-03-01T00:00:00.000Z';
  const fx = setup({
    inbox: { 'r-b': [card('mine', { claimed: 'before', createdAt: old }), card('fresh-claim', { claimed: 'now', createdAt: old })] },
  });
  await fx.service.sweep();
  assert.deepEqual(fx.pushes, ['r-b:fresh-claim']);
});

test('with no question subscribers and no browser, a sweep does nothing; with a browser only, it reads without claiming', async () => {
  const fx = setup({ subscribers: false, sockets: false, inbox: { 'r-b': [card('c1')] } });
  assert.deepEqual(await fx.service.sweep(), { skipped: true });
  assert.equal(fx.calls.length, 0);
  fx.state.sockets = true;
  await fx.service.sweep();
  assert.deepEqual(fx.calls.map((call) => call.path), [RELAY_ASK_REMOTE_PATHS.inbox]);
  assert.deepEqual(fx.pushes, [], 'nothing pushed without a device to push to');
  assert.deepEqual(fx.emitted, [REMOTE_INBOX_CHANGED_EVENT]);
});

test('the socket event goes out only when the set of pending remote items changed', async () => {
  const fx = setup({ subscribers: false, sockets: true, inbox: { 'r-b': [] } });
  await fx.service.sweep();
  assert.deepEqual(fx.emitted, [], 'nothing pending, nothing changed');
  fx.state.inbox['r-b'] = [card('c1', { notice: undefined })];
  await fx.service.sweep();
  await fx.service.sweep();
  assert.equal(fx.emitted.length, 1);
  fx.state.inbox['r-b'] = [card('c2', { notice: undefined })];
  await fx.service.sweep();
  assert.equal(fx.emitted.length, 2, 'one went, another came: same count, still a change');
  fx.state.inbox['r-b'] = [card('c2', { notice: undefined }), card('c3', { kind: 'plan', notice: undefined, status: 'acted' })];
  await fx.service.sweep();
  assert.equal(fx.emitted.length, 2, 'a settled item is no pending change');
  fx.state.relays = [];
  await fx.service.sweep();
  assert.equal(fx.emitted.length, 3, 'an unpaired relay\'s items leave');
});

test('the sweep runs every 20 s ± 3 s until stopped, one at a time', async () => {
  const timers = [];
  let reads = 0;
  const service = createRemoteInboxWatchService({
    registry: { list: () => [RELAY_B] },
    client: { request: async () => { reads += 1; return { items: [] }; } },
    push: { hasQuestionSubscribers: () => false, notifyRemoteCard: async () => {} },
    hasSockets: () => true,
    random: () => 1,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  service.start();
  service.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 23_000);
  await timers[0].fn();
  assert.equal(reads, 1);
  assert.equal(timers.length, 2);
  service.stop();
  assert.equal(timers[1].cleared, true);
});

test('a push that never settles does not hold the sweep: the next sweep is still scheduled and runs', async () => {
  const timers = [];
  const warnings = [];
  let reads = 0;
  const service = createRemoteInboxWatchService({
    registry: { list: () => [RELAY_B] },
    client: { request: async () => { reads += 1; return { items: [card('c1'), card('c2')] }; } },
    push: { hasQuestionSubscribers: () => true, notifyRemoteCard: () => new Promise(() => {}) },
    hasSockets: () => true,
    logger: { warn: (line) => warnings.push(line) },
    random: () => 0.5,
    pushWaitMs: 10,
    // The sweep timers are driven by hand; the push wait runs for real.
    setTimer: (fn, ms) => {
      if (ms === 10) return setTimeout(fn, ms);
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer && !('fn' in timer)) clearTimeout(timer); },
  });
  service.start();
  await timers[0].fn();
  assert.equal(reads, 1);
  assert.equal(timers.length, 2, 'the next sweep is scheduled');
  assert.equal(warnings.length, 2, 'each hung push gave up after its wait');
  assert.match(warnings[0], /no answer from the push service/);
  await timers[1].fn();
  assert.equal(reads, 2, 'and it runs');
  service.stop();
});

test('stop() and start() during a sweep leave one timer chain', async () => {
  const timers = [];
  let release;
  let reads = 0;
  const service = createRemoteInboxWatchService({
    registry: { list: () => [RELAY_B] },
    client: {
      request: () => {
        reads += 1;
        return reads === 1 ? new Promise((resolve) => { release = () => resolve({ items: [] }); }) : Promise.resolve({ items: [] });
      },
    },
    push: { hasQuestionSubscribers: () => false, notifyRemoteCard: async () => {} },
    hasSockets: () => true,
    random: () => 0.5,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  service.start();
  const oldTick = timers[0].fn();
  service.stop();
  service.start();
  assert.equal(timers.length, 2, 'the new chain\'s first timer');
  release();
  await oldTick;
  assert.equal(timers.length, 2, 'the old chain\'s sweep schedules nothing after it ends');
  await timers[1].fn();
  assert.equal(timers.length, 3);
  service.stop();
});
