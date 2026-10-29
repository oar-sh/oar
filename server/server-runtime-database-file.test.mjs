'use strict';

// server-runtime.mjs boots a live server on import, so the order of the
// database-file steps is pinned by source inspection; a real start on each
// name is tests/database-file.spec.mjs, the steps themselves
// services/database-file.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

function at(needle) {
  const index = runtimeSource.indexOf(needle);
  assert.notEqual(index, -1, `missing ${needle}`);
  return index;
}

test('lock, then both names settled, then the earlier database, then the file resolved, then opened', () => {
  const order = [
    'relaySingletonGuard.acquire();',
    'settled = settleDatabaseFile({',
    'earlierDatabase = adoptEarlierDatabase({',
    'const databaseFile = resolveDatabaseFile(DATA_DIR);',
    'const db = new Database(DB_PATH);',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(runtimeSource, /const DB_PATH = databaseFile\.path;/);
  assert.match(runtimeSource, /const databaseCreatedAtStart = databaseFile\.created;/);
});

test('a refused settle stops like a refused adoption: the lock released, exit 78', () => {
  const block = runtimeSource.slice(at('settled = settleDatabaseFile({'), at('let earlierDatabase;'));
  assert.match(block, /progressFile: path\.join\(DATA_DIR, TAKEOVER_PROGRESS_FILE\)/);
  assert.match(block, /if \(settled\.status === 'refused'\) \{\s*console\.error\(settled\.error\);\s*try \{ relaySingletonGuard\.release\(\); \} catch \{\}\s*process\.exit\(RELAY_STOP_EXIT_CODE\);/);
  assert.match(block, /catch \(error\) \{\s*settled = \{ status: 'refused'/);
});

test('checkDatabaseFile decides (database-file.test.mjs): its refusal stops the start, its warnings are said', () => {
  const block = runtimeSource.slice(at('const DB_PATH = databaseFile.path;'), at('const MAX_REQUEUE_RETRIES'));
  assert.match(block, /const check = checkDatabaseFile\(databaseFile\);\s*for \(const warning of check\.warnings\) console\.warn\(warning\);/);
  assert.match(block, /if \(check\.refusal\) \{\s*console\.error\(check\.refusal\);\s*try \{ relaySingletonGuard\.release\(\); \} catch \{\}\s*process\.exit\(RELAY_STOP_EXIT_CODE\);/);
});

test('the backup step runs after the database opens, before applySchema and before reconcileUpdateAttempt reads the update record away', () => {
  const order = [
    'const db = new Database(DB_PATH);',
    'dbBackupAtStart = await maybeBackupBeforeStart({',
    'applySchema(db);',
    'if (dbBackupAtStart?.deferredLastRun) writeDbLastRun(db, dbBackupAtStart.deferredLastRun);',
    'reconcileUpdateAttempt({',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const step = runtimeSource.slice(at('dbBackupAtStart = await maybeBackupBeforeStart({'), at('applySchema(db);'));
  for (const dep of ['databaseCreated: databaseCreatedAtStart', 'layout: STATE_LAYOUT', 'runningVersion: RUNNING_VERSION', 'runningCommit: BUILD_COMMIT', 'config,']) {
    assert.ok(step.includes(dep), dep);
  }
  assert.match(step, /\} catch \(error\) \{\s*console\.warn\(`\[backup\] failed: /, 'never stops the start');
  assert.match(runtimeSource, /dbBackups: \{ enabled: true, keep: 2 \}/, 'DEFAULT_CONFIG');
  assert.match(runtimeSource, /describeNextBackup: \(\) => describeNextBackup\(\{ layout: STATE_LAYOUT/);
  assert.match(runtimeSource, /describeBackups: \(\) => describeBackups\(\{ layout: STATE_LAYOUT, serverDir: __dirname, dataDir: DATA_DIR, config, sizes: false \}\)/, 'About walks no folder sizes');
});
