import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createRelayAskService } from './relay-ask-service.mjs';
import { RELAY_ASK_REMOTE_PATHS, createRelayAskLinkService } from './relay-ask-link-service.mjs';

const LEAD = 'conv-fixture-lead';

function setup({ answer }) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Lead', '2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z')`).run(LEAD);
  const told = [];
  const asks = createRelayAskService({
    db,
    relayEvents: { noteQuestionAnswered: (outcome) => told.push(outcome) },
    logger: { log() {}, warn() {} },
  });
  const timers = [];
  const calls = [];
  const link = createRelayAskLinkService({
    asks,
    registry: { get: (id) => (id === 'relay-lab' ? { id, name: 'lab', url: 'https://lab.example' } : null) },
    client: {
      async request(relay, method, path, { body }) {
        calls.push({ relay: relay.id, method, path, body });
        return answer(body);
      },
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.done = true; },
    logger: { warn() {} },
  });
  const runTimers = async () => {
    for (const timer of timers.splice(0)) {
      if (timer.done) continue;
      timer.done = true;
      timer.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { asks, link, calls, told, timers, runTimers };
}

test('the link asks the paired relay for its open asks until they close there, then tells the asker', async () => {
  let state = 'pending';
  const { asks, link, calls, told, timers, runTimers } = setup({
    answer: ({ ids }) => ({ asks: ids.map((id) => ({ id, status: state, ...(state === 'answered' ? { answer: 'Yes', choice: 'Yes' } : {}) })) }),
  });
  asks.addMirror({ relayId: 'relay-lab', createdBy: LEAD, remote: { id: 'ask_there01', question: 'Deploy?', options: ['Yes', 'No'], session: { id: 'conv-there', title: 'Far' } } });
  link.start();
  await runTimers();
  assert.deepEqual(calls[0], { relay: 'relay-lab', method: 'POST', path: RELAY_ASK_REMOTE_PATHS.status, body: { ids: ['ask_there01'] } });
  assert.equal(told.length, 0);
  assert.ok(link.isPolling('relay-lab'));
  assert.ok(timers.some((timer) => !timer.done), 'asked again later');
  state = 'answered';
  await runTimers();
  assert.equal(told.length, 1);
  assert.equal(told[0].relay.name, 'lab');
  assert.deepEqual(told[0].notify, [LEAD]);
  assert.equal(link.isPolling('relay-lab'), false, 'nothing open there any more');
});

test('a relay that does not answer is asked less often; a removed pairing ends its mirrors', async () => {
  const { asks, link, timers, runTimers } = setup({ answer: () => { throw new Error('offline'); } });
  asks.addMirror({ relayId: 'relay-lab', createdBy: LEAD, remote: { id: 'ask_there01', question: 'Deploy?', session: { id: 'conv-there' } } });
  link.start();
  await runTimers();
  const next = timers.find((timer) => !timer.done);
  assert.equal(next.ms, 30_000);
  assert.equal(asks.getMirror('relay-lab', 'ask_there01').status, 'pending', 'nothing lost meanwhile');
  asks.addMirror({ relayId: 'relay-gone', createdBy: LEAD, remote: { id: 'ask_there02', question: 'Q?', session: { id: 'conv-x' } } });
  await link.fetchNow('relay-gone');
  assert.equal(asks.getMirror('relay-gone', 'ask_there02').status, 'cancelled');
});
