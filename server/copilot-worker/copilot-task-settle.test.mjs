import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTransientProgressText,
  settleForTask,
  shellExitFromEvent,
} from './copilot-task-settle.mjs';

test('a spinner or status line is transient, content is not', () => {
  for (const line of ['', '   ', '⟳ Thinking…', '⟳', 'Thinking...', 'working', '⠋ Running', '… waiting']) {
    assert.equal(isTransientProgressText(line), true, line);
  }
  for (const line of ['Found 3 failing tests in the parser', 'Thinking about the cache: it is stale', 'done']) {
    assert.equal(isTransientProgressText(line), false, line);
  }
});

test('an attached shell reports its exit code on shell_completed', () => {
  assert.deepEqual(shellExitFromEvent({
    type: 'system.notification',
    data: { kind: { type: 'shell_completed', shellId: '3', exitCode: 2 } },
  }), { shellId: '3', exitCode: 2 });
  // Without a code (the field is optional) and for a detached shell: nothing.
  assert.equal(shellExitFromEvent({
    type: 'system.notification',
    data: { kind: { type: 'shell_completed', shellId: '3' } },
  }), null);
  assert.equal(shellExitFromEvent({
    type: 'system.notification',
    data: { kind: { type: 'shell_detached_completed', shellId: '1' } },
  }), null);
});

test('a detached shell exit code is read from the read_bash result text', () => {
  assert.deepEqual(shellExitFromEvent({
    type: 'tool.execution_complete',
    data: { result: { content: 'done\n<detached command with shellId: 1 completed with exit code 0>' } },
  }), { shellId: '1', exitCode: 0 });
  assert.deepEqual(shellExitFromEvent({
    type: 'tool.execution_complete',
    data: { result: { content: '', detailedContent: '<shellId: 7 completed with exit code 127>' } },
  }), { shellId: '7', exitCode: 127 });
  assert.equal(shellExitFromEvent({
    type: 'tool.execution_complete',
    data: { result: { content: '<detached command with shellId: 1 is still running>' } },
  }), null);
  assert.equal(shellExitFromEvent({ type: 'assistant.message', data: {} }), null);
});

test('a shell end maps the registry status and the exit code', () => {
  assert.deepEqual(settleForTask({ type: 'shell', status: 'completed' }, { exitCode: 0 }),
    { status: 'completed', exitCode: 0, summary: 'exit code 0' });
  assert.deepEqual(settleForTask({ type: 'shell', status: 'completed' }, { exitCode: 1 }),
    { status: 'failed', exitCode: 1, summary: 'exit code 1' });
  assert.deepEqual(settleForTask({ type: 'shell', status: 'completed' }),
    { status: 'completed', exitCode: null, summary: null });
  assert.deepEqual(settleForTask({ type: 'shell', status: 'failed' }),
    { status: 'failed', exitCode: null, summary: null });
  assert.deepEqual(settleForTask({ type: 'shell', status: 'cancelled' }, { exitCode: 143 }),
    { status: 'stopped', exitCode: 143, summary: 'exit code 143' });
  // Gone from the list while still running, and no code from any event.
  assert.deepEqual(settleForTask({ type: 'shell', status: 'running' }),
    { status: 'unknown', exitCode: null, summary: null });
  assert.deepEqual(settleForTask({ type: 'shell', status: 'running' }, { exitCode: 0 }),
    { status: 'completed', exitCode: 0, summary: 'exit code 0' });
});

test('an agent end uses its result text and never a status line', () => {
  assert.deepEqual(settleForTask({ type: 'agent', status: 'completed', result: 'Fixed the parser.' }),
    { status: 'completed', exitCode: null, summary: 'Fixed the parser.' });
  assert.deepEqual(settleForTask({ type: 'agent', status: 'failed', result: 'partial', error: 'Rate limited' }),
    { status: 'failed', exitCode: null, summary: 'Rate limited' });
  assert.deepEqual(settleForTask({ type: 'agent', status: 'completed', latestResponse: '⟳ Thinking…' }),
    { status: 'completed', exitCode: null, summary: null });
  assert.deepEqual(settleForTask({ type: 'agent', status: 'completed' }),
    { status: 'completed', exitCode: null, summary: null });
  assert.equal(settleForTask({ type: 'agent', status: 'completed', result: 'x'.repeat(900) }).summary.length, 500);
});
