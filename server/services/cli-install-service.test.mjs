import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_SPAWN_DISABLED_ERROR } from './cli-process-runner.mjs';
import {
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

test('the descriptor table holds exactly grok, claude and a detect-only copilot', () => {
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

test('copilot is read-only: it reports a version but refuses to be installed', async () => {
  const harness = createHarness();
  harness.fsImpl.addFile('/usr/bin/copilot', { realPath: '/usr/lib/node_modules/@github/copilot/npm-loader.js' });
  try {
    const status = await harness.service.probeCliStatus('copilot');
    assert.equal(status.installed, true);
    assert.equal(status.version, '1.0.82');
    assert.equal(status.installMethod, 'npm-global');
    assert.equal(status.canInstall, false);
    assert.equal(status.canUpdate, false);
    assert.match(status.blockedReason, /npm/i);
    assert.deepEqual(status.commands, {});

    const refused = harness.service.runInstall('copilot', { action: 'install' });
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 400);
    assert.match(refused.error, /npm/i);
  } finally {
    harness.cleanup();
  }
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
