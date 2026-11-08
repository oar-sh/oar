// The agent SDKs (and koffi on Windows) are installed on demand from the pins
// folders in server/agent-sdks/: an exact package.json and the lockfile `npm
// ci` installs from. A git checkout runs the same versions from its own
// node_modules, so the root package names every pin at the same version.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPinsFolders, lockProblems } from '../scripts/agent-sdk-lock.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinsDir = path.join(repoRoot, 'server', 'agent-sdks');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRIES = { claude: ['entry.mjs'], cursor: ['entry.mjs', 'entry-sqlite.mjs'], koffi: ['entry.cjs'] };
// The package each folder exists for; the rest are its peers, which npm
// installs beside it in a checkout too.
const MAIN = { claude: '@anthropic-ai/claude-agent-sdk', cursor: '@cursor/sdk', koffi: 'koffi' };

test('the pins folders are claude, cursor and koffi, each with its entries', () => {
  assert.deepEqual(listPinsFolders(pinsDir), Object.keys(ENTRIES).sort());
  for (const [id, entries] of Object.entries(ENTRIES)) {
    for (const file of ['package.json', 'package-lock.json', ...entries]) {
      assert.ok(fs.existsSync(path.join(pinsDir, id, file)), `server/agent-sdks/${id}/${file} is missing`);
    }
  }
});

test('every pin is an exact version, and its lockfile may ship', () => {
  for (const id of listPinsFolders(pinsDir)) {
    const pkg = readJson(path.join(pinsDir, id, 'package.json'));
    assert.equal(pkg.private, true, `${id}: package.json is private`);
    for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
      assert.equal(pkg[field], undefined, `${id}: package.json has no ${field}`);
    }
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      assert.match(spec, EXACT_VERSION, `${id}: ${name} is "${spec}", not an exact version`);
    }
    const lock = readJson(path.join(pinsDir, id, 'package-lock.json'));
    assert.deepEqual(lockProblems(id, pkg, lock), [], `${id}: run node scripts/agent-sdk-lock.mjs ${id} on Linux`);
  }
});

test('the root package holds every pin as a devDependency at the same version, for a checkout', () => {
  const root = readJson(path.join(repoRoot, 'package.json'));
  const rootLock = readJson(path.join(repoRoot, 'package-lock.json'));
  for (const id of listPinsFolders(pinsDir)) {
    const pkg = readJson(path.join(pinsDir, id, 'package.json'));
    assert.ok(pkg.dependencies[MAIN[id]], `${id}: the pins folder pins ${MAIN[id]}`);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      // An install gets them on demand; a shipped dependency would bring them back.
      assert.equal(root.dependencies?.[name], undefined, `${id}: ${name} must not be a dependency of the package`);
      assert.equal(root.devDependencies?.[name], version, `${id}: the root devDependencies name ${name} ${root.devDependencies?.[name]}, the pins folder ${version}`);
      assert.equal(rootLock.packages[`node_modules/${name}`]?.version, version, `${id}: the root lockfile holds another ${name}`);
    }
  }
});

test('lockProblems finds what must not ship', () => {
  const pkg = { name: 'oar-agent-sdk-claude', dependencies: { a: '1.0.0' } };
  const good = {
    name: pkg.name,
    packages: {
      '': { name: pkg.name, dependencies: { a: '1.0.0' } },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a-linux-x64-musl': { version: '1.0.0', os: ['linux'], libc: ['musl'] },
      'node_modules/zod': { version: '4.6.7' },
    },
  };
  assert.deepEqual(lockProblems('claude', pkg, good), []);
  const bad = structuredClone(good);
  bad.packages['node_modules/a'].version = '1.0.1';
  bad.packages['node_modules/a-linux-x64-musl'].libc = undefined;
  bad.packages['node_modules/b/node_modules/zod'] = { version: '4.3.6' };
  bad.packages['node_modules/c'] = { version: '1.0.0', hasInstallScript: true };
  const problems = lockProblems('claude', pkg, bad).join('\n');
  assert.match(problems, /a: the lock holds 1\.0\.1/);
  assert.match(problems, /no "libc": \["musl"\]/);
  assert.match(problems, /zod 4\.3\.6, below 4\.6\.6/);
  assert.match(problems, /install script: c/);
  // koffi's lock holds exactly koffi with a script.
  const koffiPkg = { name: 'oar-agent-sdk-koffi', dependencies: { koffi: '3.3.4' } };
  const koffiLock = {
    name: koffiPkg.name,
    packages: { '': { name: koffiPkg.name, dependencies: { koffi: '3.3.4' } }, 'node_modules/koffi': { version: '3.3.4', hasInstallScript: true } },
  };
  assert.deepEqual(lockProblems('koffi', koffiPkg, koffiLock), []);
  koffiLock.packages['node_modules/koffi'].hasInstallScript = false;
  assert.match(lockProblems('koffi', koffiPkg, koffiLock).join('\n'), /expected koffi/);
});
