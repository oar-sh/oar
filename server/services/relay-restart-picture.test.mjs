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

// The user manager's cgroup segment, built so no line reads as an email address.
const USER_MANAGER = ['user', '1000.service'].join('@');

test('hosting: the unit, and whether a user manager runs it', () => {
  const detect = (cgroup) => {
    const { systemd, unit, userManager } = detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'linux', readCgroup: () => cgroup });
    return { systemd, unit, userManager };
  };
  assert.deepEqual(detect(`0::/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/oar.service\n`), { systemd: true, unit: 'oar.service', userManager: true });
  assert.deepEqual(detect(`0::/user.slice/user-1000.slice/${USER_MANAGER}/oar-relay.service\n`), { systemd: true, unit: 'oar-relay.service', userManager: true });
  assert.deepEqual(detect('0::/system.slice/oar.service\n'), { systemd: true, unit: 'oar.service', userManager: false });
  // A worker in a scope of its own, a tmux pane, a login shell: not the service.
  for (const cgroup of [
    `0::/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/run-r3f2a.scope\n`,
    `0::/user.slice/user-1000.slice/${USER_MANAGER}/tmux-spawn-4c91.scope\n`,
    '0::/user.slice/user-1000.slice/session-3.scope\n',
    '',
  ]) {
    assert.deepEqual(detect(cgroup), { systemd: false, unit: '', userManager: false }, cgroup);
  }
  // cgroup v1 (hybrid): controller lines stop at the user manager; the
  // unified and name=systemd lines name the unit.
  assert.deepEqual(detect([
    `10:memory:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `7:pids:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `1:name=systemd:/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/oar.service`,
    `0::/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/oar.service`,
  ].join('\n')), { systemd: true, unit: 'oar.service', userManager: true });
  // v1 without the unified line: name=systemd alone.
  assert.deepEqual(detect([
    '12:cpu,cpuacct:/user.slice',
    `1:name=systemd:/user.slice/user-1000.slice/${USER_MANAGER}/oar.service`,
  ].join('\n')), { systemd: true, unit: 'oar.service', userManager: true });
  // A scoped worker on a hybrid host: the memory line still ends in the
  // user manager, but the worker is not the service.
  assert.deepEqual(detect([
    `10:memory:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `7:pids:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `1:name=systemd:/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/run-r3f2a.scope`,
    `0::/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/run-r3f2a.scope`,
  ].join('\n')), { systemd: false, unit: '', userManager: false });
  // Only controller lines: nothing to tell from.
  assert.deepEqual(detect(`10:memory:/user.slice/user-1000.slice/${USER_MANAGER}\n`), { systemd: false, unit: '', userManager: false });
});

test('hosting: the unified line counts only when it names a service (v2, hybrid with a bare 0::/, v1)', () => {
  const detect = (cgroup) => {
    const { systemd, unit, userManager } = detectRelayHosting({ env: { INVOCATION_ID: 'abc' }, argv: [], platform: 'linux', readCgroup: () => cgroup });
    return { systemd, unit, userManager };
  };
  const service = { systemd: true, unit: 'oar.service', userManager: true };
  const none = { systemd: false, unit: '', userManager: false };
  // cgroup v2: the unified line only.
  assert.deepEqual(detect(`0::/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/oar.service\n`), service);
  // Hybrid: the unified hierarchy mounted but unused, a bare `0::/`; the
  // name=systemd line names the unit.
  const hybrid = (named) => [
    '12:cpu,cpuacct:/user.slice',
    `10:memory:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `1:name=systemd:/user.slice/user-1000.slice/${USER_MANAGER}/${named}`,
    '0::/',
    '',
  ].join('\n');
  assert.deepEqual(detect(hybrid('app.slice/oar.service')), service);
  assert.deepEqual(detect(hybrid('app.slice/run-r3f2a.scope')), none, 'a scoped worker is still not the service');
  // cgroup v1: no unified line at all.
  assert.deepEqual(detect([
    '12:cpu,cpuacct:/user.slice',
    `10:memory:/user.slice/user-1000.slice/${USER_MANAGER}`,
    `1:name=systemd:/user.slice/user-1000.slice/${USER_MANAGER}/app.slice/oar.service`,
    '',
  ].join('\n')), service);
});

test('survival: workers outlive a restart and a shutdown, under systemd in scopes of their own', () => {
  assert.equal(describeRestartSurvival({ action: 'restart', hosting: { systemd: true } }).workersSurvive, true);
  assert.equal(describeRestartSurvival({ action: 'restart', hosting: {} }).workersSurvive, true);
  assert.equal(describeRestartSurvival({ action: 'shutdown', hosting: {} }).workersSurvive, true);
  const stop = describeRestartSurvival({ action: 'shutdown', hosting: { systemd: true, userManager: true, workerScopes: true } });
  assert.equal(stop.workersSurvive, true);
  assert.match(stop.summary, /systemd/);
  assert.match(stop.summary, /scopes of their own and keep running/);
  assert.match(stop.summary, /A worker on a tmux server or in a process started before OAR 0\.9\.20, inside the service, may stop once/);
  // A user service restarts as a whole: the same rule.
  const restart = describeRestartSurvival({ action: 'restart', hosting: { systemd: true, userManager: true, workerScopes: true } });
  assert.equal(restart.workersSurvive, true);
  assert.match(restart.summary, /a restart restarts the service/);
  // A system service only relaunches the runtime on a restart.
  assert.doesNotMatch(describeRestartSurvival({ action: 'restart', hosting: { systemd: true, userManager: false, workerScopes: false } }).summary, /systemd/);
});

test('survival: under systemd, workers that could not get scopes of their own may stop', () => {
  for (const action of ['shutdown', 'restart']) {
    for (const workerScopes of [false, undefined]) {
      const survival = describeRestartSurvival({ action, hosting: { systemd: true, userManager: true, workerScopes } });
      assert.equal(survival.workersSurvive, false, `${action} ${workerScopes}`);
      assert.match(survival.summary, /could not start its session workers outside it/);
    }
  }
  // A system service: no scopes, a shutdown may take the workers.
  assert.equal(describeRestartSurvival({ action: 'shutdown', hosting: { systemd: true, userManager: false, workerScopes: false } }).workersSurvive, false);
  const collect = createRestartPictureCollector({
    db: null,
    hosting: { systemd: true, userManager: true, unit: 'oar.service' },
    workerScopes: () => false,
    backgroundWorkView: { backgroundBlockers: () => [{ kind: 'background', conversationId: 'c1', title: 'export' }] },
  });
  const picture = collect({ action: 'shutdown' });
  assert.equal(picture.survival.workersSurvive, false);
  assert.equal(picture.backgroundTasks[0].survives, false);
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

test('a shutdown under systemd keeps the tasks of scoped workers', () => {
  const picture = buildRestartPicture({ action: 'shutdown', backgroundBlockers: BLOCKERS, hosting: { systemd: true, workerScopes: true } });
  assert.ok(picture.backgroundTasks.every((task) => task.survives === true));
});

test('a shutdown under systemd stops the tasks of workers without a scope; a cloud session\'s survive', () => {
  const picture = buildRestartPicture({
    action: 'shutdown',
    queueRows: [],
    backgroundBlockers: BLOCKERS,
    hosting: { systemd: true, workerScopes: false },
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
