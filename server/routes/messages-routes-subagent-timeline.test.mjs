import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';
import { SUBAGENT_TOOL_RESULT_MAX_CHARS } from '../../shared/subagent-timeline.mjs';
import { subagentViewerRoom } from '../services/subagent-viewer-rooms.mjs';

// The sub-agent viewer's relay side, on the real schema and repositories:
// timeline writes fenced by the run row, header patches, the read route, the
// mirror for providers without a timeline of their own, and the status
// events that carry the run's own turn.

const CONV = 'conv-subagent-1';
const OTHER_CONV = 'conv-subagent-2';
const RUN = 'toolu_fixture_alpha';
const CHILD = 'toolu_fixture_beta';
const NOW = '2026-10-10T10:00:00.000Z';

function boot({ tasks = [] } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  for (const id of [CONV, OTHER_CONV]) {
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, 'Widget work', ?, 'active', ?, ?)`)
      .run(id, id, NOW, NOW);
  }
  for (const [id, conv, status] of [['q-1', CONV, 'done'], ['q-2', CONV, 'processing'], ['q-other', OTHER_CONV, 'processing']]) {
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'prompt', ?, ?)`).run(id, conv, status, NOW);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const emitted = [];
  const taskSets = new Map([[CONV, tasks]]);
  const deps = makeRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
      to: (room) => ({ volatile: { emit: (event, payload) => emitted.push({ event, payload, room, volatile: true }) } }),
    },
    subagentTimelineDefer: (flush) => flush(),
    ts: () => NOW,
    uuidv4: () => crypto.randomUUID(),
    DEFAULT_RELAY_MODE: 'agent',
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 200),
    backgroundTaskStore: {
      replace: (id, list) => taskSets.set(id, list),
      get: (id) => taskSets.get(id) || [],
    },
  });
  const routes = captureRoutes(deps);
  const call = (method, path, options) => invokeRoute(routes, method, path, options);
  const events = (name) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload);
  return { db, stmts, call, events, emitted, taskSets };
}

async function spawnRun(call, { runId = RUN, messageId = 'q-1', conversationId = CONV, parentSubagentId, ...extra } = {}) {
  return call('POST', '/api/subagent-run', {
    body: { messageId, conversationId, subagentRunId: runId, parentSubagentId, displayName: 'Survey the widget parser', status: 'running', ...extra },
  });
}

test('timeline entries need a known run and land under its own turn', async () => {
  const { call, events, emitted } = boot();
  const unknown = await call('POST', '/api/subagent-timeline', { body: { conversationId: CONV, subagentRunId: RUN, entries: [{ key: 'w:1', kind: 'text', text: 'x' }] } });
  assert.equal(unknown.status, 404);

  await spawnRun(call, { timelineOwner: 'worker' });
  const stored = await call('POST', '/api/subagent-timeline', {
    body: {
      conversationId: CONV,
      subagentRunId: RUN,
      entries: [
        { key: 'w:1', kind: 'thought', text: 'Reading the parser first', done: true },
        { key: 'w:2', kind: 'tool_call', toolName: 'Read', toolUseId: 'toolu_read_1', text: '{"file_path":"/home/dev/widget/parser.js"}' },
        { key: 'w:3', kind: 'tool_result', toolUseId: 'toolu_read_1', text: 'y'.repeat(SUBAGENT_TOOL_RESULT_MAX_CHARS + 10) },
      ],
    },
  });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.stored, 3);
  const [event] = events('subagent_timeline');
  assert.equal(event.messageId, 'q-1', 'the run names its own turn, not an open one');
  const [sent] = emitted.filter((entry) => entry.event === 'subagent_timeline');
  assert.equal(sent.room, subagentViewerRoom(RUN), 'only to the pages watching this run');
  assert.equal(sent.volatile, true, 'never kept for a reconnect replay');
  assert.deepEqual(event.entries.map((entry) => [entry.seq, entry.kind]), [[1, 'thought'], [2, 'tool_call'], [3, 'tool_result']]);
  assert.equal(event.entries[2].text.length, SUBAGENT_TOOL_RESULT_MAX_CHARS);
  assert.equal(event.entries[2].metadata.cut, SUBAGENT_TOOL_RESULT_MAX_CHARS + 10);
});

test('a write for a run of another conversation is refused', async () => {
  const { call } = boot();
  await spawnRun(call);
  const wrong = await call('POST', '/api/subagent-timeline', { body: { conversationId: OTHER_CONV, subagentRunId: RUN, entries: [{ key: 'k', kind: 'text', text: 'x' }] } });
  assert.equal(wrong.status, 409);
  const missing = await call('POST', '/api/subagent-timeline', { body: { conversationId: CONV, entries: [] } });
  assert.equal(missing.status, 400);
});

test('an agent spawned inside a known run is created under its parent\'s turn', async () => {
  const { call, stmts, events } = boot();
  await spawnRun(call);
  const created = await call('POST', '/api/subagent-timeline', {
    body: {
      conversationId: CONV,
      subagentRunId: CHILD,
      header: { parentSubagentId: RUN, displayName: 'Check the fixtures', subagentType: 'general-purpose', timelineOwner: 'worker' },
      entries: [{ key: 'w:1', kind: 'text', text: 'Fixtures look fine.' }],
    },
  });
  assert.equal(created.status, 200);
  const child = stmts.getSubagentRun.get(CHILD);
  assert.equal(child.queue_message_id, 'q-1');
  assert.equal(child.parent_subagent_id, RUN);
  assert.equal(child.subagent_type, 'general-purpose');
  const status = events('subagent_status').find((event) => event.subagentRunId === CHILD);
  assert.equal(status.messageId, 'q-1');
  assert.equal(status.parentSubagentId, RUN);
});

test('a run update without a messageId ends a background run from a later turn', async () => {
  const { call, stmts, events } = boot();
  await spawnRun(call, { background: true });
  // The spawning turn's id is not the open turn's: a later turn must not name it.
  const mismatch = await spawnRun(call, { messageId: 'q-2', status: 'completed' });
  assert.equal(mismatch.status, 409);

  const ended = await call('POST', '/api/subagent-run', { body: { conversationId: CONV, subagentRunId: RUN, status: 'stopped' } });
  assert.equal(ended.status, 200);
  const row = stmts.getSubagentRun.get(RUN);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.background, 1);
  assert.ok(row.completed_at);
  const last = events('subagent_status').at(-1);
  assert.equal(last.messageId, 'q-1');
  assert.equal(last.status, 'cancelled');

  const unknownWithoutTurn = await call('POST', '/api/subagent-run', { body: { conversationId: CONV, subagentRunId: 'toolu_nobody', status: 'running' } });
  assert.equal(unknownWithoutTurn.status, 400);
});

test('a header-only run update keeps the run\'s state', async () => {
  const { call, stmts } = boot();
  await spawnRun(call);
  await call('POST', '/api/subagent-run', { body: { conversationId: CONV, subagentRunId: RUN, status: 'completed' } });
  await call('POST', '/api/subagent-run', { body: { conversationId: CONV, subagentRunId: RUN, subagentType: 'Explore' } });
  const row = stmts.getSubagentRun.get(RUN);
  assert.equal(row.status, 'completed');
  assert.equal(row.subagent_type, 'Explore');
});

test('the task panel feed fills the run header, once per change', async () => {
  const { call, stmts, events } = boot();
  await spawnRun(call);
  const tasks = [{ taskId: 'task-1', taskType: 'local_agent', description: 'Survey the widget parser', toolUseId: RUN, model: 'claude-fixture-model', subagentType: 'general-purpose', totalTokens: 1200 }];
  await call('POST', '/api/background-tasks', { body: { conversationId: CONV, tasks } });
  const before = events('subagent_status').length;
  await call('POST', '/api/background-tasks', { body: { conversationId: CONV, tasks } });
  assert.equal(events('subagent_status').length, before, 'an unchanged task emits nothing');
  const row = stmts.getSubagentRun.get(RUN);
  assert.equal(row.model, 'claude-fixture-model');
  assert.equal(row.task_id, 'task-1');
  assert.equal(row.total_tokens, 1200);
  assert.equal(row.background, 1);
  const [panel] = events('background_tasks');
  assert.equal(panel.tasks[0].toolUseId, RUN, 'the panel row can open its run');
});

test('the read route serves header, entries after a seq, open entries and children', async () => {
  const { call } = boot({ tasks: [{ taskId: 'task-1', toolUseId: RUN, stoppable: true }] });
  await spawnRun(call, { background: true, timelineOwner: 'worker' });
  await call('POST', '/api/subagent-timeline', {
    body: {
      conversationId: CONV,
      subagentRunId: RUN,
      entries: [
        { key: 'w:1', kind: 'text', text: 'Draft so far', done: false },
        { key: 'w:2', kind: 'tool_call', toolName: 'Grep', text: '{"pattern":"widget"}' },
        { key: 'w:3', kind: 'child', toolUseId: CHILD, text: 'Check the fixtures' },
      ],
    },
  });
  await spawnRun(call, { runId: CHILD, parentSubagentId: RUN });

  const page = await call('GET', '/api/conversation/:conversationId/subagent/:subagentRunId', { params: { conversationId: CONV, subagentRunId: RUN }, query: {} });
  assert.equal(page.status, 200);
  assert.equal(page.body.run.subagentRunId, RUN);
  assert.equal(page.body.run.stoppable, true);
  assert.equal(page.body.run.background, true);
  assert.deepEqual(page.body.entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.deepEqual(page.body.children.map((child) => child.subagentRunId), [CHILD]);
  assert.equal(page.body.complete, true);

  const after = await call('GET', '/api/conversation/:conversationId/subagent/:subagentRunId', { params: { conversationId: CONV, subagentRunId: RUN }, query: { after: '2' } });
  assert.deepEqual(after.body.entries.map((entry) => entry.seq), [1, 3], 'the open entry comes along');

  const wrong = await call('GET', '/api/conversation/:conversationId/subagent/:subagentRunId', { params: { conversationId: OTHER_CONV, subagentRunId: RUN }, query: {} });
  assert.equal(wrong.status, 404);
});

test('frames on a sub-agent lane are mirrored for runs no worker writes, uncut', async () => {
  const { call, events } = boot();
  await spawnRun(call, { messageId: 'q-2' });
  const longLine = `Tool (Bash): ${'x'.repeat(400)}`;
  await call('POST', '/api/activity', { body: { messageId: 'q-2', conversationId: CONV, text: longLine, subagentRunId: RUN } });
  await call('POST', '/api/thought', { body: { messageId: 'q-2', conversationId: CONV, text: 'Plan the change', reasoningId: 'r-1', done: false, subagentRunId: RUN } });
  await call('POST', '/api/thought', { body: { messageId: 'q-2', conversationId: CONV, text: 'Plan the change carefully', reasoningId: 'r-1', done: true, subagentRunId: RUN } });
  await call('POST', '/api/stream', { body: { messageId: 'q-2', conversationId: CONV, text: 'Done: the parser', done: false, subagentRunId: RUN } });
  await call('POST', '/api/stream', { body: { messageId: 'q-2', conversationId: CONV, text: 'Done: the parser is fixed.', done: true, subagentRunId: RUN } });

  const page = await call('GET', '/api/conversation/:conversationId/subagent/:subagentRunId', { params: { conversationId: CONV, subagentRunId: RUN }, query: {} });
  assert.deepEqual(page.body.entries.map((entry) => [entry.kind, entry.done]), [['tool_call', true], ['thought', true], ['text', true]]);
  assert.equal(page.body.entries[0].text, longLine);
  assert.equal(page.body.entries[0].toolName, 'Bash');
  assert.equal(page.body.entries[1].text, 'Plan the change carefully');
  assert.equal(page.body.entries[2].text, 'Done: the parser is fixed.');
  assert.ok(events('subagent_timeline').length >= 4);
});

test('runs a worker writes itself are not mirrored', async () => {
  const { call } = boot();
  await spawnRun(call, { messageId: 'q-2', timelineOwner: 'worker' });
  await call('POST', '/api/activity', { body: { messageId: 'q-2', conversationId: CONV, text: 'Tool (Read): /home/dev/a.js', subagentRunId: RUN } });
  const page = await call('GET', '/api/conversation/:conversationId/subagent/:subagentRunId', { params: { conversationId: CONV, subagentRunId: RUN }, query: {} });
  assert.deepEqual(page.body.entries, []);
  assert.equal(page.body.run.legacy, undefined, 'a worker-owned run never falls back to the lanes');
});

test('a failed turn closes its foreground runs with their turn named, and leaves background runs alone', async () => {
  const { call, stmts, events } = boot();
  await spawnRun(call, { runId: 'toolu_fixture_front', messageId: 'q-2' });
  await spawnRun(call, { runId: 'toolu_fixture_back', messageId: 'q-2', background: true });
  const failed = await call('POST', '/api/requeue', {
    body: { messageId: 'q-2', terminalError: { kind: 'claude-turn-failed', code: 'turn-error', message: 'The fixture turn failed.' } },
  });
  assert.equal(failed.status, 200);
  assert.equal(stmts.getSubagentRun.get('toolu_fixture_front').status, 'failed');
  assert.equal(stmts.getSubagentRun.get('toolu_fixture_back').status, 'running');
  const closed = events('subagent_status').find((event) => event.subagentRunId === 'toolu_fixture_front' && event.reconciled);
  assert.ok(closed, 'a reconcile event was sent');
  assert.equal(closed.messageId, 'q-2', 'the event names the run\'s turn so the browser can place it');
  assert.equal(closed.status, 'failed');
});
