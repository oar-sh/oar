import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBackgroundShellTracker,
  createReplayGate,
  describeSettledShell,
  isContinuationOpeningEvent,
} from './copilot-continuation-signals.mjs';
import { loadFixture } from './copilot-sdk-test-harness.mjs';

// Every payload below is copied from the live capture that motivated this
// module (session 10a1a9ad, 2026-08-31) rather than invented, so a runtime that
// changes these shapes fails here first.

const detachStart = {
  type: 'tool.execution_start',
  timestamp: '2026-08-31T14:23:20.249Z',
  data: {
    toolCallId: 'call_56Cu',
    toolName: 'bash',
    arguments: {
      command: "sleep 60 && printf '%s\\n' 'Timer fired after 1 minute.'",
      description: 'Wait one minute for the requested timer',
      mode: 'async',
      detach: true,
      initial_wait: 30,
    },
  },
};

const detachComplete = {
  type: 'tool.execution_complete',
  timestamp: '2026-08-31T14:23:20.274Z',
  data: {
    toolCallId: 'call_56Cu',
    success: true,
    result: {
      content: '<command started in detached background with shellId: 1>',
      detailedContent: '<command started in detached background with shellId: 1>',
    },
    toolTelemetry: { properties: { executionMode: 'async', detached: 'true' } },
  },
};

const shellSettledNotification = {
  type: 'system.notification',
  timestamp: '2026-08-31T14:24:20.843Z',
  data: {
    content: '<system_notification>\nDetached shell "Wait one minute for the requested timer" (shellId: 1) has completed.\n</system_notification>',
    kind: {
      type: 'shell_detached_completed',
      shellId: '1',
      description: 'Wait one minute for the requested timer',
    },
  },
};

const readBashComplete = {
  type: 'tool.execution_complete',
  timestamp: '2026-08-31T14:24:23.119Z',
  data: {
    toolCallId: 'call_Hh2p',
    success: true,
    result: {
      content: 'Output:\nTimer fired after 1 minute.\n<detached command with shellId: 1 completed with exit code 0>',
      detailedContent: 'Output:\nTimer fired after 1 minute.\n<detached command with shellId: 1 completed with exit code 0>',
    },
  },
};

// ---------------------------------------------------------- opening events --

test('the events that mean "the runtime started work" open a continuation', () => {
  for (const type of [
    'assistant.turn_start',
    'assistant.message',
    'assistant.message_start',
    'tool.execution_start',
    'permission.requested',
    'user_input.requested',
    'user.message',
  ]) {
    assert.equal(isContinuationOpeningEvent({ type }), true, type);
  }
});

test('terminators and connection bookkeeping never open a continuation', () => {
  // A stray terminator with no turn open must stay a no-op: a row minted here
  // would be closed by the very next event and show as an empty turn, and a row
  // minted for `session.background_tasks_changed` (23 fire per bash call) would
  // mint 23 of them.
  for (const type of [
    'session.idle',
    'session.error',
    'session.start',
    'session.resume',
    'session.shutdown',
    'session.background_tasks_changed',
    'session.usage_checkpoint',
    'pending_messages.modified',
    'capabilities.changed',
    'assistant.turn_end',
    'assistant.usage',
    'model.call_start',
    'system.notification',
    'system.message',
  ]) {
    assert.equal(isContinuationOpeningEvent({ type }), false, type);
  }
});

// ------------------------------------------------------------- replay gate --

test('a resume replays history through the live callback, and none of it counts as new work', () => {
  const gate = createReplayGate();
  const resume = {
    type: 'session.resume',
    timestamp: '2026-08-31T09:23:40.771Z',
    data: { resumeTime: '2026-08-31T09:23:40.594Z', eventCount: 22, selectedModel: 'gpt-5-mini' },
  };
  assert.equal(gate.isReplay(resume), false, 'the resume event itself is live');
  assert.equal(gate.armed(), true);

  // Persisted events keep their ORIGINAL timestamps when replayed, which is
  // what makes them recognisable — including a durable `assistant.message` that
  // would otherwise mint a continuation row for a reply the relay already has.
  assert.equal(gate.isReplay({
    type: 'assistant.message',
    timestamp: '2026-08-29T11:00:00.000Z',
    data: { content: 'an answer from two days ago' },
  }), true);
  assert.equal(gate.isReplay({
    type: 'assistant.turn_start',
    timestamp: '2026-08-29T11:00:01.000Z',
    data: {},
  }), true);

  // The first event at or after the resume time is live, and closes the window.
  assert.equal(gate.isReplay({
    type: 'user.message',
    timestamp: '2026-08-31T09:23:41.392Z',
    data: {},
  }), false);
  assert.equal(gate.armed(), false);
  // Nothing reopens it, so a late straggler is never eaten.
  assert.equal(gate.isReplay({
    type: 'assistant.message',
    timestamp: '2026-08-29T11:00:02.000Z',
    data: {},
  }), false);
});

test('the replay window is bounded by eventCount, not just by the clock', () => {
  const gate = createReplayGate();
  gate.isReplay({
    type: 'session.resume',
    timestamp: '2026-08-31T09:23:40.771Z',
    data: { resumeTime: '2026-08-31T09:23:40.594Z', eventCount: 2 },
  });
  const stale = (n) => ({ type: 'assistant.message', timestamp: `2026-08-29T11:00:0${n}.000Z`, data: {} });
  assert.equal(gate.isReplay(stale(1)), true);
  assert.equal(gate.isReplay(stale(2)), true);
  // Budget spent: a runtime emitting stale timestamps forever cannot silence
  // the worker forever.
  assert.equal(gate.isReplay(stale(3)), false);
  assert.equal(gate.armed(), false);
});

test('a resume with nothing to replay arms no window at all', () => {
  const gate = createReplayGate();
  gate.isReplay({
    type: 'session.resume',
    timestamp: '2026-08-31T09:23:40.771Z',
    data: { resumeTime: '2026-08-31T09:23:40.594Z', eventCount: 0 },
  });
  assert.equal(gate.armed(), false);
  gate.isReplay({ type: 'session.resume', timestamp: 'x', data: { eventCount: 9 } });
  assert.equal(gate.armed(), false);
});

test('the resume fixture replays no history, and the gate lets all of it through', () => {
  // Guards the other direction: a live resume whose events all postdate
  // `resumeTime` must reach the turn untouched, or the whole resume path goes
  // silent.
  const gate = createReplayGate();
  const suppressed = loadFixture('resume-turn').filter((event) => gate.isReplay(event));
  assert.deepEqual(suppressed, []);
});

test('an event with no parseable timestamp is treated as live', () => {
  const gate = createReplayGate();
  gate.isReplay({
    type: 'session.resume',
    timestamp: '2026-08-31T09:23:40.771Z',
    data: { resumeTime: '2026-08-31T09:23:40.594Z', eventCount: 5 },
  });
  assert.equal(gate.isReplay({ type: 'assistant.message', data: {} }), false);
});

// -------------------------------------------------------- shell liveness ----

test('a detached bash opens a tracked shell and its notification settles it', () => {
  const tracker = createBackgroundShellTracker();
  assert.deepEqual(tracker.observe(detachStart), { opened: [], settled: [], heralded: false });

  const started = tracker.observe(detachComplete);
  assert.equal(started.opened.length, 1);
  assert.equal(started.opened[0].shellId, '1');
  // The description comes off the `tool.execution_start` arguments — the
  // completion event has no room for it.
  assert.equal(started.opened[0].description, 'Wait one minute for the requested timer');
  assert.equal(tracker.size(), 1);

  const settled = tracker.observe(shellSettledNotification);
  assert.equal(settled.settled.length, 1);
  assert.equal(settled.settled[0].shellId, '1');
  assert.equal(tracker.size(), 0);
});

test('a read_bash reporting an exit code closes the shell even without a notification', () => {
  const tracker = createBackgroundShellTracker();
  tracker.observe(detachStart);
  tracker.observe(detachComplete);
  // The exit report and the "started detached" report both mention a shellId;
  // the exit must win, or reading a finished shell would re-open it.
  const closed = tracker.observe(readBashComplete);
  assert.equal(closed.opened.length, 0);
  assert.equal(closed.settled[0].shellId, '1');
  assert.equal(tracker.size(), 0);
});

test('only the notification heralds a continuation, not the read that follows it', () => {
  // The runner pins the runtime open on `heralded`. If a `read_bash` close
  // heralded too, every ordinary background command would hold the runtime for
  // the whole grace window after its turn ended.
  const tracker = createBackgroundShellTracker();
  tracker.observe(detachStart);
  assert.equal(tracker.observe(detachComplete).heralded, false);
  assert.equal(tracker.observe(shellSettledNotification).heralded, true);

  const second = createBackgroundShellTracker();
  second.observe(detachStart);
  second.observe(detachComplete);
  assert.equal(second.observe(readBashComplete).heralded, false);
});

test('a successful stop_bash closes the shell it named', () => {
  const tracker = createBackgroundShellTracker();
  tracker.observe(detachStart);
  tracker.observe(detachComplete);
  tracker.observe({
    type: 'tool.execution_start',
    data: { toolCallId: 'call_stop', toolName: 'stop_bash', arguments: { shellId: '1' } },
  });
  const stopped = tracker.observe({
    type: 'tool.execution_complete',
    data: { toolCallId: 'call_stop', success: true, result: { content: 'stopped' } },
  });
  assert.equal(stopped.settled[0].shellId, '1');
  assert.equal(tracker.size(), 0);
});

test('a foreground bash is not tracked as background work', () => {
  const tracker = createBackgroundShellTracker();
  tracker.observe({
    type: 'tool.execution_start',
    data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'pwd' } },
  });
  tracker.observe({
    type: 'tool.execution_complete',
    data: { toolCallId: 'c1', success: true, result: { content: '/home/user\n' } },
  });
  assert.equal(tracker.size(), 0);
});

test('a shell that settles before the tracker ever saw it open is still reported', () => {
  // The worker restarted mid-flight: the open happened in a previous process,
  // the settle arrives in this one. The continuation is still due.
  const tracker = createBackgroundShellTracker();
  const settled = tracker.observe(shellSettledNotification);
  assert.equal(settled.settled.length, 1);
  assert.equal(settled.settled[0].shellId, '1');
});

test('a `shell_completed` notification settles a shell just like the detached kind', () => {
  const tracker = createBackgroundShellTracker();
  tracker.observe(detachStart);
  tracker.observe(detachComplete);
  const settled = tracker.observe({
    type: 'system.notification',
    data: { kind: { type: 'shell_completed', shellId: '1', exitCode: 0 } },
  });
  assert.equal(settled.settled[0].shellId, '1');
});

test('an unrelated system notification changes nothing', () => {
  const tracker = createBackgroundShellTracker();
  tracker.observe(detachStart);
  tracker.observe(detachComplete);
  const seen = tracker.observe({
    type: 'system.notification',
    data: { kind: { type: 'instruction_discovered', sourcePath: 'AGENTS.md', triggerFile: 'a.js' } },
  });
  assert.deepEqual(seen, { opened: [], settled: [], heralded: false });
  assert.equal(tracker.size(), 1);
});

test('the cap forgets shells older than it, and 0 means no cap', () => {
  let clock = 1_000_000;
  const tracker = createBackgroundShellTracker({ now: () => clock });
  tracker.observe(detachStart);
  tracker.observe(detachComplete);

  assert.deepEqual(tracker.expireOlderThan(0), [], '0 = unlimited, nothing expires');
  clock += 29 * 60_000;
  assert.deepEqual(tracker.expireOlderThan(30 * 60_000), []);
  clock += 2 * 60_000;
  const expired = tracker.expireOlderThan(30 * 60_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].shellId, '1');
  assert.equal(tracker.size(), 0);
});

test('the tool-call memory stays bounded over a long session', () => {
  const tracker = createBackgroundShellTracker();
  for (let i = 0; i < 500; i += 1) {
    tracker.observe({
      type: 'tool.execution_start',
      data: { toolCallId: `call-${i}`, toolName: 'view', arguments: {} },
    });
  }
  // Nothing observable leaks: no shell was opened, and the tracker still works.
  assert.equal(tracker.size(), 0);
  tracker.observe(detachStart);
  assert.equal(tracker.observe(detachComplete).opened.length, 1);
});

test('the live capture drives the whole shell lifecycle end to end', () => {
  const tracker = createBackgroundShellTracker();
  for (const event of loadFixture('background-timer-turn')) tracker.observe(event);
  assert.equal(tracker.size(), 1, 'the timer shell is still running when the first turn settles');

  const settled = [];
  for (const event of loadFixture('background-timer-continuation')) {
    settled.push(...tracker.observe(event).settled);
  }
  assert.equal(settled[0].shellId, '1');
  assert.equal(tracker.size(), 0);
});

test('a settled shell describes itself for the transcript', () => {
  assert.equal(
    describeSettledShell({ shellId: '1', description: 'Wait one minute' }),
    'Background shell 1 finished: Wait one minute',
  );
  assert.equal(describeSettledShell({ shellId: '2' }), 'Background shell 2 finished');
  assert.equal(describeSettledShell({}), '');
});
