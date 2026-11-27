/**
 * better-sqlite3 13 ships its binary for linux (glibc and musl), darwin and
 * win32 on x64 and arm64, and runs no install script. Anywhere else (Android
 * under Termux, 32-bit ARM, FreeBSD) the first database open finds no binary
 * and throws: the binding has to be compiled from the sources the package
 * ships. OAR runs that build itself, after an update (the Update button,
 * `oar update`) and as `oar build-native`, never as an install script of its
 * own package: one would bring back the install-script warning every package
 * scanner shows for OAR, and npm 12 skips it unless the user allows it.
 *
 * The build is node-gyp's, the one npm bundles (else one the user installed
 * globally with `npm install -g --ignore-scripts node-gyp`), in the package's
 * own folder with `--force_build=1`, as the package's `build-release` script
 * runs it. It needs Python 3, make and a C++ compiler. OAR never fetches
 * node-gyp itself (no package-runner fallback): that would download and run
 * whatever version the registry serves at that moment.
 */
import { execFile as defaultExecFile, spawn as defaultSpawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

import { killTree, runToCompletion, tailOf } from './cli-process-runner.mjs';

export const BETTER_SQLITE3_PREBUILD_PLATFORMS = Object.freeze(['linux', 'darwin', 'win32']);
export const BETTER_SQLITE3_PREBUILD_ARCHS = Object.freeze(['x64', 'arm64']);
export const NATIVE_BUILD_COMMAND = 'oar build-native';
// sqlite3.c is one large file: a phone takes minutes for it.
export const NATIVE_BUILD_TIMEOUT_MS = 30 * 60_000;
export const TERMUX_BUILD_TOOLS = 'pkg install python clang make';
// node-gyp and its dependencies need no install script.
export const NODE_GYP_INSTALL_COMMAND = 'npm install -g --ignore-scripts node-gyp';

const BINDING_FILE = path.join('build', 'Release', 'better_sqlite3.node');

/** True where better-sqlite3 has no prebuilt binary and must be compiled. */
export function needsSourceBuild({ platform = process.platform, arch = process.arch } = {}) {
  return !(BETTER_SQLITE3_PREBUILD_PLATFORMS.includes(platform) && BETTER_SQLITE3_PREBUILD_ARCHS.includes(arch));
}

/** The folder of the better-sqlite3 this package loads, or null. */
export function resolveBetterSqlite3Dir({ packageRoot, requireFrom = createRequire } = {}) {
  try {
    const require = requireFrom(path.join(path.resolve(String(packageRoot || '.')), 'package.json'));
    return path.dirname(require.resolve('better-sqlite3/package.json'));
  } catch {
    return null;
  }
}

/** The error better-sqlite3 throws when it finds neither a prebuilt nor a built binary. */
export function isMissingSqliteBindingError(error) {
  const code = String(error?.code || '');
  return (code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED')
    && /better_sqlite3\.node|better-sqlite3[\\/]prebuilds[\\/][^\\/]+\.node/.test(String(error?.message || ''));
}

/**
 * The lines a relay prints, instead of a stack trace, when it cannot open a
 * database because the binding is missing.
 */
export function missingSqliteBindingLines({ platform = process.platform, arch = process.arch, error = null } = {}) {
  const target = `${platform}-${arch}`;
  if (!needsSourceBuild({ platform, arch })) {
    // There, but not loadable on this system. better-sqlite3 loads its
    // prebuilt binding before a built one, so no build here would be used.
    if (String(error?.code || '') === 'ERR_DLOPEN_FAILED') {
      return [
        `The SQLite binding that better-sqlite3 ships for ${target} does not load on this system (${String(error?.message || '').split('\n')[0]}).`,
        'Its C library is too old for it, or the system is not one the binding supports.',
        'Update the operating system, or run the relay on a supported one.',
      ];
    }
    return [
      `The SQLite binding of better-sqlite3 for ${target} is missing from the installed package (${String(error?.message || '').split('\n')[0]}).`,
      'Reinstall OAR: npm install -g @oar-sh/oar',
    ];
  }
  return [
    `better-sqlite3 has no prebuilt SQLite binding for ${target}, and it has not been built here yet.`,
    `Build it with: ${NATIVE_BUILD_COMMAND}`,
    platform === 'android'
      ? `It needs Python 3, make and a C++ compiler: ${TERMUX_BUILD_TOOLS}`
      : 'It needs Python 3, make and a C++ compiler.',
  ];
}

const NODE_GYP_SCRIPT = ['node-gyp', 'bin', 'node-gyp.js'];

// The node-gyp that ships inside npm, beside this Node; else one installed
// globally (NODE_GYP_INSTALL_COMMAND): in the global node_modules of this
// Node's npm, beside this package when it is a global install itself, or in
// `globalRoot` (what `npm root -g` answers, for a prefix set elsewhere).
// null when there is none.
function installedNodeGyp({ execPath, platform, packageRoot, globalRoot, existsImpl, realpathImpl }) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(String(execPath || ''));
  const bundled = [];
  const globalInstalls = [];
  if (platform !== 'win32') {
    // <prefix>/bin/npm is a link to <prefix>/lib/node_modules/npm/bin/npm-cli.js.
    // Only that layout says where npm sits: a wrapper script in its place
    // (a version manager's shim) names no npm folder.
    try {
      const cli = realpathImpl(pathImpl.join(nodeDir, 'npm'));
      const npmRoot = pathImpl.dirname(pathImpl.dirname(cli));
      if (pathImpl.basename(cli) === 'npm-cli.js' && pathImpl.basename(pathImpl.dirname(cli)) === 'bin' && pathImpl.basename(npmRoot) === 'npm') {
        bundled.push(pathImpl.join(npmRoot, 'node_modules', ...NODE_GYP_SCRIPT));
        globalInstalls.push(pathImpl.join(pathImpl.dirname(npmRoot), ...NODE_GYP_SCRIPT));
      }
    } catch {}
    const globalModules = pathImpl.join(nodeDir, '..', 'lib', 'node_modules');
    bundled.push(pathImpl.join(globalModules, 'npm', 'node_modules', ...NODE_GYP_SCRIPT));
    globalInstalls.push(pathImpl.join(globalModules, ...NODE_GYP_SCRIPT));
  } else {
    bundled.push(pathImpl.join(nodeDir, 'node_modules', 'npm', 'node_modules', ...NODE_GYP_SCRIPT));
    globalInstalls.push(pathImpl.join(nodeDir, 'node_modules', ...NODE_GYP_SCRIPT));
  }
  // <global node_modules>/@oar-sh/oar: a global node-gyp sits beside the scope.
  const root = String(packageRoot || '').replace(/[\\/]+$/, '');
  const scopeDir = root ? pathImpl.dirname(root) : '';
  if (scopeDir && pathImpl.basename(scopeDir) === '@oar-sh' && pathImpl.basename(pathImpl.dirname(scopeDir)) === 'node_modules') {
    globalInstalls.push(pathImpl.join(pathImpl.dirname(scopeDir), ...NODE_GYP_SCRIPT));
  }
  const npmRoot = String(globalRoot || '').trim();
  if (npmRoot && pathImpl.isAbsolute(npmRoot)) globalInstalls.push(pathImpl.join(npmRoot, ...NODE_GYP_SCRIPT));
  return [...bundled, ...globalInstalls].find((file) => existsImpl(file)) || null;
}

/**
 * How to run node-gyp: npm's own (npm_config_node_gyp when npm set it, else
 * the one bundled with the npm beside this Node), else a global install of
 * node-gyp. Returns { command, args, env }, or null when there is none: OAR
 * does not download node-gyp (see the top of this file).
 */
export function resolveNodeGypInvocation({
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
  packageRoot = '',
  globalRoot = null,
  existsImpl = fs.existsSync,
  realpathImpl = fs.realpathSync,
} = {}) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(String(execPath || ''));
  const separator = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env || {}).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  // node-gyp runs `node` from the gyp files: this Node first on its PATH.
  const childEnv = { ...env, [pathKey]: [nodeDir, String(env?.[pathKey] || '')].filter(Boolean).join(separator) };
  // Node for Termux has no android_ndk_path in its common.gypi, which gyp
  // then refuses as undefined; an empty one builds with Termux's own clang.
  if (platform === 'android' && !/\bandroid_ndk_path=/.test(String(env?.GYP_DEFINES || ''))) {
    childEnv.GYP_DEFINES = [String(env?.GYP_DEFINES || '').trim(), "android_ndk_path=''"].filter(Boolean).join(' ');
  }
  // Absolute only: a relative one would be checked here against this
  // process's folder but run from better-sqlite3's.
  const fromNpm = String(env?.npm_config_node_gyp || '').trim();
  const gyp = (fromNpm && pathImpl.isAbsolute(fromNpm) && existsImpl(fromNpm) ? fromNpm : null)
    || installedNodeGyp({ execPath, platform, packageRoot, globalRoot, existsImpl, realpathImpl });
  return gyp ? { command: execPath, args: [gyp], env: childEnv } : null;
}

/**
 * What `npm root -g` answers: the global node_modules `npm install -g` uses,
 * which is not beside this Node or this package when npm's prefix is set in
 * ~/.npmrc or by a version manager. It runs no script and fetches nothing.
 * Resolves null when npm is missing or fails.
 */
export function npmGlobalRoot({ env = process.env, platform = process.platform, execFileImpl = defaultExecFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl('npm', ['root', '-g'], { env, timeout: 30_000, windowsHide: true, ...(platform === 'win32' ? { shell: true } : {}) }, (error, stdout) => {
        const root = error ? '' : String(stdout || '').trim().split(/\r?\n/).pop().trim();
        resolve(root && (platform === 'win32' ? path.win32 : path.posix).isAbsolute(root) ? root : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// What a failed build's output says is missing, as one line to act on.
function missingToolHint(output, platform) {
  const text = String(output || '');
  const missing = /find Python|Could not find any Python|python3?: (?:not found|command not found)/i.test(text)
    || /make: (?:not found|command not found)|not found: g?make|spawn g?make ENOENT/i.test(text)
    || /(?:c\+\+|g\+\+|clang\+\+|cc|clang): (?:not found|command not found)|No such file or directory.*(?:c\+\+|g\+\+|clang)/i.test(text);
  if (!missing) return null;
  return `Install ${buildToolsToInstall(platform)}, then run ${NATIVE_BUILD_COMMAND} again.`;
}

// What to install for node-gyp, said the way the platform names it.
function buildToolsToInstall(platform) {
  const name = String(platform || '');
  if (name === 'android') return `the build tools first: ${TERMUX_BUILD_TOOLS}`;
  if (name.includes('bsd') || name === 'aix') return 'Python 3, GNU make (gmake) and a C++ compiler';
  return 'Python 3, make and a C++ compiler (build-essential on Debian and Ubuntu)';
}

// Opens a database in a child Node with the binding just built, named by its
// path: the default loader would take a prebuilt one first where one ships.
function bindingLoads({ dir, execPath, spawnImpl, env }) {
  const binding = path.join(dir, BINDING_FILE);
  const script = `const Database = require(${JSON.stringify(dir)}); new Database(':memory:', { nativeBinding: ${JSON.stringify(binding)} }).close();`;
  return runToCompletion(
    () => spawnImpl(execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true }),
    { timeoutMs: 60_000 },
  );
}

/**
 * Builds the binding when this platform has no prebuilt one. `force` builds
 * where one ships too, to check the toolchain; better-sqlite3 still loads its
 * prebuilt binding first there. Resolves (never rejects) with { ok, status, error?, hint? }:
 * status 'prebuilt' (nothing to do), 'built', 'failed'. Every line of the
 * build goes to `onOutput`; what it says about itself goes to `logger.log`.
 */
export async function buildBetterSqlite3({
  packageRoot,
  force = false,
  platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  env = process.env,
  spawnImpl = defaultSpawn,
  existsImpl = fs.existsSync,
  realpathImpl = fs.realpathSync,
  requireFrom = createRequire,
  npmGlobalRootImpl = npmGlobalRoot,
  timeoutMs = NATIVE_BUILD_TIMEOUT_MS,
  onOutput = null,
  onChild = null,
  logger = console,
} = {}) {
  if (!force && !needsSourceBuild({ platform, arch })) return { ok: true, status: 'prebuilt' };
  const dir = resolveBetterSqlite3Dir({ packageRoot, requireFrom });
  if (!dir) {
    const error = `better-sqlite3 is not installed under ${packageRoot}`;
    logger.error?.(`[oar] ${error}.`);
    return { ok: false, status: 'failed', error };
  }
  // `npm root -g` only when no node-gyp is where this Node's npm keeps one.
  const gyp = resolveNodeGypInvocation({ execPath, platform, env, packageRoot, existsImpl, realpathImpl })
    || resolveNodeGypInvocation({ execPath, platform, env, packageRoot, existsImpl, realpathImpl, globalRoot: await npmGlobalRootImpl({ env, platform }) });
  if (!gyp) {
    const error = 'node-gyp was not found: the npm beside this Node does not bundle it, and no global install of it was found';
    const hint = `Install node-gyp: ${NODE_GYP_INSTALL_COMMAND}, then run ${NATIVE_BUILD_COMMAND} again.`;
    logger.error?.(`[oar] The SQLite binding cannot be built: ${error}.`);
    logger.error?.(`[oar] ${hint}`);
    return { ok: false, status: 'failed', error, hint };
  }
  const args = [...gyp.args, 'rebuild', '--release', '--force_build=1'];
  logger.log?.(`[oar] Building the SQLite binding of better-sqlite3 for ${platform}-${arch} in ${dir}; this takes a few minutes.`);
  const result = await runToCompletion(
    () => spawnImpl(gyp.command, args, {
      cwd: dir,
      env: gyp.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(platform === 'win32' ? { windowsHide: true } : { detached: true }),
    }),
    {
      timeoutMs,
      killChild: (child, signal) => killTree(child, signal, { platform }),
      onChild,
      onOutput,
    },
  );
  if (!result.ok || !existsImpl(path.join(dir, BINDING_FILE))) {
    const error = result.error || `node-gyp exited with code ${result.code}`;
    const hint = missingToolHint(result.output, platform);
    logger.error?.(`[oar] The build of the SQLite binding failed: ${error}.`);
    if (hint) logger.error?.(`[oar] ${hint}`);
    else logger.error?.(`[oar] The end of its output:\n${tailOf(result.output, 2_000)}`);
    return { ok: false, status: 'failed', error, ...(hint ? { hint } : {}) };
  }
  const check = await bindingLoads({ dir, execPath, spawnImpl, env: gyp.env });
  if (!check.ok) {
    const error = `the built binding does not load: ${tailOf(check.output || check.error || '', 500).trim()}`;
    logger.error?.(`[oar] ${error}`);
    return { ok: false, status: 'failed', error };
  }
  logger.log?.('[oar] The SQLite binding is built.');
  return { ok: true, status: 'built' };
}

// ─── Self-update on a platform without a prebuilt binding ────────────────────
//
// `npm install -g` replaces the installed package, the SQLite binding this
// relay runs on included, before the new version's binding is built. A build
// that fails then would leave an install the relay cannot start on. So:
// before the install, prepareSelfUpdateBuild checks that the build can run
// (node-gyp and the build tools) and refuses the update otherwise, with the
// install untouched, and keeps a copy of the running binding; after it,
// finishSelfUpdateBuild builds, and when that fails, puts the copy back where
// the new version has the same better-sqlite3, or else installs the running
// version again with its binding. Either way the install is one whole version.

// What node-gyp runs, each found through the variable that names it or on PATH.
// Its make is $MAKE, else GNU make as gmake on the BSDs and AIX (their own
// make cannot run its makefiles), else make (node-gyp lib/build.js).
function buildTools(platform) {
  const gnuMakeAsGmake = platform.includes('bsd') || platform === 'aix';
  return [
    { name: 'Python 3', envKeys: ['npm_config_python', 'PYTHON'], commands: ['python3', 'python'] },
    { name: gnuMakeAsGmake ? 'GNU make (gmake)' : 'make', envKeys: ['MAKE'], commands: [gnuMakeAsGmake ? 'gmake' : 'make'] },
    { name: 'a C++ compiler', envKeys: ['CXX'], commands: ['c++', 'g++', 'clang++'] },
  ];
}

function findOnPath(command, { env, platform, existsImpl }) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const name = String(command || '').trim().split(/\s+/)[0];
  if (!name) return null;
  if (pathImpl.isAbsolute(name)) return existsImpl(name) ? name : null;
  if (name.includes('/') || name.includes('\\')) return null;
  const dirs = String(env?.PATH ?? env?.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = pathImpl.join(dir, `${name}${ext}`);
      if (existsImpl(file)) return file;
    }
  }
  return null;
}

/**
 * The build tools node-gyp needs that are not there, by name ([] when all
 * are). On Windows it builds with Visual Studio, which node-gyp finds itself:
 * only Python is checked there.
 */
export function missingBuildTools({ env = process.env, platform = process.platform, existsImpl = fs.existsSync } = {}) {
  const all = buildTools(String(platform || ''));
  const tools = platform === 'win32' ? all.slice(0, 1) : all;
  return tools.filter((tool) => {
    const named = tool.envKeys.map((key) => String(env?.[key] || '').trim()).find(Boolean);
    return !(named ? findOnPath(named, { env, platform, existsImpl }) : tool.commands.some((command) => findOnPath(command, { env, platform, existsImpl })));
  }).map((tool) => tool.name);
}

/**
 * Whether the binding of the version a self-update installs could be built
 * here. Resolves { ok: true, needed } (needed false where a binding ships),
 * or { ok: false, needed: true, error, hint }. Runs nothing but `npm root -g`.
 */
export async function nativeBuildPreflight({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  execPath = process.execPath,
  env = process.env,
  existsImpl = fs.existsSync,
  realpathImpl = fs.realpathSync,
  npmGlobalRootImpl = npmGlobalRoot,
} = {}) {
  if (!needsSourceBuild({ platform, arch })) return { ok: true, needed: false };
  const gyp = resolveNodeGypInvocation({ execPath, platform, env, packageRoot, existsImpl, realpathImpl })
    || resolveNodeGypInvocation({ execPath, platform, env, packageRoot, existsImpl, realpathImpl, globalRoot: await npmGlobalRootImpl({ env, platform }) });
  if (!gyp) {
    return {
      ok: false,
      needed: true,
      error: 'node-gyp was not found: the npm beside this Node does not bundle it, and no global install of it was found',
      hint: `Install node-gyp: ${NODE_GYP_INSTALL_COMMAND}, then update again.`,
    };
  }
  const missing = missingBuildTools({ env, platform, existsImpl });
  if (missing.length) {
    return {
      ok: false,
      needed: true,
      error: `${missing.join(', ')} not found`,
      hint: `Install ${buildToolsToInstall(platform)}, then update again.`,
    };
  }
  return { ok: true, needed: true };
}

function betterSqlite3Version(dir, fsImpl) {
  try {
    return String(JSON.parse(fsImpl.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '') || null;
  } catch {
    return null;
  }
}

/**
 * Copies the built binding this install runs on out of the package, with the
 * better-sqlite3 version it belongs to: { version, file, holder }; null when
 * there is none to copy; { error } when there is one but the copy failed.
 */
export function saveSqliteBinding({ packageRoot, requireFrom = createRequire, fsImpl = fs, tmpDir = os.tmpdir() } = {}) {
  const dir = resolveBetterSqlite3Dir({ packageRoot, requireFrom });
  const version = dir ? betterSqlite3Version(dir, fsImpl) : null;
  if (!version || !fsImpl.existsSync(path.join(dir, BINDING_FILE))) return null;
  let holder = null;
  try {
    holder = fsImpl.mkdtempSync(path.join(tmpDir, 'oar-sqlite-binding-'));
    const file = path.join(holder, 'better_sqlite3.node');
    fsImpl.copyFileSync(path.join(dir, BINDING_FILE), file);
    return { version, file, holder };
  } catch (error) {
    if (holder) discardSavedSqliteBinding({ holder }, { fsImpl });
    const message = String(error?.message || error);
    return { error: message.includes(tmpDir) ? message : `${message} (in ${tmpDir})` };
  }
}

export function discardSavedSqliteBinding(saved, { fsImpl = fs } = {}) {
  if (!saved?.holder) return;
  try { fsImpl.rmSync(saved.holder, { recursive: true, force: true }); } catch {}
}

// One line of why a binding did not load, for the error the UI shows: the
// error code when node names one (ERR_DLOPEN_FAILED), else the line that
// says Error, else the first line.
function loadFailureLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const code = String(text || '').match(/\b(ERR_[A-Z0-9_]+)\b/);
  if (code) return code[1];
  const line = lines.find((entry) => /\bError\b/.test(entry)) || lines[0] || 'no output';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Puts a saved binding into the installed better-sqlite3 when it is the same
 * version, and checks that it loads. Resolves { ok: true, version } or
 * { ok: false, reason }; a copy that does not load is removed again.
 */
export async function restoreSqliteBinding({
  saved,
  packageRoot,
  execPath = process.execPath,
  env = process.env,
  spawnImpl = defaultSpawn,
  requireFrom = createRequire,
  fsImpl = fs,
} = {}) {
  if (!saved) return { ok: false, reason: 'no binding was saved' };
  const dir = resolveBetterSqlite3Dir({ packageRoot, requireFrom });
  if (!dir) return { ok: false, reason: `better-sqlite3 is not installed under ${packageRoot}` };
  const version = betterSqlite3Version(dir, fsImpl);
  if (version !== saved.version) return { ok: false, reason: `it comes with better-sqlite3 ${version || '(unknown)'}, not ${saved.version}` };
  const binding = path.join(dir, BINDING_FILE);
  try {
    fsImpl.mkdirSync(path.dirname(binding), { recursive: true });
    fsImpl.copyFileSync(saved.file, binding);
  } catch (error) {
    return { ok: false, reason: `the saved binding could not be copied (${error?.message || error})` };
  }
  const check = await bindingLoads({ dir, execPath, spawnImpl, env });
  if (!check.ok) {
    try { fsImpl.rmSync(binding, { force: true }); } catch {}
    return { ok: false, reason: `the saved binding does not load (${loadFailureLine(check.output || check.error)})` };
  }
  return { ok: true, version };
}

/**
 * Before a self-update's install: { ok: true, saved } (saved is null where a
 * binding ships), or { ok: false, error, reason, hint } to refuse the update
 * (reason: the error framed for the message that the update was not done).
 */
export async function prepareSelfUpdateBuild({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  preflightImpl = nativeBuildPreflight,
  saveImpl = saveSqliteBinding,
  ...options
} = {}) {
  const preflight = await preflightImpl({ packageRoot, platform, arch, ...options });
  if (!preflight.ok) return { ok: false, error: preflight.error, reason: `its SQLite binding could not be built here (${preflight.error})`, hint: preflight.hint };
  if (!preflight.needed) return { ok: true, saved: null };
  // A binding that is there but cannot be copied aside could not be put back
  // after a failed build: refuse rather than update without that way back.
  const saved = saveImpl({ packageRoot });
  if (saved?.error) {
    return {
      ok: false,
      error: saved.error,
      reason: `the SQLite binding this relay runs on could not be copied aside (${saved.error})`,
      hint: `Make room in the temporary folder (or point ${platform === 'win32' ? 'TEMP and TMP' : 'TMPDIR'} at one with room), then update again.`,
    };
  }
  return { ok: true, saved };
}

/**
 * After a self-update's install, where no binding ships: builds it, else
 * keeps the install whole (see above). `build` runs buildBetterSqlite3 and
 * `reinstallRunning` the install of the running version, each resolving
 * { ok, error? }. Resolves { ok, status, build?, rollbackError?, installed? }:
 * status 'built', 'kept' (the saved binding, same better-sqlite3: the new
 * version runs), 'rolled-back' (the running version is installed again,
 * whole) or 'failed', where installed says which version is now installed
 * without a binding: 'new', or 'running' when it was installed again but its
 * binding could not be put back. Discards the saved copy.
 */
export async function finishSelfUpdateBuild({
  saved,
  packageRoot,
  runningVersion,
  build,
  reinstallRunning,
  restoreImpl = restoreSqliteBinding,
  discardImpl = discardSavedSqliteBinding,
  execPath = process.execPath,
  env = process.env,
  spawnImpl = defaultSpawn,
  logger = console,
} = {}) {
  try {
    const built = await build();
    if (built.ok) return { ok: true, status: 'built' };
    if (!saved) return { ok: false, status: 'failed', installed: 'new', build: built };
    const restore = () => restoreImpl({ saved, packageRoot, execPath, env, spawnImpl });
    const kept = await restore();
    if (kept.ok) {
      logger.log?.(`[oar] The new version comes with the same better-sqlite3 (${kept.version}): it keeps the SQLite binding this relay runs on.`);
      return { ok: true, status: 'kept', build: built };
    }
    logger.log?.(`[oar] The binding this relay runs on does not fit the new version (${kept.reason}). Installing ${runningVersion} again ...`);
    const back = await reinstallRunning();
    if (!back.ok) return { ok: false, status: 'failed', installed: 'new', build: built, rollbackError: back.error || 'npm failed' };
    const again = await restore();
    if (!again.ok) return { ok: false, status: 'failed', installed: 'running', build: built, rollbackError: again.reason };
    logger.log?.(`[oar] ${runningVersion} is installed again, with the SQLite binding it runs on.`);
    return { ok: false, status: 'rolled-back', build: built };
  } finally {
    discardImpl(saved);
  }
}
