import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubagentTimelineRecorder, toolResultText } from './subagent-timeline-recorder.mjs';
import { SUBAGENT_TIMELINE_MAX_ENTRIES, SUBAGENT_TOOL_RESULT_MAX_CHARS } from '../../shared/subagent-timeline.mjs';

const CONV = 'conv-fixture-1';
const RUN = 'toolu_fixture_alpha';
const CHILD = 'toolu_fixture_beta';

// A recorder with a manual clock and timer, posting into an in-memory relay
// that knows the runs it is told about (404 for anything else).
function makeRecorder({ knownRuns = [RUN], failFirst = 0 } = {}) {
  const posts = [];
  const known = new Set(knownRuns);
  let failures = failFirst;
  let clock = 0;
  let timer = null;
  const api = async (method, path, body) => {
    assert.equal(method, 'POST');
    assert.equal(path, '/api/subagent-timeline');
    if (failures > 0) {
      failures -= 1;
      const error = new Error('HTTP 503');
      error.status = 503;
      throw error;
    }
    const parent = body.header?.parentSubagentId;
    if (!known.has(body.subagentRunId)) {
      if (parent && known.has(parent)) known.add(body.subagentRunId);
      else {
        const error = new Error('HTTP 404 unknown_run');
        error.status = 404;
        throw error;
      }
    }
    posts.push(structuredClone(body));
    return { ok: true };
  };
  const recorder = createSubagentTimelineRecorder({
    api,
    conversationId: CONV,
    writerId: 'w',
    flushIntervalMs: 500,
    retryLimitMs: 10_000,
    now: () => clock,
    setTimer: (fn) => { timer = fn; return { unref() {} }; },
    clearTimer: () => { timer = null; },
  });
  const tick = async (ms = 500) => {
    clock += ms;
    const fn = timer;
    timer = null;
    if (fn) fn();
    await recorder.flush();
  };
  const entries = (runId = RUN) => {
    const byKey = new Map();
    for (const post of posts.filter((p) => p.subagentRunId === runId)) {
      for (const entry of post.entries) byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  };
  const headers = (runId = RUN) => posts.filter((p) => p.subagentRunId === runId && p.header).map((p) => p.header);
  return { recorder, posts, tick, entries, headers, known };
}

const spawn = (id = RUN, { parent = null, input = {} } = {}) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: `msg-spawn-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Survey the widget parser', subagent_type: 'general-purpose', prompt: 'Look at the parser.', ...input } }] },
});
const subAssistant = (blocks, { parent = RUN, id = 'msg-sub-1', model = 'claude-fixture-model' } = {}) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { id, model, content: blocks },
});
const subStream = (event, parent = RUN) => ({ type: 'stream_event', parent_tool_use_id: parent, event });
const subUser = (blocks, parent = RUN) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: blocks } });

test('thoughts, tool calls with their full input, tool results and reply text are recorded in order', async () => {
  const { recorder, tick, entries, headers } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe(subAssistant([{ type: 'thinking', thinking: 'The parser lives in src/widget.' }]));
  recorder.observe(subAssistant([{ type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: '/home/dev/widget/parser.js' } }]));
  recorder.observe(subUser([{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: [{ type: 'text', text: 'export function parse() {}' }] }]));
  recorder.observe(subAssistant([{ type: 'text', text: 'The parser is a single function.' }], { id: 'msg-sub-2' }));
  await tick();

  assert.deepEqual(entries().map((entry) => entry.kind), ['thought', 'tool_call', 'tool_result', 'text']);
  const [, call, result, reply] = entries();
  assert.equal(call.toolName, 'Read');
  assert.equal(call.toolUseId, 'toolu_read_1');
  assert.deepEqual(JSON.parse(call.text), { file_path: '/home/dev/widget/parser.js' });
  assert.equal(result.toolUseId, 'toolu_read_1');
  assert.equal(result.text, 'export function parse() {}');
  assert.equal(reply.text, 'The parser is a single function.');
  const [header] = headers();
  assert.equal(header.timelineOwner, 'worker');
  assert.equal(header.model, 'claude-fixture-model');
  assert.equal(header.displayName, 'Survey the widget parser');
  assert.equal(header.subagentType, 'general-purpose');
});

test('streamed text is one entry, open while it streams and closed by its complete copy', async () => {
  const { recorder, tick, posts, entries } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe(subStream({ type: 'message_start', message: { id: 'msg-sub-1' } }));
  recorder.observe(subStream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
  recorder.observe(subStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The parser ' } }));
  await tick();
  assert.deepEqual(entries().map((entry) => [entry.kind, entry.text, entry.done]), [['text', 'The parser ', false]]);

  recorder.observe(subStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is fine.' } }));
  recorder.observe(subAssistant([{ type: 'text', text: 'The parser is fine.' }]));
  recorder.observe(subStream({ type: 'content_block_stop', index: 0 }));
  await tick();
  assert.deepEqual(entries().map((entry) => [entry.kind, entry.text, entry.done]), [['text', 'The parser is fine.', true]]);
  const keys = new Set(posts.flatMap((post) => post.entries.map((entry) => entry.key)));
  assert.equal(keys.size, 1, 'one entry, updated in place');
});

test('a tool result is cut to 4 KB and says how long it was', async () => {
  const { recorder, tick, entries } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe(subUser([{ type: 'tool_result', tool_use_id: 'toolu_bash_1', is_error: true, content: 'e'.repeat(SUBAGENT_TOOL_RESULT_MAX_CHARS * 2) }]));
  await tick();
  const [result] = entries();
  assert.equal(result.text.length, SUBAGENT_TOOL_RESULT_MAX_CHARS);
  assert.deepEqual(result.metadata, { isError: true, cut: SUBAGENT_TOOL_RESULT_MAX_CHARS * 2 });
});

test('a background launch keeps the run running until its task notification ends it', async () => {
  const { recorder, tick, entries, headers } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: RUN, subagent_type: 'general-purpose', is_backgrounded: true });
  recorder.observe({
    type: 'user',
    parent_tool_use_id: null,
    tool_use_result: { status: 'async_launched', agentId: 'agent-1' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: RUN, content: 'Async agent launched successfully.' }] },
  });
  recorder.observe({ type: 'system', subtype: 'task_progress', task_id: 'task-1', tool_use_id: RUN, usage: { total_tokens: 900 } });
  await tick();
  assert.ok(headers().every((header) => header.status === undefined), 'not settled by the launch receipt');
  assert.ok(headers().some((header) => header.background === true && header.taskId === 'task-1'));

  recorder.observe({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: RUN, status: 'completed', summary: 'Found two parser bugs', usage: { total_tokens: 1500 } });
  await tick();
  const last = headers().at(-1);
  assert.equal(last.status, 'completed');
  assert.equal(last.totalTokens, 1500);
  assert.deepEqual(entries().map((entry) => [entry.kind, entry.text]), [['note', 'Finished: Found two parser bugs']]);
});

test('a foreground agent ends with its spawn\'s tool result', async () => {
  const { recorder, tick, headers } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: RUN, content: 'Report: all good.' }] } });
  await tick();
  assert.equal(headers().at(-1).status, 'completed');
});

test('an agent spawned inside another becomes a child entry and a run of its own, posted after its parent', async () => {
  const { recorder, tick, posts, entries } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe(spawn(CHILD, { parent: RUN, input: { description: 'Check the fixtures', subagent_type: 'Explore' } }));
  recorder.observe(subAssistant([{ type: 'text', text: 'Fixtures are fine.' }], { parent: CHILD, id: 'msg-child-1' }));
  await tick();
  const [child] = entries(RUN);
  assert.equal(child.kind, 'child');
  assert.equal(child.toolUseId, CHILD);
  assert.equal(child.text, 'Check the fixtures');
  const firstChildPost = posts.findIndex((post) => post.subagentRunId === CHILD);
  assert.ok(firstChildPost > posts.findIndex((post) => post.subagentRunId === RUN));
  assert.equal(posts[firstChildPost].header.parentSubagentId, RUN);
  assert.deepEqual(entries(CHILD).map((entry) => entry.text), ['Fixtures are fine.']);
});

test('a run the relay does not know yet keeps its entries, in order, until it does', async () => {
  const { recorder, tick, entries, known, posts } = makeRecorder({ knownRuns: [] });
  recorder.observe(spawn());
  recorder.observe(subAssistant([{ type: 'thinking', thinking: 'first' }]));
  await tick();
  assert.equal(posts.length, 0);
  recorder.observe(subAssistant([{ type: 'thinking', thinking: 'second' }], { id: 'msg-sub-2' }));
  known.add(RUN);
  await tick(2_000);
  assert.deepEqual(entries().map((entry) => entry.text), ['first', 'second']);
  assert.equal(posts.length, 1);
});

test('a relay that stays away is given up on after the retry limit', async () => {
  const { recorder, tick, posts } = makeRecorder({ knownRuns: [] });
  recorder.observe(spawn());
  recorder.observe(subAssistant([{ type: 'thinking', thinking: 'lost' }]));
  for (let i = 0; i < 8; i += 1) await tick(2_000);
  assert.equal(posts.length, 0);
  assert.equal(recorder.hasPending(), false);
});

test('a transient relay error is retried without losing the batch', async () => {
  const { recorder, tick, entries } = makeRecorder({ failFirst: 1 });
  recorder.observe(spawn());
  recorder.observe(subAssistant([{ type: 'thinking', thinking: 'kept' }]));
  await tick();
  await tick(2_000);
  assert.deepEqual(entries().map((entry) => entry.text), ['kept']);
});

test('past the per-run limit one note marks the cut', async () => {
  const { recorder, tick, entries, headers } = makeRecorder();
  recorder.observe(spawn());
  for (let index = 0; index < SUBAGENT_TIMELINE_MAX_ENTRIES + 5; index += 1) {
    recorder.observe(subAssistant([{ type: 'tool_use', id: `toolu_${index}`, name: 'Bash', input: { command: `echo ${index}` } }], { id: `m-${index}` }));
  }
  await tick();
  const all = entries();
  assert.equal(all.length, SUBAGENT_TIMELINE_MAX_ENTRIES + 1);
  assert.equal(all.at(-1).kind, 'note');
  assert.ok(headers().some((header) => header.truncated === true));
});

test('only the spawning turn owns a background agent\'s lanes', () => {
  const { recorder } = makeRecorder();
  const turnA = { id: 'turn-a' };
  const turnB = { id: 'turn-b' };
  recorder.observe(spawn());
  recorder.claimSpawns(spawn(), turnA);
  recorder.observe(spawn(CHILD, { parent: RUN }));
  assert.equal(recorder.ownsRun(RUN, turnA), true);
  assert.equal(recorder.ownsRun(CHILD, turnA), true, 'a child belongs to its parent\'s turn');
  // Foreground: it is the CLI turn in progress, whichever relay turn carries it.
  assert.equal(recorder.isForeignRun(RUN, turnB), false);
  recorder.observe({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: RUN, is_backgrounded: true });
  assert.equal(recorder.isForeignRun(RUN, turnA), false);
  assert.equal(recorder.isForeignRun(RUN, turnB), true);
  assert.equal(recorder.isForeignRun(CHILD, turnB), true, 'a child of a background agent is foreign too');
  assert.equal(recorder.isForeignRun('toolu_unknown', turnB), false);
});

test('when the process ends, open text closes and running agents fail', async () => {
  const { recorder, tick, entries, headers } = makeRecorder();
  recorder.observe(spawn());
  recorder.observe(subStream({ type: 'message_start', message: { id: 'msg-sub-1' } }));
  recorder.observe(subStream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
  recorder.observe(subStream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'half a thought' } }));
  await tick();
  await recorder.processEnded();
  const all = entries();
  assert.equal(all[0].done, true);
  assert.equal(all.at(-1).kind, 'note');
  assert.equal(headers().at(-1).status, 'failed');
});

test('tool result content of every shape reads as text', () => {
  assert.equal(toolResultText('plain'), 'plain');
  assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'tool_reference' }]), 'a\n[image]\n[tool_reference]');
  assert.equal(toolResultText(null), '');
});
