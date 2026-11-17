import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerSessionLiveness } from './worker-session-liveness.mjs';

const LIVE_PID = 4101;
const DEAD_PID = 4102;

function liveness({ liveSockets = [], pids = {}, processes = [], findProcessForSession } = {}) {
  const asked = [];
  const probe = createWorkerSessionLiveness({
    hasLiveWorkerSocket: (sessionId) => liveSockets.includes(sessionId),
    getWorkerPid: (sessionId) => pids[sessionId] ?? null,
    isPidAlive: (pid) => pid === LIVE_PID,
    findProcessForSession: findProcessForSession === undefined
      ? async (sessionId) => { asked.push(sessionId); return processes.includes(sessionId) ? { processId: 77 } : null; }
      : findProcessForSession,
  });
  return { ...probe, asked };
}

test('a live socket, the registry pid, the hinted pid or the process list each make a session alive; none makes it dead', async () => {
  const probe = liveness({ liveSockets: ['sdk-socket'], pids: { 'sdk-registry': LIVE_PID, 'sdk-hint': DEAD_PID }, processes: ['sdk-listed'] });
  assert.equal(await probe.probe('sdk-socket'), 'alive');
  assert.equal(await probe.probe('sdk-registry'), 'alive');
  assert.equal(await probe.probe('sdk-hint', { hintPid: LIVE_PID }), 'alive');
  assert.equal(await probe.probe('sdk-listed'), 'alive');
  assert.equal(await probe.probe('sdk-gone'), 'dead');
  assert.equal(await probe.probe('sdk-hint'), 'dead', 'the registry pid is dead and nothing lists it');
  // The pids cost nothing and answer first: the process list is asked last.
  assert.deepEqual(probe.asked, ['sdk-listed', 'sdk-gone', 'sdk-hint']);
});

test('a worker whose socket went quiet but whose process runs is alive', async () => {
  const byPid = liveness({ pids: { 'sdk-quiet': LIVE_PID } });
  assert.equal(await byPid.probe('sdk-quiet'), 'alive');
  const byList = liveness({ processes: ['sdk-quiet'] });
  assert.equal(await byList.probe('sdk-quiet'), 'alive');
});

test('a live socket is alive even when no process is found for the session', async () => {
  const probe = liveness({ liveSockets: ['sdk-remote'] });
  assert.equal(await probe.probe('sdk-remote'), 'alive');
  assert.deepEqual(probe.asked, [], 'the process list is not asked');
});

test('a process list that throws, or none at all, answers unknown', async () => {
  const errors = [];
  const throwing = liveness({ findProcessForSession: async () => { throw new Error('powershell timed out'); } });
  assert.equal(await throwing.probe('sdk-x', { onLookupError: (sessionId, error) => errors.push([sessionId, error.message]) }), 'unknown');
  assert.deepEqual(errors, [['sdk-x', 'powershell timed out']]);
  const none = liveness({ findProcessForSession: null });
  assert.equal(await none.probe('sdk-x'), 'unknown');
  assert.equal(await none.probe('sdk-x', { hintPid: LIVE_PID }), 'alive', 'a live pid still answers');
});

test('probeAll answers every session together, within its limit', async () => {
  const probe = liveness({ liveSockets: ['sdk-a'], processes: ['sdk-b'] });
  const { states, unanswered } = await probe.probeAll(['sdk-a', 'sdk-b', 'sdk-c'], { timeoutMs: 5_000 });
  assert.equal(unanswered, 0);
  assert.deepEqual([...states], [['sdk-a', 'alive'], ['sdk-b', 'alive'], ['sdk-c', 'dead']]);
});

test('probeAll stops waiting at its limit: a session that has not answered is unknown, and a late answer changes nothing', async () => {
  let answerLate = null;
  const probe = liveness({
    pids: { 'sdk-pid': LIVE_PID },
    findProcessForSession: (sessionId) => (sessionId === 'sdk-slow'
      ? new Promise((resolve) => { answerLate = () => resolve(null); })
      : Promise.resolve(null)),
  });
  const startedAt = Date.now();
  const { states, unanswered } = await probe.probeAll(['sdk-pid', 'sdk-fast', 'sdk-slow'], { timeoutMs: 40 });
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(unanswered, 1);
  assert.deepEqual([...states], [['sdk-pid', 'alive'], ['sdk-fast', 'dead'], ['sdk-slow', 'unknown']]);
  answerLate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.get('sdk-slow'), 'unknown');
});

test('probeAll with a throwing lookup reports it and answers unknown for that session', async () => {
  const errors = [];
  const probe = liveness({ findProcessForSession: async (sessionId) => { if (sessionId === 'sdk-bad') throw new Error('access denied'); return null; } });
  const { states, unanswered } = await probe.probeAll(['sdk-bad', 'sdk-gone'], { timeoutMs: 5_000, onLookupError: (sessionId) => errors.push(sessionId) });
  assert.equal(unanswered, 0);
  assert.deepEqual([...states], [['sdk-bad', 'unknown'], ['sdk-gone', 'dead']]);
  assert.deepEqual(errors, ['sdk-bad']);
});
