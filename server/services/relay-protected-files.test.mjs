// What no file route serves: the names that count inside the relay's
// folders, a folder name that only starts with `..`, the backup folder read
// on every check, and the folders of the earlier-database takeover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProtectedRelayFiles } from './relay-protected-files.mjs';
import { earlierDatabaseFolders } from './earlier-database-service.mjs';

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-protected-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a backup being written and the secrets file\'s temporary copy count, in the data and backup folders', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  const backups = path.join(dir, 'backups');
  const files = createProtectedRelayFiles({ dataDir, configPath: path.join(dir, 'config.json'), backupDir: () => backups });
  for (const name of ['oar-2026-11-12.db.partial', 'copy.db.partial', '.relay-secrets.json.4242.a1b2c3d4.tmp', '.relay-previous.json.7.00ff00ff.tmp', 'relay-secrets.json']) {
    assert.equal(files.isProtected(path.join(dataDir, name)), true, `data/${name}`);
    assert.equal(files.isProtected(path.join(backups, name)), true, `backups/${name}`);
  }
  // Elsewhere, or other names: not the relay's.
  assert.equal(files.isProtected(path.join(dir, 'work', 'copy.db.partial')), false);
  assert.equal(files.isProtected(path.join(dataDir, 'notes.partial')), false);
  assert.equal(files.isProtected(path.join(dataDir, 'notes.txt')), false);
});

test('a folder named `..x` beside the data folder is not inside it; `..` itself is not either', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, '..x'), { recursive: true });
  const files = createProtectedRelayFiles({ dataDir, configPath: path.join(dir, 'config.json') });
  // Inside the data folder, a folder whose name starts with `..` holds a database name: counted.
  assert.equal(files.isProtected(path.join(dataDir, '..x', 'copy.db')), true);
  assert.equal(files.containsProtected(path.join(dataDir, '..x')), false, 'an empty folder holds nothing');
  fs.writeFileSync(path.join(dataDir, '..x', 'copy.db'), 'database copy');
  assert.equal(files.containsProtected(path.join(dataDir, '..x')), true);
  // The folder above the data folder is not inside it (it holds it).
  assert.equal(files.isProtected(path.join(dir, 'copy.db')), false);
});

test('the backup folder is read on every check: a folder the config moves it to counts at once', (t) => {
  const dir = tempDir(t);
  let backups = path.join(dir, 'backups-a');
  const files = createProtectedRelayFiles({ dataDir: path.join(dir, 'data'), configPath: path.join(dir, 'config.json'), backupDir: () => backups });
  assert.equal(files.isProtected(path.join(dir, 'backups-a', 'oar.db')), true);
  assert.equal(files.isProtected(path.join(dir, 'backups-b', 'oar.db')), false);
  backups = path.join(dir, 'backups-b');
  assert.equal(files.isProtected(path.join(dir, 'backups-b', 'oar.db')), true);
});

test('the earlier-database folders: the unpinned data folder (originals set aside), the rescue copies and backups under the state root', (t) => {
  const dir = tempDir(t);
  const stateRoot = path.join(dir, 'state');
  const dataDir = path.join(stateRoot, 'data');
  const serverDir = path.join(dir, 'pkg', 'server');
  const folders = earlierDatabaseFolders({
    dataDir,
    serverDir,
    configPath: path.join(dir, 'missing-config.json'),
    packageRoot: path.join(dir, 'pkg'),
    env: { OAR_STATE_ROOT: stateRoot, COPILOT_WEB_RELAY_DATA_DIR: dataDir },
    platform: 'linux',
  });
  assert.ok(folders.includes(path.join(serverDir, 'data')), 'the folder the relay ran on without the pin');
  assert.ok(folders.includes(path.join(dataDir, 'rescued-package-data')));
  const files = createProtectedRelayFiles({ dataDir, configPath: path.join(dir, 'config.json'), folders: () => folders });
  assert.equal(files.isProtected(path.join(serverDir, 'data', 'oar.db.older-2026-11-12T10-00-00-000Z')), true);
  assert.equal(files.isProtected(path.join(serverDir, 'data', 'copilot.db.adopted-2026-11-12T10-00-00-000Z')), true);
  assert.equal(files.isProtected(path.join(serverDir, 'data', 'relay-secrets.json')), true);
  assert.equal(files.isProtected(path.join(serverDir, 'readme.txt')), false);
  for (const folder of folders) assert.equal(files.isProtected(path.join(folder, 'copy.db')), true, folder);
});

test('on Windows (platform win32, run on any host) a path is compared without regard to case, separator or drive-letter case', () => {
  // No disk here: every look at it fails, so only the strings count.
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const fsImpl = { realpathSync: missing, statSync: missing, readdirSync: missing };
  const files = createProtectedRelayFiles({
    dataDir: 'C:\\Users\\dev\\oar\\data',
    configPath: 'C:\\Users\\dev\\oar\\config.json',
    backupDir: () => 'C:\\Users\\dev\\oar\\backups',
    fsImpl,
    platform: 'win32',
  });
  for (const refused of [
    'C:\\Users\\dev\\oar\\data\\relay-secrets.json',
    'C:\\USERS\\DEV\\OAR\\DATA\\RELAY-SECRETS.JSON',
    'c:\\users\\dev\\oar\\Data\\Relay-Secrets.json',
    'C:/Users/dev/oar/data/relay-secrets.json',
    'C:\\Users\\dev\\oar\\data\\..\\data\\relay-previous.json',
    'C:\\Users\\dev\\oar\\CONFIG.JSON',
    'C:\\Users\\dev\\oar\\DATA\\OAR.DB-WAL',
    'c:/users/dev/oar/backups/oar-2026-11-12.db',
  ]) {
    assert.equal(files.isProtected(refused), true, refused);
  }
  for (const kept of ['C:\\Users\\dev\\oar\\notes.txt', 'C:\\Users\\dev\\oar\\data-b\\relay-secrets.json', 'D:\\Users\\dev\\oar\\data\\relay-secrets.json']) {
    assert.equal(files.isProtected(kept), false, kept);
  }
  // The folders holding them, in any case.
  assert.equal(files.containsProtected('C:\\USERS\\DEV\\OAR'), true);
  assert.equal(files.containsProtected('c:/users/dev/oar/data'), true);
  assert.equal(files.containsProtected('C:\\Users\\dev\\elsewhere'), false);
});
