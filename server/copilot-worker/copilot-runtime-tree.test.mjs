// What a Copilot runtime leaves running when it goes, and when the worker
// stops it. Driven against the fake client and a fake process table: no
// process is started, read or signalled here.
//
// The incident (2026-09-29): the runtime was killed while the agent's command
// ran. The turn failed as it should and the next message got a new runtime,
// but the command ran on with nobody left to read its result.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeApiStub,
  makeContinuationApiStub,
  makeRunner,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { readRuntimePid } from './copilot-sdk-adapter.mjs';
import {
  describeCommandsBeingStopped,
  isDetachedRuntimeCommand,
  runtimeStopLeavesCommands,
  watchCopilotRuntimeTree,
} from './copilot-runtime-tree.mjs';
import { makeFakeProcessTable } from '../../shared/worker-runtime/process-tree-test-harness.mjs';

const RELAY = 9000;
const WORKER = 9001;
const RUNTIME = 4100;
const STOPPING_NOTE = /A command that was still running is being stopped\./;

// The worker under the relay, its runtime, the agent's shell with a python
// child, and the processes of somebody else.
const layout = () => [
  { processId: 1, parentProcessId: 0, createdAt: 10, name: 'init' },
  { processId: RELAY, parentProcessId: 1, createdAt: 100, name: 'node' },
  { processId: WORKER, parentProcessId: RELAY, createdAt: 200, name: 'node' },
  { processId: RUNTIME, parentProcessId: WORKER, createdAt: 300, name: 'node' },
  { processId: 4200, parentProcessId: RUNTIME, createdAt: 400, name: 'bash', sessionLeader: true },
  { processId: 4201, parentProcessId: 4200, createdAt: 410, name: 'python3', sessionLeader: false },
  { processId: 5100, parentProcessId: RELAY, createdAt: 310, name: 'node' },
  { processId: 5200, parentProcessId: 5100, createdAt: 420, name: 'bash', sessionLeader: true },
];
const BYSTANDERS = [1, 5100, 5200, RELAY, WORKER];

const bodyOf = (stub, route) => stub.bodiesFor(route)[0] || null;

/**
 * A runner whose fake client has a runtime process (pid 4100) in a fake
 * process table. `platform` picks how that table behaves; nothing here reads
 * the platform of the host.
 */
function setup({
  processes = layout(),
  platform = 'linux',
  ignoresTerm = [],
  events = [],
  stub = makeApiStub(),
  clientOptions = {},
  treeOptions = {},
  ...overrides
} = {}) {
  const fake = makeFakeProcessTable(processes, { posix: platform !== 'win32', ignoresTerm });
  const log = [];
  const client = createFakeCopilotClient({
    onSend: (session) => { if (session.sends.length === 1) session.replay(events); },
    ...clientOptions,
  });
  client.cliProcess = { pid: RUNTIME };
  let killRuntime = null;
  client.processExitPromise = new Promise((_resolve, reject) => { killRuntime = reject; });
  client.processExitPromise.catch(() => {});
  const watches = [];
  const { runner, started } = makeRunner({
    stub,
    client,
    continuationRetryDelayMs: 1,
    dbg: (...parts) => log.push(parts.join(' ')),
    watchRuntimeTreeImpl: (options) => {
      const watch = watchCopilotRuntimeTree({
        ...options,
        platform,
        lister: fake.lister,
        signal: fake.signal,
        selfPid: WORKER,
        parentPid: RELAY,
        // No timer of the watch runs in these tests; a command that ends on
        // SIGTERM is gone at once, so the waits are never slept either.
        pollMs: 0,
        stopGraceMs: 40,
        killWaitMs: 40,
        exitPollMs: 1,
        ...treeOptions,
      });
      watches.push(watch);
      return watch;
    },
    ...overrides,
  });
  return {
    stub,
    client,
    runner,
    started,
    fake,
    log,
    watches,
    /** The runtime dies the way a SIGKILL ends it: its commands run on. */
    killRuntime(message = 'CLI server exited unexpectedly with code null') {
      fake.end(RUNTIME);
      killRuntime(new Error(message));
    },
  };
}

const treeLog = (log) => log.filter((line) => /process tree|left running/.test(line));

// ------------------------------------------------------- the three reasons --

test('a runtime that is killed under a turn: its command is stopped and the note says so', async () => {
  const { stub, runner, fake, log, killRuntime } = setup({ turnStallTimeoutMs: 0 });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime();

  assert.equal(await pending, true);
  const response = bodyOf(stub, '/api/response');
  assert.match(response.text, /runtime exited before the turn completed/);
  assert.match(response.terminalError.message, STOPPING_NOTE);
  assert.equal(response.text, response.terminalError.message);

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
  assert.deepEqual(treeLog(log), [
    'copilot runtime process tree read: 2 processes below pid 4100',
    'stopping what the copilot runtime left running (runtime-gone): pid 4200, 4201',
    'copilot runtime process tree stopped (runtime-gone): 2 ended on SIGTERM, 0 killed, 0 still running',
  ]);
});

test('a runtime that has already ended: its commands are stopped at once, not after the teardown', async () => {
  // The teardown of a dead runtime still waits out its windows on a
  // connection with nobody behind it (10 s, measured).
  let endDetach = null;
  const { stub, client, runner, fake, killRuntime } = setup({ turnStallTimeoutMs: 0 });
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await createSession(config);
    session.disconnect = () => new Promise((resolve) => { endDetach = resolve; });
    return session;
  };

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime();

  await waitFor(() => !fake.has(4201), { label: 'command stopped' });
  assert.equal(typeof endDetach, 'function');
  assert.equal(client.stopped, 0, 'the teardown has not come past the detach');
  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);

  endDetach();
  assert.equal(await pending, true);
  // Stopped once: the teardown finds the stop already done.
  assert.equal(fake.signals.length, 2);
  assert.match(bodyOf(stub, '/api/response').terminalError.message, STOPPING_NOTE);
});

test('a runtime that is still there: the failure is published first, its commands are stopped after it is gone', async () => {
  // The order of the failure path is kept: the user is told first, the
  // teardown follows. That is why the note says "is being stopped".
  let endDetach = null;
  const { stub, client, runner, fake } = setup({ turnStallTimeoutMs: 150 });
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await createSession(config);
    session.disconnect = () => new Promise((resolve) => { endDetach = resolve; });
    return session;
  };
  // This runtime has to be asked twice and leaves its command behind.
  client.stop = async () => { fake.end(RUNTIME); return []; };

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => stub.bodiesFor('/api/response').length === 1, { label: 'failure published' });

  assert.match(bodyOf(stub, '/api/response').terminalError.message, STOPPING_NOTE);
  assert.equal(typeof endDetach, 'function');
  assert.deepEqual(fake.signals, [], 'nothing is signalled while the runtime is still there');
  assert.equal(fake.has(RUNTIME), true);

  endDetach();
  assert.equal(await pending, true);
  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
});

test('a runtime that dies between turns: what it left running is stopped', async () => {
  const { stub, runner, fake, log, killRuntime } = setup({ events: loadFixture('happy-turn') });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(runner._getState().hasClient, true);
  killRuntime();

  await waitFor(() => !fake.has(4201), { label: 'command stopped' });
  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
  assert.ok(treeLog(log).includes('stopping what the copilot runtime left running (runtime-exit): pid 4200, 4201'));
  // Nobody's turn failed, so nobody is told.
  assert.equal(stub.bodiesFor('/api/response').length, 1);
  assert.equal(bodyOf(stub, '/api/response').terminalError, undefined);
  await runner.dispose();
});

test('a runtime that no longer answers: it is killed, and its command after it', async () => {
  const { stub, client, runner, fake, log } = setup({
    events: [
      { type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'bash', arguments: { command: 'make' } } },
    ],
    turnStallTimeoutMs: 150,
    turnStallToolTimeoutMs: 5_000,
    stallProbeTimeoutMs: 20,
    runtimeDetachTimeoutMs: 20,
    runtimeStopTimeoutMs: 20,
  });
  client.ping = () => new Promise(() => {});
  client.stop = () => new Promise(() => {});
  const signalsAtKill = [];
  client.forceStop = async () => {
    signalsAtKill.push(fake.signals.length);
    fake.end(RUNTIME);
  };

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const response = bodyOf(stub, '/api/response');
  assert.match(response.text, /the Copilot runtime stopped answering while a tool was running \(bash\)/);
  assert.match(response.terminalError.message, STOPPING_NOTE);
  // Not one signal before the runtime itself was gone.
  assert.deepEqual(signalsAtKill, [0]);
  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
  assert.ok(treeLog(log).includes('stopping what the copilot runtime left running (runtime-gone): pid 4200, 4201'));
});

test('a failed turn whose runtime stops in good order: the runtime ended its commands, nothing is signalled', async () => {
  const { stub, client, runner, fake, log } = setup({ turnStallTimeoutMs: 150 });
  client.stop = async () => {
    // Measured: a runtime that is asked to stop ends its commands itself.
    fake.end(4201);
    fake.end(4200);
    fake.end(RUNTIME);
    return [];
  };

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.turn-stalled');
  // It was running when the turn failed, and it is stopped with the runtime.
  assert.match(response.terminalError.message, STOPPING_NOTE);
  assert.deepEqual(fake.signals, []);
  assert.equal(treeLog(log).at(-1), 'copilot runtime process tree (turn-failure): nothing left to stop');
});

test('a failed turn whose runtime has to be killed: what is left of its tree is stopped after the kill', async () => {
  const { stub, client, runner, fake, log } = setup({
    turnStallTimeoutMs: 150, runtimeDetachTimeoutMs: 20, runtimeStopTimeoutMs: 20,
  });
  client.stop = () => new Promise(() => {});
  client.forceStop = async () => {
    // The agent started one more command while the runtime was being waited
    // for; the tree is read once more right before the kill.
    assert.deepEqual(fake.signals, []);
    fake.end(RUNTIME);
  };
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await createSession(config);
    session.disconnect = async () => {
      fake.add({ processId: 4300, parentProcessId: RUNTIME, createdAt: 600, name: 'bash', sessionLeader: true });
    };
    return session;
  };

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.match(bodyOf(stub, '/api/response').terminalError.message, STOPPING_NOTE);
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201, 4300]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
  assert.ok(treeLog(log).includes('stopping what the copilot runtime left running (turn-failure): pid 4200, 4201, 4300'));
});

test('a command that ignores SIGTERM is killed, and the next runtime waits for that', async () => {
  // A command of the old runtime must not still be writing into the workspace
  // the new one starts to work in.
  let endWait = null;
  const waiting = new Promise((resolve) => { endWait = resolve; });
  const { stub, runner, fake, started, killRuntime } = setup({
    ignoresTerm: [4200],
    turnStallTimeoutMs: 0,
    events: [],
    // The wait for the command to end is held until the test lets it go.
    treeOptions: { sleep: () => waiting },
  });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime();
  await waitFor(() => fake.signals.length === 2, { label: 'SIGTERM sent' });
  await waitFor(() => stub.bodiesFor('/api/response').length === 1, { label: 'failure published' });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await tick(20);
  assert.equal(started.length, 1, 'no second runtime while the commands of the first are being stopped');
  assert.deepEqual(fake.signalled('SIGKILL'), []);

  endWait();
  assert.equal(await first, true);
  await waitFor(() => started.length === 2, { label: 'next runtime started' });
  assert.deepEqual(fake.signals, [
    { pid: 4200, name: 'SIGTERM' },
    { pid: 4201, name: 'SIGTERM' },
    { pid: 4200, name: 'SIGKILL' },
  ]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
  // The second turn has no events to end on; the runner is shut down under it.
  await runner.dispose();
  await second;
});

// ------------------------------------------------ the reasons that do not --

test('an idle shutdown signals nothing: the runtime ends its commands itself', async () => {
  const { client, runner, fake, log } = setup({
    events: loadFixture('happy-turn'), idleShutdownMs: 20, lifecyclePollMs: 5,
  });

  await runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown' });
  await waitFor(() => log.some((line) => /copilot runtime stopped after/.test(line)), { label: 'runtime stopped' });

  assert.equal(client.stopped, 1);
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.has(4200), true);
  assert.equal(fake.has(4201), true);
  assert.equal(treeLog(log).some((line) => /left running|nothing left to stop/.test(line)), false);
  await runner.dispose();
});

test('a worker that shuts down signals nothing', async () => {
  const { client, runner, fake, log } = setup({ events: loadFixture('happy-turn') });

  await runner.handlePendingPayload({ message: baseMessage });
  await runner.dispose();

  assert.equal(client.stopped, 1);
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.has(4201), true);
  assert.equal(treeLog(log).some((line) => /left running|nothing left to stop/.test(line)), false);
});

test('a healthy turn keeps its commands', async () => {
  const { stub, runner, fake } = setup({ events: loadFixture('happy-turn') });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.equal(bodyOf(stub, '/api/response').terminalError, undefined);
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.has(4201), true);
  await runner.dispose();
});

test('a model selection the runtime did not confirm keeps the runtime and its commands', async () => {
  // The session is healthy and merely on its previous model: background work
  // of the conversation may be running in it.
  const { stub, client, runner, fake } = setup({ events: loadFixture('happy-turn') });
  await runner.handlePendingPayload({ message: baseMessage });
  client.session.rpc.model.switchTo = async () => { throw new Error('model unavailable'); };

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'nope' } }), true);

  const failed = stub.bodiesFor('/api/response')[1];
  assert.equal(failed.terminalError.stableCode, 'relay.model-switch-unconfirmed');
  assert.doesNotMatch(failed.terminalError.message, /being stopped/);
  assert.equal(runner._getState().hasClient, true);
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.has(4201), true);
  await runner.dispose();
});

test('a turn the runtime opened by itself and that stalls keeps the runtime and its background work', async () => {
  const { stub, client, runner, fake } = setup({
    stub: makeContinuationApiStub(),
    events: loadFixture('background-timer-turn'),
    turnStallTimeoutMs: 30,
  });
  await runner.handlePendingPayload({ message: baseMessage });

  // The continuation opens and then goes silent.
  client.session.replay(loadFixture('background-timer-continuation').slice(0, 3));
  await waitFor(
    () => stub.bodiesFor('/api/response').some((body) => body.messageId === 'cont-1'),
    { label: 'stall failure' },
  );

  const failed = stub.bodiesFor('/api/response').find((body) => body.messageId === 'cont-1');
  assert.equal(failed.terminalError.stableCode, 'copilot.turn-stalled');
  assert.doesNotMatch(failed.terminalError.message, /being stopped/);
  assert.equal(runner._getState().hasClient, true);
  assert.deepEqual(fake.signals, []);
  assert.equal(fake.has(4201), true);
  await runner.dispose();
});

// ---------------------------------------------------------------- the note --

test('the note names one command, several, or none', () => {
  assert.equal(describeCommandsBeingStopped(0), '');
  assert.equal(describeCommandsBeingStopped(undefined), '');
  assert.equal(describeCommandsBeingStopped(1), 'A command that was still running is being stopped.');
  assert.equal(describeCommandsBeingStopped(3), '3 commands that were still running are being stopped.');
});

test('a failed turn with nothing running says nothing about commands', async () => {
  const { stub, runner, fake, killRuntime } = setup({
    processes: layout().filter((proc) => ![4200, 4201].includes(proc.processId)),
    turnStallTimeoutMs: 0,
  });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime();
  assert.equal(await pending, true);

  const response = bodyOf(stub, '/api/response');
  assert.match(response.text, /runtime exited before the turn completed/);
  assert.doesNotMatch(response.terminalError.message, /command/);
  assert.deepEqual(fake.signals, []);
});

test('a command that ended before the runtime died is not in the note', async () => {
  const { stub, runner, fake, killRuntime } = setup({ turnStallTimeoutMs: 0 });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  // Read while it ran, ended since.
  fake.end(4201);
  fake.end(4200);
  killRuntime();
  assert.equal(await pending, true);

  assert.doesNotMatch(bodyOf(stub, '/api/response').terminalError.message, /command/);
  assert.deepEqual(fake.signals, []);
});

test('the note follows the sentence about the tool calls, and counts the commands', async () => {
  const { stub, runner, fake, killRuntime } = setup({
    processes: [
      ...layout(),
      { processId: 4300, parentProcessId: RUNTIME, createdAt: 430, name: 'bash', sessionLeader: true },
      // A helper in the runtime's own session is stopped, and is no command.
      { processId: 4500, parentProcessId: RUNTIME, createdAt: 440, name: 'node', sessionLeader: false },
    ],
    events: [
      { type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'bash', arguments: { command: 'make' } } },
      { type: 'tool.execution_start', data: { toolCallId: 'call-2', toolName: 'bash', arguments: { command: 'make test' } } },
    ],
    turnStallTimeoutMs: 0,
  });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession && runner.isTurnActive(), { label: 'turn running' });
  await waitFor(() => stub.bodiesFor('/api/activity').length >= 2, { label: 'tool calls seen' });
  killRuntime();
  assert.equal(await pending, true);

  assert.match(
    bodyOf(stub, '/api/response').terminalError.message,
    /Before that the agent made 2 tool calls; what they changed is still in place\. 2 commands that were still running are being stopped\.$/,
  );
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201, 4300, 4500]);
});

test('the failure note does not wait for a process list', async () => {
  // Windows reads the list through PowerShell, which takes seconds. The note
  // goes out at once and says what the last read knew; the commands are
  // stopped once the new list is there.
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const { stub, runner, fake, watches, killRuntime } = setup({
    platform: 'win32', turnStallTimeoutMs: 0,
  });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  await watches[0].latest();
  const list = fake.lister.list;
  fake.lister.list = async () => { await held; return list(); };
  killRuntime();

  await waitFor(() => stub.bodiesFor('/api/response').length === 1, { label: 'failure published' });
  assert.match(
    bodyOf(stub, '/api/response').terminalError.message,
    /A command that was still running is being stopped\.$/,
  );
  assert.deepEqual(fake.signals, [], 'published while the list is still being read');

  release();
  assert.equal(await pending, true);
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
});

// ----------------------------------------------------------------- windows --
//
// Unverified on Windows. The process table of these tests behaves as Windows
// is documented to: a child keeps the pid of a parent that has ended.

test('windows: the commands of a killed runtime are found by the pid they kept, and stopped', async () => {
  const { stub, runner, fake, watches, killRuntime } = setup({ platform: 'win32', turnStallTimeoutMs: 0 });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  await watches[0].latest();
  // Started after the only read, which Windows takes when the runtime starts.
  fake.add({ processId: 4600, parentProcessId: RUNTIME, createdAt: 700, name: 'cmd.exe' });
  killRuntime();
  assert.equal(await pending, true);

  // The note knows the command of the last read; the one started since is
  // found by the read of the teardown and stopped all the same.
  assert.match(
    bodyOf(stub, '/api/response').terminalError.message,
    /A command that was still running is being stopped\.$/,
  );
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201, 4600]);
  assert.deepEqual(fake.pids(), BYSTANDERS);
});

// ------------------------------------------------------------- the seams --

test('the pid of the runtime is read from the client, and a client without one is not watched', () => {
  assert.equal(readRuntimePid({ cliProcess: { pid: 4100 } }), 4100);
  assert.equal(readRuntimePid({ cliProcess: null }), 0);
  assert.equal(readRuntimePid({}), 0);
  assert.equal(readRuntimePid(null), 0);
  // Never pid 1, and never a pid that is none.
  assert.equal(readRuntimePid({ cliProcess: { pid: 1 } }), 0);
  assert.equal(readRuntimePid({ cliProcess: { pid: -4100 } }), 0);
  assert.equal(readRuntimePid({ cliProcess: { pid: '4100abc' } }), 0);

  const fake = makeFakeProcessTable(layout());
  const log = [];
  const watch = watchCopilotRuntimeTree({
    client: {}, platform: 'linux', lister: fake.lister, signal: fake.signal, dbg: (line) => log.push(line),
  });
  assert.equal(watch, null);
  assert.equal(fake.listCount(), 0);
  assert.deepEqual(log, ['the pid of the copilot runtime is not known; its commands are not watched']);
});

test('a runner whose client has no process runs its turns and signals nothing', async () => {
  // The fake client of every other suite, and a bundle that dropped the field.
  const stub = makeApiStub();
  const client = createFakeCopilotClient();
  const { runner } = makeRunner({ stub, client, turnStallTimeoutMs: 150 });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.equal(bodyOf(stub, '/api/response').terminalError.stableCode, 'copilot.turn-stalled');
  assert.doesNotMatch(bodyOf(stub, '/api/response').terminalError.message, /command/);
});

test('a watch that cannot be set up costs the clean-up, not the turn', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const log = [];
  const { runner } = makeRunner({
    stub,
    client,
    dbg: (...parts) => log.push(parts.join(' ')),
    watchRuntimeTreeImpl: () => { throw new Error('EACCES: /proc is not readable'); },
  });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.equal(bodyOf(stub, '/api/response').text, 'SPIKE_OK');
  assert.ok(log.includes('the copilot runtime process tree is not watched EACCES: /proc is not readable'));
  await runner.dispose();
});

test('the three reasons that stop the tree, and the ones that do not', () => {
  for (const reason of ['runtime-exit', 'runtime-gone', 'turn-failure']) {
    assert.equal(runtimeStopLeavesCommands(reason), true, reason);
  }
  for (const reason of ['idle', 'worker-shutdown', '', undefined, 'something-new']) {
    assert.equal(runtimeStopLeavesCommands(reason), false, String(reason));
  }
});

test('a command started with detach is recognised by the wrapper the runtime puts around it', () => {
  assert.equal(isDetachedRuntimeCommand({
    commandLine: 'sh -c __copilot_pid_path=$1; __copilot_exit_path=$2; shift 3; "$@" sh /tmp/a.pid /tmp/a.exit',
  }), true);
  assert.equal(isDetachedRuntimeCommand({ commandLine: '/bin/bash --norc --noprofile -c make test' }), false);
  // host-platform: the wrapper of the runtime on Windows, as its command line reads there.
  assert.equal(isDetachedRuntimeCommand({
    commandLine: '"pwsh.exe" -NoProfile -NoLogo -Command "$__copilotProcess = $null; try { '
      + '$__copilotProcess = Start-Process -PassThru -FilePath \'pwsh.exe\' -WindowStyle Hidden; '
      + '$__copilotProcess.WaitForExit() } catch { }"',
  }), true);
  assert.equal(isDetachedRuntimeCommand({ commandLine: '"pwsh.exe" -NoProfile -Command "npm test"' }), false);
  // A command that names one of the wrapper's files is a command like any other.
  assert.equal(isDetachedRuntimeCommand({
    commandLine: '"pwsh.exe" -NoProfile -Command "Get-Content copilot-detached-0-1700000000000.log"',
  }), false);
  assert.equal(isDetachedRuntimeCommand({}), false);
});

test('a command started with detach outlives a runtime that was killed', async () => {
  const { runner, fake, killRuntime } = setup({
    processes: [
      ...layout(),
      {
        processId: 4400,
        parentProcessId: RUNTIME,
        createdAt: 430,
        name: 'sh',
        sessionLeader: true,
        commandLine: 'sh -c __copilot_pid_path=$1; shift 3; "$@" sh /home/dev/tmp/server.pid',
      },
      { processId: 4401, parentProcessId: 4400, createdAt: 440, name: 'node', sessionLeader: false },
    ],
    turnStallTimeoutMs: 0,
  });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime();
  assert.equal(await pending, true);

  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
  assert.deepEqual(fake.pids(), [...BYSTANDERS, 4400, 4401].sort((left, right) => left - right));
});
