// The task console's routes: what a worker may publish about a task's output,
// how an end becomes an ended row, who may read the output, and the snapshot
// fallback for a task with no file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBackgroundTaskStore } from '../services/background-task-store.mjs';
import { createTaskOutputSnapshots } from '../services/task-output-service.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const OUTPUT_ROUTE = '/api/conversation/:conversationId/background-task/:taskId/output';
const CONVERSATIONS = {
  'conv-1': { id: 'conv-1', sdk_session_id: 'sess-1' },
  'conv-2': { id: 'conv-2', sdk_session_id: 'sess-2' },
};

function boot(t, { workerConnected = true, provider = 'claude', trackedTasks = [], runs = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createBackgroundTaskStore();
  const snapshots = createTaskOutputSnapshots();
  const emitted = [];
  const controls = [];
  const pokes = [];
  const routes = captureRoutes(makeRouteDeps({
    backgroundTaskStore: store,
    taskOutputSnapshots: snapshots,
    pokeTaskHealth: () => pokes.push(Date.now()),
    getTaskStallMinutes: () => 15,
    stmts: {
      getConvAnyStatus: { get: (id) => CONVERSATIONS[id] || null },
      getRuntimeSessionByConversation: { get: (id) => (CONVERSATIONS[id] ? { provider_type: provider } : null) },
      getSubagentRun: { get: (id) => runs[id] || null },
    },
    sessionActivityTracker: { describe: (id) => ({ state: 'idle', tasks: id === 'conv-1' ? trackedTasks : [] }) },
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    sendWorkerControl: (sessionId, control) => {
      controls.push({ sessionId, control });
      return workerConnected;
    },
    resolveConversationRecord: ({ sdkSessionId }) => Object.values(CONVERSATIONS).find((conv) => conv.sdk_session_id === sdkSessionId) || null,
    remoteRelayInbound: { inboundEnabled: () => false, listRelays: () => [] },
  }));
  const file = path.join(dir, 'task-b7.log');
  return {
    dir,
    file,
    store,
    snapshots,
    emitted,
    controls,
    pokes,
    post: async (routePath, body, params = {}) => invokeRoute(routes, 'POST', routePath, { body, params }),
    output: async (conversationId, taskId, query = {}, headers = {}) => invokeRoute(routes, 'GET', OUTPUT_ROUTE, { params: { conversationId, taskId }, query, headers }),
  };
}

test('the publish route keeps outputPath, outputKind, steps and exitCode, and the first path wins', async (t) => {
  const fx = boot(t);
  await fx.post('/api/background-tasks', {
    conversationId: 'sess-1',
    tasks: [
      { taskId: 'task-b7', taskType: 'local_bash', description: 'npm test', outputPath: fx.file },
      { taskId: 'agent-c8', taskType: 'local_agent', steps: '22', outputPath: 'relative.log' },
      { taskId: 'task-d9', taskType: 'local_bash', outputKind: 'snapshot' },
      { taskId: 'task-e0', taskType: 'local_bash', outputKind: 'spool' },
      { taskId: 'task-f1', taskType: 'local_bash', exitCode: null, steps: -3 },
    ],
  });
  const [shell, agent, snapshot, spoolWithoutPath, plain] = fx.store.get('sess-1');
  assert.deepEqual([shell.outputPath, shell.outputKind], [fx.file, 'file']);
  assert.deepEqual([agent.outputPath, agent.outputKind, agent.steps], [undefined, undefined, 22]);
  assert.deepEqual([snapshot.outputPath, snapshot.outputKind], [undefined, 'snapshot']);
  assert.equal(spoolWithoutPath.outputKind, 'none');
  assert.deepEqual([plain.exitCode, plain.steps, plain.outputKind], [undefined, undefined, undefined]);
  const event = fx.emitted.find((entry) => entry.event === 'background_tasks').payload;
  assert.deepEqual(event.endedTasks, []);
  assert.equal(event.conversationId, 'sess-1');

  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [{ taskId: 'task-b7', taskType: 'local_bash', outputPath: '/tmp/elsewhere.log' }] });
  assert.equal(fx.store.get('sess-1')[0].outputPath, fx.file);
});

test('a settle post: its exit code only when sent, steps kept, and an ended row for a task with output', async (t) => {
  const fx = boot(t);
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [{ taskId: 'task-b7', taskType: 'local_bash', outputPath: fx.file }] });
  await fx.post('/api/background-task-settled', { conversationId: 'sess-1', taskId: 'task-b7', status: 'completed', exitCode: null, steps: 4 });
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [] });
  const [row] = fx.store.ended('sess-1');
  assert.deepEqual([row.status, row.exitCode, row.steps], ['completed', null, 4]);
  const last = fx.emitted.filter((entry) => entry.event === 'background_tasks').at(-1).payload;
  assert.deepEqual(last.tasks, []);
  assert.equal(last.endedTasks[0].taskId, 'task-b7');

  // An end this runtime never saw live, naming its output, still becomes a row.
  await fx.post('/api/background-task-settled', { conversationId: 'sess-1', taskId: 'task-z1', status: 'failed', exitCode: 2, outputPath: fx.file, description: 'lint' });
  const late = fx.store.ended('sess-1').find((entry) => entry.taskId === 'task-z1');
  assert.deepEqual([late.status, late.exitCode, late.description], ['failed', 2, 'lint']);
  assert.equal(fx.emitted.filter((entry) => entry.event === 'background_tasks').at(-1).payload.endedTasks.length, 2);
});

test('a shell row\'s command line is kept scrubbed and cut, on the live row, the ended row and the output answer', async (t) => {
  const fx = boot(t);
  fs.writeFileSync(fx.file, 'building\n');
  const secret = 'API_TOKEN=s3cretValue42 npm test 2>&1 | tail -40';
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [
    { taskId: 'task-b7', taskType: 'local_bash', description: 'Run the tests', command: `\x1b[31m${secret}\x1b[0m`, outputPath: fx.file },
    { taskId: 'task-c8', taskType: 'local_bash', command: `echo ${'x'.repeat(5000)}` },
    { taskId: 'task-d9', taskType: 'local_bash', command: { not: 'a string' } },
  ] });
  const [shell, long, odd] = fx.store.get('sess-1');
  assert.equal(shell.command, 'API_TOKEN=[redacted] npm test 2>&1 | tail -40');
  assert.equal(long.command.length, 2000);
  assert.equal('command' in odd && odd.command !== undefined, false);
  const event = fx.emitted.filter((entry) => entry.event === 'background_tasks').at(-1).payload;
  assert.doesNotMatch(JSON.stringify(event), /s3cretValue42/, 'the pages never see it');

  const answer = await fx.output('conv-1', 'task-b7');
  assert.equal(answer.body.task.command, 'API_TOKEN=[redacted] npm test 2>&1 | tail -40');

  // The ended row keeps it; an end this runtime never saw live brings its own, scrubbed too.
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [] });
  assert.equal(fx.store.ended('sess-1').find((row) => row.taskId === 'task-b7').command, 'API_TOKEN=[redacted] npm test 2>&1 | tail -40');
  await fx.post('/api/background-task-settled', { conversationId: 'sess-1', taskId: 'task-z1', status: 'failed', exitCode: 2, outputPath: fx.file, description: 'lint', command: 'PASSWORD=hunter2hunter npm run lint | head' });
  assert.equal(fx.store.ended('sess-1').find((row) => row.taskId === 'task-z1').command, 'PASSWORD=[redacted] npm run lint | head');
});

test('a description, summary and tool call are scrubbed too: a Grok row\'s description is its command line', async (t) => {
  const fx = boot(t);
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [
    {
      taskId: 'term-1',
      taskType: 'local_bash',
      description: 'DB_PASSWORD=hunter22lantern npm run migrate',
      command: 'DB_PASSWORD=hunter22lantern npm run migrate',
      summary: 'ran curl -u builder:s3cr3tpass https://example.com',
      lastToolCall: 'Bash: deploy --token=abcd1234wxyz',
      outputPath: fx.file,
    },
  ] });
  const [row] = fx.store.get('sess-1');
  assert.equal(row.description, 'DB_PASSWORD=[redacted] npm run migrate');
  assert.equal(row.summary, 'ran curl -u builder:[redacted] https://example.com');
  assert.equal(row.lastToolCall, 'Bash: deploy --token=[redacted]');
  const sent = JSON.stringify(fx.emitted);
  for (const secret of ['hunter22lantern', 's3cr3tpass', 'abcd1234wxyz']) assert.doesNotMatch(sent, new RegExp(secret));

  await fx.post('/api/background-task-settled', { conversationId: 'sess-1', taskId: 'term-9', status: 'failed', exitCode: 1, outputPath: fx.file, description: 'API_TOKEN=lan7ernS3cretValue make', summary: 'exit code 1' });
  assert.equal(fx.store.ended('sess-1').find((entry) => entry.taskId === 'term-9').description, 'API_TOKEN=[redacted] make');
});

test('a task with a console that ends has the health poller read soon', async (t) => {
  const fx = boot(t);
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [
    { taskId: 'task-b7', taskType: 'local_bash', outputPath: fx.file },
    { taskId: 'task-c8', taskType: 'local_bash' },
  ] });
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [{ taskId: 'task-b7', taskType: 'local_bash', outputPath: fx.file }] });
  assert.equal(fx.pokes.length, 0, 'a task without a console ending is no reason');
  await fx.post('/api/background-tasks', { conversationId: 'sess-1', tasks: [] });
  assert.equal(fx.pokes.length, 1);
  await fx.post('/api/background-task-settled', { conversationId: 'sess-1', taskId: 'task-b7', status: 'failed', exitCode: 1 });
  assert.equal(fx.pokes.length, 2, 'a settle that updates the ended row');
});

test('the output route reads a live task under the worker\'s session key, cleaned, with the stall setting', async (t) => {
  const fx = boot(t);
  fs.writeFileSync(fx.file, 'one\n\x1b]0;title\x07two\nAPI_TOKEN=abcdef1234\n');
  fx.store.replace('sess-1', [{ taskId: 'task-b7', taskType: 'local_bash', description: 'npm test', outputPath: fx.file }]);
  fx.store.setHealth('sess-1', 'task-b7', { lastOutputAt: 5, size: 30, counts: null, runner: null, final: false, firstFailureOffset: null });
  const answer = await fx.output('conv-1', 'task-b7', { lines: '2' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const body = answer.body;
  assert.deepEqual([body.ok, body.kind, body.ended, body.status, body.taskStallMinutes], [true, 'file', false, 'running', 15]);
  assert.equal(body.text, 'two\nAPI_TOKEN=[redacted]\n');
  assert.deepEqual(body.lines.map((line) => line.text), ['two', 'API_TOKEN=[redacted]']);
  assert.equal(body.hasMoreBefore, true);
  assert.equal(body.health.size, 30);
  assert.deepEqual(body.task, { taskId: 'task-b7', taskType: 'local_bash', description: 'npm test', startedAt: null, endedAt: null, stoppable: true });
  const earlier = await fx.output('conv-1', 'task-b7', { before: String(body.startOffset) });
  assert.deepEqual(earlier.body.lines.map((line) => line.text), ['one']);
});

test('an ended task stays readable; a foreign conversation and an unknown task get 404', async (t) => {
  const fx = boot(t);
  fs.writeFileSync(fx.file, 'done\n');
  fx.store.replace('sess-1', [{ taskId: 'task-b7', taskType: 'local_bash', outputPath: fx.file }]);
  fx.store.settle('sess-1', 'task-b7', { status: 'failed', exitCode: 1 });
  fx.store.replace('sess-1', []);
  const ended = await fx.output('conv-1', 'task-b7');
  assert.deepEqual([ended.status, ended.body.ended, ended.body.status, ended.body.exitCode, ended.body.task.stoppable], [200, true, 'failed', 1, false]);
  assert.equal(ended.body.text, 'done\n');

  const foreign = await fx.output('conv-2', 'task-b7');
  assert.deepEqual([foreign.status, foreign.body.code], [404, 'task-not-found']);
  assert.equal((await fx.output('conv-9', 'task-b7')).status, 404);
  assert.equal((await fx.output('conv-1', 'task-nope')).status, 404);
});

test('another relay\'s agent reads it too, scrubbed the same, also with the inbound switch off', async (t) => {
  const fx = boot(t);
  fs.writeFileSync(fx.file, 'token: hunter22x\n');
  fx.store.replace('sess-1', [{ taskId: 'task-b7', taskType: 'local_bash', outputPath: fx.file }]);
  const remote = await fx.output('conv-1', 'task-b7', {}, { 'x-oar-remote-origin': 'relay-other-id', 'x-oar-remote-hops': '1' });
  assert.equal(remote.status, 200);
  assert.equal(remote.body.text, 'token: [redacted]\n');
});

test('no file yet reads as no output; a session that named no file says so', async (t) => {
  const fx = boot(t);
  fx.store.replace('sess-1', [
    { taskId: 'task-b7', taskType: 'local_bash', outputPath: path.join(fx.dir, 'not-yet.log'), outputKind: 'spool' },
    { taskId: 'task-n1', taskType: 'local_bash', outputKind: 'none' },
  ]);
  const waiting = await fx.output('conv-1', 'task-b7');
  assert.deepEqual([waiting.status, waiting.body.ok, waiting.body.size, waiting.body.lines, waiting.body.unavailable], [200, true, 0, [], undefined]);
  const none = await fx.output('conv-1', 'task-n1');
  assert.equal(none.body.kind, 'none');
  assert.match(none.body.message, /did not report an output file .* need a restart/);
});

test('a provider without task output says so; Copilot, Claude and Claude API sessions do not', async (t) => {
  for (const [provider, expected] of [
    ['openai', /^Output is not available for this provider\.$/],
    ['github', /did not report an output file/],
    ['claude', /did not report an output file/],
    ['claude-api', /did not report an output file/],
  ]) {
    const fx = boot(t, { provider });
    fx.store.replace('sess-1', [{ taskId: 'task-n1', taskType: 'local_bash' }]);
    const none = await fx.output('conv-1', 'task-n1');
    assert.equal(none.body.kind, 'none', provider);
    assert.match(none.body.message, expected, provider);
  }
});

test('sub-agents answer kind none with a pointer to their view, not 404', async (t) => {
  const fx = boot(t, {
    trackedTasks: [
      { id: 'agent-a1', kind: 'subagent', type: 'local_agent', description: 'review', status: 'completed', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:05:00.000Z', runId: 'toolu_a1' },
      { id: 'shell-s1', kind: 'shell', type: 'local_bash', description: 'sleep', status: 'failed', exitCode: 2 },
    ],
    runs: { 'toolu_c9': { id: 'toolu_c9', conversation_id: 'conv-1', subagent_type: 'general-purpose', display_name: 'explore', status: 'running' } },
  });
  // A live sub-agent in the store.
  fx.store.replace('sess-1', [{ taskId: 'agent-l1', taskType: 'local_agent', description: 'live one' }]);
  const live = await fx.output('conv-1', 'agent-l1');
  assert.deepEqual([live.status, live.body.kind, live.body.ended], [200, 'none', false]);
  assert.equal(live.body.message, 'Sub-agents have no shell output; open the sub-agent view.');

  // Ended ones the store never kept: by task id and by run id.
  for (const id of ['agent-a1', 'toolu_a1']) {
    const ended = await fx.output('conv-1', id);
    assert.deepEqual([ended.status, ended.body.kind, ended.body.ended, ended.body.status], [200, 'none', true, 'completed'], id);
    assert.equal(ended.body.message, 'Sub-agents have no shell output; open the sub-agent view.');
    assert.equal(ended.body.task.description, 'review');
  }
  // A Copilot sub-agent known by its run row only.
  const run = await fx.output('conv-1', 'toolu_c9');
  assert.deepEqual([run.status, run.body.kind, run.body.ended, run.body.status], [200, 'none', false, 'running']);
  // A shell that ended without a console.
  const shell = await fx.output('conv-1', 'shell-s1');
  assert.deepEqual([shell.status, shell.body.kind, shell.body.exitCode], [200, 'none', 2]);
  assert.match(shell.body.message, /did not report an output file/);

  // Another conversation's run and an unknown id stay 404.
  assert.equal((await fx.output('conv-2', 'toolu_c9')).status, 404);
  assert.equal((await fx.output('conv-1', 'nothing-here')).status, 404);
});

test('a snapshot task asks the worker and answers from the newest posted copy; 409 without a worker', async (t) => {
  const fx = boot(t);
  fx.store.replace('sess-1', [{ taskId: 'task-s1', taskType: 'local_bash', outputKind: 'snapshot' }]);
  const first = await fx.output('conv-1', 'task-s1');
  assert.deepEqual([first.status, first.body.kind, first.body.pending], [200, 'snapshot', true]);
  assert.deepEqual(fx.controls, [{ sessionId: 'sess-1', control: { type: 'task_output_snapshot', taskId: 'task-s1' } }]);

  const posted = await fx.post('/api/background-tasks/:taskId/output-snapshot', { conversationId: 'sess-1', output: 'last lines\npassword=s3cretvalue\n', totalBytes: 40000, truncated: true }, { taskId: 'task-s1' });
  assert.deepEqual(posted.body, { ok: true });
  const second = await fx.output('conv-1', 'task-s1');
  assert.equal(second.body.text, 'last lines\npassword=[redacted]\n');
  assert.deepEqual([second.body.endOffset, second.body.truncated], [40000, true]);
  assert.equal((await fx.post('/api/background-tasks/:taskId/output-snapshot', { conversationId: 'sess-1', output: 42 }, { taskId: 'task-s1' })).status, 400);

  const offline = boot(t, { workerConnected: false });
  offline.store.replace('sess-1', [{ taskId: 'task-s1', taskType: 'local_bash', outputKind: 'snapshot' }]);
  const refused = await offline.output('conv-1', 'task-s1');
  assert.deepEqual([refused.status, refused.body.code], [409, 'worker-not-connected']);
});
