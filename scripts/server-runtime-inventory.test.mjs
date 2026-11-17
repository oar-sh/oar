// The parts of scripts/server-runtime-inventory.mjs that need no runtime:
// telling a constant timer delay from a computed one, and the line format.
// The comparison with a real start is in server/server-runtime-boot.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { delayArgumentAt, formatInventory, inventoryDiff, isConstantDelay } from './server-runtime-inventory.mjs';

test('delayArgumentAt reads the second argument across lines, strings and comments', () => {
  const source = [
    'runtimeTimers.sweep = setInterval(() => {',
    "  if (x(')')) log(\"a, b\"); // a ) here",
    '  /* and , here */',
    '}, 15_000);',
  ].join('\n');
  assert.equal(delayArgumentAt(source, source.indexOf('setInterval')), '15_000');
  assert.equal(delayArgumentAt('setTimeout(fn, Math.max(15_000, 2 * windowMs));', 0), 'Math.max(15_000, 2 * windowMs)');
  assert.equal(delayArgumentAt('setTimeout(fn);', 0), null);
});

test('isConstantDelay: numbers and UPPER_CASE names, not variables or calls', () => {
  for (const text of ['15000', '15_000', '60 * 1000', 'SWEEP_INTERVAL_MS', '2 * STALE_MS']) assert.equal(isConstantDelay(text), true, text);
  for (const text of ['ms', 'delayMs', 'Math.max(1_000, ms)', 'this.sessionTimeout', '', null]) assert.equal(isConstantDelay(text), false, String(text));
});

test('formatInventory: one fact per line, key lists once, short timeouts left out', () => {
  const probe = {
    exports: [],
    registerCalls: [
      { name: 'registerA', args: [{ kind: 'app' }, { kind: 'object', keys: ['auth', 'db'] }] },
      { name: 'registerB', args: [{ kind: 'app' }, { kind: 'object', keys: ['auth', 'db'] }, { kind: 'undefined' }] },
    ],
    routes: [{ app: 0, method: 'USE', path: '/' }, { app: 0, method: 'GET', path: '/api/status' }],
    afterStart: {
      timers: [
        { kind: 'setTimeout', delay: 0, ref: false, site: '' },
        { kind: 'setInterval', delay: 1000, ref: true, site: 'at nowhere:1:1' },
      ],
      processListeners: { exit: 1 },
      serverListeners: { request: 1 },
    },
    atExit: { timers: [], processListeners: {}, serverListeners: {} },
  };
  assert.deepEqual(formatInventory(probe), [
    'export (none)',
    'register registerA arg0 app',
    'register registerA arg1 object keyset=K1',
    'register registerB arg0 app',
    'register registerB arg1 object keyset=K1',
    'register registerB arg2 undefined',
    'keyset K1 auth',
    'keyset K1 db',
    'route USE /',
    'route GET /api/status',
    'timer after-start setInterval computed ref x1',
    'listener after-start process exit x1',
    'listener after-start server request x1',
  ]);
});

test('inventoryDiff ignores the header and names the lines that differ', () => {
  assert.deepEqual(inventoryDiff('# a\nroute GET /x\n', '# b\nroute GET /x\n'), []);
  assert.deepEqual(inventoryDiff('route GET /x\nroute GET /y\nroute GET /z\n', 'route GET /y\nroute GET /w\nroute GET /z\n'), ['- route GET /x', '+ route GET /w']);
});
