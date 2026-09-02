import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import * as claudeAuth from './claude-auth-service.mjs';
import {
  CLI_SPAWN_DISABLED_ERROR,
  isBatchLauncher,
  killTree,
  quoteForCmd,
  runToCompletion,
  tailOf,
} from './cli-process-runner.mjs';

/** Fake child process: the events the runner listens for, plus kill recorders. */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinEnded = false;
  child.stdin = new EventEmitter();
  child.stdin.end = () => { child.stdinEnded = true; };
  child.killSignals = [];
  child.kill = (signal) => { child.killSignals.push(signal); return true; };
  child.emitStdout = (text) => child.stdout.emit('data', Buffer.from(text));
  child.emitStderr = (text) => child.stderr.emit('data', Buffer.from(text));
  child.exit = (code) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  return child;
}

/** Manual timer seam: the runner's timeout is fired by the test, not the clock. */
function createManualTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl(fn, ms) {
      const id = (nextId += 1);
      pending.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) {
      if (handle && pending.has(handle.id)) pending.delete(handle.id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    fire(ms) {
      let fired = 0;
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
        fired += 1;
      }
      return fired;
    },
  };
}

// ─── The extraction contract ─────────────────────────────────────────────────

// claude-auth-service.mjs was live-verified before these helpers moved out of
// it, and every importer and test of it still takes them from that path. This
// pins the re-export rather than trusting that nobody deletes it.
test('claude-auth-service re-exports the helpers it used to own', () => {
  const runner = { CLI_SPAWN_DISABLED_ERROR, tailOf };
  assert.equal(claudeAuth.CLI_SPAWN_DISABLED_ERROR, runner.CLI_SPAWN_DISABLED_ERROR);
  for (const name of ['stripTerminalEscapes', 'joinWrappedLines', 'scrubSecrets']) {
    assert.equal(typeof claudeAuth[name], 'function', `${name} must stay exported`);
  }
  assert.equal(claudeAuth.stripTerminalEscapes('\x1b[2mplain\x1b[0m\r\n'), 'plain\n');
});

// ─── tailOf ──────────────────────────────────────────────────────────────────

test('tailOf collapses captured output into one short line', () => {
  // Only the right-hand side is trimmed: an installer's indentation is part of
  // the line it belongs to.
  assert.equal(tailOf('first  \n\n  second \n'), 'first ·   second');
  assert.equal(tailOf(''), '');
  const long = tailOf('x'.repeat(900));
  assert.equal(long.length, 601, 'the ellipsis plus the limit');
  assert.ok(long.startsWith('…'));
  assert.equal(tailOf('abcdef', 3), '…def');
});

// ─── killTree ────────────────────────────────────────────────────────────────

test('killTree signals the whole process group on POSIX', () => {
  const kills = [];
  const child = createFakeChild(4242);
  killTree(child, 'SIGTERM', { platform: 'linux', processKillImpl: (pid, signal) => kills.push([pid, signal]) });
  assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
  assert.deepEqual(child.killSignals, [], 'the group signal is enough');
});

test('killTree falls back to the child handle on Windows and when the group signal fails', () => {
  const child = createFakeChild(4243);
  killTree(child, 'SIGTERM', { platform: 'win32', processKillImpl: () => { throw new Error('unreachable'); } });
  assert.deepEqual(child.killSignals, ['SIGTERM']);

  const failing = createFakeChild(4244);
  killTree(failing, 'SIGKILL', {
    platform: 'linux',
    processKillImpl: () => { throw new Error('ESRCH'); },
  });
  assert.deepEqual(failing.killSignals, ['SIGKILL']);
});

test('killTree leaves an already-exited child alone', () => {
  const kills = [];
  const child = createFakeChild(4245);
  child.exitCode = 0;
  killTree(child, 'SIGTERM', { platform: 'linux', processKillImpl: (pid, signal) => kills.push([pid, signal]) });
  assert.deepEqual(kills, []);
  assert.deepEqual(child.killSignals, []);
});

// ─── runToCompletion ─────────────────────────────────────────────────────────

test('runToCompletion resolves with the exit code, the captured output and a closed stdin', async () => {
  const child = createFakeChild(5001);
  const pending = runToCompletion(() => child, { timeoutMs: 1000 });
  assert.equal(child.stdinEnded, true, 'nothing to say to the child');
  child.emitStdout('hello ');
  child.emitStderr('world\n');
  child.exit(0);
  assert.deepEqual(await pending, { ok: true, code: 0, output: 'hello world\n', error: null });

  const failing = createFakeChild(5002);
  const failed = runToCompletion(() => failing, { timeoutMs: 1000 });
  failing.emitStderr('boom\n');
  failing.exit(2);
  const result = await failed;
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.equal(result.output, 'boom\n');
});

test('runToCompletion reports a refused spawn as a result instead of throwing', async () => {
  const result = await runToCompletion(() => { throw new Error(CLI_SPAWN_DISABLED_ERROR); }, { timeoutMs: 1000 });
  assert.deepEqual(result, { ok: false, code: null, output: '', error: CLI_SPAWN_DISABLED_ERROR });
});

test('runToCompletion reports an error event on the child', async () => {
  const child = createFakeChild(5003);
  const pending = runToCompletion(() => child, { timeoutMs: 1000 });
  child.emit('error', new Error('spawn ENOENT'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test('runToCompletion caps the retained output at the tail', async () => {
  const child = createFakeChild(5004);
  const pending = runToCompletion(() => child, { timeoutMs: 1000, maxOutputChars: 10 });
  child.emitStdout('0123456789abcdef');
  child.exit(0);
  assert.equal((await pending).output, '6789abcdef');
});

test('runToCompletion hands the live child to onChild and streams every chunk to onOutput', async () => {
  const child = createFakeChild(5005);
  const seen = [];
  let handed = null;
  const pending = runToCompletion(() => child, {
    timeoutMs: 1000,
    onChild: (value) => { handed = value; },
    onOutput: (text) => seen.push(text),
  });
  assert.equal(handed, child, 'the handle arrives before any output, so a cancel can reach it');
  child.emitStdout('one\n');
  child.emitStderr('two\n');
  child.exit(0);
  await pending;
  assert.deepEqual(seen, ['one\n', 'two\n']);
});

test('a throwing onOutput or onChild never breaks the run', async () => {
  const child = createFakeChild(5006);
  const pending = runToCompletion(() => child, {
    timeoutMs: 1000,
    onChild: () => { throw new Error('listener exploded'); },
    onOutput: () => { throw new Error('listener exploded'); },
  });
  child.emitStdout('still captured\n');
  child.exit(0);
  assert.equal((await pending).output, 'still captured\n');
});

test('the timeout kills through the injected killChild and clears its own timer', async () => {
  const timers = createManualTimers();
  const child = createFakeChild(5007);
  const killed = [];
  const pending = runToCompletion(() => child, {
    timeoutMs: 400,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    killChild: (target, signal) => killed.push([target.pid, signal]),
  });
  child.emitStdout('partial\n');
  assert.deepEqual(timers.delays(), [400]);
  assert.equal(timers.fire(400), 1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.equal(result.output, 'partial\n');
  assert.match(result.error, /timed out after 400ms/);
  assert.deepEqual(killed, [[5007, 'SIGTERM']]);

  // The late close from the signalled child must not re-settle the promise.
  child.exit(143);
  assert.equal((await pending).ok, false);
});

test('a completed run clears its timeout so nothing fires later', async () => {
  const timers = createManualTimers();
  const child = createFakeChild(5008);
  const pending = runToCompletion(() => child, {
    timeoutMs: 400,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  child.exit(0);
  await pending;
  assert.deepEqual(timers.delays(), []);
});

test('isBatchLauncher flags .cmd and .bat on win32 only', () => {
  assert.equal(isBatchLauncher('C:\Users\dev\claude.cmd', 'win32'), true);
  assert.equal(isBatchLauncher('C:\Users\dev\copilot.BAT', 'win32'), true);
  assert.equal(isBatchLauncher('C:\Users\dev\grok.exe', 'win32'), false);
  assert.equal(isBatchLauncher('C:\Users\dev\grok', 'win32'), false);
  // A .cmd suffix on POSIX is just a file name, not a batch launcher.
  assert.equal(isBatchLauncher('/home/dev/claude.cmd', 'linux'), false);
  assert.equal(isBatchLauncher('', 'win32'), false);
  assert.equal(isBatchLauncher(null, 'win32'), false);
});

test('quoteForCmd wraps every token and doubles embedded quotes', () => {
  assert.equal(quoteForCmd('C:\Program Files\App\claude.cmd'), '"C:\Program Files\App\claude.cmd"');
  assert.equal(quoteForCmd('plain'), '"plain"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});
