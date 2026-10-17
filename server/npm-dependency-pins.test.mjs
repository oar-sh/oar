// The package names exact versions for what it depends on itself: a range
// let every install fetch whatever was newest that day, versions no release
// was tested with. npm ignores a lockfile inside an installed package, and a
// shrinkwrap installs every platform's native binaries, so the direct
// dependencies are pinned in package.json, at the versions of the lockfile.
// Dependencies of dependencies still follow their own ranges.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8'));

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

test('every shipped dependency is pinned to the version the lockfile holds', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] || {})) {
      assert.match(spec, EXACT_VERSION, `${field}.${name} is "${spec}", not an exact version`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, spec, `${name}: package-lock.json holds another version`);
      assert.equal(lock.packages['']?.[field]?.[name], spec, `${name}: the lockfile's root entry names another range`);
    }
  }
});
