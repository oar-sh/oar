// The boot test: server-runtime.mjs starts for real, as server.js starts it,
// against a temp state root and a free port; answers one authenticated
// request and one socket handshake (and refuses both without the token); and
// stops through its own shutdown path. It guards the start-up order of the
// runtime, which a move of code out of the file can break without any route
// test noticing. tests/helpers/runtime-boot.mjs starts it;
// tests/helpers/runtime-probe.mjs refuses a database outside the state root
// and records writes outside it.
//
// It runs on Windows and Linux. The file-mode checks are POSIX only (the
// runtime sets no modes on Windows).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

import { INVENTORY_FIXTURE, inventoryDiff, inventoryText } from '../scripts/server-runtime-inventory.mjs';
import { bootRuntime, isInside, runBootCycle, snapshotCheckoutFallbacks } from '../tests/helpers/runtime-boot.mjs';
import { RELAY_SECRETS_FILE } from './services/owner-secret-store.mjs';

describe('server-runtime boot', () => {
  let run;
  before(async () => {
    run = await runBootCycle();
  });

  const why = () => run.output;

  it('resolves and opens its database inside the temp state root only', () => {
    assert.ok(isInside(run.stateRoot, run.databasePath), `database path ${run.databasePath}`);
    assert.deepEqual(run.probe.refusedDatabases, []);
    assert.ok(run.probe.databases.includes('data/oar.db'), `opened: ${run.probe.databases.join(', ')}`);
  });

  it('keeps its config and owner secret in the state root and writes nothing outside it', () => {
    assert.ok(isInside(run.stateRoot, run.configPath));
    const dataDir = path.relative(run.stateRoot, path.dirname(run.databasePath)).split(path.sep).join('/');
    assert.ok(run.statePaths.includes('config.json'), run.statePaths.join('\n'));
    assert.ok(run.statePaths.includes(`${dataDir}/${RELAY_SECRETS_FILE}`), run.statePaths.join('\n'));
    assert.deepEqual(run.probe.writesOutside, []);
  });

  it('creates and changes nothing in the checkout it runs from', () => {
    assert.deepEqual(run.checkoutAfter, run.checkoutBefore);
  });

  it('answers an authenticated request and refuses one without the token', () => {
    assert.equal(run.statusWithToken, 200, why());
    assert.equal(run.statusWithoutToken, 401, why());
  });

  it('accepts a socket with the token and refuses one without it', () => {
    assert.deepEqual(run.socketWithToken, { connected: true, error: null }, why());
    assert.equal(run.socketWithoutToken.connected, false, why());
  });

  it('stops through its own shutdown, closing the server without the forced exit', () => {
    assert.equal(run.stop.response.status, 200, run.stop.response.body);
    assert.equal(run.stop.signal, null, why());
    assert.equal(run.stop.code, 0, why());
    assert.doesNotMatch(run.output, /Runtime shutdown timeout reached; forcing exit/);
    assert.equal(run.probe.atExit.serverListening, false);
    // What is still set at exit holds no process open.
    assert.deepEqual(run.probe.atExit.timers.filter((timer) => timer.ref), []);
  });

  it('sets owner-only modes on its data folder, database and config (POSIX)', { skip: process.platform === 'win32' && 'no file modes on Windows' }, () => {
    assert.deepEqual(run.modes, { dataDir: '700', database: '600', config: '600' });
  });

  // The guard before the spawn: a variable missing from the environment makes
  // the runtime fall back to a path in the checkout (server/config.json, which
  // it writes when absent; server/data; server/logs; server/backups) or, for
  // the home and temp variables, to the account's real folders; the start is
  // refused before any process runs. The home and temp variable each platform
  // reads (os.homedir, os.tmpdir) is the one dropped here.
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'; // host-platform: the child's os.homedir() on this host reads it
  const tempVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'; // host-platform: the child's os.tmpdir() on this host reads it
  for (const [drop, names] of [
    [['COPILOT_WEB_RELAY_CONFIG'], ['config', 'backups']],
    [['COPILOT_WEB_RELAY_DATA_DIR'], ['dataDir', 'database', 'uploads']],
    [['COPILOT_WEB_RELAY_DATA_DIR', 'COPILOT_WEB_RELAY_LOG_DIR'], ['dataDir', 'database', 'uploads', 'log']],
    [[homeVar], [homeVar]],
    [[tempVar], [tempVar]],
  ]) {
    it(`refuses to start without ${drop.join(' and ')}, naming ${names.join(', ')}`, async () => {
      const before = snapshotCheckoutFallbacks();
      const envChange = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !drop.includes(key)));
      await assert.rejects(bootRuntime({ envChange }), (error) => {
        assert.match(error.message, /^boot refused: the runtime would use paths outside the state root: /);
        const list = error.message.slice(error.message.indexOf('state root: ') + 'state root: '.length);
        const named = list.split('; ').map((entry) => entry.split(' ')[0]);
        assert.deepEqual(named, names);
        return true;
      });
      assert.deepEqual(snapshotCheckoutFallbacks(), before);
    });
  }

  // A pure move leaves the inventory as it is; the fixture's header says when
  // it may change (scripts/server-runtime-inventory.mjs).
  it('matches the inventory fixture', () => {
    const diff = inventoryDiff(fs.readFileSync(INVENTORY_FIXTURE, 'utf8'), inventoryText(run.probe));
    assert.deepEqual(diff, [], `server-runtime.mjs no longer matches ${path.relative(process.cwd(), INVENTORY_FIXTURE)}:\n${diff.join('\n')}`);
  });
});
