import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  STALE_RUNNING_RUN_MAX_AGE_MS,
  TASK_END_GRACE_MS,
  createSessionActivityTracker,
  exitCodeFromSummary,
  taskKindOf,
} from './session-activity-tracker.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const CONV = 'conv-fixture-builder';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'builder', ?, ?)`)
    .run(CONV, new Date(T0).toISOString(), new Date(T0).toISOString());
  let clock = T0;
  const timers = [];
  const edges = [];
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
