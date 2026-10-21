import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  BOOT_REPORTING_WINDOW_MAX_MS,
  BOOT_REPORTING_WINDOW_MS,
  STALE_RUNNING_RUN_MAX_AGE_MS,
  TASK_END_GRACE_MS,
  UNLISTED_RUNNING_RUN_MAX_QUIET_MS,
  UNREPORTED_BACKGROUND_TASK_ID,
  createSessionActivityTracker,
  resolveBootReportingWindowMs,
  exitCodeFromSummary,
  taskKindOf,
} from './session-activity-tracker.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const CONV = 'conv-fixture-builder';

// `db` and `startAt`: a second tracker on the same database, as a relay
// runtime that starts later on the same state.
function setup({ db = null, startAt = T0, ...trackerOptions } = {}) {
  if (!db) {
    db = new Database(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'builder', ?, ?)`)
      .run(CONV, new Date(T0).toISOString(), new Date(T0).toISOString());
  }
  let clock = startAt;
  const timers = [];
  const edges = [];
  const tracker = createSessionActivityTracker({
    ...trackerOptions,
    db,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.done = true; },
    onEdge: (edge) => edges.push(edge),
    logger: { warn() {} },
  });
  return {
    db,
    tracker,
    edges,
    advance(ms) {
      clock += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= clock) {
          timer.done = true;
          timer.fn();
        }
      }
    },
    at: () => clock,
  };
}

const shellTask = (extra = {}) => ({ taskId: 'task-shell-1', taskType: 'local_bash', description: 'npm test', startedAt: T0, ...extra });
const agentTask = (extra = {}) => ({ taskId: 'task-agent-1', taskType: 'local_agent', description: 'M1 orbit camera', toolUseId: 'toolu_fixture_orbit', startedAt: T0, ...extra });

function seedRun(db, { id = 'toolu_fixture_orbit', status = 'running', background = 1 } = {}) {
  const at = new Date(T0).toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES (?, 'q-fixture', ?, 'M1 orbit camera', ?, ?, ?, ?)
  `).run(id, CONV, status, at, at, background);
}

test('task kinds and exit codes', () => {
  assert.equal(taskKindOf('local_bash'), 'shell');
  assert.equal(taskKindOf('local_agent'), 'subagent');
  assert.equal(taskKindOf('local_workflow'), 'subagent');
  assert.equal(exitCodeFromSummary('Command failed. Exit code 2'), 2);
  assert.equal(exitCodeFromSummary('exited with 0'), 0);
  // The shape the Claude CLI reports for a background shell (probed 2026-10-11).
  assert.equal(exitCodeFromSummary('Background command "npm run build" failed with exit code 3'), 3);
  assert.equal(exitCodeFromSummary('done'), null);
});

test('an idle session with background tasks reads background_only, with its tasks', () => {
  const { tracker, edges } = setup();
  assert.equal(tracker.describe(CONV).state, 'idle');
  tracker.noteTaskSet(CONV, [shellTask(), agentTask()]);
  const view = tracker.describe(CONV);
  assert.equal(view.state, 'background_only');
  assert.equal(view.runningTaskCount, 2);
  assert.deepEqual(view.tasks.map((task) => [task.kind, task.description, task.status]), [
    ['shell', 'npm test', 'running'],
    ['subagent', 'M1 orbit camera', 'running'],
  ]);
  assert.equal(view.tasks[0].startedAt, new Date(T0).toISOString());
  assert.deepEqual(edges.map((edge) => edge.type), ['task_started', 'task_started']);
});

test('a processing turn wins over tasks', () => {
  const { db, tracker } = setup();
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES ('q-1', ?, 'go', 'processing', ?, ?)`)
    .run(CONV, new Date(T0).toISOString(), new Date(T0).toISOString());
  tracker.noteTaskSet(CONV, [shellTask()]);
  assert.equal(tracker.describe(CONV).state, 'running_turn');
});

test('a turn held at the usage limit is not a running turn', () => {
  const { db, tracker } = setup();
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, next_attempt_at, usage_limit_pause) VALUES ('q-2', ?, 'go', 'pending', ?, ?, '{}')`)
    .run(CONV, new Date(T0).toISOString(), new Date(T0 + 3_600_000).toISOString());
  assert.equal(tracker.describe(CONV).state, 'idle');
});

test('the settled notice gives the end its status and exit code, once', () => {
  const { tracker, edges } = setup();
  tracker.noteTaskSet(CONV, [shellTask()]);
  tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'completed', summary: 'Exit code 1' });
  tracker.noteTaskSet(CONV, [shellTask()]);
  tracker.noteTaskSet(CONV, []);
  const ends = edges.filter((edge) => edge.type !== 'task_started');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].type, 'task_failed');
  assert.equal(ends[0].task.exitCode, 1);
  const view = tracker.describe(CONV);
  assert.equal(view.state, 'idle');
  assert.equal(view.tasks[0].status, 'completed');
  assert.equal(view.tasks[0].exitCode, 1);
});

test('the settled notice replaces the live progress line: its summary, or none', () => {
  const { tracker } = setup();
  tracker.noteTaskSet(CONV, [agentTask({ summary: '⟳ Thinking…' }), shellTask({ summary: 'running suite 3' })]);
  tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', status: 'completed', summary: null });
  tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'completed', summary: 'Exit code 0' });
  tracker.noteTaskSet(CONV, []);
  const byId = Object.fromEntries(tracker.describe(CONV).tasks.map((task) => [task.id, task]));
  assert.equal(byId['task-agent-1'].summary ?? null, null);
  assert.equal(byId['task-shell-1'].summary, 'Exit code 0');
});

test('a settle without a summary after an end by absence clears the progress line too', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ summary: '⟳ Thinking…' })]);
  t.tracker.noteTaskSet(CONV, []);
  t.advance(TASK_END_GRACE_MS + 1);
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', status: 'completed' });
  const [ended] = t.tracker.describe(CONV).tasks;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.summary ?? null, null);
});

test('a task that leaves without word ends after the grace, outcome not reported', () => {
  const { tracker, edges, advance } = setup();
  tracker.noteTaskSet(CONV, [shellTask()]);
  tracker.noteTaskSet(CONV, []);
  assert.equal(edges.filter((edge) => edge.type === 'task_finished').length, 0);
  advance(TASK_END_GRACE_MS);
  const finished = edges.filter((edge) => edge.type === 'task_finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].task.statusReported, false);
});

test('a background agent ends with its run status, whichever arrives first', () => {
  const { db, tracker, edges, advance } = setup();
  seedRun(db);
  tracker.noteTaskSet(CONV, [agentTask()]);
  tracker.noteTaskSet(CONV, []);
  db.prepare(`UPDATE subagent_runs SET status = 'failed' WHERE id = 'toolu_fixture_orbit'`).run();
  tracker.noteSubagentRun({ id: 'toolu_fixture_orbit', conversation_id: CONV, status: 'failed', background: 1 });
  advance(TASK_END_GRACE_MS);
  const ends = edges.filter((edge) => edge.type !== 'task_started');
  assert.deepEqual(ends.map((edge) => [edge.type, edge.task.status]), [['task_failed', 'failed']]);
});

test('a background run with no task in the set ends on its own status', () => {
  const { db, tracker, edges } = setup();
  seedRun(db, { id: 'toolu_fixture_copilot' });
  assert.equal(tracker.describe(CONV).state, 'background_only');
  db.prepare(`UPDATE subagent_runs SET status = 'completed', completed_at = ? WHERE id = 'toolu_fixture_copilot'`).run(new Date(T0).toISOString());
  tracker.noteSubagentRun({ id: 'toolu_fixture_copilot', conversation_id: CONV, status: 'completed', background: 1, display_name: 'scan' });
  tracker.noteSubagentRun({ id: 'toolu_fixture_copilot', conversation_id: CONV, status: 'completed', background: 1, display_name: 'scan' });
  assert.deepEqual(edges.map((edge) => edge.type), ['task_finished']);
  assert.equal(tracker.describe(CONV).state, 'idle');
});

test('an in-turn sub-agent run raises no edge', () => {
  const { tracker, edges } = setup();
  tracker.noteSubagentRun({ id: 'toolu_fixture_inturn', conversation_id: CONV, status: 'completed', background: 0 });
  assert.equal(edges.length, 0);
});

test('activity moves the clock; a changed task is activity', () => {
  const { tracker, advance, at } = setup();
  tracker.noteTaskSet(CONV, [shellTask()]);
  advance(60_000);
  tracker.noteTaskSet(CONV, [shellTask({ summary: 'compiling' })]);
  assert.equal(tracker.describe(CONV).tasks[0].lastActivityAt, new Date(at()).toISOString());
  advance(60_000);
  tracker.touch(CONV);
  assert.equal(tracker.describe(CONV).lastActivityAt, new Date(at()).toISOString());
});

test('a dead worker takes its tasks without edges', () => {
  const { tracker, edges } = setup();
  tracker.noteTaskSet(CONV, [shellTask()]);
  tracker.noteWorkerDied(CONV);
  assert.equal(tracker.describe(CONV).state, 'idle');
  assert.deepEqual(edges.map((edge) => edge.type), ['task_started']);
});

test('a running run row not touched for a day is not running work', () => {
  const { db, tracker } = setup();
  const stale = new Date(T0 - STALE_RUNNING_RUN_MAX_AGE_MS - 60_000).toISOString();
  const fresh = new Date(T0 - STALE_RUNNING_RUN_MAX_AGE_MS + 60 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES ('run_fixture_stale', 'q-fixture', ?, 'Forgotten', 'running', ?, ?, 1)
  `).run(CONV, stale, stale);
  assert.equal(tracker.describe(CONV).state, 'idle');
  assert.equal(tracker.describe(CONV).runningTaskCount, 0);
  assert.ok(!tracker.describe(CONV).tasks.some((task) => task.runId === 'run_fixture_stale'), 'the stale row is not listed');

  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES ('run_fixture_fresh', 'q-fixture', ?, 'Still at it', 'running', ?, ?, 1)
  `).run(CONV, fresh, fresh);
  const view = tracker.describe(CONV);
  assert.equal(view.state, 'background_only');
  assert.equal(view.runningTaskCount, 1);
  assert.equal(view.tasks[0].runId, 'run_fixture_fresh', 'a run touched within the bound still counts');
});

// ─── A relay runtime that starts while workers and their tasks keep running ──

const RESTART_AT = T0 + 10 * 60_000;
const oldShell = (extra = {}) => shellTask({ startedAt: T0 + 1_000, ...extra });

test('a new runtime knows nothing of a running shell until the worker sends its set again', () => {
  const before = setup();
  before.advance(1_000);
  before.tracker.noteTaskSet(CONV, [oldShell()]);
  assert.equal(before.tracker.describe(CONV).state, 'background_only');
  assert.deepEqual(before.edges.map((edge) => edge.type), ['task_started']);

  const after = setup({ db: before.db, startAt: RESTART_AT });
  assert.equal(after.tracker.describe(CONV).state, 'idle');

  after.advance(2_000);
  after.tracker.noteTaskSet(CONV, [oldShell()], { resync: true });
  const view = after.tracker.describe(CONV);
  assert.equal(view.state, 'background_only');
  assert.equal(view.tasks[0].id, 'task-shell-1');
  assert.equal(view.tasks[0].startedAt, new Date(T0 + 1_000).toISOString(), 'the start time is the worker\'s, not the resync\'s');
  assert.deepEqual(after.edges, [], 'the runtime before this one announced the start');
});

test('a task older than the runtime is not a start, whichever post brings it back', () => {
  const after = setup({ startAt: RESTART_AT });
  // A progress update overtakes the resync: an ordinary post, no flag.
  after.tracker.noteTaskSet(CONV, [oldShell({ summary: 'running suite 3 of 9' })]);
  after.tracker.noteTaskSet(CONV, [oldShell({ summary: 'running suite 3 of 9' })], { resync: true });
  assert.equal(after.tracker.describe(CONV).state, 'background_only');
  assert.deepEqual(after.edges, []);
});

test('a resync announces a task that started since the runtime did, once', () => {
  const t = setup();
  t.advance(5_000);
  // Its first post was lost; the resync is the first the relay hears of it.
  t.tracker.noteTaskSet(CONV, [shellTask({ startedAt: T0 + 4_000 })], { resync: true });
  t.tracker.noteTaskSet(CONV, [shellTask({ startedAt: T0 + 4_000 })], { resync: true });
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started']);
  // Without a start time the resync flag decides: restored, not announced.
  t.tracker.noteTaskSet(CONV, [shellTask({ startedAt: T0 + 4_000 }), { taskId: 'task-shell-2', taskType: 'local_bash', description: 'npm run build' }], { resync: true });
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started']);
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 2);
});

test('a task that ended while the set was out of step ends once', () => {
  const t = setup();
  t.advance(1_000);
  t.tracker.noteTaskSet(CONV, [shellTask({ startedAt: T0 + 1_000 }), agentTask({ startedAt: T0 + 1_000 })]);
  t.edges.length = 0;
  // The post that dropped the shell was lost; the resync is the first set without it.
  t.tracker.noteTaskSet(CONV, [agentTask({ startedAt: T0 + 1_000 })], { resync: true });
  t.advance(TASK_END_GRACE_MS + 1);
  assert.deepEqual(t.edges.map((edge) => `${edge.type}:${edge.task.id}`), ['task_finished:task-shell-1']);
  // The worker's kept settle notice arrives after it: no second end.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'completed', description: 'npm test', taskType: 'local_bash' });
  assert.equal(t.edges.length, 1);
});

test('the end of a task the runtime never knew is an event when the worker describes it', () => {
  const after = setup({ startAt: RESTART_AT });
  after.tracker.noteTaskSettled(CONV, {
    taskId: 'task-shell-1', status: 'failed', summary: 'Exit code 2', description: 'npm test', taskType: 'local_bash', startedAt: T0 + 1_000,
  });
  assert.equal(after.edges.length, 1);
  assert.equal(after.edges[0].type, 'task_failed');
  assert.deepEqual(
    { id: after.edges[0].task.id, kind: after.edges[0].task.kind, description: after.edges[0].task.description, exitCode: after.edges[0].task.exitCode, startedAt: after.edges[0].task.startedAt },
    { id: 'task-shell-1', kind: 'shell', description: 'npm test', exitCode: 2, startedAt: new Date(T0 + 1_000).toISOString() },
  );
  assert.equal(after.tracker.describe(CONV).state, 'idle');
  assert.equal(after.tracker.describe(CONV).tasks[0].status, 'failed');
  // Sent again (the worker never saw the answer): still one end. And the
  // set that still lists it, arriving late, does not bring it back.
  after.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'failed', description: 'npm test', taskType: 'local_bash' });
  after.tracker.noteTaskSet(CONV, [oldShell()], { resync: true });
  assert.equal(after.edges.length, 1);
  assert.equal(after.tracker.describe(CONV).state, 'idle');
});

test('a settle notice for an unknown task without a description stays silent', () => {
  // What a worker that predates the description sends, and what any worker
  // sends for a task that never was session-level background work.
  const t = setup();
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-9', status: 'completed', summary: 'done' });
  assert.deepEqual(t.edges, []);
  assert.deepEqual(t.tracker.describe(CONV).tasks, []);
});

test('background work a live worker reports without a set shows as one placeholder task', () => {
  const unreported = new Set([CONV]);
  const t = setup({
    startAt: RESTART_AT,
    hasUnreportedBackgroundWork: (id) => unreported.has(id),
    listUnreportedBackgroundWork: () => [...unreported],
  });
  assert.deepEqual(t.tracker.knownConversationIds(), [CONV], 'readers that ask only about known conversations ask about it');
  const view = t.tracker.describe(CONV);
  assert.equal(view.state, 'background_only');
  assert.equal(view.runningTaskCount, 1);
  assert.deepEqual(view.tasks, [{
    id: UNREPORTED_BACKGROUND_TASK_ID,
    kind: 'unknown',
    type: null,
    description: 'background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)',
    startedAt: null,
    lastActivityAt: null,
    status: 'running',
    placeholder: true,
  }]);
  // The real set replaces it: the task is older than the runtime, so no start.
  t.tracker.noteTaskSet(CONV, [oldShell()]);
  unreported.clear();
  assert.deepEqual(t.tracker.describe(CONV).tasks.map((task) => task.id), ['task-shell-1']);
  // And a placeholder that simply goes (the flag went false) ends nothing.
  const gone = setup({ startAt: RESTART_AT, hasUnreportedBackgroundWork: () => false });
  assert.equal(gone.tracker.describe(CONV).state, 'idle');
  assert.deepEqual([...t.edges, ...gone.edges], [], 'the placeholder raises no start and no end');
});

test('a running background run in the database stands for the reported work: no placeholder beside it', () => {
  const t = setup({ startAt: RESTART_AT, hasUnreportedBackgroundWork: () => true });
  t.db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES ('toolu_fixture_orbit', 'q-fixture', ?, 'M1 orbit camera', 'running', ?, ?, 1)
  `).run(CONV, new Date(RESTART_AT - 60_000).toISOString(), new Date(RESTART_AT - 60_000).toISOString());
  assert.deepEqual(t.tracker.describe(CONV).tasks.map((task) => task.id), ['toolu_fixture_orbit']);
});

test('the boot reporting window: one constant, the tracker\'s clock, an override for test relays', () => {
  assert.equal(BOOT_REPORTING_WINDOW_MS, 45_000);
  const t = setup();
  assert.deepEqual(t.tracker.bootReporting(), { active: true, ageMs: 0, remainingMs: 45_000 });
  t.advance(44_999);
  assert.deepEqual(t.tracker.bootReporting(), { active: true, ageMs: 44_999, remainingMs: 1 });
  t.advance(1);
  assert.deepEqual(t.tracker.bootReporting(), { active: false, ageMs: 45_000, remainingMs: 0 });
  assert.equal(setup({ bootReportingWindowMs: 0 }).tracker.bootReporting().active, false);
  assert.equal(resolveBootReportingWindowMs({}), 45_000);
  assert.equal(resolveBootReportingWindowMs({ OAR_BOOT_REPORTING_WINDOW_MS: '0' }), 0);
  assert.equal(resolveBootReportingWindowMs({ OAR_BOOT_REPORTING_WINDOW_MS: '1500' }), 1_500);
  assert.equal(resolveBootReportingWindowMs({ OAR_BOOT_REPORTING_WINDOW_MS: 'soon' }), 45_000);
});

test('an override of the boot window is kept within a sane range and logged once', () => {
  const lines = [];
  const resolve = (value) => resolveBootReportingWindowMs({ OAR_BOOT_REPORTING_WINDOW_MS: value }, (line) => lines.push(line));
  assert.equal(resolveBootReportingWindowMs({}, (line) => lines.push(line)), 45_000);
  assert.deepEqual(lines, [], 'no override, no line');
  assert.equal(BOOT_REPORTING_WINDOW_MAX_MS, 10 * 60_000);
  // Above 2^31 ms a timer's delay overflows to 1 ms: never passed on.
  assert.equal(resolve('4000000000'), BOOT_REPORTING_WINDOW_MAX_MS);
  assert.equal(resolve('0'), 0);
  assert.equal(resolve('1500.9'), 1_500);
  // Not a value at all: the default, never "no wait".
  assert.equal(resolve('-5'), 45_000);
  assert.equal(resolve('soon'), 45_000);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /wait 600000 ms after a relay start \(asked for 4000000000, kept within 0 to 600000\)/);
  assert.match(lines[1], /OAR_BOOT_REPORTING_WINDOW_MS=0: no wait after a relay start/);
  assert.match(lines[2], /wait 1500 ms/);
  assert.match(lines[3], /OAR_BOOT_REPORTING_WINDOW_MS=-5 is not a number of milliseconds from 0; using 45000/);
  assert.match(lines[4], /OAR_BOOT_REPORTING_WINDOW_MS=soon is not a number of milliseconds from 0; using 45000/);
});

// ─── Sets out of turn, and ends reported twice ───────────────────────────────

test('a task ended only by its absence from a set comes back when a later set lists it, with no second start', () => {
  const t = setup();
  t.advance(1_000);
  const first = shellTask({ startedAt: T0 + 1_000 });
  const third = { taskId: 'task-shell-3', taskType: 'local_bash', description: 'npm run build', startedAt: T0 + 1_000 };
  t.tracker.noteTaskSet(CONV, [first, third]);
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_started']);
  // A set without the third task (an older one that arrived late, from a
  // worker that numbers none), and nothing says how it ended.
  t.tracker.noteTaskSet(CONV, [first]);
  t.advance(TASK_END_GRACE_MS + 1);
  assert.deepEqual(t.edges.map((edge) => `${edge.type}:${edge.task.id}`).slice(2), ['task_finished:task-shell-3']);
  assert.equal(t.edges[2].task.statusReported, false);
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);

  // The next set lists it again: it never ended.
  t.advance(4_000);
  t.tracker.noteTaskSet(CONV, [first, third]);
  const view = t.tracker.describe(CONV);
  assert.equal(view.runningTaskCount, 2);
  assert.deepEqual(view.tasks.map((task) => [task.id, task.status]), [['task-shell-1', 'running'], ['task-shell-3', 'running']], 'and its ended row is gone from the recent ones');
  assert.equal(view.tasks[1].startedAt, new Date(T0 + 1_000).toISOString());
  assert.equal(t.edges.length, 3, 'no second task_started');

  // Its real end is reported as an end.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-3', status: 'failed', summary: 'Exit code 1' });
  assert.deepEqual(t.edges.map((edge) => `${edge.type}:${edge.task.id}`).slice(3), ['task_failed:task-shell-3']);
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);
});

test('a task whose end was reported stays ended when a late set lists it', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [shellTask()]);
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'completed' });
  t.tracker.noteTaskSet(CONV, [shellTask()]);
  assert.equal(t.tracker.describe(CONV).state, 'idle');
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished']);
});

function seedUnknownRun(db, { taskId = null, name = 'M1 orbit camera', startedAt = RESTART_AT - 60_000 } = {}) {
  const at = new Date(startedAt).toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background, task_id)
    VALUES ('toolu_fixture_orbit', 'q-fixture', ?, ?, 'running', ?, ?, 1, ?)
  `).run(CONV, name, at, at, taskId);
}
const runEnd = { id: 'toolu_fixture_orbit', conversation_id: CONV, status: 'completed', background: 1, display_name: 'M1 orbit camera' };
const agentSettle = (extra = {}) => ({
  taskId: 'task-agent-1', status: 'completed', description: 'M1 orbit camera', taskType: 'local_agent', startedAt: RESTART_AT - 60_000, ...extra,
});

test('one end for a sub-agent the runtime never knew: a described settle without a run id is paired by the task id on the run', () => {
  const seed = { taskId: 'task-agent-1', name: 'orbit' };
  const settle = agentSettle({ description: 'camera work', startedAt: null });
  // The run's status first, then the worker's notice.
  const runFirst = setup({ startAt: RESTART_AT });
  seedUnknownRun(runFirst.db, seed);
  runFirst.db.prepare(`UPDATE subagent_runs SET status = 'completed', completed_at = ?`).run(new Date(RESTART_AT).toISOString());
  runFirst.tracker.noteSubagentRun(runEnd);
  runFirst.tracker.noteTaskSettled(CONV, settle);
  assert.deepEqual(runFirst.edges.map((edge) => edge.type), ['task_finished']);
  // The notice first, then the run's status.
  const settleFirst = setup({ startAt: RESTART_AT });
  seedUnknownRun(settleFirst.db, seed);
  settleFirst.tracker.noteTaskSettled(CONV, settle);
  settleFirst.tracker.noteSubagentRun(runEnd);
  assert.deepEqual(settleFirst.edges.map((edge) => edge.type), ['task_finished']);
});

test('a settle notice is never paired with a run by name or by start time: another agent\'s end is not swallowed', () => {
  // Two background agents of one name, started half a second apart, neither
  // row carrying a task id. The first ends: its run status, then its notice.
  const t = setup({ startAt: RESTART_AT });
  const insert = t.db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES (?, 'q-fixture', ?, 'review pass', 'running', ?, ?, 1)
  `);
  insert.run('toolu_fixture_first', CONV, new Date(RESTART_AT - 60_000).toISOString(), new Date(RESTART_AT - 60_000).toISOString());
  insert.run('toolu_fixture_second', CONV, new Date(RESTART_AT - 59_500).toISOString(), new Date(RESTART_AT - 59_500).toISOString());
  t.db.prepare(`UPDATE subagent_runs SET status = 'completed', completed_at = ? WHERE id = 'toolu_fixture_first'`).run(new Date(RESTART_AT).toISOString());
  t.tracker.noteSubagentRun({ id: 'toolu_fixture_first', conversation_id: CONV, status: 'completed', background: 1, display_name: 'review pass' });
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-first', status: 'completed', description: 'review pass', taskType: 'local_agent', startedAt: RESTART_AT - 60_000 });
  // The second agent is untouched: still running in the state…
  assert.deepEqual(t.tracker.describe(CONV).tasks.filter((task) => task.status === 'running').map((task) => task.id), ['toolu_fixture_second']);
  // …restored when the worker sends its set again…
  t.tracker.noteTaskSet(CONV, [{ taskId: 'task-agent-second', taskType: 'local_agent', description: 'review pass', toolUseId: 'toolu_fixture_second', startedAt: RESTART_AT - 59_500 }], { resync: true });
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);
  // …and its own end is sent.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-second', toolUseId: 'toolu_fixture_second', status: 'failed', description: 'review pass', taskType: 'local_agent' });
  const ends = t.edges.map((edge) => `${edge.type}:${edge.task.runId || edge.task.id}`);
  assert.ok(ends.includes('task_failed:toolu_fixture_second'), ends.join(' '));
  assert.equal(ends.filter((end) => end.endsWith('toolu_fixture_second')).length, 1);
});

test('a described settle for an unknown shell is not paired with a run', () => {
  const t = setup({ startAt: RESTART_AT });
  seedUnknownRun(t.db, { name: 'npm test' });
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'completed', description: 'npm test', taskType: 'local_bash', startedAt: RESTART_AT - 60_000 });
  t.tracker.noteSubagentRun(runEnd);
  assert.equal(t.edges.length, 2, 'a shell and a sub-agent of the same name are two pieces of work');
});

test('a run that ends finds its live task by the task id on the run when the set named no run', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ toolUseId: undefined })]);
  seedRun(t.db);
  t.tracker.noteSubagentRun({ id: 'toolu_fixture_orbit', conversation_id: CONV, status: 'completed', background: 1, task_id: 'task-agent-1' });
  t.tracker.noteTaskSet(CONV, []);
  t.advance(TASK_END_GRACE_MS + 1);
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished']);
});

test('an end by absence that a settle notice then confirms is final: a late set does not bring the task back', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [shellTask()]);
  t.tracker.noteTaskSet(CONV, []);
  t.advance(TASK_END_GRACE_MS + 1);
  assert.equal(t.edges.at(-1).task.statusReported, false);
  // The word on how it ended arrives after the grace.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-shell-1', status: 'failed', summary: 'Exit code 2' });
  assert.equal(t.edges.length, 2, 'the end was reported already; no second one');
  const [ended] = t.tracker.describe(CONV).tasks;
  assert.deepEqual([ended.status, ended.exitCode, 'statusReported' in ended], ['failed', 2, false], 'the ended row now says how');
  // A set of an older worker, without an order, that still lists it.
  t.tracker.noteTaskSet(CONV, [shellTask()]);
  assert.equal(t.tracker.describe(CONV).state, 'idle');
  assert.equal(t.edges.length, 2);
});

test('an end by absence that the run\'s status then confirms is final too', () => {
  const t = setup();
  seedRun(t.db);
  t.tracker.noteTaskSet(CONV, [agentTask()]);
  t.tracker.noteTaskSet(CONV, []);
  t.advance(TASK_END_GRACE_MS + 1);
  t.db.prepare(`UPDATE subagent_runs SET status = 'completed', completed_at = ? WHERE id = 'toolu_fixture_orbit'`).run(new Date(t.at()).toISOString());
  t.tracker.noteSubagentRun({ id: 'toolu_fixture_orbit', conversation_id: CONV, status: 'completed', background: 1 });
  t.tracker.noteTaskSet(CONV, [agentTask()]);
  assert.equal(t.tracker.describe(CONV).state, 'idle');
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished']);
});

test('a running background row that its worker\'s set does not list is dropped once it has been quiet for 15 minutes', () => {
  let listed = null;
  const t = setup({ runListedByWorker: () => listed });
  seedRun(t.db);
  t.advance(UNLISTED_RUNNING_RUN_MAX_QUIET_MS + 1);
  assert.equal(t.tracker.describe(CONV).state, 'background_only', 'the worker has not reported: the row counts');
  listed = true;
  assert.equal(t.tracker.describe(CONV).state, 'background_only');
  listed = false;
  assert.equal(t.tracker.describe(CONV).state, 'idle');
  assert.deepEqual(t.tracker.describe(CONV).tasks, []);
  // Touched since: running work again.
  t.db.prepare(`UPDATE subagent_runs SET updated_at = ?`).run(new Date(t.at() - 60_000).toISOString());
  assert.equal(t.tracker.describe(CONV).state, 'background_only');
  // A run inside a turn is not judged by the task set.
  t.db.prepare(`UPDATE subagent_runs SET updated_at = started_at, background = 0`).run();
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);
});

// ─── A resumed sub-agent: the same task id, a run of its own ────────────────

// A Claude session that sends a finished background agent a new message
// resumes it: the CLI registers the same task id again, with a new run id
// (the SDK's `run_id`, `taskRunId` in the worker's set).
test('a resumed sub-agent is a running task again, with a start of its own, and ends once more', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', toolUseId: 'toolu_fixture_orbit', taskRunId: 'run-fixture-1', status: 'completed', summary: 'First pass done' });
  t.tracker.noteTaskSet(CONV, []);
  // A late set of the first run does not bring it back.
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  assert.equal(t.tracker.describe(CONV).state, 'idle');

  t.advance(60_000);
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-2', startedAt: T0 + 60_000, summary: null })]);
  const view = t.tracker.describe(CONV);
  assert.equal(view.state, 'background_only');
  assert.deepEqual(view.tasks.map((task) => [task.id, task.status, task.runId]), [['task-agent-1', 'running', 'toolu_fixture_orbit']],
    'one row: the task runs again, the first run\'s end is not listed beside it');
  assert.equal(view.tasks[0].startedAt, new Date(T0 + 60_000).toISOString());
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished', 'task_started']);

  // A settle of the first run that arrives late does not end the second.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', toolUseId: 'toolu_fixture_orbit', taskRunId: 'run-fixture-1', status: 'completed' });
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);

  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', toolUseId: 'toolu_fixture_orbit', taskRunId: 'run-fixture-2', status: 'failed', summary: 'Tests still red' });
  t.tracker.noteTaskSet(CONV, []);
  const ended = t.tracker.describe(CONV);
  assert.equal(ended.state, 'idle');
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished', 'task_started', 'task_failed']);
  assert.equal(ended.tasks[0].summary, 'Tests still red');
});

test('a set that names no run cannot tell a resume from a late set: the ended task stays ended', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', taskRunId: 'run-fixture-1', status: 'completed' });
  t.tracker.noteTaskSet(CONV, [agentTask()]);
  assert.equal(t.tracker.describe(CONV).state, 'idle');
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished']);
});

test('a task back in the set within the grace, under another run, ended and started again: the earlier run\'s late notice does not end it', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  // It leaves without word, and is resumed before the grace is over.
  t.tracker.noteTaskSet(CONV, []);
  t.advance(1_000);
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-2', startedAt: T0 + 1_000 })]);
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started', 'task_finished', 'task_started']);
  // The first run's notice, sent again late.
  t.tracker.noteTaskSettled(CONV, { taskId: 'task-agent-1', taskRunId: 'run-fixture-1', status: 'failed' });
  t.advance(TASK_END_GRACE_MS + 1);
  const view = t.tracker.describe(CONV);
  assert.equal(view.runningTaskCount, 1);
  assert.equal(view.tasks[0].startedAt, new Date(T0 + 1_000).toISOString());
  assert.equal(t.edges.length, 3);
});

test('a task back in the set within the grace under the same run never ended', () => {
  const t = setup();
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  t.tracker.noteTaskSet(CONV, []);
  t.tracker.noteTaskSet(CONV, [agentTask({ taskRunId: 'run-fixture-1' })]);
  t.advance(TASK_END_GRACE_MS + 1);
  assert.equal(t.tracker.describe(CONV).runningTaskCount, 1);
  assert.deepEqual(t.edges.map((edge) => edge.type), ['task_started']);
});
