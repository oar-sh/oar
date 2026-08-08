import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { AcpClient } from './acp-client.mjs';
import { createGrokAgentHandle } from './grok-sdk-adapter.mjs';

function createFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.pid = 12345;
  return proc;
}

test('a spawn failure rejects pending requests instead of crashing the process', async () => {
  // Regression: `emit('error')` on a listener-less EventEmitter throws
  // ERR_UNHANDLED_ERROR synchronously out of the spawn callback — which used
  // to escape as an uncaught exception and take down the relay server when
  // the Grok CLI was not installed (ENOENT on the Linux host).
  let proc = null;
  const client = new AcpClient({
    spawnImpl: () => {
      proc = createFakeProc();
      return proc;
    },
  });

  const pending = client.initialize();
  const enoent = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
  // Throws here (not in the promise) if the emit is unguarded.
  proc.emit('error', enoent);

  await assert.rejects(pending, /ENOENT/);
  assert.equal(client.dead, true);
});

test('an error listener still receives spawn failures after pending rejection', async () => {
  let proc = null;
  const client = new AcpClient({
    spawnImpl: () => {
      proc = createFakeProc();
      return proc;
    },
  });
  const seen = [];
  client.on('error', (err) => seen.push(err));

  const pending = client.initialize();
  proc.emit('error', new Error('spawn grok ENOENT'));

  await assert.rejects(pending, /ENOENT/);
  assert.equal(seen.length, 1);
});

test('createGrokAgentHandle surfaces a missing CLI as a rejection, not a crash', async () => {
  await assert.rejects(
    createGrokAgentHandle({
      cwd: process.cwd(),
      AcpClientImpl: class extends AcpClient {
        constructor(opts) {
          super({
            ...opts,
            spawnImpl: () => {
              const proc = createFakeProc();
              queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' })));
              return proc;
            },
          });
        }
      },
    }),
    /ENOENT/,
  );
});
