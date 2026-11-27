import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  NATIVE_BUILD_COMMAND,
  buildBetterSqlite3,
  isMissingSqliteBindingError,
  missingSqliteBindingLines,
  needsSourceBuild,
  npmGlobalRoot,
  resolveNodeGypInvocation,
} from './native-addon-build-service.mjs';

test('a source build is needed only where better-sqlite3 13 ships no binary', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const arch of ['x64', 'arm64']) assert.equal(needsSourceBuild({ platform, arch }), false, `${platform}-${arch}`);
  }
  for (const [platform, arch] of [['android', 'arm64'], ['linux', 'arm'], ['freebsd', 'x64'], ['linux', 'ia32'], ['win32', 'ia32']]) {
    assert.equal(needsSourceBuild({ platform, arch }), true, `${platform}-${arch}`);
  }
});

test('the missing binding is told apart from other load errors', () => {
  const missing = Object.assign(new Error("Cannot find module '/pkg/node_modules/better-sqlite3/build/Release/better_sqlite3.node'"), { code: 'MODULE_NOT_FOUND' });
  assert.equal(isMissingSqliteBindingError(missing), true);
  assert.equal(isMissingSqliteBindingError(Object.assign(new Error("Cannot find module 'express'"), { code: 'MODULE_NOT_FOUND' })), false);
  assert.equal(isMissingSqliteBindingError(Object.assign(new Error('SQLITE_CANTOPEN'), { code: 'SQLITE_CANTOPEN' })), false);
  assert.equal(isMissingSqliteBindingError(null), false);
  // A prebuilt binding that is there but does not load (an older C library).
  const dlopen = Object.assign(new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /pkg/node_modules/better-sqlite3/prebuilds/linux-x64.node)"), { code: 'ERR_DLOPEN_FAILED' });
  assert.equal(isMissingSqliteBindingError(dlopen), true);
});

test('a shipped binding that does not load points at the system, not at a build', () => {
  // better-sqlite3 loads its prebuilt binding before a built one, so a build
  // here would never be used: no build advice.
  const error = Object.assign(new Error('version GLIBC_2.38 not found (required by prebuilds/linux-x64.node)\nmore'), { code: 'ERR_DLOPEN_FAILED' });
  const lines = missingSqliteBindingLines({ platform: 'linux', arch: 'x64', error });
  assert.match(lines[0], /binding that better-sqlite3 ships for linux-x64 does not load on this system \(version GLIBC_2\.38/);
  assert.match(lines[1], /C library is too old/);
  assert.equal(lines[2], 'Update the operating system, or run the relay on a supported one.');
  assert.doesNotMatch(lines.join('\n'), /build-native|--force|Reinstall/);
});

test('the start-up lines name the command, and the Termux tools on Android', () => {
  const termux = missingSqliteBindingLines({ platform: 'android', arch: 'arm64' });
  assert.match(termux[0], /no prebuilt SQLite binding for android-arm64/);
  assert.equal(termux[1], `Build it with: ${NATIVE_BUILD_COMMAND}`);
  assert.match(termux[2], /pkg install python clang make/);
  assert.doesNotMatch(missingSqliteBindingLines({ platform: 'freebsd', arch: 'x64' }).join('\n'), /pkg install/);
  // Where a binary ships, a missing one means a broken install.
  const broken = missingSqliteBindingLines({ platform: 'linux', arch: 'x64', error: new Error('Cannot find module x\nRequire stack: y') });
  assert.match(broken[0], /missing from the installed package \(Cannot find module x\)/);
  assert.equal(broken[1], 'Reinstall OAR: npm install -g @oar-sh/oar');
});

test('node-gyp is npm\'s own, beside this Node; else a global install; never npx; this Node first on the PATH', () => {
  const gyp = '/opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js';
  const found = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node',
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    realpathImpl: () => '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
    existsImpl: (file) => file === gyp,
  });
  assert.equal(found.command, '/opt/node/bin/node');
  assert.deepEqual(found.args, [gyp]);
  assert.equal(found.env.PATH, '/opt/node/bin:/usr/bin');
  assert.equal(found.env.GYP_DEFINES, undefined);

  const viaNpm = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node', platform: 'linux', env: { npm_config_node_gyp: '/x/node-gyp.js' },
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === '/x/node-gyp.js',
  });
  assert.deepEqual(viaNpm.args, ['/x/node-gyp.js']);
  // A relative npm_config_node_gyp is not used: it would run from another folder.
  const relative = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node', platform: 'linux', env: { npm_config_node_gyp: 'x/node-gyp.js' },
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === 'x/node-gyp.js',
  });
  assert.equal(relative, null);

  // A wrapper script in npm's place names no npm folder: nothing is derived
  // from it (no /usr/node_modules/node-gyp from /usr/bin/npm-wrapper).
  const probed = [];
  const wrapped = resolveNodeGypInvocation({
    execPath: '/usr/bin/node', platform: 'linux', env: {},
    realpathImpl: () => '/usr/share/shims/bin/npm-wrapper',
    existsImpl: (file) => { probed.push(file); return file.startsWith('/usr/share/shims/'); },
  });
  assert.equal(wrapped, null);
  assert.ok(probed.every((file) => !file.startsWith('/usr/share/shims/')), probed.join(', '));

  // npx is there, node-gyp is not: no download of an unpinned node-gyp.
  const none = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node', platform: 'linux', env: {},
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === '/opt/node/bin/npx',
  });
  assert.equal(none, null);

  // `npm install -g node-gyp` with this Node's npm.
  const globalGyp = '/opt/node/lib/node_modules/node-gyp/bin/node-gyp.js';
  const globalInstall = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node', platform: 'linux', env: {},
    realpathImpl: () => '/opt/node/lib/node_modules/npm/bin/npm-cli.js', existsImpl: (file) => file === globalGyp,
  });
  assert.equal(globalInstall.command, '/opt/node/bin/node');
  assert.deepEqual(globalInstall.args, [globalGyp]);
  // npm's own wins over a global one.
  const both = resolveNodeGypInvocation({
    execPath: '/opt/node/bin/node', platform: 'linux', env: {},
    realpathImpl: () => '/opt/node/lib/node_modules/npm/bin/npm-cli.js', existsImpl: (file) => file === globalGyp || file === gyp,
  });
  assert.deepEqual(both.args, [gyp]);
  // OAR installed with --prefix: node-gyp installed globally sits beside @oar-sh.
  const prefixGyp = '/home/dev/.oar/npm/lib/node_modules/node-gyp/bin/node-gyp.js';
  const besidePackage = resolveNodeGypInvocation({
    execPath: '/usr/bin/node', platform: 'linux', env: {}, packageRoot: '/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar',
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === prefixGyp,
  });
  assert.deepEqual(besidePackage.args, [prefixGyp]);
  // npm's prefix set elsewhere (~/.npmrc, a version manager): what `npm root -g` answers.
  const rootGyp = '/home/dev/.npm-global/lib/node_modules/node-gyp/bin/node-gyp.js';
  const fromNpmRoot = resolveNodeGypInvocation({
    execPath: '/usr/bin/node', platform: 'linux', env: {}, globalRoot: '/home/dev/.npm-global/lib/node_modules',
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === rootGyp,
  });
  assert.deepEqual(fromNpmRoot.args, [rootGyp]);
  assert.equal(resolveNodeGypInvocation({
    execPath: '/usr/bin/node', platform: 'linux', env: {}, globalRoot: 'relative/node_modules',
    realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => file === 'relative/node_modules/node-gyp/bin/node-gyp.js',
  }), null, 'a relative npm root is not used');

  const win = resolveNodeGypInvocation({
    execPath: path.win32.join('C:\\Program Files', 'nodejs', 'node.exe'), platform: 'win32', env: { Path: 'C:\\Windows' },
    existsImpl: (file) => file === path.win32.join('C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  });
  assert.deepEqual(win.args, [path.win32.join('C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')]);
  assert.equal(win.env.Path, `${path.win32.join('C:\\Program Files', 'nodejs')};C:\\Windows`);

  // Without npm's node-gyp on Windows: a global one beside OAR (%APPDATA%\npm),
  // and never npx-cli.js or npx.cmd.
  const winNode = path.win32.join('C:\\Program Files', 'nodejs', 'node.exe');
  const npxCli = path.win32.join('C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  assert.equal(resolveNodeGypInvocation({ execPath: winNode, platform: 'win32', env: {}, existsImpl: (file) => file === npxCli }), null);
  assert.equal(resolveNodeGypInvocation({ execPath: winNode, platform: 'win32', env: {}, existsImpl: () => false }), null);
  const appData = path.win32.join('C:\\Users', 'dev', 'AppData', 'Roaming', 'npm', 'node_modules');
  const winGlobal = resolveNodeGypInvocation({
    execPath: winNode, platform: 'win32', env: {}, packageRoot: path.win32.join(appData, '@oar-sh', 'oar'),
    existsImpl: (file) => file === path.win32.join(appData, 'node-gyp', 'bin', 'node-gyp.js'),
  });
  assert.equal(winGlobal.command, winNode);
  assert.deepEqual(winGlobal.args, [path.win32.join(appData, 'node-gyp', 'bin', 'node-gyp.js')]);
});

test('on Android gyp gets an empty android_ndk_path, unless one is set already', () => {
  const base = { execPath: '/data/data/com.termux/files/usr/bin/node', platform: 'android', realpathImpl: () => { throw new Error('ENOENT'); }, existsImpl: (file) => /node-gyp\.js$/.test(file) };
  assert.equal(resolveNodeGypInvocation({ ...base, env: {} }).env.GYP_DEFINES, "android_ndk_path=''");
  assert.equal(resolveNodeGypInvocation({ ...base, env: { GYP_DEFINES: 'foo=1' } }).env.GYP_DEFINES, "foo=1 android_ndk_path=''");
  assert.equal(resolveNodeGypInvocation({ ...base, env: { GYP_DEFINES: 'android_ndk_path=/ndk' } }).env.GYP_DEFINES, 'android_ndk_path=/ndk');
});

// A spawn that answers each call with the next scripted child: output, then
// an exit code. Calls are recorded.
function scriptedSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const { output = '', code = 0, onRun = null } = script.shift() || {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    setImmediate(() => {
      onRun?.();
      if (output) child.stdout.emit('data', Buffer.from(output));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

function buildOptions(overrides = {}) {
  const built = new Set();
  const logs = [];
  return {
    built,
    logs,
    options: {
      packageRoot: '/srv/oar/pkg',
      platform: 'android',
      arch: 'arm64',
      execPath: '/data/data/com.termux/files/usr/bin/node',
      env: {},
      requireFrom: () => ({ resolve: () => '/srv/oar/pkg/node_modules/better-sqlite3/package.json' }),
      realpathImpl: () => '/data/data/com.termux/files/usr/lib/node_modules/npm/bin/npm-cli.js',
      existsImpl: (file) => /node-gyp\.js$/.test(file) || (/better_sqlite3\.node$/.test(file) && built.has('binding')),
      logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
      npmGlobalRootImpl: async () => null,
      ...overrides,
    },
  };
}

test('where a binary ships nothing is built or spawned', async () => {
  const { spawnImpl, calls } = scriptedSpawn([]);
  const { options } = buildOptions({ platform: 'linux', arch: 'x64', spawnImpl });
  assert.deepEqual(await buildBetterSqlite3(options), { ok: true, status: 'prebuilt' });
  assert.equal(calls.length, 0);
});

test('on Termux: node-gyp rebuild with force_build in the package folder, then the binding is opened', async () => {
  const fixture = buildOptions();
  const { spawnImpl, calls } = scriptedSpawn([
    { output: 'gyp info ok\n', onRun: () => fixture.built.add('binding') },
    { code: 0 },
  ]);
  const streamed = [];
  const result = await buildBetterSqlite3({ ...fixture.options, spawnImpl, onOutput: (text) => streamed.push(text) });
  assert.deepEqual(result, { ok: true, status: 'built' });
  assert.equal(calls[0].command, '/data/data/com.termux/files/usr/bin/node');
  assert.deepEqual(calls[0].args, ['/data/data/com.termux/files/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js', 'rebuild', '--release', '--force_build=1']);
  assert.equal(calls[0].options.cwd, '/srv/oar/pkg/node_modules/better-sqlite3');
  assert.equal(calls[0].options.env.GYP_DEFINES, "android_ndk_path=''");
  assert.deepEqual(streamed, ['gyp info ok\n']);
  // The check opens a database with the binding just built, by its path.
  assert.equal(calls[1].args[0], '-e');
  assert.match(calls[1].args[1], /new Database\(':memory:', \{ nativeBinding: ".*better_sqlite3\.node" \}\)\.close\(\)/);
  assert.match(calls[1].args[1], /build[\\/]+Release[\\/]+better_sqlite3\.node/);
  assert.match(fixture.logs.at(-1), /binding is built/);
});

test('a build without make says to install the Termux build tools', async () => {
  const fixture = buildOptions();
  const { spawnImpl, calls } = scriptedSpawn([{ output: 'gyp ERR! stack Error: not found: make\n', code: 1 }]);
  const result = await buildBetterSqlite3({ ...fixture.options, spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /exited with code 1/);
  assert.equal(result.hint, 'Install the build tools first: pkg install python clang make, then run oar build-native again.');
  assert.equal(calls.length, 1, 'no load check after a failed build');
  assert.ok(fixture.logs.includes(`[oar] ${result.hint}`));
});

test('a build without GNU make on FreeBSD names gmake, not build-essential', async () => {
  const fixture = buildOptions({ platform: 'freebsd', arch: 'x64', realpathImpl: () => '/usr/local/lib/node_modules/npm/bin/npm-cli.js' });
  const { spawnImpl } = scriptedSpawn([{ output: 'gyp ERR! stack Error: not found: gmake\n', code: 1 }]);
  const result = await buildBetterSqlite3({ ...fixture.options, spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.hint, 'Install Python 3, GNU make (gmake) and a C++ compiler, then run oar build-native again.');
  const linux = buildOptions({ platform: 'linux', arch: 'arm', realpathImpl: () => '/usr/lib/node_modules/npm/bin/npm-cli.js' });
  const { spawnImpl: linuxSpawn } = scriptedSpawn([{ output: 'gyp ERR! stack Error: not found: make\n', code: 1 }]);
  const onLinux = await buildBetterSqlite3({ ...linux.options, spawnImpl: linuxSpawn });
  assert.equal(onLinux.hint, 'Install Python 3, make and a C++ compiler (build-essential on Debian and Ubuntu), then run oar build-native again.');
});

test('without node-gyp the build fails at once with how to install it, and fetches nothing', async () => {
  const fixture = buildOptions({ existsImpl: () => false, realpathImpl: () => { throw new Error('ENOENT'); } });
  const { spawnImpl, calls } = scriptedSpawn([]);
  const result = await buildBetterSqlite3({ ...fixture.options, spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /node-gyp was not found/);
  assert.equal(result.hint, 'Install node-gyp: npm install -g --ignore-scripts node-gyp, then run oar build-native again.');
  assert.equal(calls.length, 0, 'nothing spawned: no npx, no download');
  assert.ok(fixture.logs.includes(`[oar] ${result.hint}`));
});

test('a node-gyp installed under the prefix `npm root -g` names is built with', async () => {
  const rootGyp = '/home/dev/.npm-global/lib/node_modules/node-gyp/bin/node-gyp.js';
  let asked = 0;
  const fixture = buildOptions({
    realpathImpl: () => { throw new Error('ENOENT'); },
    npmGlobalRootImpl: async () => { asked += 1; return '/home/dev/.npm-global/lib/node_modules'; },
  });
  fixture.options.existsImpl = (file) => file === rootGyp || (/better_sqlite3\.node$/.test(file) && fixture.built.has('binding'));
  const { spawnImpl, calls } = scriptedSpawn([{ onRun: () => fixture.built.add('binding') }, {}]);
  const result = await buildBetterSqlite3({ ...fixture.options, spawnImpl });
  assert.equal(result.status, 'built');
  assert.equal(asked, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), [rootGyp, 'rebuild']);

  // npm's own node-gyp is found first: npm is not asked.
  asked = 0;
  const own = buildOptions({ npmGlobalRootImpl: async () => { asked += 1; return null; } });
  const second = scriptedSpawn([{ onRun: () => own.built.add('binding') }, {}]);
  assert.equal((await buildBetterSqlite3({ ...own.options, spawnImpl: second.spawnImpl })).status, 'built');
  assert.equal(asked, 0);
});

test('npm root -g: the last line when absolute, else null; npm runs no script', async () => {
  let seen = null;
  const answer = (error, stdout) => (command, args, options, callback) => { seen = { command, args, options }; callback(error, stdout); };
  assert.equal(await npmGlobalRoot({ platform: 'linux', env: {}, execFileImpl: answer(null, '/opt/npm-global/lib/node_modules\n') }), '/opt/npm-global/lib/node_modules');
  assert.deepEqual([seen.command, seen.args, seen.options.shell], ['npm', ['root', '-g'], undefined]);
  assert.equal(await npmGlobalRoot({ platform: 'win32', env: {}, execFileImpl: answer(null, 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\r\n') }), 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules');
  assert.equal(seen.options.shell, true, 'npm is npm.cmd on Windows');
  assert.equal(await npmGlobalRoot({ platform: 'linux', env: {}, execFileImpl: answer(new Error('ENOENT'), '') }), null);
  assert.equal(await npmGlobalRoot({ platform: 'linux', env: {}, execFileImpl: answer(null, 'npm warn something\nnode_modules\n') }), null);
  assert.equal(await npmGlobalRoot({ platform: 'linux', env: {}, execFileImpl: () => { throw new Error('spawn EPERM'); } }), null);
});

test('a build that leaves no binding, or one that does not load, fails', async () => {
  const quiet = buildOptions();
  const noFile = scriptedSpawn([{ code: 0 }]);
  const missing = await buildBetterSqlite3({ ...quiet.options, spawnImpl: noFile.spawnImpl });
  assert.equal(missing.ok, false);
  assert.equal(missing.hint, undefined);

  const fixture = buildOptions();
  const { spawnImpl } = scriptedSpawn([
    { onRun: () => fixture.built.add('binding') },
    { output: 'Error: dlopen failed', code: 1 },
  ]);
  const unloadable = await buildBetterSqlite3({ ...fixture.options, spawnImpl });
  assert.equal(unloadable.ok, false);
  assert.match(unloadable.error, /does not load: Error: dlopen failed/);
});

test('force builds where a binary ships too; a package without better-sqlite3 fails at once', async () => {
  const fixture = buildOptions({ platform: 'linux', arch: 'x64', force: true });
  const { spawnImpl, calls } = scriptedSpawn([{ onRun: () => fixture.built.add('binding') }, {}]);
  assert.equal((await buildBetterSqlite3({ ...fixture.options, spawnImpl })).status, 'built');
  assert.equal(calls.length, 2);

  const none = buildOptions({ requireFrom: () => ({ resolve: () => { throw new Error('MODULE_NOT_FOUND'); } }) });
  const result = await buildBetterSqlite3({ ...none.options, spawnImpl: scriptedSpawn([]).spawnImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed/);
});
