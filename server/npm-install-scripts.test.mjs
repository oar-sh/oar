// npm 12 runs no install script it was not told to allow. The updater (and the
// installers on oar.sh) pass the list in NPM_INSTALL_SCRIPT_PACKAGES; a
// dependency that gains an install script without being added there would
// install without its binary on npm 12 and only fail at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NPM_ALLOW_SCRIPTS_ARG, NPM_INSTALL_SCRIPT_PACKAGES } from './services/oar-cli-helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every shipped dependency with an install script is on the allow list', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const withScripts = Object.entries(lock.packages)
    .filter(([key, entry]) => key && entry.hasInstallScript && !entry.dev)
    .map(([key]) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
    .sort();
  assert.deepEqual([...new Set(withScripts)], [...NPM_INSTALL_SCRIPT_PACKAGES].sort());
  assert.equal(NPM_ALLOW_SCRIPTS_ARG, `--allow-scripts=${NPM_INSTALL_SCRIPT_PACKAGES.join(',')}`);
});
