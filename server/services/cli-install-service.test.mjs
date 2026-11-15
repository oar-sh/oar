import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COPILOT_SDK_NOT_FOUND, resolveCopilotSdkLaunchPath } from '../copilot-sdk-runtime.mjs';
import { CLI_LONG_PROBE_TIMEOUT_MS, CLI_SPAWN_DISABLED_ERROR } from './cli-process-runner.mjs';
import {
  CLI_INSTALL_TIMEOUT_MS,
  CLI_PROVIDER_IDS,
  createCliInstallService,
  parseClaudeDoctor,
  writeCliBinariesToConfigFile,
} from './cli-install-service.mjs';

// Fictional host layout (DEVELOPING.md test-data rules): the platform and the
// path module are injected into the service, so both halves run everywhere.
const HOME = '/home/dev';
const GROK_VERSION_BANNER = 'grok 1.0.13 (5e9a58528b76) [stable]\n';
const CLAUDE_VERSION_BANNER = '2.1.247 (Claude Code)\n';
const GROK_UPDATE_CHECK = '{"currentVersion":"1.0.13","latestVersion":"1.0.13","updateAvailable":false,'
  + '"installer":"internal","channel":"stable","autoUpdate":null,"error":null}\n';
// Verbatim from a host whose npm global folder the relay user cannot write.
const DOCTOR_NPM_NOT_WRITABLE = [
  'Running: npm-global (2.1.247)',
  'Path: /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  'Auto-updates: enabled',
  'Last update attempt: failed (no_permissions) — 2026-08-26',
  '1 warning found',
  "- Can't auto-update: npm global folder isn't writable",
  '  Fix: Run claude install to switch to the native installer (no sudo)',
  '',
].join('\n');
const DOCTOR_HEALTHY = [
  'Running: native (2.1.247)',
  `Path: ${HOME}/.local/bin/claude`,
  'Auto-updates: enabled',
  '',
].join('\n');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Fake child process: the events the runner listens for, plus kill recorders. */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.killSignals = [];
  child.kill = (signal) => { child.killSignals.push(signal); return true; };
  child.emitStdout = (text) => child.stdout.emit('data', Buffer.from(text));
  child.emitStderr = (text) => child.stderr.emit('data', Buffer.from(text));
  child.exit = (code) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  return child;
}

/**
 * In-memory filesystem for the resolve walk. Mutable so a test can make the
 * installed binary appear exactly when the fake installer says it did.
 */
function createFakeFs() {
  const files = new Map();
  const dirs = new Set();
  const links = new Map();
  return {
    addFile(filePath, { executable = true, realPath = '' } = {}) {
      files.set(filePath, { executable });
      if (realPath) links.set(filePath, realPath);
    },
    removeFile(filePath) {
      files.delete(filePath);
      links.delete(filePath);
    },
    addDir(dirPath) { dirs.add(dirPath); },
    statSync(target) {
      if (files.has(target)) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(target)) return { isFile: () => false, isDirectory: () => true };
      throw new Error(`ENOENT: ${target}`);
    },
    accessSync(target) {
      const entry = files.get(target);
      if (!entry) throw new Error(`ENOENT: ${target}`);
      if (!entry.executable) throw new Error(`EACCES: ${target}`);
    },
    realpathSync(target) {
      return links.get(target) || target;
    },
  };
}

/** Manual timer seam: probe/install/escalation timeouts fire on demand. */
function createManualTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl(fn, ms) {
      const id = (nextId += 1);
      pending.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) {
      if (handle && pending.has(handle.id)) pending.delete(handle.id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    fire(ms) {
      let fired = 0;
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
        fired += 1;
      }
      return fired;
    },
  };
}

/** Default answers for the read-only probes, keyed by the subcommand. */
function defaultReply(call) {
  const args = call.args.join(' ');
  if (args === '--version') {
    if (call.command.endsWith('grok')) return { out: GROK_VERSION_BANNER, code: 0 };
    if (call.command.endsWith('claude')) return { out: CLAUDE_VERSION_BANNER, code: 0 };
    return { out: 'GitHub Copilot CLI 1.0.82.\n', code: 0 };
  }
  if (args === 'update --check --json') return { out: GROK_UPDATE_CHECK, code: 0 };
  if (args === 'doctor') return { out: DOCTOR_NPM_NOT_WRITABLE, code: 0 };
  // Install/update spawns are driven by the test instead.
  return null;
}

function createHarness({
  platform = 'linux',
  pathImpl = path.posix,
  env = {},
  stored = {},
  ...serviceOptions
} = {}) {
  const timers = createManualTimers();
  const fsImpl = createFakeFs();
  const calls = [];
  const kills = [];
  const persisted = [];
  const control = { reply: defaultReply };
  let nextPid = 6000;

  const serviceEnv = { PATH: '/usr/bin', ...env };

  const spawnImpl = (command, args, options) => {
    const child = createFakeChild((nextPid += 1));
    const call = { command, args, options, child };
    calls.push(call);
    // Answering asynchronously mirrors a real child: the runner attaches its
    // listeners after spawn() returns.
    queueMicrotask(() => {
      const reply = control.reply(call);
      if (!reply) return;
      if (reply.out) call.child.emitStdout(reply.out);
      call.child.exit(reply.code);
    });
    return child;
  };

  const service = createCliInstallService({
    env: serviceEnv,
    platform,
    pathImpl,
    fsImpl,
    homedirImpl: () => HOME,
    spawnImpl,
    processKillImpl: (pid, signal) => { kills.push([pid, signal]); },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: { log() {} },
    readBoundBinaries: () => stored,
    writeBoundBinaries: (binaries) => { persisted.push(binaries); },
    ...serviceOptions,
  });

  const states = [];
  service.subscribe((snapshot) => states.push(snapshot));

  return {
    service,
    env: serviceEnv,
    fsImpl,
    timers,
    calls,
    kills,
    persisted,
    states,
    control,
    stateNames: () => states.map((entry) => entry.state),
    callsFor: (subcommand) => calls.filter((call) => call.args.join(' ') === subcommand),
    lastChild: () => calls[calls.length - 1]?.child || null,
    cleanup() { service.dispose(); },
  };
}

// ─── Descriptor table ────────────────────────────────────────────────────────

test('the descriptor table holds exactly grok, claude and copilot', () => {
  // Cursor is deliberately absent: the relay never invokes a Cursor binary.
  assert.deepEqual([...CLI_PROVIDER_IDS].sort(), ['claude', 'copilot', 'grok']);
});

test('an unknown provider id is rejected before anything can spawn', async () => {
  const harness = createHarness();
  try {
    assert.equal(harness.service.getDescriptor('cursor'), null);
    assert.equal(harness.service.getDescriptor(''), null);
    assert.equal(harness.service.getDescriptor('constructor'), null, 'no prototype smuggling');
    assert.equal(harness.service.getDescriptor('__proto__'), null);
    assert.equal(harness.service.resolveCliBinary('cursor'), null);
    assert.equal(await harness.service.probeCliStatus('cursor'), null);

    for (const bogus of ['cursor', '', null, 'grok; rm -rf /', '../../bin/sh']) {
      const refused = harness.service.runInstall(bogus, { action: 'install' });
      assert.equal(refused.ok, false, `${bogus} must be refused`);
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.error, 'Unknown CLI provider');
    }
    assert.deepEqual(harness.calls, [], 'no child process was ever created');
  } finally {
    harness.cleanup();
  }
});

test('an unknown action is rejected, and a known provider is case-insensitive', () => {
  const harness = createHarness();
  try {
    const bogusAction = harness.service.runInstall('GROK', { action: 'uninstall' });
    assert.equal(bogusAction.statusCode, 400);
    assert.equal(bogusAction.error, 'Unknown install action');
    assert.equal(harness.service.getDescriptor('GROK')?.id, 'grok');
    assert.deepEqual(harness.calls, []);
  } finally {
    harness.cleanup();
  }
});

// ─── Copilot ─────────────────────────────────────────────────────────────────

const COPILOT_SCRIPT_URL = 'https://raw.githubusercontent.com/github/copilot-cli/main/install.sh';
const COPILOT_NPM_LOADER = '/usr/lib/node_modules/@github/copilot/npm-loader.js';

/** The launch lookup's answer once a version folder with the SDK exists: its SDK folder. */
function sdkFound(version = '1.0.112') {
  return () => `${HOME}/.cache/copilot/pkg/linux-x64/${version}/copilot-sdk`;
}

/** The lookup's own refusal while no version folder has the SDK. */
function sdkMissing() {
  return () => {
    const error = new Error(`Copilot SDK not found. Looked in: ${HOME}/.cache/copilot/pkg`);
    error.code = COPILOT_SDK_NOT_FOUND;
    throw error;
  };
}

/** Lets an installer's close, the first run and the re-probe settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await flush();
}

/**
 * Starts a Copilot install whose installer leaves `copilot` in ~/.local/bin,
 * and holds the first run (`copilot --version`) for the test to answer.
 */
async function installCopilotUpToFirstRun(harness, action = 'install') {
  harness.fsImpl.addDir(`${HOME}/.local/bin`);
  harness.control.reply = (call) => (call.args.join(' ') === '--version' ? null : defaultReply(call));
  const installer = startInstall(harness, 'copilot', action);
  if (action === 'install') harness.fsImpl.addFile(`${HOME}/.local/bin/copilot`);
  installer.exit(0);
  await settle();
  const firstRun = harness.callsFor('--version')[0];
  assert.ok(firstRun, 'the first run was started');
  harness.control.reply = defaultReply;
  return { installer, firstRun };
}

test('on Linux copilot installs with the vendor script from its raw URL, detached, with stdin closed', async () => {
  const harness = createHarness();
  try {
    const status = await harness.service.probeCliStatus('copilot');
    assert.equal(status.installed, false);
    assert.equal(status.canInstall, true);
    assert.equal(status.blockedReason, null);
    assert.equal(status.commands.install.display, `curl -fsSL ${COPILOT_SCRIPT_URL} | bash`);
    assert.equal(status.commands.install.targetDir, '~/.local/bin');
    assert.match(status.commands.install.detail, /checksum/);
    assert.match(status.hint, /run copilot once in a terminal .* log in/);

    startInstall(harness, 'copilot');
    const call = harness.calls.at(-1);
    assert.equal(call.command, 'bash');
    assert.equal(call.args[0], '-lc');
    const script = call.args[1];
    assert.ok(script.includes(`curl -fsSL ${COPILOT_SCRIPT_URL} -o "$stage/install.sh"`));
    assert.ok(!script.includes('gh.io'), 'never the short link');
    assert.ok(script.includes('bash "$stage/install.sh" </dev/null'), 'the script gets no stdin');
    assert.ok(script.includes('mv -f "$stage/bin/copilot" "$HOME/.local/bin/copilot"'));
    assert.ok(!/\.profile|\.bashrc/.test(script), 'no shell profile is edited');
    // Detached: a session of its own, so no controlling terminal for the
    // script's /dev/tty question.
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(harness.service.getInstallState().command, `curl -fsSL ${COPILOT_SCRIPT_URL} | bash`);
  } finally {
    harness.cleanup();
  }
});

test('on macOS copilot installs with the same script, and its update names the macOS cache', async () => {
  const harness = createHarness({ platform: 'darwin' });
  try {
    const before = await harness.service.probeCliStatus('copilot');
    assert.equal(before.commands.install.display, `curl -fsSL ${COPILOT_SCRIPT_URL} | bash`);
    harness.fsImpl.addFile(`${HOME}/.local/bin/copilot`);
    const after = await harness.service.probeCliStatus('copilot', { force: true });
    assert.equal(after.commands.update.display, 'copilot update');
    assert.equal(after.commands.update.targetDir, '~/Library/Caches/copilot');
  } finally {
    harness.cleanup();
  }
});

test('on Windows copilot installs with npm through npm.cmd, never winget', async () => {
  const harness = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD' },
  });
  try {
    const status = await harness.service.probeCliStatus('copilot');
    assert.equal(status.commands.install.display, 'npm install -g @github/copilot');
    assert.equal(status.commands.install.targetDir, '%APPDATA%\\npm');
    assert.match(status.commands.install.detail, /integrity/);

    startInstall(harness, 'copilot');
    const call = harness.calls.at(-1);
    assert.equal(call.command, 'powershell');
    assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    const command = call.args[3];
    // `exit $LASTEXITCODE` is 0 when npm.cmd does not exist, so a missing npm
    // is caught first and named, with a failing exit code.
    assert.ok(command.startsWith('if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { '));
    assert.match(command, /\[Console\]::Error\.WriteLine\('npm was not found on PATH\. [^']*'\); exit 1 \}; /);
    assert.ok(command.endsWith("npm.cmd install -g '@github/copilot'; exit $LASTEXITCODE"));
    assert.ok(command.indexOf('Get-Command npm.cmd') < command.indexOf('npm.cmd install'));
    assert.ok(!call.args.join(' ').includes('winget'));
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  } finally {
    harness.cleanup();
  }
});

test('copilot update is offered for every install method; a copy the relay did not install only says so', async () => {
  const npm = createHarness();
  npm.fsImpl.addFile('/usr/bin/copilot', { realPath: COPILOT_NPM_LOADER });
  try {
    const status = await npm.service.probeCliStatus('copilot');
    assert.equal(status.installed, true);
    assert.equal(status.version, '1.0.82');
    assert.equal(status.installMethod, 'npm-global');
    assert.equal(status.canInstall, false);
    assert.equal(status.commands.install, undefined, 'never an Install over a managed copy');
    assert.equal(status.canUpdate, true, 'copilot update writes to the user cache, not to the npm prefix');
    assert.equal(status.commands.update.display, 'copilot update');
    assert.equal(status.commands.update.targetDir, '~/.cache/copilot');
    assert.match(status.blockedReason, /npm, Homebrew or into a system folder/);
    assert.match(status.blockedReason, /copilot update writes only to your user cache/);
    assert.match(status.hint, /To log in, run copilot once in a terminal/);

    npm.control.reply = () => null;
    startInstall(npm, 'copilot', 'update');
    const call = npm.calls.at(-1);
    assert.equal(call.command, '/usr/bin/copilot');
    assert.deepEqual(call.args, ['update']);
  } finally {
    npm.cleanup();
  }

  const system = createHarness();
  system.fsImpl.addFile('/usr/local/bin/copilot');
  const native = createHarness();
  native.fsImpl.addFile(`${HOME}/.local/bin/copilot`);
  try {
    assert.match((await system.service.probeCliStatus('copilot')).blockedReason, /system folder/);
    const own = await native.service.probeCliStatus('copilot');
    assert.equal(own.installMethod, 'native');
    assert.equal(own.blockedReason, null);
    assert.equal(own.canUpdate, true);
  } finally {
    system.cleanup();
    native.cleanup();
  }

  // npm is the relay's own route on Windows, so it gets no note there.
  const windows = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: 'C:\\Users\\dev\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.CMD' },
  });
  windows.fsImpl.addFile('C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot.cmd', {
    realPath: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\npm-loader.js',
  });
  // The .cmd launcher's args reach cmd.exe quoted, so the default reply does
  // not recognise them.
  windows.control.reply = () => ({ out: 'GitHub Copilot CLI 1.0.112.\n', code: 0 });
  try {
    const status = await windows.service.probeCliStatus('copilot');
    assert.equal(status.installMethod, 'npm-global');
    assert.equal(status.blockedReason, null);
    assert.equal(status.commands.update.targetDir, '%LOCALAPPDATA%\\copilot');
  } finally {
    windows.cleanup();
  }
});

test('the copilot --version probe gets the long timeout; the other CLIs keep theirs', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile(`${HOME}/.local/bin/copilot`);
  harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
  harness.control.reply = () => null;
  try {
    const copilot = harness.service.probeCliStatus('copilot');
    await flush();
    assert.deepEqual(harness.timers.delays(), [CLI_LONG_PROBE_TIMEOUT_MS]);
    assert.equal(harness.timers.fire(5_000), 0, 'a first run past 5 s is not cut off');
    const versionRun = harness.callsFor('--version')[0];
    versionRun.child.emitStdout('GitHub Copilot CLI 1.0.112.\n');
    versionRun.child.exit(0);
    const status = await copilot;
    assert.equal(status.installed, true);
    assert.equal(status.version, '1.0.112');

    const grok = harness.service.probeCliStatus('grok');
    await flush();
    assert.deepEqual(harness.timers.delays(), [5_000]);
    harness.callsFor('--version')[1].child.exit(0);
    await flush();
    harness.callsFor('update --check --json')[0].child.exit(0);
    await grok;
  } finally {
    harness.cleanup();
  }
});

test('a copilot install is done after its first run, under the install timeout, once the SDK is found', async () => {
  const harness = createHarness({ findCopilotSdk: sdkFound() });
  const hookCalls = [];
  try {
    harness.service.onInstallSuccess((detail) => { hookCalls.push(`${detail.providerId} ${detail.action}`); });
    const { firstRun } = await installCopilotUpToFirstRun(harness);
    assert.equal(firstRun.command, `${HOME}/.local/bin/copilot`);
    assert.equal(firstRun.options.detached, true);
    assert.equal(firstRun.options.stdio[0], 'ignore');

    // Still the install: Cancel reaches it and a second install is refused.
    const running = harness.service.getInstallState();
    assert.equal(running.state, 'running');
    assert.equal(running.active, true);
    assert.equal(harness.service.runInstall('grok').statusCode, 409);

    // Under the install timeout: a first run slower than either probe budget
    // (12 s were measured on one host) is not cut off.
    assert.ok(harness.timers.delays().includes(CLI_INSTALL_TIMEOUT_MS));
    assert.equal(harness.timers.fire(5_000), 0);
    assert.equal(harness.timers.fire(CLI_LONG_PROBE_TIMEOUT_MS), 0);
    assert.equal(harness.service.getInstallState().state, 'running');

    firstRun.child.emitStdout('GitHub Copilot CLI 1.0.112.\n');
    firstRun.child.exit(0);
    await settle();

    const done = harness.service.getInstallState();
    assert.equal(done.state, 'success');
    assert.equal(done.active, false);
    assert.match(done.log, /\$ copilot --version\nGitHub Copilot CLI 1\.0\.112\./);
    assert.match(done.log, /Copilot SDK found: \/home\/dev\/\.cache\/copilot\/pkg\/linux-x64\/1\.0\.112\/copilot-sdk\n/);
    assert.deepEqual(harness.persisted.at(-1), { copilot: `${HOME}/.local/bin/copilot` });
    assert.equal(harness.env.PATH.split(':')[0], `${HOME}/.local/bin`);
    assert.deepEqual(hookCalls, ['copilot install']);
  } finally {
    harness.cleanup();
  }
});

test('a copilot update gets the same first run before it counts as done', async () => {
  const harness = createHarness({ findCopilotSdk: sdkFound('1.0.113') });
  harness.fsImpl.addFile('/usr/bin/copilot', { realPath: COPILOT_NPM_LOADER });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(harness, 'update');
    assert.deepEqual(harness.calls[0].args, ['update']);
    assert.equal(harness.service.getInstallState().state, 'running');
    firstRun.child.exit(0);
    await settle();
    assert.equal(harness.service.getInstallState().state, 'success');
  } finally {
    harness.cleanup();
  }
});

test('a copilot install whose first run leaves no SDK folder fails with what the lookup saw', async () => {
  const harness = createHarness({ findCopilotSdk: sdkMissing() });
  const hookCalls = [];
  try {
    harness.service.onInstallSuccess(() => { hookCalls.push('hook'); });
    const { firstRun } = await installCopilotUpToFirstRun(harness);
    firstRun.child.exit(0);
    await settle();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.equal(state.active, false);
    assert.match(state.error, /copilot --version ran, but a Copilot launch would not find its SDK: Copilot SDK not found\. Looked in: /);
    assert.deepEqual(harness.persisted, [], 'nothing is bound');
    assert.deepEqual(hookCalls, []);
  } finally {
    harness.cleanup();
  }
});

test('a copilot install whose first run fails, or outlasts the install timeout, fails', async () => {
  const failing = createHarness({ findCopilotSdk: sdkFound() });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(failing);
    firstRun.child.emitStdout('Error: this build needs a newer glibc\n');
    firstRun.child.exit(1);
    await settle();
    const state = failing.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /first run \(copilot --version\) failed: Error: this build needs a newer glibc/);
    assert.deepEqual(failing.persisted, []);
  } finally {
    failing.cleanup();
  }

  const hanging = createHarness({ findCopilotSdk: sdkFound() });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(hanging);
    assert.equal(hanging.timers.fire(CLI_INSTALL_TIMEOUT_MS), 1);
    await settle();
    const state = hanging.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /first run \(copilot --version\) failed: timed out after 600000ms/);
    assert.ok(hanging.kills.some(([pid, signal]) => pid === -firstRun.child.pid && signal === 'SIGTERM'));
  } finally {
    hanging.cleanup();
  }
});

test('cancel during the copilot first run stops it and binds nothing', async () => {
  const harness = createHarness({ findCopilotSdk: sdkFound() });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(harness);
    harness.service.cancel();
    assert.deepEqual(harness.kills[0], [-firstRun.child.pid, 'SIGTERM']);
    firstRun.child.exit(null);
    await settle();
    assert.equal(harness.service.getInstallState().state, 'cancelled');
    assert.deepEqual(harness.persisted, []);
  } finally {
    harness.cleanup();
  }
});

test('a launch after a copilot install finds the SDK without a relay restart', async (t) => {
  // The real lookup (no findCopilotSdk injected) over a cache folder of the
  // test's own, and the one a worker launch calls, before and after.
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-copilot-cache-'));
  t.after(() => fs.rmSync(cacheHome, { recursive: true, force: true }));
  const harness = createHarness({ env: { PATH: '/usr/bin', COPILOT_PKG_CACHE_HOME: cacheHome } });
  const launchLookup = () => resolveCopilotSdkLaunchPath({ env: harness.env, platform: 'linux', homeDir: HOME });
  const versionDir = path.join(cacheHome, 'pkg', `linux-${process.arch}`, '1.0.112');
  try {
    assert.throws(launchLookup, (error) => error.code === COPILOT_SDK_NOT_FOUND);

    const { firstRun } = await installCopilotUpToFirstRun(harness);
    // What the CLI's first run does: unpack its package into the cache.
    fs.mkdirSync(path.join(versionDir, 'copilot-sdk'), { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'copilot-sdk', 'index.js'), '');
    fs.writeFileSync(path.join(versionDir, 'app.js'), '');
    firstRun.child.exit(0);
    await settle();

    assert.equal(harness.service.getInstallState().state, 'success');
    assert.equal(launchLookup(), path.join(versionDir, 'copilot-sdk'));
  } finally {
    harness.cleanup();
  }
});

test('with a pinned SDK version that is not in the cache, the done-check fails with the launch\'s own message', async (t) => {
  // The runtime hands in the launch's lookup with its configuration; here
  // the same function with a pinned sdkVersion. The first run unpacks
  // another version, which the launch would refuse.
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-copilot-pinned-'));
  t.after(() => fs.rmSync(cacheHome, { recursive: true, force: true }));
  const versionDir = path.join(cacheHome, 'pkg', `linux-${process.arch}`, '1.0.112');
  fs.mkdirSync(path.join(versionDir, 'copilot-sdk'), { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'copilot-sdk', 'index.js'), '');
  fs.writeFileSync(path.join(versionDir, 'app.js'), '');
  const env = { PATH: '/usr/bin', COPILOT_PKG_CACHE_HOME: cacheHome };
  const launchLookupWith = (config) => () => resolveCopilotSdkLaunchPath({ config, env, platform: 'linux', homeDir: HOME });

  const pinned = createHarness({ env, findCopilotSdk: launchLookupWith({ sdkVersion: '1.0.200' }) });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(pinned);
    firstRun.child.exit(0);
    await settle();
    const state = pinned.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /but a Copilot launch would not find its SDK: Copilot SDK version 1\.0\.200 not found\./);
    assert.deepEqual(pinned.persisted, [], 'nothing is bound');
  } finally {
    pinned.cleanup();
  }

  const unpinned = createHarness({ env, findCopilotSdk: launchLookupWith({}) });
  try {
    const { firstRun } = await installCopilotUpToFirstRun(unpinned);
    firstRun.child.exit(0);
    await settle();
    assert.equal(unpinned.service.getInstallState().state, 'success');
    assert.ok(unpinned.service.getInstallState().log.includes(`Copilot SDK found: ${path.join(versionDir, 'copilot-sdk')}\n`));
  } finally {
    unpinned.cleanup();
  }
});

/** A Windows host whose npm global folder is not the default one. */
const NODE_DIR = 'C:\\Program Files\\nodejs';
const NPM_CMD = 'C:\\Program Files\\nodejs\\npm.cmd';
// How a .cmd launcher reaches cmd.exe: its absolute path, quoted.
const NPM_CMD_QUOTED = '"C:\\Program Files\\nodejs\\npm.cmd"';

function createCustomNpmPrefixHarness({ stdout = '', stderr = '' } = {}) {
  const harness = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: `C:\\Windows;${NODE_DIR}`, PATHEXT: '.COM;.EXE;.CMD' },
    findCopilotSdk: () => 'C:\\Users\\dev\\AppData\\Local\\copilot\\pkg\\win32-x64\\1.0.112\\copilot-sdk',
  });
  harness.fsImpl.addFile(NPM_CMD);
  harness.fsImpl.addDir('D:\\tools\\npm-global');
  // A .cmd launcher's args reach cmd.exe quoted.
  harness.control.reply = (call) => {
    if (call.command === NPM_CMD_QUOTED && call.args.join(' ') === '"prefix" "-g"') {
      if (stderr) call.child.emitStderr(stderr);
      return { out: stdout, code: 0 };
    }
    if (call.args.join(' ') === '"--version"') return { out: 'GitHub Copilot CLI 1.0.112.\r\n', code: 0 };
    return null;
  };
  return harness;
}

test('after an npm install on Windows, copilot is looked for in npm\'s global folder, through npm.cmd\'s full path', async () => {
  const harness = createCustomNpmPrefixHarness({ stdout: 'D:\\tools\\npm-global\r\n' });
  try {
    const installer = startInstall(harness, 'copilot');
    // npm wrote its launcher into a prefix that is neither on PATH nor searched.
    harness.fsImpl.addFile('D:\\tools\\npm-global\\copilot.cmd');
    installer.exit(0);
    await settle();

    // Never the bare name: npm.cmd finds its JS through %~dp0, which is the
    // working directory when cmd.exe starts it by name.
    assert.ok(!harness.calls.some((call) => call.command === '"npm.cmd"'));
    const prefixRun = harness.calls.find((call) => call.command === NPM_CMD_QUOTED);
    assert.deepEqual(prefixRun.args, ['"prefix"', '"-g"'], 'npm prefix -g ran');
    assert.equal(prefixRun.options.shell, true);
    const state = harness.service.getInstallState();
    assert.equal(state.state, 'success', state.error || '');
    assert.equal(harness.env.PATH.split(';')[0], 'D:\\tools\\npm-global');
    assert.deepEqual(harness.persisted.at(-1), { copilot: 'D:\\tools\\npm-global\\copilot.cmd' });
  } finally {
    harness.cleanup();
  }
});

test('the npm prefix is the first stdout line that is a folder: a notice on stderr or stdout never is', async () => {
  const harness = createCustomNpmPrefixHarness({
    stderr: 'npm notice New major version of npm available! 11.19.1 -> 12.0.0\r\n',
    stdout: 'npm warn config ignoring an unknown key\r\nD:\\tools\\npm-global\r\n',
  });
  try {
    const installer = startInstall(harness, 'copilot');
    harness.fsImpl.addFile('D:\\tools\\npm-global\\copilot.cmd');
    installer.exit(0);
    await settle();
    assert.equal(harness.service.getInstallState().state, 'success', harness.service.getInstallState().error || '');
    assert.equal(harness.env.PATH.split(';')[0], 'D:\\tools\\npm-global');
  } finally {
    harness.cleanup();
  }
});

test('the npm prefix lookup runs under the probe timeout, and a miss names the prefix', async () => {
  const harness = createCustomNpmPrefixHarness();
  const reply = harness.control.reply;
  harness.control.reply = (call) => (call.command === NPM_CMD_QUOTED ? null : reply(call));
  try {
    const installer = startInstall(harness, 'copilot');
    installer.exit(0);
    await settle();
    const prefixRun = harness.calls.find((call) => call.command === NPM_CMD_QUOTED);
    assert.deepEqual(harness.timers.delays(), [5_000], 'the probe timeout, not the install timeout');
    prefixRun.child.emitStdout('D:\\tools\\npm-global\r\n');
    prefixRun.child.exit(0);
    await settle();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.equal(state.error,
      "GitHub Copilot CLI install finished but copilot was not found on PATH or in npm's global folder D:\\tools\\npm-global");
    assert.deepEqual(harness.persisted, []);
  } finally {
    harness.cleanup();
  }
});

test('without npm.cmd on PATH there is no prefix lookup to run', async () => {
  const harness = createCustomNpmPrefixHarness({ stdout: 'D:\\tools\\npm-global\r\n' });
  harness.fsImpl.removeFile(NPM_CMD);
  try {
    const installer = startInstall(harness, 'copilot');
    installer.exit(0);
    await settle();
    assert.ok(!harness.calls.some((call) => /npm\.cmd/.test(call.command)));
    assert.equal(harness.service.getInstallState().error,
      'GitHub Copilot CLI install finished but copilot was not found on PATH');
  } finally {
    harness.cleanup();
  }
});

test('on a real Windows host the prefix lookup runs an npm.cmd that finds its own JS through %~dp0', { skip: process.platform !== 'win32' }, async (t) => {
  // A stand-in for the npm.cmd Node.js ships: it starts the JS next to it,
  // found through %~dp0, which only works when cmd.exe gets its full path.
  // The installer is the only fake; npm.cmd and copilot.cmd run for real.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-npm-prefix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeDir = path.join(root, 'nodejs');
  const prefix = path.join(root, 'npm-global');
  fs.mkdirSync(nodeDir);
  fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(nodeDir, 'npm.cmd'), '@ECHO OFF\r\n"%NODE_EXE%" "%~dp0npm-prefix.js" %*\r\n');
  fs.writeFileSync(path.join(nodeDir, 'npm-prefix.js'), [
    "process.stderr.write('npm notice a newer npm is available\\n');",
    `if (process.argv[2] === 'prefix' && process.argv[3] === '-g') process.stdout.write(${JSON.stringify(`${prefix}\r\n`)});`,
    'else process.exit(1);',
    '',
  ].join('\n'));
  // Neither the host's PATH nor its home: the resolve walk must not find a
  // copilot the host already has. System32 stays, for cmd.exe (Node starts it from ComSpec).
  const env = {
    ...process.env,
    PATH: `${nodeDir};${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')}`,
    NODE_EXE: process.execPath,
    COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '',
    COPILOT_WEB_RELAY_CLI_BIN_DIR: '',
  };
  const realSpawn = (await import('node:child_process')).spawn;
  const spawnImpl = (command, args, options) => {
    if (command === 'powershell') {
      // The npm install itself: it writes copilot.cmd into the custom prefix.
      fs.writeFileSync(path.join(prefix, 'copilot.cmd'), '@ECHO GitHub Copilot CLI 1.0.112.\r\n');
      const child = new EventEmitter();
      child.pid = 0;
      child.exitCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
    return realSpawn(command, args, options);
  };
  const service = createCliInstallService({
    env,
    platform: 'win32',
    homedirImpl: () => root,
    spawnImpl,
    logger: { log() {} },
    findCopilotSdk: () => path.join(root, 'copilot-sdk'),
    writeBoundBinaries: () => {},
  });
  t.after(() => service.dispose());
  // Only an install with no copilot reachable yet means anything here.
  if (service.resolveCliBinary('copilot')) {
    t.skip('this host already has a copilot the resolve walk finds');
    return;
  }
  const done = new Promise((resolve) => {
    service.subscribe((snapshot) => {
      if (['success', 'error', 'cancelled'].includes(snapshot.state)) resolve(snapshot);
    });
  });
  assert.equal(service.runInstall('copilot').ok, true);
  const finished = await done;
  assert.equal(finished.state, 'success', finished.error || '');
  assert.equal(service.getBoundBinaries().copilot.toLowerCase(), path.join(prefix, 'copilot.cmd').toLowerCase());
});

/**
 * The POSIX install command itself, run by a real bash against stubs: a `curl`
 * that serves a stand-in for the vendor script and logs what it was asked
 * for, and a PATH holding only the tools the command uses. Nothing reaches
 * the network and nothing is installed outside the test's own folder.
 */
function runCopilotInstallCommand(t, { validated = true, hashTool = true, existing = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-copilot-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(bin);
  const tools = ['bash', 'cat', 'chmod', 'find', 'grep', 'mkdir', 'mktemp', 'mv', 'rm', 'tee'];
  if (hashTool) tools.push('sha256sum', 'shasum');
  for (const tool of tools) {
    const found = ['/usr/bin', '/bin', '/usr/local/bin']
      .map((dir) => path.join(dir, tool))
      .find((candidate) => fs.existsSync(candidate));
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  const bash = fs.realpathSync(path.join(bin, 'bash'));
  fs.writeFileSync(path.join(root, 'install.sh'), [
    'echo "Installing GitHub Copilot CLI..."',
    'if read -r line; then echo "read from stdin: $line"; fi',
    'mkdir -p "$PREFIX/bin"',
    'printf "#!/bin/sh\\necho new\\n" > "$PREFIX/bin/copilot"',
    'chmod +x "$PREFIX/bin/copilot"',
    ...(validated ? ['echo "✓ Checksum validated"'] : []),
    'echo "✓ GitHub Copilot CLI installed to $PREFIX/bin/copilot"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'curl'), [
    `#!${bash}`,
    'echo "$*" >> "$STUB_ROOT/curl.log"',
    'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
    'cat "$STUB_ROOT/install.sh" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 });
  if (existing) fs.writeFileSync(path.join(home, '.local', 'bin', 'copilot'), existing, { mode: 0o755 });
  // A staging folder a killed install left behind two hours ago.
  const stale = path.join(home, '.local', '.copilot-install.OLD123');
  fs.mkdirSync(stale);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

  const harness = createHarness();
  const script = harness.service.getDescriptor('copilot').commands.install.posix.argv[2];
  harness.cleanup();
  const result = spawnSync(bash, ['-c', script], {
    env: { PATH: bin, HOME: home, STUB_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 20_000,
  });
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  return {
    result,
    installed: read(path.join(home, '.local', 'bin', 'copilot')),
    curlLog: read(path.join(root, 'curl.log')),
    leftovers: fs.readdirSync(path.join(home, '.local')).filter((name) => name.startsWith('.copilot-install.')),
  };
}

test('the copilot install command installs only what the vendor script checked against its checksum', { skip: process.platform === 'win32' }, (t) => {
  const run = runCopilotInstallCommand(t, { existing: '#!/bin/sh\necho old\n' });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.installed, '#!/bin/sh\necho new\n');
  assert.match(run.curlLog, new RegExp(`^-fsSL ${COPILOT_SCRIPT_URL.replace(/\./g, '\\.')} -o `));
  assert.ok(!run.result.stdout.includes('read from stdin'), 'the script read nothing');
  assert.match(run.result.stdout, /Installed to .*\/\.local\/bin\/copilot/);
  assert.deepEqual(run.leftovers, [], 'its own staging folder and the stale one are gone');
});

test('the copilot install command fails, and leaves the old binary, when the script skipped its checksum check', { skip: process.platform === 'win32' }, (t) => {
  const run = runCopilotInstallCommand(t, { validated: false, existing: '#!/bin/sh\necho old\n' });
  assert.equal(run.result.status, 1);
  assert.match(run.result.stderr, /did not check the download against its checksum file.*Nothing was installed/);
  assert.equal(run.installed, '#!/bin/sh\necho old\n');
  assert.deepEqual(run.leftovers, []);
});

test('the copilot install command refuses to start without sha256sum or shasum', { skip: process.platform === 'win32' }, (t) => {
  const run = runCopilotInstallCommand(t, { hashTool: false });
  assert.equal(run.result.status, 1);
  assert.match(run.result.stderr, /neither sha256sum nor shasum is installed/);
  assert.equal(run.curlLog, null, 'nothing was downloaded');
  assert.equal(run.installed, null);
});

// ─── resolveCliBinary ────────────────────────────────────────────────────────

test('resolveCliBinary walks PATH first, then the descriptor bin dirs', () => {
  const harness = createHarness({ env: { PATH: '/usr/bin:/usr/local/bin' } });
  try {
    assert.equal(harness.service.resolveCliBinary('grok'), null, 'nothing on disk yet');

    // Only the installer's private dir is populated: the vendor could not
    // symlink into a directory that is on PATH.
    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
    assert.deepEqual(harness.service.resolveCliBinary('grok'), {
      path: `${HOME}/.grok/bin/grok`,
      realPath: `${HOME}/.grok/bin/grok`,
    });

    // Once a copy is on PATH, that is what a shell would run, so that is what
    // the relay binds.
    harness.fsImpl.addFile('/usr/local/bin/grok');
    assert.equal(harness.service.resolveCliBinary('grok').path, '/usr/local/bin/grok');
  } finally {
    harness.cleanup();
  }
});

test('resolveCliBinary skips a non-executable file and a directory of the same name', () => {
  const harness = createHarness();
  try {
    harness.fsImpl.addDir('/usr/bin/grok');
    assert.equal(harness.service.resolveCliBinary('grok'), null, 'a directory is not a binary');
    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`, { executable: false });
    assert.equal(harness.service.resolveCliBinary('grok'), null, 'a non-executable file is not a binary');
  } finally {
    harness.cleanup();
  }
});

test('resolveCliBinary follows the symlink, and a node_modules realpath classifies as npm-global', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile('/usr/bin/claude', {
    realPath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  });
  try {
    const resolved = harness.service.resolveCliBinary('claude');
    assert.equal(resolved.path, '/usr/bin/claude');
    assert.equal(resolved.realPath, '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');

    // `claude doctor` reports the method itself, so the heuristic only has to
    // agree with it here.
    const status = await harness.service.probeCliStatus('claude');
    assert.equal(status.installMethod, 'npm-global');
  } finally {
    harness.cleanup();
  }
});

test('a binary under the home directory classifies as a native install', async () => {
  const harness = createHarness();
  // The launcher is the installer's symlink; the realpath is the downloaded
  // build it points at.
  harness.fsImpl.addFile(`${HOME}/.local/bin/grok`, { realPath: `${HOME}/.grok/downloads/grok-linux-x86_64` });
  try {
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.installMethod, 'native');
    assert.equal(status.path, `${HOME}/.local/bin/grok`, 'the launcher is what gets bound');
  } finally {
    harness.cleanup();
  }
});

test('on Windows the resolve walk honours PATHEXT and the semicolon delimiter', () => {
  const harness = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: 'C:\\tools;C:\\Windows', PATHEXT: '.COM;.EXE;.CMD' },
  });
  try {
    harness.fsImpl.addFile('C:\\tools\\grok.cmd');
    const resolved = harness.service.resolveCliBinary('grok');
    assert.equal(resolved.path, 'C:\\tools\\grok.cmd');

    // An .exe next to it wins: PATHEXT order, not filesystem order.
    harness.fsImpl.addFile('C:\\tools\\grok.exe');
    assert.equal(harness.service.resolveCliBinary('grok').path, 'C:\\tools\\grok.exe');
  } finally {
    harness.cleanup();
  }
});

test('COPILOT_WEB_RELAY_CLI_BIN_DIR pins resolution, hiding the host CLIs from a test relay', () => {
  const harness = createHarness({ env: { COPILOT_WEB_RELAY_CLI_BIN_DIR: '/tmp/stub-bin' } });
  try {
    // An isolated relay still inherits the host's PATH, so the pin has to be
    // exclusive: merely preferring the stub dir would leave the host's real
    // binaries visible in the status rows.
    harness.fsImpl.addFile('/usr/bin/grok');
    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
    assert.equal(harness.service.resolveCliBinary('grok'), null);

    harness.fsImpl.addFile('/tmp/stub-bin/grok');
    assert.equal(harness.service.resolveCliBinary('grok').path, '/tmp/stub-bin/grok');
  } finally {
    harness.cleanup();
  }
});

// ─── claude doctor parsing ───────────────────────────────────────────────────

test('parseClaudeDoctor reads the method, version, path and the not-writable warning', () => {
  const parsed = parseClaudeDoctor(DOCTOR_NPM_NOT_WRITABLE);
  assert.equal(parsed.method, 'npm-global');
  assert.equal(parsed.version, '2.1.247');
  assert.equal(parsed.path, '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  assert.equal(parsed.autoUpdates, 'enabled');
  assert.match(parsed.lastUpdateAttempt, /no_permissions/);
  assert.equal(parsed.warnings.length, 1);
  // The indented `Fix:` line belongs to the warning above it.
  assert.match(parsed.warnings[0], /npm global folder isn't writable Fix: Run claude install/);
  assert.equal(parsed.npmGlobalNotWritable, true);
});

test('parseClaudeDoctor reports a healthy install with no warnings', () => {
  const parsed = parseClaudeDoctor(DOCTOR_HEALTHY);
  assert.equal(parsed.method, 'native');
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.npmGlobalNotWritable, false);
  assert.equal(parsed.lastUpdateAttempt, null);
});

test('parseClaudeDoctor degrades instead of throwing on unfamiliar output', () => {
  assert.equal(parseClaudeDoctor(''), null);
  assert.equal(parseClaudeDoctor('   \n'), null);
  const parsed = parseClaudeDoctor('\x1b[2mEverything is fine.\x1b[0m\r\n');
  assert.deepEqual(parsed, {
    method: null,
    version: null,
    path: null,
    autoUpdates: null,
    lastUpdateAttempt: null,
    warnings: [],
    npmGlobalNotWritable: false,
  });
});

// ─── Status probes ───────────────────────────────────────────────────────────

test('a probe resolves, reads the version and the update check, and caches within the TTL', async () => {
  const harness = createHarness({ statusTtlMs: 30_000 });
  harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
  try {
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.installed, true);
    assert.equal(status.version, '1.0.13');
    assert.equal(status.path, `${HOME}/.grok/bin/grok`);
    assert.equal(status.updateAvailable, false);
    assert.equal(status.latestVersion, '1.0.13');
    assert.equal(status.canInstall, false, 'an installed CLI offers Update, never Install');
    assert.equal(status.canUpdate, true);
    assert.equal(status.commands.update.display, 'grok update');
    assert.equal(status.error, null);
    assert.equal(harness.callsFor('--version').length, 1);

    await harness.service.probeCliStatus('grok');
    assert.equal(harness.callsFor('--version').length, 1, 'cached inside the TTL');

    await harness.service.probeCliStatus('grok', { force: true });
    assert.equal(harness.callsFor('--version').length, 2);
  } finally {
    harness.cleanup();
  }
});

test('a missing CLI reports not-installed with an Install command and no spawn', async () => {
  const harness = createHarness();
  try {
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.installed, false);
    assert.equal(status.version, null);
    assert.equal(status.path, null);
    assert.equal(status.canInstall, true);
    assert.equal(status.canUpdate, false);
    assert.equal(status.commands.install.display, 'curl -fsSL https://x.ai/cli/install.sh | bash');
    assert.equal(status.commands.install.targetDir, '~/.grok/bin');
    assert.equal(status.commands.update, undefined);
    assert.deepEqual(harness.calls, [], 'nothing to run when there is no binary');
  } finally {
    harness.cleanup();
  }
});

test('on Windows the confirm sheet names the PowerShell one-liner', async () => {
  const harness = createHarness({ platform: 'win32', pathImpl: path.win32, env: { PATH: 'C:\\Windows' } });
  try {
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.commands.install.display, 'irm https://x.ai/cli/install.ps1 | iex');
  } finally {
    harness.cleanup();
  }
});

test('an unparseable version still counts as installed, with the reason attached', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile('/usr/bin/grok');
  harness.control.reply = () => ({ out: 'grok: totally new banner\n', code: 0 });
  try {
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.installed, true, 'the install is decided by the resolve, never by the scrape');
    assert.equal(status.version, null);
    assert.equal(status.updateAvailable, null, 'an unparseable check is unknown, not "no"');
    assert.match(status.error, /totally new banner/);
  } finally {
    harness.cleanup();
  }
});

test('a --version that fails reports the failure instead of scraping a version out of it', async () => {
  const broken = createHarness();
  broken.fsImpl.addFile('/usr/bin/grok');
  // A binary built against a newer libc: the generic "any dotted number"
  // fallback would happily read this as version 2.32 with no error at all,
  // rendering a CLI that cannot start as a healthy install.
  broken.control.reply = () => ({
    out: "/usr/bin/grok: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.32' not found\n",
    code: 127,
  });
  try {
    const status = await broken.service.probeCliStatus('grok');
    assert.equal(status.installed, true, 'the file is there — it just cannot run');
    assert.equal(status.version, null, 'GLIBC_2.32 is not a version of grok');
    assert.match(status.error, /GLIBC_2\.32/);
  } finally {
    broken.cleanup();
  }

  const silent = createHarness();
  silent.fsImpl.addFile('/usr/bin/grok');
  silent.control.reply = () => ({ out: '', code: 3 });
  try {
    const status = await silent.service.probeCliStatus('grok');
    assert.equal(status.version, null);
    assert.match(status.error, /exited with code 3/, 'a silent failure still says something');
  } finally {
    silent.cleanup();
  }
});

test('getStatusSnapshot answers for every provider plus the install state', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
  try {
    const snapshot = await harness.service.getStatusSnapshot();
    assert.deepEqual(Object.keys(snapshot.providers).sort(), ['claude', 'copilot', 'grok']);
    assert.equal(snapshot.providers.grok.installed, true);
    assert.equal(snapshot.providers.claude.installed, false);
    assert.equal(snapshot.install.state, 'idle');
    assert.equal(snapshot.install.logSeq, 0);
  } finally {
    harness.cleanup();
  }
});

test('a forced probe never adopts an in-flight one that started before it', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile('/usr/bin/grok');
  harness.control.reply = () => null;
  try {
    const cached = harness.service.probeCliStatus('grok');
    await flush();
    assert.equal(harness.callsFor('--version').length, 1);

    // The install that prompts the force happens here, mid-probe.
    const forced = harness.service.probeCliStatus('grok', { force: true });
    assert.equal(harness.callsFor('--version').length, 1, 'the second walk waits for the first');

    harness.control.reply = defaultReply;
    const first = harness.callsFor('--version')[0];
    first.child.emitStdout('grok 1.0.12 (old) [stable]\n');
    first.child.exit(0);
    await flush();
    harness.calls.find((call) => call.args.join(' ') === 'update --check --json')?.child.exit(0);
    assert.equal((await cached).version, '1.0.12');
    assert.equal((await forced).version, '1.0.13', 'the forced read ran its own probe');
  } finally {
    harness.cleanup();
  }
});

// ─── Install / update ────────────────────────────────────────────────────────

/** Starts an install and returns its (already spawned) child. */
function startInstall(harness, providerId = 'grok', action = 'install') {
  const started = harness.service.runInstall(providerId, { action });
  assert.equal(started.ok, true, started.error || '');
  return harness.lastChild();
}

test('an install spawns the frozen vendor one-liner detached, with stdin closed', () => {
  const harness = createHarness();
  try {
    startInstall(harness);
    const call = harness.calls[0];
    assert.equal(call.command, 'bash');
    assert.deepEqual(call.args, ['-lc', 'curl -fsSL https://x.ai/cli/install.sh | bash']);
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'running');
    assert.equal(state.providerId, 'grok');
    assert.equal(state.action, 'install');
    assert.equal(state.command, 'curl -fsSL https://x.ai/cli/install.sh | bash');
    assert.equal(state.active, true);
  } finally {
    harness.cleanup();
  }
});

test('on Windows only a batch launcher goes through cmd.exe, with every token quoted', async () => {
  // Node refuses to spawn a .cmd/.bat without a shell (EINVAL, since the
  // CVE-2024-27980 fix) and PATHEXT resolves exactly those — the npm shim for
  // `copilot` is `copilot.cmd`, so without the shell every probe of it reported
  // "installed, version unknown" and a .cmd-shimmed update died instantly.
  const shimmed = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: 'C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.CMD' },
  });
  shimmed.fsImpl.addFile('C:\\Program Files\\nodejs\\copilot.cmd');
  shimmed.control.reply = () => ({ out: 'GitHub Copilot CLI 1.0.82.\n', code: 0 });
  try {
    const status = await shimmed.service.probeCliStatus('copilot');
    const call = shimmed.calls[0];
    assert.equal(call.options.shell, true);
    // shell:true makes Node join command+args into one string and quote
    // nothing, so the quoting has to be ours — the directory has a space in it.
    assert.equal(call.command, '"C:\\Program Files\\nodejs\\copilot.cmd"');
    assert.deepEqual(call.args, ['"--version"']);
    assert.equal(call.options.windowsHide, true);
    assert.equal(status.version, '1.0.82', 'the npm-shimmed row reports a real version');
  } finally {
    shimmed.cleanup();
  }

  const native = createHarness({
    platform: 'win32',
    pathImpl: path.win32,
    env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.CMD' },
  });
  native.fsImpl.addFile('C:\\tools\\copilot.exe');
  native.control.reply = () => ({ out: 'GitHub Copilot CLI 1.0.82.\n', code: 0 });
  try {
    await native.service.probeCliStatus('copilot');
    const call = native.calls[0];
    assert.equal(call.options.shell, undefined, 'an .exe needs no shell, so it gets none');
    assert.equal(call.command, 'C:\\tools\\copilot.exe');
    assert.deepEqual(call.args, ['--version']);
  } finally {
    native.cleanup();
  }
});

test('an update runs the resolved binary, and is refused while nothing is installed', () => {
  const harness = createHarness();
  try {
    const refused = harness.service.runInstall('grok', { action: 'update' });
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.error, /not installed/);
    assert.deepEqual(harness.calls, []);

    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
    startInstall(harness, 'grok', 'update');
    assert.equal(harness.calls[0].command, `${HOME}/.grok/bin/grok`);
    assert.deepEqual(harness.calls[0].args, ['update']);
  } finally {
    harness.cleanup();
  }
});

test('the claude migrate action is Anthropic\'s own `claude install`, run through the resolved binary', () => {
  const harness = createHarness();
  harness.fsImpl.addFile('/usr/bin/claude');
  try {
    startInstall(harness, 'claude', 'migrate');
    assert.equal(harness.calls[0].command, '/usr/bin/claude');
    assert.deepEqual(harness.calls[0].args, ['install']);
    assert.equal(harness.service.getInstallState().command, 'claude install');
  } finally {
    harness.cleanup();
  }
});

test('the streamed log is escape-stripped, sequence-numbered and capped', () => {
  const harness = createHarness();
  try {
    const child = startInstall(harness);
    child.emitStdout('\x1b[32mDownloading grok\x1b[0m\r\n');
    child.emitStderr('  93% done\n');

    const state = harness.service.getInstallState();
    assert.equal(state.log, 'Downloading grok\n  93% done\n', 'no ANSI payload ever reaches the DOM');
    assert.equal(state.logSeq, 2, 'one bump per appended chunk');
    // The payload is always the whole retained buffer, so a client that joins
    // mid-install renders the log rather than a suffix.
    assert.equal(harness.states.at(-1).log, 'Downloading grok\n');

    child.emitStdout('x'.repeat(20_000));
    const capped = harness.service.getInstallState();
    assert.equal(capped.log.length, 16_000, 'the same 16KB cap as the auth service');
    assert.equal(capped.log.endsWith('x'), true, 'the tail is what is kept');
    assert.equal(capped.logSeq, 3);
  } finally {
    harness.cleanup();
  }
});

test('log broadcasts coalesce into one per flush window, without changing the payload', async () => {
  const harness = createHarness({ logFlushMs: 250 });
  try {
    const child = startInstall(harness);
    assert.deepEqual(harness.stateNames(), ['running'], 'the transition itself is never coalesced');

    // First chunk goes out at once: the log has to appear, not wait a window.
    child.emitStdout('a\n');
    assert.equal(harness.states.length, 2);
    assert.equal(harness.states.at(-1).log, 'a\n');

    // Everything inside the open window collapses into one trailing emit — the
    // flood this exists to stop is a progress-bar installer, one chunk a frame.
    child.emitStdout('b\n');
    child.emitStdout('c\n');
    assert.equal(harness.states.length, 2, 'no broadcast per chunk');
    assert.equal(harness.service.getInstallState().logSeq, 3, 'logSeq still counts every chunk');

    assert.equal(harness.timers.fire(250), 1);
    assert.equal(harness.states.length, 3);
    assert.equal(harness.states.at(-1).log, 'a\nb\nc\n', 'the coalesced emit carries the whole buffer');
    assert.equal(harness.states.at(-1).logSeq, 3, 'a client sees the counter jump, which is the point of it');

    // A window that lapses with nothing pending does not emit, and does not
    // re-arm, so the next chunk is immediate again.
    harness.timers.fire(250);
    assert.equal(harness.states.length, 3);
    child.emitStdout('d\n');
    assert.equal(harness.states.length, 4);

    // The terminal state flushes: it must never be the coalesced-away one.
    child.emitStdout('e\n');
    child.exit(1);
    await flush();
    const final = harness.states.at(-1);
    assert.equal(final.state, 'error');
    assert.equal(final.log, 'a\nb\nc\nd\ne\n', 'the final broadcast carries the complete log');
    assert.equal(final.logSeq, 5);

    // …and the cancelled flush window cannot fire a stale duplicate after it.
    const afterFinal = harness.states.length;
    harness.timers.fire(250);
    assert.equal(harness.states.length, afterFinal);
  } finally {
    harness.cleanup();
  }
});

test('a successful install re-probes, binds the binary and publishes success', async () => {
  const harness = createHarness();
  harness.fsImpl.addDir(`${HOME}/.grok/bin`);
  const hookCalls = [];
  try {
    harness.service.onInstallSuccess((detail) => { hookCalls.push(detail.providerId); });
    const child = startInstall(harness);
    child.emitStdout('Installed grok 1.0.13\n');
    // The installer has done its job by the time it exits.
    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
    child.exit(0);
    await flush();
    await flush();
    await flush();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'success');
    assert.equal(state.active, false);
    assert.ok(state.finishedAt, 'the terminal state is timestamped');

    // §4.3: the env var the worker reads, plus a PATH prepend so anything
    // resolving by name (the Grok ACP adapter defaults to `grok`) finds it.
    assert.equal(harness.env.GROK_CLI_COMMAND, `${HOME}/.grok/bin/grok`);
    assert.equal(harness.env.PATH, `${HOME}/.grok/bin:/usr/bin`);
    assert.deepEqual(harness.persisted.at(-1), { grok: `${HOME}/.grok/bin/grok` });
    assert.deepEqual(harness.service.getBoundBinaries(), { grok: `${HOME}/.grok/bin/grok` });
    assert.deepEqual(hookCalls, ['grok'], 'the model-refresh hook runs after the bind');

    const snapshot = harness.service.getCachedStatusSnapshot();
    assert.equal(snapshot.providers.grok.version, '1.0.13');
    assert.equal(snapshot.providers.grok.bound, `${HOME}/.grok/bin/grok`);
  } finally {
    harness.cleanup();
  }
});

test('a claude migrate binds the native build, never the npm launcher it replaced', async () => {
  // `claude install` switches an npm-global install to the native build and
  // leaves the npm copy in place, so at the moment the installer exits BOTH
  // exist and the npm one is still first on PATH. A post-install resolve that
  // ran before the descriptor's own bin dir was hoisted would bind — and
  // persist — the launcher the migration was run to get away from, and report
  // SUCCESS while doing it.
  const harness = createHarness({ env: { PATH: '/usr/bin' } });
  harness.fsImpl.addFile('/usr/bin/claude', {
    realPath: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  });
  harness.fsImpl.addDir(`${HOME}/.local/bin`);
  try {
    const child = startInstall(harness, 'claude', 'migrate');
    assert.equal(harness.calls[0].command, '/usr/bin/claude', 'the npm copy is what runs the migration');

    harness.fsImpl.addFile(`${HOME}/.local/bin/claude`);
    child.exit(0);
    await flush();
    await flush();
    await flush();
    await flush();

    assert.equal(harness.service.getInstallState().state, 'success');
    assert.equal(harness.env.CLAUDE_CODE_EXECUTABLE, `${HOME}/.local/bin/claude`);
    assert.deepEqual(harness.persisted.at(-1), { claude: `${HOME}/.local/bin/claude` });
    assert.equal(harness.env.PATH, `${HOME}/.local/bin:/usr/bin`,
      'and the bound path agrees with what `claude` now means to a spawned child');
  } finally {
    harness.cleanup();
  }
});

test('a config write that fails costs the persistence, not the in-process binding', async () => {
  // writeCliBinariesToConfigFile() throws rather than clobbering a config it
  // could not read; that must degrade to "this binding is lost at the next
  // restart", not to a failed install.
  const harness = createHarness({
    writeBoundBinaries: () => { throw new Error('refusing to rewrite config.json: it could not be read'); },
  });
  harness.fsImpl.addDir(`${HOME}/.grok/bin`);
  try {
    const child = startInstall(harness);
    harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
    child.exit(0);
    await flush();
    await flush();
    await flush();

    assert.equal(harness.service.getInstallState().state, 'success');
    assert.equal(harness.env.GROK_CLI_COMMAND, `${HOME}/.grok/bin/grok`);
    assert.deepEqual(harness.service.getBoundBinaries(), { grok: `${HOME}/.grok/bin/grok` });
  } finally {
    harness.cleanup();
  }
});

test('an installer that exits 0 without producing a binary is a failure, not a success', async () => {
  const harness = createHarness();
  try {
    const child = startInstall(harness);
    child.emitStdout('Everything looks fine!\n');
    child.exit(0);
    await flush();
    await flush();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /finished but grok was not found/);
    assert.equal(harness.env.GROK_CLI_COMMAND, undefined, 'nothing is bound');
    assert.deepEqual(harness.persisted, []);
  } finally {
    harness.cleanup();
  }
});

test('a failing installer reports the tail of its own output', async () => {
  const harness = createHarness();
  try {
    const child = startInstall(harness);
    child.emitStderr('curl: (22) The requested URL returned error: 503\n');
    child.exit(1);
    await flush();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /503/);
    assert.equal(state.active, false);
  } finally {
    harness.cleanup();
  }
});

test('the install is single-flight relay-wide; a repeat press joins the run', () => {
  const harness = createHarness();
  try {
    startInstall(harness);
    const repeat = harness.service.runInstall('grok', { action: 'install' });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.reused, true);

    const other = harness.service.runInstall('claude', { action: 'install' });
    assert.equal(other.ok, false);
    assert.equal(other.statusCode, 409);
    assert.match(other.error, /already running \(Grok CLI\)/);
    assert.equal(harness.calls.length, 1, 'no second installer');
  } finally {
    harness.cleanup();
  }
});

test('cancel signals the whole process group and escalates to SIGKILL', () => {
  const harness = createHarness();
  try {
    const child = startInstall(harness);
    const cancelled = harness.service.cancel();
    assert.equal(cancelled.install.state, 'cancelled');
    assert.equal(cancelled.install.active, false);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);

    assert.ok(harness.timers.delays().includes(2000), 'the escalation timer is armed');
    harness.timers.fire(2000);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);

    // Once the child is gone the escalation is a no-op.
    harness.kills.length = 0;
    child.exitCode = 143;
    harness.timers.fire(2000);
    assert.deepEqual(harness.kills, []);
  } finally {
    harness.cleanup();
  }
});

test('a late close from a cancelled install leaves a newer one alone', async () => {
  const harness = createHarness();
  try {
    const first = startInstall(harness);
    harness.service.cancel();
    const second = startInstall(harness, 'claude', 'install');
    assert.notEqual(first, second);

    // The killed installer finally reports in.
    first.exit(143);
    await flush();
    await flush();

    const state = harness.service.getInstallState();
    assert.equal(state.state, 'running');
    assert.equal(state.providerId, 'claude');
    assert.equal(state.active, true);
  } finally {
    harness.cleanup();
  }
});

test('cancel with nothing running clears a terminal state back to idle', async () => {
  const harness = createHarness();
  try {
    const child = startInstall(harness);
    child.exit(1);
    await flush();
    assert.equal(harness.service.getInstallState().state, 'error');

    const dismissed = harness.service.cancel();
    assert.equal(dismissed.install.state, 'idle');
    assert.equal(dismissed.install.providerId, null);
    assert.equal(dismissed.install.error, null);
  } finally {
    harness.cleanup();
  }
});

test('the install hard timeout kills the run and reports it', async () => {
  const harness = createHarness({ installTimeoutMs: 600_000 });
  try {
    const child = startInstall(harness);
    assert.ok(harness.timers.delays().includes(600_000));
    assert.equal(harness.timers.fire(600_000), 1);
    await flush();

    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
    const state = harness.service.getInstallState();
    assert.equal(state.state, 'error');
    assert.match(state.error, /timed out after 600000ms/);
  } finally {
    harness.cleanup();
  }
});

test('dispose tears down a running installer and stops broadcasting', () => {
  const harness = createHarness();
  const child = startInstall(harness);
  const before = harness.states.length;
  harness.service.dispose();
  assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  child.exit(143);
  assert.equal(harness.states.length, before, 'no listener fires after dispose');
});

// ─── Kill switch ─────────────────────────────────────────────────────────────

test('every spawn path refuses when the relay runs with CLI spawns disabled', async () => {
  const harness = createHarness({ env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' } });
  harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
  try {
    const refused = harness.service.runInstall('grok', { action: 'install' });
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.error, CLI_SPAWN_DISABLED_ERROR);
    assert.equal(harness.service.getInstallState().state, 'error');

    // The probe still resolves the binary (that is a filesystem walk) but never
    // runs it, so the row reports the install with no version.
    const status = await harness.service.probeCliStatus('grok');
    assert.equal(status.installed, true);
    assert.equal(status.version, null);
    assert.equal(status.error, CLI_SPAWN_DISABLED_ERROR);
    assert.equal(status.blockedReason, CLI_SPAWN_DISABLED_ERROR);
    assert.deepEqual(status.commands, {}, 'no buttons while the kill switch is on');
    assert.deepEqual(harness.calls, [], 'no child process was ever created');
  } finally {
    harness.cleanup();
  }
});

test('the stub escape hatch needs both halves: the opt-in flag and a command override', () => {
  const flagOnly = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN: '1',
    },
  });
  try {
    assert.equal(flagOnly.service.runInstall('grok', { action: 'install' }).error, CLI_SPAWN_DISABLED_ERROR);
    assert.deepEqual(flagOnly.calls, [], 'no stub path: still refused');
  } finally {
    flagOnly.cleanup();
  }

  const stubbed = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN: '1',
      COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND: '/repo/fixtures/cli-install-stub.sh',
    },
  });
  try {
    const started = stubbed.service.runInstall('grok', { action: 'install' });
    assert.equal(started.ok, true);
    const call = stubbed.calls[0];
    assert.equal(call.command, '/repo/fixtures/cli-install-stub.sh');
    // The stub is handed the descriptor id and the resolved action — both
    // frozen values, never anything off the request body.
    assert.deepEqual(call.args, ['grok', 'install']);
    // The confirm sheet still names the real vendor command.
    assert.equal(stubbed.service.getInstallState().command, 'curl -fsSL https://x.ai/cli/install.sh | bash');
  } finally {
    stubbed.cleanup();
  }
});

// ─── Binding at startup (§4.3) ───────────────────────────────────────────────

test('applyPersistedBindings restores both env vars and hoists each bound bin dir', () => {
  const harness = createHarness({
    env: { PATH: '/usr/bin' },
    stored: { grok: `${HOME}/.grok/bin/grok`, claude: `${HOME}/.local/bin/claude` },
  });
  harness.fsImpl.addFile(`${HOME}/.grok/bin/grok`);
  harness.fsImpl.addFile(`${HOME}/.local/bin/claude`);
  harness.fsImpl.addDir(`${HOME}/.grok/bin`);
  harness.fsImpl.addDir(`${HOME}/.local/bin`);
  try {
    const applied = harness.service.applyPersistedBindings();
    assert.deepEqual(applied, {
      grok: `${HOME}/.grok/bin/grok`,
      claude: `${HOME}/.local/bin/claude`,
    });
    assert.equal(harness.env.GROK_CLI_COMMAND, `${HOME}/.grok/bin/grok`);
    assert.equal(harness.env.CLAUDE_CODE_EXECUTABLE, `${HOME}/.local/bin/claude`);
    // One directory per binding — the one the bound binary actually lives in,
    // not every directory the descriptor could have installed into. Claude is
    // walked second, so its dir ends up in front; they never compete, because
    // each only has to win for its own binary name.
    assert.equal(harness.env.PATH, `${HOME}/.local/bin:${HOME}/.grok/bin:/usr/bin`);
    assert.deepEqual(harness.persisted, [], 'startup re-application never rewrites the config');

    // Idempotent: re-applying the same bindings must not grow or reshuffle PATH.
    harness.service.applyPersistedBindings();
    assert.equal(harness.env.PATH, `${HOME}/.local/bin:${HOME}/.grok/bin:/usr/bin`);
  } finally {
    harness.cleanup();
  }
});

test('a persisted binary that is gone is dropped instead of bound', () => {
  const harness = createHarness({ stored: { grok: `${HOME}/.grok/bin/grok` } });
  try {
    assert.deepEqual(harness.service.applyPersistedBindings(), {});
    assert.equal(harness.env.GROK_CLI_COMMAND, undefined);
  } finally {
    harness.cleanup();
  }
});

test('a boot with nothing bound leaves PATH exactly as the host set it', () => {
  // Every child the relay spawns inherits this PATH, so a relay that has never
  // installed a CLI through the panel must not have its resolution order
  // rewritten on every boot.
  const harness = createHarness({ env: { PATH: `/usr/bin:${HOME}/.local/bin` } });
  harness.fsImpl.addDir(`${HOME}/.local/bin`);
  harness.fsImpl.addDir(`${HOME}/.grok/bin`);
  harness.fsImpl.addDir('/usr/local/bin');
  try {
    assert.deepEqual(harness.service.applyPersistedBindings(), {});
    assert.equal(harness.env.PATH, `/usr/bin:${HOME}/.local/bin`);
  } finally {
    harness.cleanup();
  }
});

test('a bound dir already on PATH is moved to the front, not left behind the copy it replaced', () => {
  // The failure this guards: `~/.local/bin` is on PATH but *after* the npm
  // global dir, so resolving `claude` by name keeps finding the launcher the
  // binding exists to stop using.
  const harness = createHarness({
    env: { PATH: `/usr/bin:${HOME}/.local/bin` },
    stored: { claude: `${HOME}/.local/bin/claude` },
  });
  harness.fsImpl.addFile(`${HOME}/.local/bin/claude`);
  harness.fsImpl.addDir(`${HOME}/.local/bin`);
  try {
    harness.service.applyPersistedBindings();
    assert.equal(harness.env.PATH, `${HOME}/.local/bin:/usr/bin`, 'moved once, never duplicated');
  } finally {
    harness.cleanup();
  }
});

// ─── Persisting the binding into config.json (§4.3 step 1) ───────────────────
// config.json also holds the relay's auth token, its port and the
// localhost-only flag. Everything below exists because a binding is worth
// exactly one re-run of the Install button, and the token is worth every paired
// client on the user's phone.

/** Real filesystem: this is a test about what survives on disk. */
function withTempConfigDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-binaries-'));
  try {
    return body(path.join(dir, 'config.json'), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('persisting a binding merges cliBinaries in and leaves every other key alone', () => {
  withTempConfigDir((configPath) => {
    const original = { authToken: 'fictional-relay-token', port: 8317, localhostOnly: true };
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2));

    const merged = writeCliBinariesToConfigFile(configPath, { grok: '/opt/grok/bin/grok' });

    const reread = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(reread, { ...original, cliBinaries: { grok: '/opt/grok/bin/grok' } });
    assert.deepEqual(merged, reread, 'the caller gets exactly what landed on disk');
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['config.json'], 'no temp file left behind');
  });
});

test('a config.json that cannot be parsed is never overwritten', () => {
  withTempConfigDir((configPath) => {
    // A half-written config: boot tolerates this by falling back to defaults,
    // which leaves the token still recoverable by hand. Rewriting the file with
    // nothing but cliBinaries would not — the next boot would mint a new token
    // and lock out every paired client.
    const corrupt = '{\n  "authToken": "fictional-relay-token",\n  "port": 831';
    fs.writeFileSync(configPath, corrupt);

    assert.throws(
      () => writeCliBinariesToConfigFile(configPath, { grok: '/opt/grok/bin/grok' }),
      /could not be read/,
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), corrupt, 'byte-identical');
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['config.json'], 'and no temp file left behind');
  });
});

test('a missing or non-object config.json is refused rather than created without the token', () => {
  withTempConfigDir((configPath, dir) => {
    assert.throws(
      () => writeCliBinariesToConfigFile(configPath, { grok: '/opt/grok/bin/grok' }),
      /could not be read/,
    );
    assert.equal(fs.existsSync(configPath), false, 'a config with no authToken is worse than no binding');

    const arrayPath = path.join(dir, 'array-config.json');
    fs.writeFileSync(arrayPath, '["not", "a", "config"]');
    assert.throws(
      () => writeCliBinariesToConfigFile(arrayPath, { grok: '/opt/grok/bin/grok' }),
      /does not hold a JSON object/,
    );
    assert.equal(fs.readFileSync(arrayPath, 'utf8'), '["not", "a", "config"]');
  });
});

test('the config write is a temp file in the same directory, owner-only, then a rename', () => {
  // A truncate-then-write that is interrupted (crash, full disk, power) leaves
  // exactly the corrupt config the test above refuses to touch — and this time
  // the relay itself created it.
  const calls = [];
  const fsImpl = {
    readFileSync: () => JSON.stringify({ authToken: 'fictional-relay-token', port: 8317 }),
    writeFileSync: (target, contents, options) => calls.push(['write', target, contents, options?.mode]),
    chmodSync: (target, mode) => calls.push(['chmod', target, mode]),
    renameSync: (from, to) => calls.push(['rename', from, to]),
    unlinkSync: (target) => calls.push(['unlink', target]),
  };

  writeCliBinariesToConfigFile('/etc/relay/config.json', { grok: '/opt/grok/bin/grok' }, {
    fsImpl,
    pathImpl: path.posix,
  });

  const [write, chmod, rename] = calls;
  assert.equal(calls.length, 3);
  assert.equal(write[0], 'write');
  assert.notEqual(write[1], '/etc/relay/config.json', 'the live config is never truncated');
  assert.equal(path.posix.dirname(write[1]), '/etc/relay', 'same directory, so the rename cannot be a copy');
  assert.equal(write[3], 0o600);
  assert.match(write[2], /"authToken": "fictional-relay-token"/);
  // chmod before the rename: the token is never briefly readable under the real
  // name, and `mode` alone is masked by umask.
  assert.deepEqual(chmod, ['chmod', write[1], 0o600]);
  assert.deepEqual(rename, ['rename', write[1], '/etc/relay/config.json']);
});

test('a rename that fails cleans up its temp file and surfaces the failure', () => {
  const unlinked = [];
  const fsImpl = {
    readFileSync: () => JSON.stringify({ authToken: 'fictional-relay-token' }),
    writeFileSync: () => {},
    chmodSync: () => {},
    renameSync: () => { throw new Error('ENOSPC: no space left on device'); },
    unlinkSync: (target) => unlinked.push(target),
  };

  assert.throws(
    () => writeCliBinariesToConfigFile('/etc/relay/config.json', { grok: '/opt/grok/bin/grok' }, {
      fsImpl,
      pathImpl: path.posix,
    }),
    /ENOSPC/,
  );
  assert.equal(unlinked.length, 1);
  assert.equal(path.posix.dirname(unlinked[0]), '/etc/relay');
  assert.notEqual(unlinked[0], '/etc/relay/config.json', 'the config itself is never unlinked');
});
