// `oar autostart`, the autostart question of `oar setup` and `oar uninstall`,
// run for real against a throwaway global install. Home, APPDATA,
// LOCALAPPDATA and the state root lie in a scratch folder; the Startup
// folder, the scheduled task, the administrator prompt, the relay and npm are
// doubles, so nothing here reads or changes the machine's own autostart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { UNINSTALL_HELPER_SOURCE, main, runAutostart, runSetup, runUninstall } from '../bin/oar.js';
import { TAKEOVER_PROGRESS_FILE } from './services/earlier-database-service.mjs';
import { scratchEnv } from './services/scratch-env-test-harness.mjs';

const CONFIG = { authToken: 'old-token', port: 4100, localhostOnly: true };
const TASK = 'scheduled task \\oar-relay';

function scripted(answers = []) {
  const asked = [];
  const next = (question) => {
    asked.push(question);
    assert.ok(answers.length, `unexpected question: ${question}`);
    return answers.shift();
  };
  return { asked, line: async (question) => next(question), yesNo: async (question) => next(question) };
}

// A relay that answers on its port and stops when asked (or stays busy).
function fakeRelay({ busy = false } = {}) {
  const relay = { running: true, shutdowns: 0 };
  relay.fetch = async (url, options = {}) => {
    const { pathname } = new URL(String(url));
    if (!relay.running) throw new Error('connect ECONNREFUSED');
    if (pathname === '/api/relay/shutdown') {
      relay.shutdowns += 1;
      if (!busy) relay.running = false;
      return { ok: true, json: async () => ({ queue: { processingCount: busy ? 1 : 0 } }) };
    }
    if (options.headers?.Authorization !== `Bearer ${CONFIG.authToken}`) return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ cliOnline: false, localhostOnly: true, relayShutdown: { status: busy ? 'queued' : 'idle' } }) };
  };
  return relay;
}

function makeInstall(t, { config = CONFIG } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-autostart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = scratchEnv(root, { COPILOT_CONFIG_HOME: path.join(root, 'copilot') });
  // Nothing of a relay this test may run under.
  for (const key of Object.keys(env)) if (/^COPILOT_WEB_RELAY_/i.test(key)) delete env[key];
  const packageRoot = path.join(root, 'pkg');
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const stateRoot = env.OAR_STATE_ROOT;
  fs.mkdirSync(stateRoot, { recursive: true });
  if (config) fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify(config));
  const install = { root, env, packageRoot, stateRoot, lines: [], spawned: [], calls: [] };
  install.output = () => install.lines.join('\n');
  install.startup = path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  install.launcher = path.join(stateRoot, 'oar-web-relay-launcher.cmd');
  install.options = (overrides = {}) => ({
    packageRoot,
    env,
    homeDir: env.HOME,
    cwd: env.HOME,
    platform: 'win32',
    logger: { log: (line) => install.lines.push(String(line)), error: (line) => install.lines.push(String(line)) },
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    prompter: scripted(),
    nodeBin: 'C:\\node\\node.exe',
    pid: 4242,
    interfaces: {},
    readFileImpl: () => { throw new Error('ENOENT'); },
    qrImpl: async () => null,
    isPortFreeImpl: async () => true,
    isProcessAliveImpl: () => false,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    spawnSyncImpl: () => ({ status: 1 }),
    spawnImpl: (command, args, spawnOptions) => {
      install.spawned.push({ command, args, spawnOptions });
      return { exitCode: null, unref() {} };
    },
    windowsAutostartImpl: install.signin,
    processListImpl: { list: async () => install.processes || [] },
    windowsBootAutostartImpl: install.boot,
    pollMs: 2,
    stopWaitMs: 60,
    lockGraceMs: 10,
    ...overrides,
  });
  return install;
}

/**
 * The two Windows autostart services as the CLI sees them. `signin` lists
 * the Startup entries; `boot` is the task's state. The administrator answers
 * each prompt with `install.boot.answer` (true: confirmed).
 */
function windowsDoubles(install, { signin = [], boot = {} } = {}) {
  const { calls } = install;
  let entries = signin.map((entry) => ({ otherInstall: null, ...entry }));
  install.signin = {
    getState: () => ({ supported: true, enabled: entries.length > 0, platform: 'win32' }),
    listEntries: () => entries.map((entry) => ({ ...entry })),
    setEnabled: (on, { replace = false, backupDir = '' } = {}) => {
      calls.push(`signin:${on}${replace ? ':replace' : ''}`);
      const backedUp = replace
        ? entries.filter((entry) => !entry.generated).map((entry) => ({ path: entry.path, backup: path.join(backupDir, `${path.basename(entry.path)}.bak`) }))
        : [];
      if (replace) entries = entries.filter((entry) => entry.generated);
      const kept = entries.filter((entry) => !entry.generated).map((entry) => entry.path);
      if (!on) entries = entries.filter((entry) => !entry.generated);
      else if (!entries.length) entries.push({ path: path.join(install.startup, 'oar-web-relay.cmd'), generated: true, otherInstall: null });
      return { kept, backedUp, changed: true };
    },
  };
  const state = { taskStatus: 'missing', taskName: 'oar-relay', generated: false, handMade: [], launcherPath: null, readError: null, ...boot };
  const copiesOf = () => state.handMade.map((entry) => ({ path: entry.path, backup: `${entry.path}.bak` }));
  install.boot = {
    answer: true,
    state,
    getState: async () => ({ supported: true, ...state }),
    // As the service: a hand-made boot entry stops it unless `replace`.
    requestEnable: async ({ onSettled, replace = false } = {}) => {
      calls.push(`elevate:enable${replace ? ':replace' : ''}`);
      if (state.handMade.length && !replace) return { ...state, accepted: false, refused: 'hand-made' };
      // As the service does before the prompt.
      fs.writeFileSync(install.launcher, 'generated launcher');
      setImmediate(() => {
        const copies = install.boot.answer === true ? copiesOf() : [];
        if (install.boot.answer === true) {
          Object.assign(state, { taskStatus: 'ready', generated: true, launcherPath: install.launcher, handMade: [] });
          entries = entries.filter((entry) => !entry.generated);
        }
        // As the service: a decline or a failure puts the launcher back (there
        // was none); a task not read back keeps it.
        else if (install.boot.answer !== 'unverified') fs.rmSync(install.launcher, { force: true });
        onSettled?.(install.boot.answer === true, { kept: [], copies, ...outcomeOf(install.boot.answer) });
      });
      return { ...state, accepted: true };
    },
    requestDisable: async ({ onSettled, replace = false } = {}) => {
      calls.push(`elevate:disable${replace ? ':replace' : ''}`);
      if (!state.generated && !(replace && state.handMade.length)) return { ...state, accepted: false };
      setImmediate(() => {
        const copies = install.boot.answer === true && replace ? copiesOf() : [];
        if (install.boot.answer === true) Object.assign(state, { taskStatus: 'missing', generated: false, launcherPath: null, handMade: [] });
        onSettled?.(install.boot.answer === true, { copies, ...outcomeOf(install.boot.answer, 'removed') });
      });
      return { ...state, accepted: true };
    },
  };
  return install;
}

// What the service reports for an answer: true confirmed, false declined,
// 'fail' a sweep that failed, 'unverified' confirmed but the task not read back.
function outcomeOf(answer, what = 'registered') {
  if (answer === 'fail') return { declined: false, error: 'The boot task could not be registered (schtasks failed). Afterwards: scheduled task \\oar-relay is not registered.' };
  if (answer === 'unverified') {
    return { unverified: true, error: `The administrator prompt was confirmed and the boot task should be ${what}, but it could not be read back to check (x). Nothing was undone; the launcher stays.` };
  }
  return { declined: answer === false };
}

const generatedSignin = (install) => ({ path: path.join(install.startup, 'oar-web-relay.cmd'), generated: true, otherInstall: null });
const BOOT_READY = (install) => ({ taskStatus: 'ready', generated: true, launcherPath: install.launcher });
const handMadeLauncher = (install, otherInstall = null) => ({ path: install.launcher, task: null, otherInstall });
const OWN_TASK = { path: TASK, task: 'oar-relay', otherInstall: null };

// ─── oar autostart on Windows ────────────────────────────────────────────────

test('autostart status names the mode and each entry, generated or hand-made', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, {
    signin: [{ path: path.join(install.startup, 'oar-web-relay.cmd'), generated: false }],
    boot: { ...BOOT_READY(install), generated: false, handMade: [handMadeLauncher(install)] },
  });
  const result = await runAutostart(install.options({ argv: ['status'] }));
  assert.deepEqual(result, { code: 0, reason: 'autostart-status', mode: 'boot' });
  assert.match(install.output(), /Autostart: at boot, before anyone signs in/);
  assert.match(install.output(), /oar-web-relay\.cmd \(hand-made\)/);
  assert.match(install.output(), /scheduled task \\oar-relay \(generated by OAR\)/);
  assert.match(install.output(), /oar-web-relay-launcher\.cmd \(hand-made\)/);
  assert.deepEqual(install.calls, [], 'status changes nothing');
});

test('sign-in to boot is one administrator prompt, and the sign-in entry goes', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  const result = await runAutostart(install.options({ argv: ['boot'] }));
  assert.deepEqual(result, { code: 0, reason: 'autostart-boot' });
  assert.deepEqual(install.calls, ['elevate:enable', 'signin:false']);
  assert.deepEqual(install.signin.listEntries(), []);
  assert.match(install.output(), /starts at boot, before anyone signs in/);
});

test('a declined prompt leaves everything as it was, with one line', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  install.boot.answer = false;
  const result = await runAutostart(install.options({ argv: ['boot'] }));
  assert.deepEqual(result, { code: 1, reason: 'not-elevated' });
  assert.deepEqual(install.calls, ['elevate:enable']);
  assert.equal(fs.existsSync(install.launcher), false, 'the launcher written for the prompt is gone again');
  assert.deepEqual(install.signin.listEntries(), [generatedSignin(install)]);
  const errors = install.lines.filter((line) => line.startsWith('[oar] Nothing changed'));
  assert.deepEqual(errors, ['[oar] Nothing changed: the administrator prompt was declined.']);

  // Leaving boot mode, declined: the task stays and no sign-in entry is written.
  const booted = makeInstall(t);
  windowsDoubles(booted, { boot: BOOT_READY(booted) });
  booted.boot.answer = false;
  assert.deepEqual(await runAutostart(booted.options({ argv: ['signin'] })), { code: 1, reason: 'not-elevated' });
  assert.deepEqual(booted.calls, ['elevate:disable']);
  assert.equal(booted.boot.state.taskStatus, 'ready');
});

test('boot to sign-in or off removes the generated task first, with one prompt; sign-in alone needs none', async (t) => {
  for (const target of ['signin', 'off']) {
    const install = makeInstall(t);
    windowsDoubles(install, { boot: BOOT_READY(install) });
    assert.deepEqual(await runAutostart(install.options({ argv: [target] })), { code: 0, reason: `autostart-${target}` });
    assert.deepEqual(install.calls, ['elevate:disable', `signin:${target === 'signin'}`]);
  }
  const install = makeInstall(t);
  windowsDoubles(install);
  assert.deepEqual(await runAutostart(install.options({ argv: ['signin'] })), { code: 0, reason: 'autostart-signin' });
  assert.deepEqual(install.calls, ['signin:true'], 'no elevation for sign-in mode');
  assert.match(install.output(), /starts when you sign in to Windows/);
});

test('a hand-made entry of another mode is never deleted: nothing changes, and it is named', async (t) => {
  // A customised boot setup (the launcher waits for a drive) and sign-in or off picked.
  for (const target of ['signin', 'off']) {
    const install = makeInstall(t);
    windowsDoubles(install, { boot: { ...BOOT_READY(install), generated: false, handMade: [handMadeLauncher(install)] } });
    assert.deepEqual(await runAutostart(install.options({ argv: [target] })), { code: 1, reason: 'hand-made' });
    assert.deepEqual(install.calls, [], 'no prompt, no delete');
    assert.match(install.output(), /Left as it is: .*oar-web-relay-launcher\.cmd \(hand-made\)\./);
    assert.match(install.output(), /Nothing changed: OAR does not delete or overwrite an autostart entry it did not make/);
  }
  // A hand-made sign-in entry and boot picked; a foreign task under our name and boot picked.
  const signin = makeInstall(t);
  windowsDoubles(signin, { signin: [{ path: path.join(signin.startup, 'oar-web-relay.cmd'), generated: false }] });
  assert.deepEqual(await runAutostart(signin.options({ argv: ['boot'] })), { code: 1, reason: 'hand-made' });
  assert.deepEqual(signin.calls, []);
  const foreign = makeInstall(t);
  windowsDoubles(foreign, { boot: { taskStatus: 'foreign', handMade: [OWN_TASK] } });
  assert.deepEqual(await runAutostart(foreign.options({ argv: ['boot'] })), { code: 1, reason: 'hand-made' });
  assert.deepEqual(foreign.calls, []);
});

test('the mode a hand-made entry already serves stays; the generated leftovers of the other mode go', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, {
    signin: [generatedSignin(install)],
    boot: { ...BOOT_READY(install), generated: false, handMade: [handMadeLauncher(install)] },
  });
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'] })), { code: 0, reason: 'autostart-boot' });
  assert.deepEqual(install.calls, ['signin:false'], 'no prompt: the task is there');
});

test('a boot task that cannot be read changes nothing', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { boot: { taskStatus: 'unknown', readError: 'schtasks could not be run' } });
  assert.deepEqual(await runAutostart(install.options({ argv: ['off'] })), { code: 1, reason: 'unknown' });
  assert.deepEqual(install.calls, []);
});

// ─── an entry of another install, and --replace ──────────────────────────────

const STALE = (install) => ({ path: path.join(install.startup, 'oar-web-relay.cmd'), generated: false, otherInstall: 'C:\\old-prefix\\oar' });

test('status and the switch say what a stale entry starts and how to replace it; nothing repairs it on its own', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [STALE(install)] });
  await runAutostart(install.options({ argv: ['status'] }));
  assert.match(install.output(), /oar-web-relay\.cmd \(hand-made: it starts the OAR install in C:\\old-prefix\\oar\)/);
  assert.match(install.output(), /To replace them with its own, keeping a copy: oar autostart signin\|boot\|off --replace/);

  install.lines.length = 0;
  assert.deepEqual(await runAutostart(install.options({ argv: ['signin'] })), { code: 0, reason: 'autostart-signin' });
  assert.deepEqual(install.calls, ['signin:true']);
  assert.deepEqual(install.signin.listEntries(), [STALE(install)], 'left as it is');
  assert.match(install.output(), /Left as it is: .*\(hand-made: it starts the OAR install in C:\\old-prefix\\oar\)\. To replace it, keeping a copy: oar autostart signin --replace/);

  install.lines.length = 0;
  install.calls.length = 0;
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'] })), { code: 1, reason: 'hand-made' });
  assert.deepEqual(install.calls, []);
  assert.match(install.output(), /Nothing changed: .*oar autostart boot --replace\./);
});

test('--replace keeps a copy of each hand-made entry and writes the generated one, with the one prompt boot needs', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [STALE(install)] });
  assert.deepEqual(await runAutostart(install.options({ argv: ['signin', '--replace'] })), { code: 0, reason: 'autostart-signin' });
  assert.deepEqual(install.calls, ['signin:true:replace'], 'no prompt for sign-in');
  assert.match(install.output(), new RegExp(`Kept a copy of .*oar-web-relay\\.cmd as ${install.stateRoot.replace(/[\\.]/g, '\\$&')}.*oar-web-relay\\.cmd\\.bak`));
  assert.deepEqual(install.signin.listEntries().map((entry) => entry.generated), [true]);

  // Boot over a foreign task and a stale sign-in entry: one prompt replaces the task, then the entry goes.
  const boot = makeInstall(t);
  windowsDoubles(boot, { signin: [STALE(boot)], boot: { taskStatus: 'foreign', handMade: [OWN_TASK] } });
  assert.deepEqual(await runAutostart(boot.options({ argv: ['boot', '--replace'] })), { code: 0, reason: 'autostart-boot' });
  assert.deepEqual(boot.calls, ['elevate:enable:replace', 'signin:false:replace']);
  assert.match(boot.output(), /Kept a copy of scheduled task \\oar-relay as /);
  assert.deepEqual(boot.signin.listEntries(), []);

  // Leaving a customised boot setup: one prompt, the hand-made launcher copied first.
  const leave = makeInstall(t);
  windowsDoubles(leave, { boot: { ...BOOT_READY(leave), generated: false, handMade: [handMadeLauncher(leave)] } });
  assert.deepEqual(await runAutostart(leave.options({ argv: ['off', '--replace'] })), { code: 0, reason: 'autostart-off' });
  assert.deepEqual(leave.calls, ['elevate:disable:replace', 'signin:false:replace']);
  assert.match(leave.output(), /Kept a copy of .*oar-web-relay-launcher\.cmd as /);

  // A declined prompt: nothing replaced, nothing copied.
  const declined = makeInstall(t);
  windowsDoubles(declined, { signin: [STALE(declined)], boot: { taskStatus: 'foreign', handMade: [OWN_TASK] } });
  declined.boot.answer = false;
  assert.deepEqual(await runAutostart(declined.options({ argv: ['boot', '--replace'] })), { code: 1, reason: 'not-elevated' });
  assert.deepEqual(declined.calls, ['elevate:enable:replace']);
  assert.deepEqual(declined.signin.listEntries(), [STALE(declined)]);
});

// ─── other platforms ─────────────────────────────────────────────────────────

test('on Linux autostart is the systemd service; on macOS and in a checkout it is not supported', async (t) => {
  const install = makeInstall(t);
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'], platform: 'linux' })), { code: 1, reason: 'no-systemd' });
  assert.match(install.output(), /No systemd user session here/);
  assert.deepEqual(await runAutostart(install.options({ argv: ['status'], platform: 'darwin' })), { code: 1, reason: 'unsupported' });
  assert.match(install.output(), /Autostart is not supported on macOS yet/);
  fs.mkdirSync(path.join(install.packageRoot, '.git'));
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'] })), { code: 1, reason: 'git-checkout' });
});

test('the command line takes autostart, uninstall and setup --autostart', async () => {
  const calls = [];
  const commands = Object.fromEntries(['autostart', 'uninstall', 'setup'].map((name) => [name, async ({ argv }) => { calls.push([name, argv]); return { code: 0 }; }]));
  const logger = { log() {}, error() {} };
  for (const argv of [['autostart', 'boot'], ['autostart'], ['uninstall', '--purge'], ['setup', '--autostart', 'off'], ['--autostart', 'signin', 'setup']]) {
    assert.equal((await main({ argv, commands, logger })).code, 0);
  }
  assert.deepEqual(calls, [
    ['autostart', ['boot']], ['autostart', []], ['uninstall', ['--purge']], ['setup', ['--autostart', 'off']], ['setup', ['--autostart', 'signin']],
  ]);
  assert.equal((await main({ argv: ['autostart', 'boot', '--replace'], commands, logger })).code, 0);
  assert.deepEqual(calls.at(-1), ['autostart', ['boot', '--replace']]);
  for (const argv of [['autostart', 'reboot'], ['uninstall', '--yes'], ['setup', '--replace'], ['uninstall', '--replace']]) {
    assert.equal((await main({ argv, commands, logger })).code, 2);
  }
});

// ─── oar setup ───────────────────────────────────────────────────────────────

test('setup in a terminal asks for the autostart mode, the current one as its default', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  const prompter = scripted([false, '', '', '2']);
  const result = await runSetup(install.options({ argv: [], stdin: { isTTY: true }, prompter }));
  assert.equal(result.code, 0);
  assert.match(prompter.asked.at(-1), /^Autostart: 1 = at sign-in, 2 = at boot, before anyone signs in \(one administrator prompt\), 3 = off \[1\]: $/);
  assert.deepEqual(install.calls, ['elevate:enable', 'signin:false'], 'boot: exactly one prompt');

  // Enter keeps the mode there is, and changes nothing.
  install.calls.length = 0;
  const again = scripted([false, '', '', '']);
  await runSetup(install.options({ argv: [], stdin: { isTTY: true }, prompter: again }));
  assert.match(again.asked.at(-1), /\[2\]: $/);
  assert.deepEqual(install.calls, []);
});

test('setup --autostart sets the mode without a question; a wrong value or a declined prompt is an error', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  assert.equal((await runSetup(install.options({ argv: ['--autostart', 'signin'] }))).code, 0);
  assert.deepEqual(install.calls, ['signin:true']);
  assert.deepEqual(await runSetup(install.options({ argv: ['--autostart', 'later'] })), { code: 2, reason: 'bad-autostart' });

  install.boot.answer = false;
  assert.deepEqual(await runSetup(install.options({ argv: ['--autostart', 'boot'] })), { code: 1, reason: 'not-elevated' });
  assert.match(install.output(), /The config is written; the autostart step did not go through/);
});

test('setup asks nothing about autostart off Windows, without a terminal, or with value flags', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  await runSetup(install.options({ argv: [], platform: 'linux', stdin: { isTTY: true }, prompter: scripted([false, '', '']) }));
  await runSetup(install.options({ argv: [] }));
  await runSetup(install.options({ argv: ['--port', '4100'], stdin: { isTTY: true } }));
  assert.deepEqual(install.calls, []);
});

// ─── oar uninstall ───────────────────────────────────────────────────────────

test('uninstall stops the relay, removes the generated entries, keeps hand-made ones and the data, and leaves npm to a helper', async (t) => {
  const install = makeInstall(t);
  const handMade = { path: path.join(install.startup, 'copilot-remote-web-relay.cmd'), generated: false, otherInstall: null };
  windowsDoubles(install, { signin: [generatedSignin(install), handMade], boot: BOOT_READY(install) });
  fs.mkdirSync(path.join(install.stateRoot, 'data'));
  fs.writeFileSync(path.join(install.stateRoot, 'data', 'copilot.db'), 'db');
  const relay = fakeRelay();
  const result = await runUninstall(install.options({ argv: [], fetchImpl: relay.fetch }));
  assert.deepEqual(result, { code: 0, reason: 'uninstalled' });
  assert.equal(relay.running, false, 'the relay is stopped');
  assert.deepEqual(install.calls, ['elevate:disable', 'signin:false']);
  assert.deepEqual(install.signin.listEntries(), [handMade]);
  assert.match(install.output(), /Left as it is: .*copilot-remote-web-relay\.cmd \(hand-made\)/);
  assert.equal(fs.readFileSync(path.join(install.stateRoot, 'data', 'copilot.db'), 'utf8'), 'db', 'the data stays');
  assert.match(install.output(), new RegExp(`Your data stays in ${install.stateRoot.replace(/[\\.]/g, '\\$&')}`));

  assert.equal(install.spawned.length, 1);
  const [helper] = install.spawned;
  assert.equal(helper.command, 'C:\\node\\node.exe');
  assert.deepEqual(helper.args.slice(0, 2), ['-e', UNINSTALL_HELPER_SOURCE]);
  assert.deepEqual(helper.args.slice(2), ['4242', path.join(install.stateRoot, 'logs', 'oar-uninstall.log'), install.root, 'npm.cmd', 'uninstall', '-g', '@oar-sh/oar']);
  assert.equal(helper.spawnOptions.detached, true, 'it outlives oar');
  assert.equal(helper.spawnOptions.cwd, install.env.HOME, 'not inside the package npm removes');
});

test('uninstall leaves a hand-made task and the launcher it runs; a launcher no task runs goes', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { boot: { ...BOOT_READY(install), generated: false, handMade: [OWN_TASK] } });
  fs.writeFileSync(install.launcher, 'generated launcher');
  assert.equal((await runUninstall(install.options({ argv: [] }))).code, 0);
  assert.deepEqual(install.calls, ['signin:false'], 'no prompt, no delete');
  assert.ok(fs.existsSync(install.launcher));
  assert.match(install.output(), /Left as it is: scheduled task \\oar-relay \(hand-made\)/);

  const stray = makeInstall(t);
  windowsDoubles(stray, { boot: { launcherPath: stray.launcher } });
  fs.writeFileSync(stray.launcher, 'generated launcher');
  assert.equal((await runUninstall(stray.options({ argv: [] }))).code, 0);
  assert.equal(fs.existsSync(stray.launcher), false);
});

// The Copilot wrapper as `oar --install-extension` of this install writes it.
async function installWrapper(install) {
  const entry = path.join(install.packageRoot, '.github', 'extensions', 'web-relay', 'extension.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  assert.equal((await main({ ...install.options(), argv: ['--install-extension'] })).code, 0);
  const wrapper = path.join(install.env.COPILOT_CONFIG_HOME, 'extensions', 'web-relay', 'extension.mjs');
  return { wrapper, source: fs.readFileSync(wrapper, 'utf8') };
}

test('uninstall removes the Copilot wrapper OAR wrote for this install, now or before the rename', async (t) => {
  for (const earlier of [false, true]) {
    const install = makeInstall(t);
    windowsDoubles(install);
    const { wrapper, source } = await installWrapper(install);
    if (earlier) {
      fs.writeFileSync(wrapper, source
        .replace('Auto-generated by oar ', 'Auto-generated by copilot-remote ')
        .replace('`oar --install-extension`', '`copilot-remote --install-extension`'));
    }
    assert.equal((await runUninstall(install.options({ argv: [] }))).code, 0);
    assert.equal(fs.existsSync(wrapper), false);
    assert.match(install.output(), /Done: removed .*web-relay[\\/]extension\.mjs/);
  }
});

test('uninstall leaves a hand-edited wrapper, or one of another install, and names it', async (t) => {
  for (const [edit, wanted] of [
    [(source) => `${source}console.log('mine');\n`, /Left as it is: .*extension\.mjs \(hand-made\)$/m],
    [(source) => source.replace(/const PACKAGE_ROOT = .*;/, 'const PACKAGE_ROOT = "C:\\\\old-prefix\\\\oar";'), /extension\.mjs \(hand-made: it starts the OAR install in C:\\old-prefix\\oar\)/],
  ]) {
    const install = makeInstall(t);
    windowsDoubles(install);
    const { wrapper, source } = await installWrapper(install);
    fs.writeFileSync(wrapper, edit(source));
    assert.equal((await runUninstall(install.options({ argv: [] }))).code, 0);
    assert.equal(fs.readFileSync(wrapper, 'utf8'), edit(source), 'byte-identical');
    assert.match(install.output(), wanted);
  }
});

test('uninstall stops at a failed step and says what is done and what is left', async (t) => {
  // A declined prompt: the relay was stopped, nothing else changed.
  const declined = makeInstall(t);
  windowsDoubles(declined, { signin: [generatedSignin(declined)], boot: BOOT_READY(declined) });
  declined.boot.answer = false;
  const relay = fakeRelay();
  assert.deepEqual(await runUninstall(declined.options({ argv: [], fetchImpl: relay.fetch })), { code: 1, reason: 'autostart' });
  assert.deepEqual(declined.calls, ['elevate:disable']);
  assert.deepEqual(declined.spawned, [], 'the package stays');
  assert.match(declined.output(), /Done: stopped the relay\./);
  assert.match(declined.output(), /Not done: the autostart entries; the package\. Run oar uninstall again/);

  // A relay still busy: nothing removed at all.
  const busy = makeInstall(t);
  windowsDoubles(busy, { signin: [generatedSignin(busy)] });
  assert.deepEqual(await runUninstall(busy.options({ argv: [], fetchImpl: fakeRelay({ busy: true }).fetch })), { code: 1, reason: 'relay-running' });
  assert.deepEqual(busy.calls, []);
  assert.deepEqual(busy.spawned, []);
  assert.match(busy.output(), /Not done: the autostart entries; the package\./);
});

test('uninstall --purge deletes the state root only after the typed word, and asks apart for what lies elsewhere', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'rescued-package-data', '2026'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'copilot.db'), 'db');
  const elsewhere = path.join(install.root, 'my-data');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'copilot.db'), 'db');
  fs.writeFileSync(path.join(install.stateRoot, 'config.json'), JSON.stringify({ ...CONFIG, dataDir: elsewhere }));

  // Anything but the word changes nothing, not even the relay or the entries.
  const refused = scripted(['yes']);
  assert.deepEqual(await runUninstall(install.options({ argv: ['--purge'], prompter: refused })), { code: 1, reason: 'purge-not-confirmed' });
  assert.deepEqual(install.calls, []);
  assert.ok(fs.existsSync(path.join(dataDir, 'copilot.db')));

  // The word, then no for the rescued data and no for the folder outside.
  const prompter = scripted(['delete', false, false]);
  assert.deepEqual(await runUninstall(install.options({ argv: ['--purge'], prompter })), { code: 0, reason: 'uninstalled' });
  assert.match(prompter.asked[1], /rescued-package-data/);
  assert.match(prompter.asked[2], /my-data \(a data folder outside the state root\)/);
  assert.equal(fs.existsSync(path.join(dataDir, 'copilot.db')), false);
  assert.equal(fs.existsSync(path.join(install.stateRoot, 'config.json')), false);
  assert.ok(fs.existsSync(path.join(dataDir, 'rescued-package-data', '2026')), 'kept without its own yes');
  assert.ok(fs.existsSync(elsewhere), 'never deleted without its own yes');
  assert.match(install.output(), /Kept: .*rescued-package-data/);
  assert.equal(install.spawned.length, 1);
  assert.equal(install.spawned[0].args[3], path.join(os.tmpdir(), 'oar-uninstall.log'), 'the log is not in the deleted folder');
});

test('uninstall --purge with yes to each deletes those too, and refuses a state root that is no folder of its own', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  const elsewhere = path.join(install.root, 'my-data');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'copilot.db'), 'db');
  fs.writeFileSync(path.join(install.stateRoot, 'config.json'), JSON.stringify({ ...CONFIG, dataDir: elsewhere }));
  await runUninstall(install.options({ argv: ['--purge'], prompter: scripted(['delete', true]) }));
  assert.equal(fs.existsSync(install.stateRoot), false);
  assert.equal(fs.existsSync(elsewhere), false);

  const home = makeInstall(t);
  windowsDoubles(home);
  const options = home.options({ argv: ['--purge'] });
  options.env = { ...options.env, OAR_STATE_ROOT: home.env.HOME };
  fs.mkdirSync(home.env.HOME, { recursive: true });
  assert.deepEqual(await runUninstall(options), { code: 1, reason: 'purge-unsafe' });
  assert.ok(fs.existsSync(home.env.HOME));
});

test('uninstall on Linux removes the unit oar service wrote and keeps a hand-made one', async (t) => {
  const { buildSystemdUnit } = await import('./services/oar-cli-helpers.mjs');
  for (const handMade of [false, true]) {
    const install = makeInstall(t);
    const unitPath = path.join(install.env.HOME, '.config', 'systemd', 'user', 'oar.service');
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const unit = buildSystemdUnit({
      nodeBin: '/opt/node/bin/node',
      packageRoot: install.packageRoot,
      configPath: path.join(install.stateRoot, 'config.json'),
      dataDir: path.join(install.stateRoot, 'data'),
      logDir: path.join(install.stateRoot, 'logs'),
      pathEnv: '/usr/bin',
    });
    fs.writeFileSync(unitPath, handMade ? unit.replace('RestartSec=5', 'RestartSec=30') : unit);
    const systemctl = [];
    const result = await runUninstall(install.options({
      argv: [], platform: 'linux', spawnSyncImpl: (command, args) => { systemctl.push([command, ...args].join(' ')); return { status: 0 }; },
    }));
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(unitPath), handMade);
    assert.equal(systemctl.includes('systemctl --user disable --now oar'), !handMade);
  }
});

test('the uninstall helper waits for oar to end, then runs npm and logs the outcome', { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-uninstall-helper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'oar-uninstall.log');
  const oar = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)']);
  const scope = path.join(root, '@oar-sh');
  fs.mkdirSync(path.join(scope, '.oar-a1b2c3'), { recursive: true });
  const helper = spawn(process.execPath, ['-e', UNINSTALL_HELPER_SOURCE, String(oar.pid), log, scope, 'node', '--version'], { stdio: 'ignore', windowsHide: true });
  const started = Date.now();
  await new Promise((resolve) => helper.on('exit', resolve));
  assert.ok(Date.now() - started >= 700, 'not before oar has ended');
  const written = fs.readFileSync(log, 'utf8');
  assert.match(written, /node --version: exit 0\nv\d+/);
  assert.match(written, /Left behind: .*\.oar-a1b2c3 holds files a program still ran from .* Delete it once nothing runs from it any more, at the latest after a reboot\./);
});

test('uninstall in a checkout removes nothing', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  fs.mkdirSync(path.join(install.packageRoot, '.git'));
  assert.deepEqual(await runUninstall(install.options({ argv: [] })), { code: 1, reason: 'git-checkout' });
  assert.deepEqual(install.spawned, []);
});

// ─── fix round: a sweep that fails, a relay that holds its lock, what --purge refuses ─

test('a sweep that fails is reported as a failure, not as a declined prompt', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  install.boot.answer = 'fail';
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'] })), { code: 1, reason: 'elevation-failed' });
  assert.match(install.output(), /\[oar\] The boot task could not be registered \(schtasks failed\)\. Afterwards: scheduled task \\oar-relay is not registered\./);
  assert.doesNotMatch(install.output(), /declined/);
  assert.deepEqual(install.signin.listEntries(), [generatedSignin(install)], 'the sign-in entry stays');
});

test('a boot task not read back after a confirmed prompt is no success, and nothing is undone or claimed', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)] });
  install.boot.answer = 'unverified';
  assert.deepEqual(await runAutostart(install.options({ argv: ['boot'] })), { code: 1, reason: 'unverified' });
  assert.match(install.output(), /\[oar\] The administrator prompt was confirmed and the boot task should be registered, but it could not be read back/);
  assert.doesNotMatch(install.output(), /starts at boot|declined/);
  assert.ok(fs.existsSync(install.launcher), 'the launcher stays');
  assert.deepEqual(install.signin.listEntries(), [generatedSignin(install)], 'the sign-in entry stays');

  // Uninstall stops there, and does not say the task was removed.
  const uninstall = makeInstall(t);
  windowsDoubles(uninstall, { signin: [generatedSignin(uninstall)], boot: BOOT_READY(uninstall) });
  uninstall.boot.answer = 'unverified';
  assert.deepEqual(await runUninstall(uninstall.options({ argv: [], fetchImpl: fakeRelay().fetch })), { code: 1, reason: 'autostart' });
  assert.match(uninstall.output(), /Uninstall stopped: The administrator prompt was confirmed and the boot task should be removed, but it could not be read back to check \(x\)\. Nothing was undone; the launcher stays\./);
  assert.doesNotMatch(uninstall.output(), /removed the scheduled task|not removed/);
  assert.deepEqual(uninstall.spawned, [], 'the package stays');
});

// A relay of this install that holds its lock: format 2, as the server writes it.
function holdLock(install, pid, { takeover = false } = {}) {
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ pid, format: 2, startedAt: new Date().toISOString() }));
  if (takeover) fs.writeFileSync(path.join(dataDir, TAKEOVER_PROGRESS_FILE), JSON.stringify({ pid, from: 'the package database', bytes: 1048576 }));
  fs.writeFileSync(path.join(dataDir, 'copilot.db'), 'db');
}

test('uninstall never goes on while a relay holds its lock: one bringing over its database, or one not answering yet', async (t) => {
  for (const takeover of [true, false]) {
    const install = makeInstall(t);
    windowsDoubles(install, { signin: [generatedSignin(install)] });
    holdLock(install, 4321, { takeover });
    const result = await runUninstall(install.options({ argv: ['--purge'], prompter: scripted(['delete']), isProcessAliveImpl: (pid) => pid === 4321 }));
    assert.deepEqual(result, { code: 1, reason: 'relay-running' });
    assert.match(install.output(), takeover
      ? /The relay \(process 4321\) is bringing over its database and does not answer yet/
      : /A relay \(process 4321\) holds .*relay-server\.lock without answering/);
    assert.doesNotMatch(install.output(), /The relay is not running/, 'no line says the opposite');
    assert.ok(fs.existsSync(path.join(install.stateRoot, 'config.json')), 'the config is not deleted either');
    assert.ok(fs.existsSync(path.join(install.stateRoot, 'data', 'copilot.db')), 'nothing purged');
    assert.deepEqual(install.calls, [], 'no autostart entry removed');
    assert.deepEqual(install.spawned, [], 'npm is not started');
  }
});

test('uninstall stops a running relay and waits until its lock is free', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  holdLock(install, 4321);
  const relay = fakeRelay();
  const result = await runUninstall(install.options({ argv: [], fetchImpl: relay.fetch, isProcessAliveImpl: () => relay.running }));
  assert.deepEqual(result, { code: 0, reason: 'uninstalled' });
  assert.equal(install.spawned.length, 1);
});

test('--purge refuses a drive root, the home folder\'s parent, a system folder and a folder without OAR in it, whatever is typed', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  const stranger = path.join(install.root, 'not-oar');
  fs.mkdirSync(stranger);
  fs.writeFileSync(path.join(stranger, 'notes.txt'), 'mine');
  for (const [root, why] of [
    [path.parse(install.root).root, /a drive or file-system root/],
    [path.dirname(install.env.HOME), /the home folder or a folder above it/],
    [install.env.APPDATA, /a system folder or a folder above one/],
    [stranger, /no OAR config or database in it/],
  ]) {
    install.lines.length = 0;
    const options = install.options({ argv: ['--purge'], prompter: scripted([]) });
    options.env = { ...options.env, OAR_STATE_ROOT: root };
    assert.deepEqual(await runUninstall(options), { code: 1, reason: 'purge-unsafe' }, root);
    assert.match(install.output(), why);
    assert.match(install.output(), /Nothing was changed\./);
  }
  assert.equal(fs.readFileSync(path.join(stranger, 'notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(install.calls, []);
  assert.deepEqual(install.spawned, []);

  // A data folder set to the home folder is not even offered.
  fs.mkdirSync(install.env.HOME, { recursive: true });
  fs.writeFileSync(path.join(install.stateRoot, 'config.json'), JSON.stringify({ ...CONFIG, dataDir: install.env.HOME }));
  install.lines.length = 0;
  assert.equal((await runUninstall(install.options({ argv: ['--purge'], prompter: scripted(['delete']) }))).code, 0);
  assert.match(install.output(), /Not deleted, and not offered: .*home \(the home folder or a folder above it\)/);
  assert.ok(fs.existsSync(install.env.HOME));
});

test('setup --autostart in a git checkout says why and changes nothing', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  fs.mkdirSync(path.join(install.packageRoot, '.git'));
  assert.deepEqual(await runSetup(install.options({ argv: ['--autostart', 'boot'] })), { code: 1, reason: 'git-checkout' });
  assert.match(install.output(), /--autostart is for global installs; a git checkout has no autostart/);
  assert.deepEqual(install.calls, []);
});
test('uninstall names the programs that still run from the package and the folder npm leaves for them', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install);
  install.processes = [
    { processId: 4242, commandLine: `node "${path.join(install.packageRoot, 'bin', 'oar.js')}" uninstall` },
    { processId: 5151, commandLine: `"C:\\node\\node.exe" "${path.join(install.packageRoot, 'server', 'session-worker.mjs')}"` },
    { processId: 6262, commandLine: 'C:\\Windows\\explorer.exe' },
  ];
  assert.equal((await runUninstall(install.options({ argv: [] }))).code, 0);
  assert.match(install.output(), new RegExp(`A program still runs from the package \\(process 5151: a session worker, or a CLI it started\\)\\. npm cannot remove the files they hold and leaves them in a hidden \\.oar-\\* folder in ${install.root.replace(/[\\.]/g, '\\$&')}; delete it once they have ended, at the latest after a reboot\\.`));
  const quiet = makeInstall(t);
  windowsDoubles(quiet);
  await runUninstall(quiet.options({ argv: [] }));
  assert.doesNotMatch(quiet.output(), /still runs? from the package/);
});

test('a declined prompt stops uninstall before anything else goes: the launcher and the wrapper stay', async (t) => {
  const install = makeInstall(t);
  windowsDoubles(install, { signin: [generatedSignin(install)], boot: BOOT_READY(install) });
  fs.writeFileSync(install.launcher, 'generated launcher');
  const { wrapper, source } = await installWrapper(install);
  install.boot.answer = false;
  install.lines.length = 0;
  assert.deepEqual(await runUninstall(install.options({ argv: [] })), { code: 1, reason: 'autostart' });
  assert.match(install.output(), /Uninstall stopped: the boot task was not removed: the administrator prompt was declined\./);
  assert.doesNotMatch(install.output(), /removed the scheduled task/);
  assert.equal(fs.readFileSync(install.launcher, 'utf8'), 'generated launcher');
  assert.equal(fs.readFileSync(wrapper, 'utf8'), source);
  assert.deepEqual(install.signin.listEntries(), [generatedSignin(install)]);
  assert.deepEqual(install.spawned, [], 'npm is not started');
});