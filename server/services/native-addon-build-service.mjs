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
 * The build is node-gyp's, the one npm bundles (npx's as the fallback), in the
 * package's own folder with `--force_build=1`, as the package's
 * `build-release` script runs it. It needs Python 3, make and a C++ compiler.
 */
import { spawn as defaultSpawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { killTree, runToCompletion, tailOf } from './cli-process-runner.mjs';

export const BETTER_SQLITE3_PREBUILD_PLATFORMS = Object.freeze(['linux', 'darwin', 'win32']);
export const BETTER_SQLITE3_PREBUILD_ARCHS = Object.freeze(['x64', 'arm64']);
export const NATIVE_BUILD_COMMAND = 'oar build-native';
// sqlite3.c is one large file: a phone takes minutes for it.
export const NATIVE_BUILD_TIMEOUT_MS = 30 * 60_000;
export const TERMUX_BUILD_TOOLS = 'pkg install python clang make';

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

// The node-gyp that ships inside npm, beside this Node; null when there is none.
function bundledNodeGyp({ execPath, platform, existsImpl, realpathImpl }) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(String(execPath || ''));
  const npmRoots = [];
  if (platform !== 'win32') {
    // <prefix>/bin/npm is a link to <prefix>/lib/node_modules/npm/bin/npm-cli.js.
    try { npmRoots.push(pathImpl.dirname(pathImpl.dirname(realpathImpl(pathImpl.join(nodeDir, 'npm'))))); } catch {}
    npmRoots.push(pathImpl.join(nodeDir, '..', 'lib', 'node_modules', 'npm'));
  } else {
    npmRoots.push(pathImpl.join(nodeDir, 'node_modules', 'npm'));
  }
  for (const root of npmRoots) {
    const file = pathImpl.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    if (existsImpl(file)) return file;
  }
  return null;
}

/**
 * How to run node-gyp: npm's own (npm_config_node_gyp when npm set it), else
 * `npx --yes node-gyp`. Returns { command, args, env }.
 */
export function resolveNodeGypInvocation({
  execPath = process.execPath,
  platform = process.platform,
  env = process.env,
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
  const fromNpm = String(env?.npm_config_node_gyp || '').trim();
  const gyp = (fromNpm && existsImpl(fromNpm) ? fromNpm : null) || bundledNodeGyp({ execPath, platform, existsImpl, realpathImpl });
  if (gyp) return { command: execPath, args: [gyp], env: childEnv };
  if (platform === 'win32') {
    // npx.cmd runs through a shell, which splits a path with a space in it
    // (C:\Program Files): this Node with npm's npx-cli.js, else npx.cmd by name.
    const npxCli = pathImpl.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (existsImpl(npxCli)) return { command: execPath, args: [npxCli, '--yes', 'node-gyp'], env: childEnv };
    return { command: 'npx.cmd', args: ['--yes', 'node-gyp'], env: childEnv };
  }
  const npx = pathImpl.join(nodeDir, 'npx');
  return { command: existsImpl(npx) ? npx : 'npx', args: ['--yes', 'node-gyp'], env: childEnv };
}

// What a failed build's output says is missing, as one line to act on.
function missingToolHint(output, platform) {
  const text = String(output || '');
  const missing = /find Python|Could not find any Python|python3?: (?:not found|command not found)/i.test(text)
    || /make: (?:not found|command not found)|not found: make|spawn make ENOENT/i.test(text)
    || /(?:c\+\+|g\+\+|clang\+\+|cc|clang): (?:not found|command not found)|No such file or directory.*(?:c\+\+|g\+\+|clang)/i.test(text);
  if (!missing) return null;
  return platform === 'android'
    ? `Install the build tools first: ${TERMUX_BUILD_TOOLS}, then run ${NATIVE_BUILD_COMMAND} again.`
    : `Install Python 3, make and a C++ compiler (build-essential on Debian and Ubuntu), then run ${NATIVE_BUILD_COMMAND} again.`;
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
  const gyp = resolveNodeGypInvocation({ execPath, platform, env, existsImpl, realpathImpl });
  const args = [...gyp.args, 'rebuild', '--release', '--force_build=1'];
  logger.log?.(`[oar] Building the SQLite binding of better-sqlite3 for ${platform}-${arch} in ${dir}; this takes a few minutes.`);
  const result = await runToCompletion(
    () => spawnImpl(gyp.command, args, {
      cwd: dir,
      env: gyp.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(platform === 'win32' ? { windowsHide: true, shell: /\.cmd$/i.test(gyp.command) } : { detached: true }),
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
