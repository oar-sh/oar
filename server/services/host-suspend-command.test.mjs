import test from 'node:test';
import assert from 'node:assert/strict';

import { runHostSuspendToRam } from './host-suspend-command.mjs';

test('refuses on non-Windows with a 501-shaped result', () => {
  const result = runHostSuspendToRam({ platform: 'linux', spawnImpl: () => { throw new Error('must not spawn'); } });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 501);
});

test('dry run logs instead of spawning', () => {
  const lines = [];
  const result = runHostSuspendToRam({ platform: 'win32', dryRun: true, spawnImpl: () => { throw new Error('must not spawn'); }, logger: { log: (l) => lines.push(l) } });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.match(lines[0], /DRY RUN/);
});

test('spawns the detached SetSuspendState call and unrefs it', () => {
  const spawned = [];
  let unrefd = false;
  const result = runHostSuspendToRam({
    platform: 'win32',
    dryRun: false,
    spawnImpl: (file, args, opts) => { spawned.push({ file, args, opts }); return { unref() { unrefd = true; } }; },
  });
  assert.equal(result.ok, true);
  assert.equal(spawned[0].file, 'rundll32.exe');
  assert.deepEqual(spawned[0].args, ['powrprof.dll,SetSuspendState', '0,0,0']);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(unrefd, true);
});

test('a spawn failure is reported, not thrown', () => {
  const result = runHostSuspendToRam({ platform: 'win32', dryRun: false, spawnImpl: () => { throw new Error('ENOENT'); } });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 500);
  assert.match(result.error, /ENOENT/);
});
