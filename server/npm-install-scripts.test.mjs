// npm 12 runs no install script it was not told to allow. No shipped
// dependency has one now (NPM_INSTALL_SCRIPT_PACKAGES is empty), so the
// updater and the installers on oar.sh pass no allow list; a dependency that
// gains an install script without being added there would install without
// its binary on npm 12 and only fail at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NPM_INSTALL_SCRIPT_PACKAGES } from './services/oar-cli-helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every shipped dependency with an install script is on the allow list', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const withScripts = Object.entries(lock.packages)
    .filter(([key, entry]) => key && entry.hasInstallScript && !entry.dev)
    .map(([key]) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
    .sort();
  assert.deepEqual(withScripts, [...NPM_INSTALL_SCRIPT_PACKAGES].sort());
});

// better-sqlite3 13 ships a binding.gyp beside its prebuilt binaries and says
// "gypfile": false, so npm does not run node-gyp for it. npm installing from
// this lock reads the lock entry as the package, which then has no gypfile:
// `npm ci` would run node-gyp rebuild, and that needs make and a compiler
// even where the prebuilt binary is used. npm drops the key whenever it
// writes the lock again; put it back.
test('the lock keeps "gypfile": false on better-sqlite3', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/better-sqlite3'];
  assert.ok(entry, 'better-sqlite3 is in the lock');
  assert.equal(entry.gypfile, false, 'add "gypfile": false to the node_modules/better-sqlite3 entry of package-lock.json');
});
