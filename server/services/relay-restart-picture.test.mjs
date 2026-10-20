import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestartPicture,
  createRestartPictureCollector,
  describeRestartSurvival,
  detectRelayHosting,
} from './relay-restart-picture.mjs';

test('hosting: systemd needs the invocation id and a service cgroup, on Linux only', () => {
  const service = () => '0::/system.slice/oar.service\n';
  const scope = () => '0::/app.slice/vte-spawn-1.scope\n';
  assert.equal(detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'linux', readCgroup: service }).systemd, true);
  assert.equal(detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'linux', readCgroup: scope }).systemd, false);
  assert.equal(detectRelayHosting({ env: {}, argv: [], platform: 'linux', readCgroup: service }).systemd, false);
  assert.equal(detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'win32', readCgroup: service }).systemd, false);
  assert.equal(detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'linux', readCgroup: () => { throw new Error('no proc'); } }).systemd, false);
  assert.equal(detectRelayHosting({ env: {}, argv: ['node', 'server.js', '--supervised'], platform: 'linux' }).supervised, true);
});

test('survival: workers outlive a restart everywhere, and a shutdown except under systemd', () => {
  assert.equal(describeRestartSurvival({ action: 'restart', hosting: { systemd: true } }).workersSurvive, true);
  assert.equal(describeRestartSurvival({ action: 'restart', hosting: {} }).workersSurvive, true);
  assert.equal(describeRestartSurvival({ action: 'shutdown', hosting: {} }).workersSurvive, true);
  const stop = describeRestartSurvival({ action: 'shutdown', hosting: { systemd: true } });
  assert.equal(stop.workersSurvive, false);
  assert.match(stop.summary, /systemd/);
  assert.match(stop.summary, /may stop/);
});

const QUEUE_ROWS = [
  { conversation_id: 'c1', status: 'processing', cnt: 1, title: 'sidebar polish' },
  { conversation_id: 'c1', status: 'pending', cnt: 2, title: 'sidebar polish' },
  { conversation_id: 'c2', status: 'processing', cnt: 2, title: null },
  { conversation_id: 'c3', status: 'parked', cnt: 1, title: 'report builder' },
  { conversation_id: '', status: 'pending', cnt: 4, title: 'orphan' },
];
const BLOCKERS = [
  { kind: 'background', conversationId: 'c4', title: 'nightly export', count: 2, detail: '2 background agents: export; lint' },
  { kind: 'background', conversationId: 'c5', title: 'cloud chat', count: 1, detail: '1 background agent: build' },
  { kind: 'boot', detail: 'the relay just started' },
];

test('the picture: processing sessions wait, pending and parked are held, background tasks with their fate', () => {
  const picture = buildRestartPicture({
    action: 'restart',
    queueRows: QUEUE_ROWS,
    backgroundBlockers: BLOCKERS,
    hosting: { systemd: true },
    providerOf: (id) => (id === 'c5' ? 'claude-cloud' : 'claude'),
    titleOf: (id) => `title of ${id}`,
  });
  assert.deepEqual(picture.waitingFor, [
    { conversationId: 'c1', title: 'sidebar polish', turns: 1 },
    { conversationId: 'c2', title: 'title of c2', turns: 2 },
  ]);
  assert.equal(picture.held.count, 3);
  assert.deepEqual(picture.held.conversations.map((entry) => [entry.conversationId, entry.count]), [['c1', 2], ['c3', 1]]);
  assert.deepEqual(picture.backgroundTasks.map((task) => [task.conversationId, task.count, task.survives]), [['c4', 2, true], ['c5', 1, true]]);
  assert.equal(picture.survival.workersSurvive, true);
});

test('a shutdown under systemd stops the local workers\' tasks; a cloud session\'s survive', () => {
  const picture = buildRestartPicture({
    action: 'shutdown',
    queueRows: [],
    backgroundBlockers: BLOCKERS,
    hosting: { systemd: true },
    providerOf: (id) => (id === 'c5' ? 'claude-cloud' : 'claude'),
  });
  const byId = Object.fromEntries(picture.backgroundTasks.map((task) => [task.conversationId, task]));
  assert.equal(byId.c4.survives, false);
  assert.match(byId.c4.why, /may stop/);
  assert.equal(byId.c5.survives, true);
  assert.equal(byId.c5.why, 'runs in the cloud');
  assert.deepEqual(picture.waitingFor, []);
  assert.equal(picture.held.count, 0);
});

test('the collector reads the queue and the background-work view, and survives a failing view', () => {
  const statements = [];
  const db = { prepare: (sql) => { statements.push(sql); return { all: () => QUEUE_ROWS }; } };
  const collect = createRestartPictureCollector({
    db,
    backgroundWorkView: { backgroundBlockers: () => { throw new Error('gone'); } },
    hosting: {},
  });
  const picture = collect({ action: 'restart' });
  assert.match(statements[0], /GROUP BY q\.conversation_id, q\.status/);
  assert.equal(picture.waitingFor.length, 2);
  assert.deepEqual(picture.backgroundTasks, []);
});

test('tasks held since the last restart count as not yet confirmed, once per session, after the live ones', () => {
  const picture = buildRestartPicture({
    action: 'restart',
    backgroundBlockers: [BLOCKERS[0]],
    heldTasks: [
      { conversationId: 'c4', description: 'already listed live' },
      { conversationId: 'c6', description: 'npm run soak' },
      { conversationId: 'c6', description: 'tail the log' },
      { conversationId: '', description: 'no session' },
    ],
    titleOf: (id) => `title of ${id}`,
  });
  assert.deepEqual(picture.backgroundTasks.map((task) => [task.conversationId, task.survives]), [['c4', true], ['c6', null]]);
  const held = picture.backgroundTasks[1];
  assert.equal(held.count, 2);
  assert.equal(held.title, 'title of c6');
  assert.match(held.detail, /^2 tasks not yet confirmed since the last relay restart: npm run soak; tail the log$/);
  assert.match(held.why, /not confirmed/);
});

test('the collector reads the held tasks and survives a failing reader', () => {
  const db = { prepare: () => ({ all: () => [] }) };
  const ok = createRestartPictureCollector({ db, hosting: {}, listHeldTasks: () => [{ conversationId: 'c7', description: 'build' }] });
  assert.equal(ok({ action: 'restart' }).backgroundTasks[0].survives, null);
  const failing = createRestartPictureCollector({ db, hosting: {}, listHeldTasks: () => { throw new Error('closed'); } });
  assert.deepEqual(failing({ action: 'restart' }).backgroundTasks, []);
});
