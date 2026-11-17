import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { applySchema } from './db-schema.mjs';
import { bootRuntime, resolvedRuntimePaths } from '../tests/helpers/runtime-boot.mjs';

// The Copilot switch when its database steps fail, on a real runtime start
// (tests/helpers/runtime-boot.mjs: a scratch state root, no Copilot CLI).
// tests/helpers/copilot-switch-db-fault.mjs makes the step fail:
// - migration 0043 throws: the relay starts with Copilot off, writes nothing
//   (the switch stays unset), says so once, and the next start with a
//   working database applies the migration;
// - after that, switching Copilot on by hand is stored and kept over a
//   restart;
// - storing the switch throws: reading it does not, the routes answer, and
//   nothing is stored.

const faultModule = pathToFileURL(path.resolve(import.meta.dirname, '..', 'tests', 'helpers', 'copilot-switch-db-fault.mjs')).href;
const MIGRATION_FAILED = /\[copilot\] migration 0043 failed; retrying on next boot\. Until then Copilot stays switched off unless it is switched on in Settings → Providers → Copilot: fixture: the settings table cannot be read/g;
const NOT_SAVED = /\[copilot\] the Copilot switch could not be saved \(fixture: attempt to write a readonly database\): Copilot is off for now, as detected, and the next start decides it again/g;
const AT = '2026-03-01T10:00:00.000Z';

const storedSwitch = (databasePath) => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT value FROM app_settings WHERE key = 'copilot_enabled'`).get()?.value ?? null;
  } finally {
    db.close();
  }
};

// The environment change for bootRuntime: the fault (if any), and the
// database in place before the start (`database(target)` writes it).
function startWith({ fault = null, database = null } = {}) {
  return (env) => {
    if (database) {
      const target = resolvedRuntimePaths(env).database;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      database(target);
    }
    return fault ? { ...env, DB_FAULT_FIXTURE: fault, NODE_OPTIONS: `--import=${faultModule}` } : env;
  };
}

// A relay in use: the database has a conversation, and no switch yet.
function inUseDatabase(target) {
  const db = new Database(target);
  try {
    applySchema(db);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-boot-fixture', 'Widget plan', ?, ?)`).run(AT, AT);
    db.prepare(`DELETE FROM app_settings WHERE key = 'copilot_enabled'`).run();
  } finally {
    db.close();
  }
}

// The database of a stopped relay, for the next start, kept beside its
// state root (which goes).
function copiedDatabase(fromPath, stateRoot) {
  const saved = fs.mkdtempSync(path.join(path.dirname(stateRoot), 'copilot-boot-db-'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(fromPath + suffix)) fs.copyFileSync(fromPath + suffix, path.join(saved, `db${suffix}`));
  }
  return {
    into: (target) => {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = path.join(saved, `db${suffix}`);
        if (fs.existsSync(file)) fs.copyFileSync(file, target + suffix);
      }
    },
    remove: () => fs.rmSync(saved, { recursive: true, force: true }),
  };
}

async function api(handle, route, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${handle.baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${handle.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const aboutIds = (about) => (Array.isArray(about?.providers) ? about.providers.map((row) => row.id) : null);
const count = (text, pattern) => (text.match(pattern) || []).length;

// Runs a start, then `check(handle)`, then the runtime's own stop; returns
// the stopped relay's database, copied, for the next start.
async function cycle(options, check) {
  const handle = await bootRuntime(options);
  try {
    await check(handle);
    const stop = await handle.shutdown();
    assert.equal(stop.code, 0, handle.output());
    return { copy: copiedDatabase(handle.databasePath, handle.stateRoot), stored: storedSwitch(handle.databasePath), output: handle.output() };
  } finally {
    await handle.kill();
    handle.cleanup();
  }
}

test('migration 0043 throws: Copilot starts off, nothing is written, one log line; the next working start applies it', { timeout: 300_000 }, async () => {
  const first = await cycle({ envChange: startWith({ fault: 'migration', database: inUseDatabase }) }, async (handle) => {
    for (let read = 0; read < 3; read += 1) {
      const settings = await api(handle, '/api/settings/copilot');
      assert.equal(settings.status, 200);
      assert.equal(settings.body.enabled, false, 'off while the migration has not run');
      const about = await api(handle, '/api/about');
      assert.equal(about.status, 200);
      assert.equal(aboutIds(about.body).includes('github'), false);
    }
    assert.equal(storedSwitch(handle.databasePath), null, 'nothing decided the switch while the relay runs');
    assert.equal(count(handle.output(), MIGRATION_FAILED), 1, handle.output());
  });
  try {
    assert.equal(first.stored, null, 'the switch stays unset, so the next start retries the migration');
    const second = await cycle({ envChange: startWith({ database: first.copy.into }) }, async (handle) => {
      const settings = await api(handle, '/api/settings/copilot');
      assert.equal(settings.body.enabled, true, 'the relay was in use: Copilot stays on');
      assert.equal(count(handle.output(), MIGRATION_FAILED), 0);
    });
    second.copy.remove();
    assert.equal(second.stored, 'true', 'migration 0043 applied');
  } finally {
    first.copy.remove();
  }
});

test('after a failed migration 0043, switching Copilot on by hand is stored and kept over a restart', { timeout: 300_000 }, async () => {
  const first = await cycle({ envChange: startWith({ fault: 'migration', database: inUseDatabase }) }, async (handle) => {
    assert.equal((await api(handle, '/api/settings/copilot')).body.enabled, false);
    assert.equal(storedSwitch(handle.databasePath), null, 'unset until switched by hand');
    const switched = await api(handle, '/api/settings/copilot', { method: 'POST', body: { enabled: true } });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.enabled, true);
    assert.equal((await api(handle, '/api/settings/copilot')).body.enabled, true);
    assert.equal(count(handle.output(), MIGRATION_FAILED), 1);
  });
  try {
    assert.equal(first.stored, 'true', 'stored by the switch');
    // The fault stays: the migration finds the switch set and has nothing to do.
    const second = await cycle({ envChange: startWith({ fault: 'migration', database: first.copy.into }) }, async (handle) => {
      assert.equal((await api(handle, '/api/settings/copilot')).body.enabled, true, 'kept over the restart');
      assert.equal(count(handle.output(), MIGRATION_FAILED), 0);
    });
    second.copy.remove();
    assert.equal(second.stored, 'true');
  } finally {
    first.copy.remove();
  }
});

test('storing the switch throws: reading it does not, the routes answer, nothing is stored, one log line', { timeout: 300_000 }, async () => {
  const run = await cycle({ envChange: startWith({ fault: 'write' }) }, async (handle) => {
    for (let read = 0; read < 3; read += 1) {
      const settings = await api(handle, '/api/settings/copilot');
      assert.equal(settings.status, 200, JSON.stringify(settings.body));
      assert.equal(settings.body.enabled, false, 'as detected: no Copilot CLI here');
      const about = await api(handle, '/api/about');
      assert.equal(about.status, 200);
      assert.equal(aboutIds(about.body).includes('github'), false);
      assert.equal((await api(handle, '/api/models')).status, 200);
    }
    assert.equal(count(handle.output(), NOT_SAVED), 1, handle.output());
  });
  run.copy.remove();
  assert.equal(run.stored, null, 'nothing stored: the next start decides it again');
});
