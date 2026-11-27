// A self-update where better-sqlite3 ships no binding (Termux, 32-bit ARM,
// FreeBSD): the checks before the install, and what keeps the install whole
// when the new version's binding does not build (native-addon-build-service.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discardSavedSqliteBinding,
  finishSelfUpdateBuild,
  missingBuildTools,
  nativeBuildPreflight,
  prepareSelfUpdateBuild,
  restoreSqliteBinding,
  saveSqliteBinding,
} from './native-addon-build-service.mjs';

const GYP = '/data/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js';
const TOOLS = ['/data/usr/bin/python3', '/data/usr/bin/make', '/data/usr/bin/clang++'];

function termux(present = [GYP, ...TOOLS]) {
  const files = new Set(present);
  return {
    platform: 'android',
    arch: 'arm64',
    execPath: '/data/usr/bin/node',
    env: { PATH: '/data/usr/bin' },
    existsImpl: (file) => files.has(String(file).replace(/\\/g, '/')),
    realpathImpl: () => { throw new Error('no link'); },
    npmGlobalRootImpl: async () => null,
  };
}

// ─── Build tools and preflight ───────────────────────────────────────────────

test('build tools: found on PATH, or through the variable that names one', () => {
  const host = termux();
  assert.deepEqual(missingBuildTools(host), []);
  assert.deepEqual(missingBuildTools({ ...host, existsImpl: () => false }), ['Python 3', 'make', 'a C++ compiler']);
  // The make node-gyp runs: $MAKE, else gmake on the BSDs and AIX (their own
  // make cannot run its makefiles), else make. Any of g++, c++, clang++.
  const bsd = new Set(['/usr/local/bin/python3', '/usr/local/bin/gmake', '/usr/bin/c++', '/usr/bin/make']);
  const freebsd = { platform: 'freebsd', env: { PATH: '/usr/bin:/usr/local/bin' }, existsImpl: (f) => bsd.has(f) };
  assert.deepEqual(missingBuildTools(freebsd), []);
  const bsdMakeOnly = new Set(['/usr/local/bin/python3', '/usr/bin/c++', '/usr/bin/make']);
  assert.deepEqual(missingBuildTools({ ...freebsd, existsImpl: (f) => bsdMakeOnly.has(f) }), ['GNU make (gmake)'], 'BSD make is not enough');
  assert.deepEqual(missingBuildTools({ ...freebsd, platform: 'openbsd', existsImpl: (f) => bsdMakeOnly.has(f) }), ['GNU make (gmake)']);
  assert.deepEqual(missingBuildTools({ ...freebsd, platform: 'aix', existsImpl: (f) => bsdMakeOnly.has(f) }), ['GNU make (gmake)']);
  assert.deepEqual(missingBuildTools({ ...freebsd, env: { ...freebsd.env, MAKE: '/usr/bin/make' }, existsImpl: (f) => bsdMakeOnly.has(f) }), [], 'MAKE is what node-gyp runs');
  assert.deepEqual(missingBuildTools({ ...freebsd, env: { ...freebsd.env, MAKE: '/opt/gnu/bin/make' } }), ['GNU make (gmake)'], 'a MAKE that is not there');
  // Elsewhere gmake alone is not what node-gyp runs.
  assert.deepEqual(missingBuildTools({ ...host, platform: 'linux', existsImpl: (f) => [GYP, TOOLS[0], TOOLS[2], '/data/usr/bin/gmake'].includes(f) }), ['make']);
  // CXX names the compiler (its first word); a missing one counts as missing
  // even when another compiler is on PATH, as node-gyp would use CXX.
  assert.deepEqual(missingBuildTools({ ...host, env: { ...host.env, CXX: '/opt/cc/bin/clang++ -std=c++20' } }), ['a C++ compiler']);
  assert.deepEqual(missingBuildTools({ ...host, env: { ...host.env, CXX: 'clang++' } }), []);
  // Windows (ia32 has no prebuilt binding): Visual Studio is node-gyp's own
  // business; only Python is looked for, with its .exe.
  const win = new Set(['C:\\Python312\\python.exe']);
  assert.deepEqual(missingBuildTools({ platform: 'win32', env: { Path: 'C:\\Windows;C:\\Python312' }, existsImpl: (f) => win.has(f) }), []);
  assert.deepEqual(missingBuildTools({ platform: 'win32', env: { Path: 'C:\\Windows' }, existsImpl: () => false }), ['Python 3']);
});

test('preflight: nothing to check where a binding ships', async () => {
  assert.deepEqual(await nativeBuildPreflight({ ...termux([]), platform: 'linux', arch: 'x64' }), { ok: true, needed: false });
});

test('preflight: no node-gyp refuses the update with how to install it, before npm runs', async () => {
  const roots = [];
  const result = await nativeBuildPreflight({ ...termux(TOOLS), npmGlobalRootImpl: async () => { roots.push(1); return '/data/elsewhere'; } });
  assert.equal(result.ok, false);
  assert.equal(result.needed, true);
  assert.match(result.error, /^node-gyp was not found/);
  assert.equal(result.hint, 'Install node-gyp: npm install -g --ignore-scripts node-gyp, then update again.');
  assert.equal(roots.length, 1, 'asks npm root -g once');
});

test('preflight: missing build tools refuse the update, with the Termux packages on Android', async () => {
  const result = await nativeBuildPreflight(termux([GYP, TOOLS[0]]));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'make, a C++ compiler not found');
  assert.equal(result.hint, 'Install the build tools first: pkg install python clang make, then update again.');
  const bsd = await nativeBuildPreflight({ ...termux([GYP]), platform: 'freebsd', arch: 'x64' });
  assert.equal(bsd.hint, 'Install Python 3, GNU make (gmake) and a C++ compiler, then update again.');
  const arm = await nativeBuildPreflight({ ...termux([GYP]), platform: 'linux', arch: 'arm' });
  assert.match(arm.hint, /^Install Python 3, make and a C\+\+ compiler \(build-essential/);
});

test('preflight: node-gyp and the tools there: the update may go on', async () => {
  assert.deepEqual(await nativeBuildPreflight(termux()), { ok: true, needed: true });
});

test('prepare: a refusal carries error and hint; otherwise the running binding is saved where it is needed', async () => {
  const saves = [];
  const saveImpl = (options) => { saves.push(options.packageRoot); return { version: '13.0.0', file: '/tmp/x', holder: '/tmp' }; };
  const refused = await prepareSelfUpdateBuild({ packageRoot: '/pkg', preflightImpl: async () => ({ ok: false, needed: true, error: 'e', hint: 'h' }), saveImpl });
  assert.deepEqual(refused, { ok: false, error: 'e', reason: 'its SQLite binding could not be built here (e)', hint: 'h' });
  assert.deepEqual(saves, []);
  const ready = await prepareSelfUpdateBuild({ packageRoot: '/pkg', preflightImpl: async () => ({ ok: true, needed: true }), saveImpl });
  assert.equal(ready.ok, true);
  assert.equal(ready.saved.version, '13.0.0');
  assert.deepEqual(saves, ['/pkg']);
  const shipped = await prepareSelfUpdateBuild({ packageRoot: '/pkg', preflightImpl: async () => ({ ok: true, needed: false }), saveImpl });
  assert.deepEqual(shipped, { ok: true, saved: null });
  assert.equal(saves.length, 1);
  // A binding that is there but cannot be copied aside: no way back after a
  // failed build, so the update is refused.
  const unsaved = await prepareSelfUpdateBuild({ packageRoot: '/pkg', platform: 'android', preflightImpl: async () => ({ ok: true, needed: true }), saveImpl: () => ({ error: 'ENOSPC: no space left on device (in /tmp)' }) });
  assert.equal(unsaved.ok, false);
  assert.equal(unsaved.reason, 'the SQLite binding this relay runs on could not be copied aside (ENOSPC: no space left on device (in /tmp))');
  assert.equal(unsaved.hint, 'Make room in the temporary folder (or point TMPDIR at one with room), then update again.');
  // Windows names its temporary folder by TEMP and TMP.
  const unsavedWin = await prepareSelfUpdateBuild({ packageRoot: 'C:\\pkg', platform: 'win32', arch: 'ia32', preflightImpl: async () => ({ ok: true, needed: true }), saveImpl: () => ({ error: 'EPERM' }) });
  assert.match(unsavedWin.hint, /point TEMP and TMP at one with room/);
  // A preflight refusal is framed as a build that cannot run here.
  const refusedReason = await prepareSelfUpdateBuild({ packageRoot: '/pkg', preflightImpl: async () => ({ ok: false, needed: true, error: 'make not found', hint: 'h' }) });
  assert.equal(refusedReason.reason, 'its SQLite binding could not be built here (make not found)');
  // Nothing to copy (no built binding yet) is no reason to refuse.
  assert.deepEqual(await prepareSelfUpdateBuild({ packageRoot: '/pkg', preflightImpl: async () => ({ ok: true, needed: true }), saveImpl: () => null }), { ok: true, saved: null });
});

// ─── Save and restore, on real folders ───────────────────────────────────────

function fakeInstall(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-selfupdate-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'lib', 'node_modules', '@oar-sh', 'oar');
  const sqliteDir = path.join(packageRoot, 'node_modules', 'better-sqlite3');
  const binding = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
  // What `npm install -g` does to the folder: the package replaced whole.
  const install = ({ oar, sqlite, built = false }) => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.mkdirSync(sqliteDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@oar-sh/oar', version: oar, dependencies: { 'better-sqlite3': sqlite } }));
    fs.writeFileSync(path.join(sqliteDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: sqlite, main: 'index.js' }));
    fs.writeFileSync(path.join(sqliteDir, 'index.js'), 'module.exports = {};\n');
    if (built) {
      fs.mkdirSync(path.dirname(binding), { recursive: true });
      fs.writeFileSync(binding, `binding of better-sqlite3 ${sqlite}`);
    }
  };
  return { root, tmp: root, packageRoot, sqliteDir, binding, install };
}

// The child that opens a database with the binding: exits with `code`.
function loadCheck(code = 0, seen = []) {
  return (command, args) => {
    seen.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (code) child.stderr.emit('data', Buffer.from('invalid ELF header'));
      child.emit('close', code);
    });
    return child;
  };
}

test('save: a copy of the running binding outside the package, with its better-sqlite3 version', (t) => {
  const box = fakeInstall(t);
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const saved = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp });
  assert.equal(saved.version, '13.0.0');
  assert.ok(!saved.file.startsWith(box.packageRoot), 'kept outside the package npm replaces');
  assert.equal(fs.readFileSync(saved.file, 'utf8'), 'binding of better-sqlite3 13.0.0');
  discardSavedSqliteBinding(saved);
  assert.equal(fs.existsSync(saved.holder), false);
  // No built binding (or no better-sqlite3): nothing to save.
  box.install({ oar: '0.9.1', sqlite: '13.0.0' });
  assert.equal(saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp }), null);
  assert.equal(saveSqliteBinding({ packageRoot: path.join(box.root, 'nothing'), tmpDir: box.tmp }), null);
  // There, but the copy fails (here: no such temporary folder): an error, not null.
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const failed = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: path.join(box.root, 'no-such-tmp') });
  assert.match(failed.error, /no-such-tmp/);
  assert.equal(failed.error.split(path.join(box.root, 'no-such-tmp')).length - 1, 1, 'the folder is named once');
  assert.equal(failed.file, undefined);
});

test('restore: only into the same better-sqlite3 version, and only a binding that loads', async (t) => {
  const box = fakeInstall(t);
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const saved = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp });
  t.after(() => discardSavedSqliteBinding(saved));

  box.install({ oar: '0.9.2', sqlite: '13.0.0' });
  const seen = [];
  const kept = await restoreSqliteBinding({ saved, packageRoot: box.packageRoot, execPath: '/usr/bin/node', spawnImpl: loadCheck(0, seen) });
  assert.deepEqual(kept, { ok: true, version: '13.0.0' });
  assert.equal(fs.readFileSync(box.binding, 'utf8'), 'binding of better-sqlite3 13.0.0');
  assert.equal(seen.length, 1);
  assert.match(seen[0].join(' '), /nativeBinding/, 'opened by its path, as after a build');

  box.install({ oar: '0.9.3', sqlite: '13.1.0' });
  const other = await restoreSqliteBinding({ saved, packageRoot: box.packageRoot, spawnImpl: loadCheck(0) });
  assert.equal(other.ok, false);
  assert.match(other.reason, /better-sqlite3 13\.1\.0, not 13\.0\.0/);
  assert.equal(fs.existsSync(box.binding), false, 'nothing copied into another version');

  box.install({ oar: '0.9.2', sqlite: '13.0.0' });
  const broken = await restoreSqliteBinding({ saved, packageRoot: box.packageRoot, spawnImpl: loadCheck(1) });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'the saved binding does not load (invalid ELF header)');
  assert.equal(fs.existsSync(box.binding), false, 'a copy that does not load is removed again');

  assert.deepEqual(await restoreSqliteBinding({ saved: null, packageRoot: box.packageRoot }), { ok: false, reason: 'no binding was saved' });
});

test('restore: why a copy does not load is one line for the UI, the error code when node names one', async (t) => {
  const box = fakeInstall(t);
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const saved = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp });
  t.after(() => discardSavedSqliteBinding(saved));
  const failing = (stderr) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', 1); });
    return child;
  };
  const stack = [
    'node:internal/modules/cjs/loader:1921',
    '  return process.dlopen(module, path.toNamespacedPath(filename));',
    '                 ^',
    '',
    'Error: /pkg/node_modules/better-sqlite3/build/Release/better_sqlite3.node: invalid ELF header',
    '    at Module._extensions..node (node:internal/modules/cjs/loader:1921:18)',
    '    at Module.load (node:internal/modules/cjs/loader:1465:32) {',
    '  code: \'ERR_DLOPEN_FAILED\'',
    '}',
  ].join('\n');
  box.install({ oar: '0.9.2', sqlite: '13.0.0' });
  const coded = await restoreSqliteBinding({ saved, packageRoot: box.packageRoot, spawnImpl: failing(stack) });
  assert.equal(coded.reason, 'the saved binding does not load (ERR_DLOPEN_FAILED)');
  const uncoded = await restoreSqliteBinding({ saved, packageRoot: box.packageRoot, spawnImpl: failing(stack.replace(/ERR_DLOPEN_FAILED/, 'X')) });
  assert.equal(uncoded.reason, 'the saved binding does not load (Error: /pkg/node_modules/better-sqlite3/build/Release/better_sqlite3.node: invalid ELF header)');
});

// ─── After the install: build, keep, or roll back ────────────────────────────

const quiet = { log: () => {}, error: () => {} };

test('finish: a build that works is all; the saved copy is discarded', async () => {
  const discarded = [];
  const result = await finishSelfUpdateBuild({
    saved: { holder: 'h' },
    build: async () => ({ ok: true, status: 'built' }),
    reinstallRunning: async () => assert.fail('no reinstall'),
    restoreImpl: async () => assert.fail('no restore'),
    discardImpl: (saved) => discarded.push(saved),
    logger: quiet,
  });
  assert.deepEqual(result, { ok: true, status: 'built' });
  assert.deepEqual(discarded, [{ holder: 'h' }]);
});

test('fallback: a failed build on the same better-sqlite3 keeps the running binding, and the new version stays', async (t) => {
  const box = fakeInstall(t);
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const saved = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp });
  box.install({ oar: '0.9.2', sqlite: '13.0.0' });
  const lines = [];
  const result = await finishSelfUpdateBuild({
    saved,
    packageRoot: box.packageRoot,
    runningVersion: '0.9.1',
    spawnImpl: loadCheck(0),
    build: async () => ({ ok: false, status: 'failed', error: 'node-gyp exited with code 1' }),
    reinstallRunning: async () => assert.fail('no reinstall: the new version is whole'),
    logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'kept');
  assert.equal(result.build.error, 'node-gyp exited with code 1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.packageRoot, 'package.json'), 'utf8')).version, '0.9.2');
  assert.equal(fs.readFileSync(box.binding, 'utf8'), 'binding of better-sqlite3 13.0.0');
  assert.match(lines.join('\n'), /same better-sqlite3 \(13\.0\.0\): it keeps the SQLite binding this relay runs on/);
  assert.equal(fs.existsSync(saved.holder), false, 'the copy is discarded');
});

test('fallback: a failed build on a new better-sqlite3 installs the running version again, whole', async (t) => {
  const box = fakeInstall(t);
  box.install({ oar: '0.9.1', sqlite: '13.0.0', built: true });
  const saved = saveSqliteBinding({ packageRoot: box.packageRoot, tmpDir: box.tmp });
  box.install({ oar: '0.9.2', sqlite: '13.1.0' });
  const reinstalls = [];
  const result = await finishSelfUpdateBuild({
    saved,
    packageRoot: box.packageRoot,
    runningVersion: '0.9.1',
    spawnImpl: loadCheck(0),
    build: async () => ({ ok: false, status: 'failed', error: 'make: not found', hint: 'Install the build tools first: pkg install python clang make, then run oar build-native again.' }),
    // npm puts 0.9.1 back, without a binding: the install ran no script.
    reinstallRunning: async () => { reinstalls.push('0.9.1'); box.install({ oar: '0.9.1', sqlite: '13.0.0' }); return { ok: true }; },
    logger: quiet,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rolled-back');
  assert.match(result.build.hint, /pkg install/);
  assert.deepEqual(reinstalls, ['0.9.1']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.packageRoot, 'package.json'), 'utf8')).version, '0.9.1');
  assert.equal(fs.readFileSync(box.binding, 'utf8'), 'binding of better-sqlite3 13.0.0', 'the running version has its binding again');
  assert.equal(fs.existsSync(saved.holder), false);
});

test('fallback: a reinstall that fails, or nothing saved, is reported as failed', async () => {
  const noReinstall = await finishSelfUpdateBuild({
    saved: { version: '13.0.0', file: '/x', holder: null },
    runningVersion: '0.9.1',
    build: async () => ({ ok: false, error: 'boom' }),
    restoreImpl: async () => ({ ok: false, reason: 'it comes with better-sqlite3 13.1.0, not 13.0.0' }),
    reinstallRunning: async () => ({ ok: false, error: 'npm exited with code 1' }),
    discardImpl: () => {},
    logger: quiet,
  });
  assert.deepEqual(noReinstall, { ok: false, status: 'failed', installed: 'new', build: { ok: false, error: 'boom' }, rollbackError: 'npm exited with code 1' });

  let restores = 0;
  const notRestored = await finishSelfUpdateBuild({
    saved: { version: '13.0.0', file: '/x', holder: null },
    runningVersion: '0.9.1',
    build: async () => ({ ok: false, error: 'boom' }),
    restoreImpl: async () => { restores += 1; return { ok: false, reason: restores === 1 ? 'other version' : 'the saved binding does not load: x' }; },
    reinstallRunning: async () => ({ ok: true }),
    discardImpl: () => {},
    logger: quiet,
  });
  assert.equal(notRestored.status, 'failed');
  assert.equal(notRestored.installed, 'running', 'the running version is the one installed now, without its binding');
  assert.equal(notRestored.rollbackError, 'the saved binding does not load: x');

  const nothingSaved = await finishSelfUpdateBuild({
    saved: null,
    build: async () => ({ ok: false, error: 'boom' }),
    reinstallRunning: async () => assert.fail('no reinstall without a binding to put back'),
    logger: quiet,
  });
  assert.deepEqual(nothingSaved, { ok: false, status: 'failed', installed: 'new', build: { ok: false, error: 'boom' } });
});
