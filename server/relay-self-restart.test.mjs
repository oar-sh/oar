import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RELAY_STOP_EXIT_CODE } from './relay-exit-codes.mjs';
import { runDirectRelaySupervisor } from './relay-self-restart.mjs';

// Runs the supervisor over runtimes that each exit with the next code.
async function supervise(codes) {
  const spawned = [];
  const logs = [];
  let exitCode = null;
  await runDirectRelaySupervisor({
    scriptPath: 'server.js',
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { pid: spawned.length + 1, exitCode: null, stdout: null, stderr: null });
      spawned.push(child);
      const code = codes[spawned.length - 1];
      setImmediate(() => child.emit('exit', code, null));
      return child;
    },
    delay: async () => {},
    exitImpl: (code) => { exitCode = code; },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    installSignalHandlers: false,
  });
  return { spawned: spawned.length, exitCode, logs };
}

test('a runtime that stops on purpose is not restarted, and its code goes on', async () => {
  assert.equal(RELAY_STOP_EXIT_CODE, 78);
  const { spawned, exitCode, logs } = await supervise([RELAY_STOP_EXIT_CODE]);
  assert.equal(spawned, 1, 'started once');
  assert.equal(exitCode, RELAY_STOP_EXIT_CODE);
  assert.ok(!logs.some((line) => /crash/.test(line)), 'not a crash');
});

test('a crash is still retried up to the limit', async () => {
  const { spawned, exitCode, logs } = await supervise([1, 1, 1]);
  assert.equal(spawned, 3);
  assert.equal(exitCode, 1);
  assert.ok(logs.some((line) => /crash limit reached/.test(line)));
});
