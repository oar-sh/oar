import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { bootRuntime, resolvedRuntimePaths } from '../tests/helpers/runtime-boot.mjs';

// The Copilot switch on a real runtime start (tests/helpers/runtime-boot.mjs:
// a scratch state root with its own home, so no Copilot CLI is found). A new
// database decides the switch once, from the CLI detection: off here, written
// as 'false'. A second start on that database keeps it off (migration 0043
// does not take the first start's own writes for use), Copilot's boot work
// (SDK session import, model discovery) does not start, and About lists no
// Copilot.

const storedSwitch = (databasePath) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT value FROM app_settings WHERE key = 'copilot_enabled'`).get()?.value ?? null;
  } finally {
    db.close();
  }
};

async function readCopilot(handle) {
  const headers = { Authorization: `Bearer ${handle.token}` };
  const settings = await (await fetch(`${handle.baseUrl}/api/settings/copilot`, { headers })).json();
  const about = await (await fetch(`${handle.baseUrl}/api/about`, { headers })).json();
  return { settings, about };
}

const aboutIds = (about) => (Array.isArray(about?.providers) ? about.providers.map((row) => row.id) : null);

test('a new relay without the Copilot CLI starts with Copilot off, twice, with no Copilot boot work', { timeout: 300_000 }, async () => {
  const first = await bootRuntime();
  let firstDatabase = null;
  let copyDir = null;
  try {
    const { settings, about } = await readCopilot(first);
    assert.equal(settings.enabled, false, 'detected once: no CLI');
    assert.equal(settings.cliFound, false);
    assert.ok(Array.isArray(aboutIds(about)), 'About lists its providers');
    assert.equal(aboutIds(about).includes('github'), false, 'About lists no Copilot');
    assert.match(first.output(), /COPILOT switched off: no SDK session import, no model discovery/);
    const stop = await first.shutdown();
    assert.equal(stop.code, 0, first.output());
    firstDatabase = first.databasePath;
    assert.equal(storedSwitch(firstDatabase), 'false', 'the first read wrote what it detected');
    // Kept for the second start before the first state root goes.
    copyDir = fs.mkdtempSync(path.join(path.dirname(first.stateRoot), 'copilot-boot-db-'));
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(firstDatabase + suffix)) fs.copyFileSync(firstDatabase + suffix, path.join(copyDir, path.basename(firstDatabase) + suffix));
    }
  } finally {
    await first.kill();
    first.cleanup();
  }

  // The second start on the same database, in a scratch root of its own.
  const second = await bootRuntime({
    envChange: (env) => {
      const target = resolvedRuntimePaths(env).database;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      for (const name of fs.readdirSync(copyDir)) {
        fs.copyFileSync(path.join(copyDir, name), path.join(path.dirname(target), name.replace(path.basename(firstDatabase), path.basename(target))));
      }
      return env;
    },
  });
  try {
    const { settings, about } = await readCopilot(second);
    assert.equal(settings.enabled, false, 'still off on the second start');
    assert.equal(aboutIds(about).includes('github'), false);
    assert.match(second.output(), /COPILOT switched off: no SDK session import, no model discovery/);
    await second.shutdown();
    assert.equal(storedSwitch(second.databasePath), 'false', 'never turned to true by the second start');
  } finally {
    await second.kill();
    second.cleanup();
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
});
