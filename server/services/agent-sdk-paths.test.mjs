import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_SDK_LEASES_DIR,
  AGENT_SDK_MARKER,
  AGENT_SDK_PIN_FILES,
  AGENT_SDK_PINS_DIR,
  AGENT_SDK_STORE_FORMAT,
  agentSdkCheckedFiles,
  agentSdkSupport,
  detectLibc,
  findReadyAgentSdkDir,
  getAgentSdkDescriptor,
  isAgentSdkFolderName,
  isValidAgentSdkInstall,
  platformPackageFor,
  readAgentSdkMarker,
  readAgentSdkPin,
  resolveAgentSdkRoot,
  writeAgentSdkLease,
} from './agent-sdk-paths.mjs';

// Every test works in its own folder under this one; the pins folders are
// fictional copies, and the host is always passed in, so nothing depends on
// the machine running the tests.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sdk-paths-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const LINUX_X64 = Object.freeze({ platform: 'linux', arch: 'x64', libc: 'glibc' });
const LINUX_X64_MUSL = Object.freeze({ platform: 'linux', arch: 'x64', libc: 'musl' });
const LINUX_ARM64 = Object.freeze({ platform: 'linux', arch: 'arm64', libc: 'glibc' });
const DARWIN_ARM64 = Object.freeze({ platform: 'darwin', arch: 'arm64', libc: null });
const WIN32_X64 = Object.freeze({ platform: 'win32', arch: 'x64', libc: null });

const PIN_FIXTURES = {
  claude: {
    dependencies: { '@anthropic-ai/claude-agent-sdk': '0.2.10' },
    platformPackages: {
      '@anthropic-ai/claude-agent-sdk-linux-x64': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
      '@anthropic-ai/claude-agent-sdk-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
    },
    entries: { 'entry.mjs': "export * from '@anthropic-ai/claude-agent-sdk';\n" },
  },
  cursor: {
    dependencies: { '@cursor/sdk': '1.4.2', 'tiny-schema': '3.1.0' },
    platformPackages: {
      '@cursor/sdk-linux-x64': { os: ['linux'], cpu: ['x64'] },
      '@cursor/sdk-win32-x64': { os: ['win32'], cpu: ['x64'] },
    },
    entries: {
      'entry.mjs': "export * from '@cursor/sdk';\n",
      'entry-sqlite.mjs': "export { openStore } from '@cursor/sdk/sqlite';\n",
    },
  },
  koffi: {
    dependencies: { koffi: '2.9.1' },
    platformPackages: {
      '@koromix/koffi-win32-x64': { os: ['win32'], cpu: ['x64'] },
      '@koromix/koffi-linux-x64': { os: ['linux'], cpu: ['x64'] },
    },
    entries: { 'entry.cjs': "module.exports = require('koffi');\n" },
  },
};

function tempDir(label) {
  return fs.mkdtempSync(path.join(TMP, `${label}-`));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A pins folder per SDK: the manifest with exact deps (pin.json), a small
 * lockfile (pin-lock.json), entries; `manifest` and `lock` rename those two.
 */
function writePins(pinsDir, overrides = {}, { manifest = 'pin.json', lock = 'pin-lock.json' } = {}) {
  for (const [id, base] of Object.entries(PIN_FIXTURES)) {
    const fixture = { ...base, ...(overrides[id] || {}) };
    const folder = path.join(pinsDir, id);
    writeJson(path.join(folder, manifest), { name: `fixture-${id}`, version: '0.0.0', private: true, dependencies: fixture.dependencies });
    const packages = { '': { name: `fixture-${id}`, version: '0.0.0', dependencies: fixture.dependencies } };
    for (const [name, version] of Object.entries(fixture.dependencies)) packages[`node_modules/${name}`] = { version };
    for (const [name, constraints] of Object.entries(fixture.platformPackages)) {
      packages[`node_modules/${name}`] = { version: '1.0.0', optional: true, ...constraints };
    }
    writeJson(path.join(folder, lock), { name: `fixture-${id}`, lockfileVersion: 3, requires: true, packages });
    for (const [name, text] of Object.entries(fixture.entries)) fs.writeFileSync(path.join(folder, name), text);
  }
  return pinsDir;
}

/**
 * A finished install as the store leaves it: the checked files on disk and
 * a marker recording their sizes. `marker` overrides marker fields.
 */
function writeInstall(root, pin, { name = pin.dirName, installedAt = '2026-03-01T10:00:00.000Z', marker = {} } = {}) {
  const dir = path.join(root, pin.id, name);
  for (const rel of agentSdkCheckedFiles(pin)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = pin.files[rel];
    fs.writeFileSync(file, entry || `${JSON.stringify({ name: rel.split('/').slice(1, -1).join('/'), version: '1.0.0' })}\n`);
  }
  const files = {};
  for (const rel of agentSdkCheckedFiles(pin)) files[rel] = fs.statSync(path.join(dir, ...rel.split('/'))).size;
  writeJson(path.join(dir, AGENT_SDK_MARKER), {
    format: AGENT_SDK_STORE_FORMAT,
    id: pin.id,
    version: pin.version,
    hash: pin.hash,
    platform: pin.host.platform,
    arch: pin.host.arch,
    libc: pin.host.libc || null,
    platformPackage: platformPackageFor(pin),
    installedAt,
    files,
    ...marker,
  });
  return dir;
}

function rewriteMarker(dir, change) {
  const marker = readAgentSdkMarker(dir);
  change(marker);
  writeJson(path.join(dir, AGENT_SDK_MARKER), marker);
}

// ─── Pins ────────────────────────────────────────────────────────────────────

test('readAgentSdkPin names the folder after the pinned version and the content hash', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pin = readAgentSdkPin('cursor', { pinsDir, host: LINUX_X64 });
  assert.equal(pin.id, 'cursor');
  assert.equal(pin.version, '1.4.2');
  assert.match(pin.hash, /^[0-9a-f]{64}$/);
  assert.equal(pin.dirName, `1.4.2-${pin.hash.slice(0, 8)}`);
  assert.ok(isAgentSdkFolderName(pin.dirName));
  assert.deepEqual(pin.host, LINUX_X64);
  // The pins as read: package.json, the lockfile and both entries.
  assert.deepEqual(Object.keys(pin.files).sort(), ['entry-sqlite.mjs', 'entry.mjs', 'package-lock.json', 'package.json']);
  assert.ok(pin.lock.packages['node_modules/@cursor/sdk-linux-x64']);
  // Ids are matched case-insensitively; unknown ones have no pin.
  assert.equal(readAgentSdkPin(' Cursor ', { pinsDir, host: LINUX_X64 }).hash, pin.hash);
  assert.equal(readAgentSdkPin('nope', { pinsDir, host: LINUX_X64 }), null);
});

test('readAgentSdkPin hashes the pins files and the host', () => {
  const first = writePins(tempDir('pins'));
  const same = writePins(tempDir('pins'));
  const changedEntry = writePins(tempDir('pins'), { claude: { entries: { 'entry.mjs': "export { query } from '@anthropic-ai/claude-agent-sdk';\n" } } });
  const base = readAgentSdkPin('claude', { pinsDir: first, host: LINUX_X64 });
  assert.equal(readAgentSdkPin('claude', { pinsDir: same, host: LINUX_X64 }).hash, base.hash, 'identical pins, identical hash');
  assert.notEqual(readAgentSdkPin('claude', { pinsDir: changedEntry, host: LINUX_X64 }).hash, base.hash, 'an entry file counts');
  assert.notEqual(readAgentSdkPin('claude', { pinsDir: first, host: LINUX_X64_MUSL }).hash, base.hash, 'the libc counts');
  assert.notEqual(readAgentSdkPin('claude', { pinsDir: first, host: WIN32_X64 }).hash, base.hash, 'the platform counts');
  assert.notEqual(readAgentSdkPin('claude', { pinsDir: first, host: LINUX_ARM64 }).hash, base.hash, 'the arch counts');
});

// The pins ship as pin.json and pin-lock.json (a package.json in the tarball
// reads as a dependency manifest to package scanners); the hash still covers
// them as package.json and package-lock.json, the names an install writes, so
// the rename moved no installed folder. These are the hashes the code before
// the rename gave the same bytes under the old names.
const PRE_RENAME_FIXTURE_HASHES = Object.freeze({
  linux: { claude: '6bf0aabb8f99ba5ed75c2159cc57264603746be0338f4dfe1e1c845acf9efc97', cursor: 'bec06bbd924e7e48c35e4d300762fc5ac984b9f4678e181149593a0234324b0a', koffi: '34c339817fd73a2dd5587d2933cc62fb5a9950d7744f880bc73dbd70d27e3e3d' },
  win32: { claude: '1dedce0d5afd362abb92ba31ddd69d1ce15dbefc2d1074235130551e01174989', cursor: '7fd66d37f23337808ad904ccaa0a4aafeca3bafd0ae286d3022745adc407c6f4', koffi: '438b46c83d9ad8816794e0dcfd6b0ac9b70413ac796ca8d90b4c65a10a867896' },
});

test('readAgentSdkPin reads pin.json and pin-lock.json and hashes them under the npm names', () => {
  assert.deepEqual({ ...AGENT_SDK_PIN_FILES }, { 'package.json': 'pin.json', 'package-lock.json': 'pin-lock.json' });
  const pinsDir = writePins(tempDir('pins'));
  for (const [host, hashes] of [[LINUX_X64, PRE_RENAME_FIXTURE_HASHES.linux], [WIN32_X64, PRE_RENAME_FIXTURE_HASHES.win32]]) {
    for (const [id, hash] of Object.entries(hashes)) {
      assert.equal(readAgentSdkPin(id, { pinsDir, host }).hash, hash, `${id} on ${host.platform}: the hash before the rename`);
    }
  }
  // What an install writes: the npm names, the shipped bytes.
  const pin = readAgentSdkPin('koffi', { pinsDir, host: WIN32_X64 });
  assert.deepEqual(Object.keys(pin.files).sort(), ['entry.cjs', 'package-lock.json', 'package.json']);
  assert.deepEqual(pin.files['package.json'], fs.readFileSync(path.join(pinsDir, 'koffi', 'pin.json')));
  assert.deepEqual(pin.files['package-lock.json'], fs.readFileSync(path.join(pinsDir, 'koffi', 'pin-lock.json')));
  // A folder with only the npm names is no pins folder.
  const npmNamed = writePins(tempDir('pins'), {}, { manifest: 'package.json', lock: 'package-lock.json' });
  assert.throws(() => readAgentSdkPin('claude', { pinsDir: npmNamed, host: LINUX_X64 }), /ENOENT/);
  assert.equal(findReadyAgentSdkDir('claude', { root: tempDir('root'), pinsDir: npmNamed, host: LINUX_X64 }), null);
});

// The package's own pins, hashed by the code before the rename (the first 8
// hex name each installed folder). `pins` is a sha256 of the pin files they
// were recorded from (pin.json, pin-lock.json and the entries, by their npm
// names): a pin bump or a lock refresh at the same version (new transitive
// dependencies) changes the folder hash on purpose, so the check covers only
// the pins it was recorded with.
const PRE_RENAME_SHIPPED = Object.freeze({
  claude: { pins: '2babf98ffe1af7426d1e67d6f557fe7cb48dcc5712167b9637fe17a8610aabc1', linux: '9fe86740aa3b78c68956f7d3059c46241edbe851220ae4c8b39a153760f320db', win32: '8af9797a07c383497ecb7d4d15bfd6d73625848b825fa8ae3240bf818ff6a483', darwin: '48aa574ed735ae383b7741b3b258359c41db33da5d227e1370d32904cf5de54f' },
  cursor: { pins: 'baebb288566c56b0f6c8bedb2375621760794dbc55d28b1998d645a1ac4c362c', linux: '05413dc3eebb45b2a7c9ada4888a5b3e9e3b7c72f3d10c58c18e9c013d615ade', win32: 'b20cf5963d1078679e4adc99d91cfc390ae7738125fe4a11d58214f40a2083e0', darwin: 'bd7d2f3f3ea46c45723dcd447a2bcbc1fd06df0194ff9bfac0b16eb7f4b9c7c0' },
  koffi: { pins: 'c87f739de4fd69c7630ca1ff9406ec35240a990d4e257234f84ae0e2cfad0754', linux: '701c4ffdd6726a4b88ec86e38712c5bbee74fd8f75dc3be335a22ec3c5b8bc47', win32: 'dc9e2f37e23dc9b9ba6ccd1ecef3a4c29dd3739d8293b372ec37b6678badedf8', darwin: '6a6753171118f9d2c528ae75edd177cb4549be56720ed55bc56e844f5b3cb8d0' },
});

function pinFilesHash(pin) {
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(pin.files).sort()) hash.update(`${name}\0`).update(pin.files[name]).update('\0');
  return hash.digest('hex');
}

test('the shipped pins keep the folders they had before the rename', (t) => {
  const fresh = { readFileSync: fs.readFileSync };
  const changed = [];
  let checked = 0;
  for (const [id, recorded] of Object.entries(PRE_RENAME_SHIPPED)) {
    if (pinFilesHash(readAgentSdkPin(id, { pinsDir: AGENT_SDK_PINS_DIR, host: LINUX_X64, fsImpl: fresh })) !== recorded.pins) {
      changed.push(id);
      continue;
    }
    for (const host of [LINUX_X64, WIN32_X64, DARWIN_ARM64]) {
      const pin = readAgentSdkPin(id, { pinsDir: AGENT_SDK_PINS_DIR, host, fsImpl: fresh });
      assert.equal(pin.hash, recorded[host.platform], `${id} ${pin.version} on ${host.platform}: the hash before the rename`);
      checked += 1;
    }
  }
  const why = `the pins of ${changed.join(', ')} changed since the rename (a bump or a lock refresh), so their pre-rename folder hashes no longer apply`;
  if (!checked) t.skip(why);
  else if (changed.length) t.diagnostic(why);
});

test('readAgentSdkPin keeps the pins it read first while the files change under it', () => {
  const pinsDir = writePins(tempDir('pins'));
  const before = readAgentSdkPin('claude', { pinsDir, host: LINUX_X64 });
  fs.writeFileSync(path.join(pinsDir, 'claude', 'entry.mjs'), '// replaced by an update\n');
  assert.equal(readAgentSdkPin('claude', { pinsDir, host: LINUX_X64 }), before);
  // A reader with its own fs bypasses the cache and sees the new files.
  const fresh = readAgentSdkPin('claude', { pinsDir, host: LINUX_X64, fsImpl: { readFileSync: fs.readFileSync } });
  assert.notEqual(fresh.hash, before.hash);
});

// ─── Platform packages and support ───────────────────────────────────────────

test('platformPackageFor matches os, cpu and libc from the lockfile', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pinFor = (id, host) => readAgentSdkPin(id, { pinsDir, host });
  assert.equal(platformPackageFor(pinFor('claude', LINUX_X64)), '@anthropic-ai/claude-agent-sdk-linux-x64');
  assert.equal(platformPackageFor(pinFor('claude', LINUX_X64_MUSL)), '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
  assert.equal(platformPackageFor(pinFor('claude', DARWIN_ARM64)), '@anthropic-ai/claude-agent-sdk-darwin-arm64');
  assert.equal(platformPackageFor(pinFor('claude', WIN32_X64)), null);
  assert.equal(platformPackageFor(pinFor('cursor', WIN32_X64)), '@cursor/sdk-win32-x64');
  assert.equal(platformPackageFor(pinFor('cursor', LINUX_ARM64)), null);
  assert.equal(platformPackageFor(null), null);
});

test('platformPackageFor honours negated lists and ignores packages outside the vendor scope', () => {
  const pin = (host) => ({
    id: 'cursor',
    host,
    lock: {
      packages: {
        // Same os/cpu, but not the vendor's scope: never the platform package.
        'node_modules/other-native-linux-x64': { os: ['linux'], cpu: ['x64'] },
        // No os at all: a plain dependency.
        'node_modules/@cursor/sdk-common': { version: '1.0.0' },
        'node_modules/@cursor/sdk-not-windows': { os: ['!win32'], cpu: ['x64', 'arm64'] },
      },
    },
  });
  assert.equal(platformPackageFor(pin(LINUX_ARM64)), '@cursor/sdk-not-windows');
  assert.equal(platformPackageFor(pin(DARWIN_ARM64)), '@cursor/sdk-not-windows');
  assert.equal(platformPackageFor(pin(WIN32_X64)), null);
});

test('agentSdkSupport: yes with a vendor build, no without one unless the host CLI may stand in', () => {
  const pinsDir = writePins(tempDir('pins'));
  const support = (id, host, options) => agentSdkSupport(readAgentSdkPin(id, { pinsDir, host }), options);
  assert.equal(support('claude', LINUX_X64), 'yes');
  assert.equal(support('claude', WIN32_X64), 'no', 'no platform has the host-CLI stand-in yet');
  assert.equal(support('claude', WIN32_X64, { hostCliPlatforms: ['win32'] }), 'cli', 'the switch in the table');
  assert.equal(support('cursor', LINUX_X64), 'yes');
  assert.equal(support('cursor', LINUX_ARM64), 'no', 'cursor needs its platform package');
  assert.equal(support('koffi', WIN32_X64), 'yes');
  // koffi is for Windows only, even where the lockfile lists a build.
  assert.equal(support('koffi', LINUX_X64), 'no');
  assert.equal(agentSdkSupport({ id: 'nope', host: LINUX_X64 }), 'no');
});

test('agentSdkCheckedFiles lists the entries, each pinned package and the platform package', () => {
  const pinsDir = writePins(tempDir('pins'));
  assert.deepEqual(agentSdkCheckedFiles(readAgentSdkPin('cursor', { pinsDir, host: LINUX_X64 })), [
    'entry.mjs',
    'entry-sqlite.mjs',
    'node_modules/@cursor/sdk/package.json',
    'node_modules/tiny-schema/package.json',
    'node_modules/@cursor/sdk-linux-x64/package.json',
  ]);
  assert.deepEqual(agentSdkCheckedFiles(readAgentSdkPin('claude', { pinsDir, host: WIN32_X64 })), [
    'entry.mjs',
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  ]);
});

// ─── Markers ─────────────────────────────────────────────────────────────────

test('isValidAgentSdkInstall accepts a finished install for the pin and the host', () => {
  const pinsDir = writePins(tempDir('pins'));
  const root = tempDir('root');
  const pin = readAgentSdkPin('cursor', { pinsDir, host: LINUX_X64 });
  const dir = writeInstall(root, pin);
  assert.equal(isValidAgentSdkInstall(dir, { pin }), true);
  assert.equal(isValidAgentSdkInstall(dir, { id: 'cursor', host: LINUX_X64 }), true);
  assert.equal(isValidAgentSdkInstall(dir, { id: 'claude', host: LINUX_X64 }), false, 'another SDK id');
  assert.equal(isValidAgentSdkInstall(path.join(root, 'cursor', 'absent'), { pin }), false, 'no folder');
});

test('isValidAgentSdkInstall rejects a recorded file whose size changed or that is gone', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pin = readAgentSdkPin('cursor', { pinsDir, host: LINUX_X64 });
  const grown = writeInstall(tempDir('root'), pin);
  fs.appendFileSync(path.join(grown, 'node_modules', '@cursor', 'sdk-linux-x64', 'package.json'), ' ');
  assert.equal(isValidAgentSdkInstall(grown, { pin }), false);

  const missing = writeInstall(tempDir('root'), pin);
  fs.rmSync(path.join(missing, 'entry-sqlite.mjs'));
  assert.equal(isValidAgentSdkInstall(missing, { pin }), false);

  // A recorded path that is a folder is not a file.
  const folder = writeInstall(tempDir('root'), pin);
  rewriteMarker(folder, (marker) => { marker.files = { ...marker.files, node_modules: 0 }; });
  assert.equal(isValidAgentSdkInstall(folder, { pin }), false);
});

test('isValidAgentSdkInstall rejects a marker for another platform, arch or libc', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pin = readAgentSdkPin('claude', { pinsDir, host: LINUX_X64 });
  for (const change of [{ platform: 'darwin' }, { arch: 'arm64' }, { libc: 'musl' }, { libc: null }]) {
    const dir = writeInstall(tempDir('root'), pin, { marker: change });
    assert.equal(isValidAgentSdkInstall(dir, { pin }), false, JSON.stringify(change));
    assert.equal(isValidAgentSdkInstall(dir, { id: 'claude', host: LINUX_X64 }), false, `${JSON.stringify(change)} without a pin`);
  }
  // A libc recorded as null matches a host whose libc is unknown or absent.
  const winPin = readAgentSdkPin('claude', { pinsDir, host: WIN32_X64 });
  const winDir = writeInstall(tempDir('root'), winPin);
  assert.equal(isValidAgentSdkInstall(winDir, { id: 'claude', host: { ...WIN32_X64, libc: undefined } }), true);
});

test('isValidAgentSdkInstall with a pin checks the version, the hash and the folder name', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pin = readAgentSdkPin('claude', { pinsDir, host: LINUX_X64 });

  const wrongHash = writeInstall(tempDir('root'), pin, { marker: { hash: 'f'.repeat(64) } });
  assert.equal(isValidAgentSdkInstall(wrongHash, { pin }), false);
  // Without a pin only the id, the host and the files count.
  assert.equal(isValidAgentSdkInstall(wrongHash, { id: 'claude', host: LINUX_X64 }), true);

  const wrongVersion = writeInstall(tempDir('root'), pin, { marker: { version: '0.2.9' } });
  assert.equal(isValidAgentSdkInstall(wrongVersion, { pin }), false);

  const renamed = writeInstall(tempDir('root'), pin, { name: '0.2.10-00000000' });
  assert.equal(isValidAgentSdkInstall(renamed, { pin }), false);
});

test('isValidAgentSdkInstall rejects another store format, an empty file list and a broken marker', () => {
  const pinsDir = writePins(tempDir('pins'));
  const pin = readAgentSdkPin('claude', { pinsDir, host: LINUX_X64 });
  const format = writeInstall(tempDir('root'), pin, { marker: { format: AGENT_SDK_STORE_FORMAT + 1 } });
  assert.equal(isValidAgentSdkInstall(format, { pin }), false);
  const empty = writeInstall(tempDir('root'), pin, { marker: { files: {} } });
  assert.equal(isValidAgentSdkInstall(empty, { pin }), false);
  const broken = writeInstall(tempDir('root'), pin);
  fs.writeFileSync(path.join(broken, AGENT_SDK_MARKER), '{"format":1,');
  assert.equal(readAgentSdkMarker(broken), null);
  assert.equal(isValidAgentSdkInstall(broken, { pin }), false);
  const array = writeInstall(tempDir('root'), pin);
  fs.writeFileSync(path.join(array, AGENT_SDK_MARKER), '[]');
  assert.equal(readAgentSdkMarker(array), null);
});

// ─── Finding a ready folder ──────────────────────────────────────────────────

test('findReadyAgentSdkDir returns the pinned folder only when it checks out', () => {
  const pinsDir = writePins(tempDir('pins'));
  const root = tempDir('root');
  const pin = readAgentSdkPin('cursor', { pinsDir, host: LINUX_X64 });
  const options = { root, pinsDir, host: LINUX_X64 };
  assert.equal(findReadyAgentSdkDir('cursor', options), null, 'nothing installed');
  const dir = writeInstall(root, pin);
  assert.equal(findReadyAgentSdkDir('cursor', options), dir);
  fs.rmSync(path.join(dir, 'entry.mjs'));
  assert.equal(findReadyAgentSdkDir('cursor', options), null, 'a damaged pinned folder');
  assert.equal(findReadyAgentSdkDir('nope', options), null);
  // A missing pins folder is no throw.
  assert.equal(findReadyAgentSdkDir('cursor', { ...options, pinsDir: path.join(pinsDir, 'absent') }), null);
});

test('findReadyAgentSdkDir with anyVersion picks the newest valid folder of an earlier pin', () => {
  const pinsDir = writePins(tempDir('pins'));
  const root = tempDir('root');
  const pin = readAgentSdkPin('koffi', { pinsDir, host: WIN32_X64 });
  const options = { root, pinsDir, host: WIN32_X64 };
  const older = writeInstall(root, pin, { name: '2.8.0-aaaaaaaa', installedAt: '2026-01-01T00:00:00.000Z', marker: { version: '2.8.0', hash: 'a'.repeat(64) } });
  const newer = writeInstall(root, pin, { name: '2.8.5-bbbbbbbb', installedAt: '2026-02-01T00:00:00.000Z', marker: { version: '2.8.5', hash: 'b'.repeat(64) } });
  // Newest of all, but damaged; and one made for another platform.
  const damaged = writeInstall(root, pin, { name: '2.9.0-cccccccc', installedAt: '2026-03-01T00:00:00.000Z', marker: { version: '2.9.0', hash: 'c'.repeat(64) } });
  fs.appendFileSync(path.join(damaged, 'entry.cjs'), '// more\n');
  writeInstall(root, pin, { name: '2.9.1-dddddddd', installedAt: '2026-04-01T00:00:00.000Z', marker: { platform: 'linux', libc: 'glibc' } });
  // Not a store folder name at all.
  writeInstall(root, pin, { name: 'scratch', installedAt: '2026-05-01T00:00:00.000Z' });

  assert.equal(findReadyAgentSdkDir('koffi', options), null, 'the pinned folder is missing');
  assert.equal(findReadyAgentSdkDir('koffi', { ...options, anyVersion: true }), newer);
  fs.rmSync(newer, { recursive: true, force: true });
  assert.equal(findReadyAgentSdkDir('koffi', { ...options, anyVersion: true }), older);
  // The pinned folder wins over any other when it checks out.
  const pinned = writeInstall(root, pin, { installedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(findReadyAgentSdkDir('koffi', { ...options, anyVersion: true }), pinned);
});

test('findReadyAgentSdkDir with anyVersion and no SDK folder at all is null', () => {
  const pinsDir = writePins(tempDir('pins'));
  assert.equal(findReadyAgentSdkDir('koffi', { root: tempDir('root'), pinsDir, host: WIN32_X64, anyVersion: true }), null);
});

// ─── Leases, roots, libc ─────────────────────────────────────────────────────

test('writeAgentSdkLease records the pid, the holder and the boot beside the folder', () => {
  const root = tempDir('root');
  const dir = path.join(root, 'claude', '0.2.10-0123abcd');
  fs.mkdirSync(dir, { recursive: true });
  const file = writeAgentSdkLease(dir, { pid: 4321, holder: { start: 'ticks:99' }, bootId: 'boot-a', now: () => new Date('2026-03-01T10:00:00.000Z') });
  assert.equal(path.dirname(file), path.join(root, 'claude', AGENT_SDK_LEASES_DIR, '0.2.10-0123abcd'));
  assert.match(path.basename(file), /^4321-[0-9a-f]{6}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    format: 2, pid: 4321, holder: { start: 'ticks:99' }, bootId: 'boot-a', startedAt: '2026-03-01T10:00:00.000Z',
  });
  // Two leases of one pid are two files.
  const second = writeAgentSdkLease(dir, { pid: 4321 });
  assert.notEqual(second, file);
  assert.equal(JSON.parse(fs.readFileSync(second, 'utf8')).bootId, undefined, 'no boot id, no field');
});

test('writeAgentSdkLease returns null when the lease cannot be written', () => {
  const root = tempDir('root');
  // `.leases` is a file here, so no folder can be made under it.
  fs.mkdirSync(path.join(root, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'claude', AGENT_SDK_LEASES_DIR), 'not a folder');
  assert.equal(writeAgentSdkLease(path.join(root, 'claude', '0.2.10-0123abcd'), { pid: 1 }), null);
});

test('resolveAgentSdkRoot prefers OAR_SDK_DIR, else <state root>/sdks', () => {
  const override = tempDir('override');
  assert.equal(resolveAgentSdkRoot({ env: { OAR_SDK_DIR: `  ${override}  ` }, platform: 'linux' }), path.resolve(override));
  const stateRoot = tempDir('state');
  assert.equal(resolveAgentSdkRoot({ env: { OAR_STATE_ROOT: stateRoot }, platform: 'linux' }), path.join(stateRoot, 'sdks'));
  assert.equal(resolveAgentSdkRoot({ env: { OAR_STATE_ROOT: stateRoot, OAR_SDK_DIR: '   ' }, platform: 'win32' }), path.join(stateRoot, 'sdks'));
  // A relative override is made absolute.
  assert.ok(path.isAbsolute(resolveAgentSdkRoot({ env: { OAR_SDK_DIR: 'relative-sdks' }, platform: 'linux' })));
});

test('detectLibc reads the runtime report on Linux only', () => {
  assert.equal(detectLibc({ platform: 'linux', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) }), 'glibc');
  assert.equal(detectLibc({ platform: 'linux', report: () => ({ header: {} }) }), 'musl');
  assert.equal(detectLibc({ platform: 'linux', report: () => { throw new Error('no report'); } }), null);
  assert.equal(detectLibc({ platform: 'darwin', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) }), null);
  assert.equal(detectLibc({ platform: 'win32' }), null);
});

test('getAgentSdkDescriptor knows the three SDKs and nothing else', () => {
  assert.equal(getAgentSdkDescriptor('claude').packageName, '@anthropic-ai/claude-agent-sdk');
  assert.deepEqual(getAgentSdkDescriptor('CURSOR').entries, { main: 'entry.mjs', sqlite: 'entry-sqlite.mjs' });
  assert.deepEqual(getAgentSdkDescriptor('koffi').platforms, ['win32']);
  assert.equal(getAgentSdkDescriptor('toString'), null, 'no prototype keys');
  assert.equal(getAgentSdkDescriptor(''), null);
  assert.equal(isAgentSdkFolderName('1.4.2-0123abcd'), true);
  assert.equal(isAgentSdkFolderName('1.4.2-0123abcd.partial-abc'), false);
  assert.equal(isAgentSdkFolderName('.trash-abc123'), false);
  assert.equal(isAgentSdkFolderName('1.4.2-0123ABCD'), false);
});

test('a checkout takes an SDK from its node_modules only while the package is there', async () => {
  const { agentSdkFromCheckout } = await import('./agent-sdk-paths.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-checkout-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'node_modules', '@cursor', 'sdk'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '@cursor', 'sdk', 'package.json'), '{}');
    assert.equal(agentSdkFromCheckout('cursor', { env: {}, packageRoot: root }), true);
    assert.equal(agentSdkFromCheckout('claude', { env: {}, packageRoot: root }), false, 'installed without devDependencies: the store');
    assert.equal(agentSdkFromCheckout('cursor', { env: { OAR_AGENT_SDK_SOURCE: 'store' }, packageRoot: root }), false);
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    assert.equal(agentSdkFromCheckout('cursor', { env: {}, packageRoot: root }), false, 'an install, not a checkout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
