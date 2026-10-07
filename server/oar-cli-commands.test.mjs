// The `oar` commands (setup, start, stop, restart, status, url, service, the
// dispatch) run for real against a throwaway global-install layout. The relay,
// systemd, Windows and the terminal are fakes, the platform is injected, and
// every writable path points into a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  exitWhenIdle, main, runDoctor, runRestart, runService, runSetup, runStart, runStatus, runStop, runUrl,
} from '../bin/oar.js';
import { PromptAborted } from './services/oar-cli-menu.mjs';

const noFile = () => { throw new Error('ENOENT'); };
const LAN = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.7.20' }] };

// A relay as the commands see it: it answers its status call on one port for
// one token, and a restart request makes it read the config again, as the
// supervisor's new runtime does.
function fakeRelay(install, { port, token, lan = false, running = true, busy = false, fixed = false } = {}) {
  const relay = { port, token, running, busy, requests: [], shutdowns: [], shutdown: 'idle', lan, readyBanner: null };
  relay.loadConfig = () => {
    const config = JSON.parse(fs.readFileSync(install.configPath, 'utf8'));
    Object.assign(relay, { port: config.port, token: config.authToken, lan: config.localhostOnly === false, running: true, shutdown: 'idle' });
  };
  relay.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const auth = String(options.headers?.Authorization || '');
    relay.requests.push({ port: Number(target.port), path: target.pathname, auth });
    if (!relay.running || Number(target.port) !== relay.port) throw new Error('connect ECONNREFUSED');
    if (auth !== `Bearer ${relay.token}`) return { ok: false, status: 401 };
    if (target.pathname === '/api/status') {
      return {
        ok: true,
        json: async () => ({
          cliOnline: false,
          localhostOnly: !relay.lan,
          relayShutdown: { status: relay.shutdown },
          readyBanner: relay.readyBanner,
          remotePath: '',
        }),
      };
    }
    if (target.pathname === '/api/relay/shutdown') {
      const body = JSON.parse(options.body);
      relay.shutdowns.push({ port: Number(target.port), auth, ...body });
      if (relay.busy) relay.shutdown = 'queued';
      else if (body.restart && !fixed) relay.loadConfig();
      else if (!body.restart) relay.running = false;
      return { ok: true, json: async () => ({ ok: true, queue: { processingCount: relay.busy ? 1 : 0 } }) };
    }
    return { ok: false, status: 404 };
  };
  return relay;
}

// systemctl and loginctl of a host with (or without) a systemd user session.
function fakeSystemd(install, { available = true, active = false, relay = null } = {}) {
  const state = { active, calls: [] };
  state.impl = (command, args = []) => {
    const line = [command, ...args].join(' ');
    if (command === 'systemctl') {
      if (!available) return { status: 1 };
      state.calls.push(line);
      if (args.includes('is-active')) return { status: state.active ? 0 : 3 };
      if (args.includes('--now') && args.includes('enable')) { state.active = true; relay?.loadConfig(); }
      if (args.includes('restart')) relay?.loadConfig();
      if (args.includes('stop') || args.includes('disable')) { state.active = false; if (relay) relay.running = false; }
      return { status: 0 };
    }
    if (command === 'loginctl') { state.calls.push(line); return { status: 0 }; }
    return { status: 1 };
  };
  return state;
}

// Answers for the questions of `oar setup`, in order; a test that expects no
// question passes none.
function scripted(answers = []) {
  const asked = [];
  const next = (question) => {
    asked.push(question);
    assert.ok(answers.length, `unexpected question: ${question}`);
    return answers.shift();
  };
  return { asked, line: async (question) => next(question), yesNo: async (question) => next(question) };
}

function makeInstall(t, { config = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-commands-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // No .git beside the package: the layout of a global install.
  const packageRoot = path.join(root, 'pkg');
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot);
  const install = {
    root,
    packageRoot,
    stateRoot,
    homeDir: path.join(root, 'home'),
    configPath: path.join(stateRoot, 'config.json'),
    previousPath: path.join(stateRoot, 'data', 'relay-previous.json'),
    lines: [],
    spawned: [],
    qrCodes: [],
  };
  install.unitPath = path.join(install.homeDir, '.config', 'systemd', 'user', 'oar.service');
  install.readConfig = () => JSON.parse(fs.readFileSync(install.configPath, 'utf8'));
  install.output = () => install.lines.join('\n');
  if (config) fs.writeFileSync(install.configPath, JSON.stringify(config));
  install.options = (overrides = {}) => ({
    packageRoot,
    homeDir: install.homeDir,
    cwd: install.homeDir,
    platform: 'linux',
    env: {
      OAR_STATE_ROOT: stateRoot,
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
      PATH: '/usr/bin',
    },
    logger: { log: (line) => install.lines.push(String(line)), error: (line) => install.lines.push(String(line)) },
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    prompter: scripted(),
    nodeBin: '/opt/node/bin/node',
    userName: 'dev',
    interfaces: LAN,
    readFileImpl: noFile,
    isPortFreeImpl: async () => true,
    isProcessAliveImpl: () => false,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    spawnSyncImpl: () => ({ status: 1 }),
    spawnImpl: (command, args, spawnOptions) => {
      install.spawned.push({ command, args, spawnOptions });
      return { exitCode: null, unref() {} };
    },
    qrImpl: async (url) => { install.qrCodes.push(url); return `QR<${url}>`; },
    pollMs: 2,
    restartWaitMs: 150,
    stopWaitMs: 150,
    lockGraceMs: 10,
    ...overrides,
  });
  return install;
}

const TTY = { isTTY: true };
const EXISTING = { authToken: 'old-token', port: 4100, localhostOnly: true, pollIntervalMs: 3000 };

// ─── dispatch ────────────────────────────────────────────────────────────────

function recordingCommands() {
  const calls = [];
  const commands = {};
  for (const name of ['menu', 'start', 'stop', 'restart', 'status', 'url', 'setup', 'service', 'copilot', 'doctor', 'update']) {
    commands[name] = async ({ argv }) => { calls.push([name, argv]); return { code: 0, reason: name }; };
  }
  return { calls, commands };
}

test('main runs the command the arguments name, wherever it stands', async () => {
  const { calls, commands } = recordingCommands();
  const logger = { log() {}, error() {} };
  for (const argv of [
    ['--port', '3339', 'setup'],
    ['--setup'],
    ['setup', '--defaults', '--start'],
    ['--stop'],
    ['service', 'remove'],
    ['--no-install-extension', '--', '--allow-all'],
    ['copilot'],
    [],
  ]) {
    assert.equal((await main({ argv, commands, logger })).code, 0);
  }
  assert.deepEqual(calls, [
    ['setup', ['--port', '3339']],
    ['setup', []],
    ['setup', ['--defaults', '--start']],
    ['stop', []],
    ['service', ['remove']],
    ['copilot', ['--no-install-extension', '--', '--allow-all']],
    ['copilot', []],
    ['menu', []],
  ]);
});

test('an unknown command or option prints the usage, exits 2 and runs nothing', async () => {
  for (const argv of [['strat'], ['--port', '3339'], ['setup', '--tunnel'], ['--frobnicate'], ['start', '--port', '1']]) {
    const { calls, commands } = recordingCommands();
    const lines = [];
    const result = await main({ argv, commands, logger: { log() {}, error: (line) => lines.push(line) } });
    assert.deepEqual(result, { code: 2, reason: 'usage' });
    assert.deepEqual(calls, []);
    assert.match(lines[0], /^\[oar\] /);
    assert.match(lines.join('\n'), /Usage: oar \[command\]/);
  }
});

test('help prints the usage; Ctrl+C in a prompt ends the command with 130', async () => {
  const lines = [];
  const logger = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  assert.equal((await main({ argv: ['help'], logger })).code, 0);
  assert.match(lines.join('\n'), /oar service install \| remove \| status/);

  lines.length = 0;
  const result = await main({ argv: ['setup'], logger, commands: { setup: async () => { throw new PromptAborted(); } } });
  assert.deepEqual(result, { code: 130, reason: 'interrupted' });
  assert.deepEqual(lines, [], 'no message on Ctrl+C');
});

test('oar without a terminal prints the status and the usage', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await main({ argv: [], ...install.options({ fetchImpl: relay.fetch }) });
  assert.deepEqual(result, { code: 0, reason: 'status' });
  assert.match(install.output(), /The relay is running on port 4100/);
  assert.match(install.output(), /Usage: oar \[command\]/);
});

// ─── setup: a fresh config ───────────────────────────────────────────────────

test('setup without a terminal writes a local config on port 3333 and asks nothing', async (t) => {
  const install = makeInstall(t);
  const result = await runSetup(install.options({ argv: [] }));
  assert.deepEqual(result, { code: 0, reason: 'setup-complete' });
  const config = install.readConfig();
  assert.equal(config.localhostOnly, true);
  assert.equal(config.port, 3333);
  assert.match(config.authToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(config.cloudflaredTunnel, undefined, 'the tunnel is not set up here any more');
  assert.match(install.output(), new RegExp(`Relay URL: http://localhost:3333/\\?token=${config.authToken}`));
  assert.deepEqual(install.qrCodes, [], 'no QR code for a localhost URL');
  assert.match(install.output(), /This machine only\. For a phone/);
  assert.match(install.output(), /Start the relay with: oar start/);
  assert.equal(fs.existsSync(install.unitPath), false, 'no service without --start');
});

test('setup in a terminal asks access and port for a fresh config, not the token', async (t) => {
  const install = makeInstall(t);
  const prompter = scripted(['2', '']);
  const result = await runSetup(install.options({ argv: [], stdin: TTY, prompter }));
  assert.equal(result.code, 0);
  assert.equal(prompter.asked.length, 2);
  assert.match(prompter.asked[0], /Access: 1 = this machine only, 2 = LAN .*\[1\]: $/);
  assert.equal(prompter.asked[1], 'Port [3333]: ');
  const config = install.readConfig();
  assert.equal(config.localhostOnly, false);
  assert.equal(config.port, 3333);
  // LAN access: the LAN address in the URL and in the QR code.
  const url = `http://192.168.7.20:3333/?token=${config.authToken}`;
  assert.ok(install.lines.includes(`[oar] Relay URL: ${url}`));
  assert.deepEqual(install.qrCodes, [url]);
});

test('a fresh config takes the first free port, in a terminal as its default and with --defaults by itself', async (t) => {
  const taken = new Set([3333, 3334]);
  const isPortFreeImpl = async (port) => !taken.has(port);

  const asked = makeInstall(t);
  const prompter = scripted(['', '']);
  await runSetup(asked.options({ argv: [], stdin: TTY, prompter, isPortFreeImpl }));
  assert.equal(prompter.asked[1], 'Port [3335]: ');
  assert.equal(asked.readConfig().port, 3335);

  const silent = makeInstall(t);
  await runSetup(silent.options({ argv: ['--defaults'], stdin: TTY, isPortFreeImpl }));
  assert.equal(silent.readConfig().port, 3335);
  assert.equal(silent.readConfig().localhostOnly, true);
  assert.match(silent.output(), /Port 3333 is in use — using 3335\./);
});

test('setup flags set their value without a question, in a terminal too', async (t) => {
  const install = makeInstall(t);
  const result = await runSetup(install.options({ argv: ['--port', '4200', '--lan'], stdin: TTY }));
  assert.equal(result.code, 0);
  assert.equal(install.readConfig().port, 4200);
  assert.equal(install.readConfig().localhostOnly, false);

  const equals = makeInstall(t);
  await runSetup(equals.options({ argv: ['--port=4201', '--local'] }));
  assert.equal(equals.readConfig().port, 4201);
  assert.equal(equals.readConfig().localhostOnly, true);
});

test('setup refuses a port that is no port, both access flags, and a port in use', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const before = fs.readFileSync(install.configPath, 'utf8');
  for (const text of ['abc', '0', '70000', '33x']) {
    const result = await runSetup(install.options({ argv: ['--port', text] }));
    assert.deepEqual(result, { code: 2, reason: 'bad-port' }, text);
  }
  assert.deepEqual(await runSetup(install.options({ argv: ['--lan', '--local'] })), { code: 2, reason: 'bad-access' });
  const taken = await runSetup(install.options({ argv: ['--port', '4300'], isPortFreeImpl: async (port) => port !== 4300 }));
  assert.deepEqual(taken, { code: 1, reason: 'port-taken' });
  assert.match(install.output(), /Port 4300 is in use by another program\. Pick another port\./);
  assert.equal(fs.readFileSync(install.configPath, 'utf8'), before, 'the config is untouched');
});

// ─── setup: an existing config ───────────────────────────────────────────────

test('setup on an existing config asks all three, shows the current values, and Enter keeps them', async (t) => {
  const install = makeInstall(t, { config: { ...EXISTING, localhostOnly: false, customKey: 'kept' } });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', lan: true });
  const prompter = scripted([false, '', '']);
  const result = await runSetup(install.options({ argv: [], stdin: TTY, prompter, fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.match(prompter.asked[0], /New auth token\? It signs every device out\./);
  assert.match(prompter.asked[1], /\[2\]: $/);
  assert.equal(prompter.asked[2], 'Port [4100]: ');
  assert.equal(prompter.asked.length, 3, 'nothing changed, so no restart question');
  const config = install.readConfig();
  assert.deepEqual(
    [config.authToken, config.port, config.localhostOnly, config.customKey],
    ['old-token', 4100, false, 'kept'],
  );
  assert.deepEqual(relay.shutdowns, []);
  assert.doesNotMatch(install.output(), /Start the relay with/);
});

test('setup --defaults keeps everything of an existing config', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--defaults'], stdin: TTY, fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.equal(install.readConfig().authToken, 'old-token');
  assert.equal(install.readConfig().port, 4100);
  assert.equal(install.readConfig().localhostOnly, true);
  assert.deepEqual(relay.shutdowns, []);
});

test('the port question asks again for a bad or taken port and takes the running relay\'s own', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const prompter = scripted([false, '', 'ninety', '4300', '4400']);
  await runSetup(install.options({
    argv: [], stdin: TTY, prompter, isPortFreeImpl: async (port) => port !== 4300,
  }));
  assert.equal(install.readConfig().port, 4400);
  assert.match(install.output(), /A port is a number from 1 to 65535\./);
  assert.match(install.output(), /Port 4300 is in use by another program\./);

  // Nothing is free, yet the port the install's own relay holds is accepted.
  const own = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(own, { port: 4100, token: 'old-token' });
  const result = await runSetup(own.options({ argv: ['--port', '4100'], fetchImpl: relay.fetch, isPortFreeImpl: async () => false }));
  assert.equal(result.code, 0);
  assert.equal(own.readConfig().port, 4100);
});

// ─── setup: applying a change to the running relay ───────────────────────────

test('a new token restarts the running relay with the old token and waits for the new one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--new-token'], fetchImpl: relay.fetch }));
  assert.deepEqual(result, { code: 0, reason: 'setup-complete' });
  const token = install.readConfig().authToken;
  assert.notEqual(token, 'old-token');
  assert.deepEqual(relay.shutdowns, [
    { port: 4100, auth: 'Bearer old-token', restart: true, reason: 'oar-cli', requestedBy: 'oar-cli' },
  ]);
  assert.deepEqual(relay.requests.at(-1), { port: 4100, path: '/api/status', auth: `Bearer ${token}` });
  assert.match(install.output(), /The relay restarted\./);
  assert.equal(fs.existsSync(install.previousPath), false);
  assert.equal(install.output().split('old-token').length, 1, 'the old token is never printed');
});

test('a new port is asked for on the old port and awaited on the new one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--port', '4150'], fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.equal(relay.shutdowns[0].port, 4100);
  assert.equal(relay.shutdowns[0].restart, true);
  assert.deepEqual(relay.requests.at(-1), { port: 4150, path: '/api/status', auth: 'Bearer old-token' });
  assert.equal(relay.port, 4150);
});

test('an access change alone restarts the relay too', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--lan'], fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.equal(relay.shutdowns.length, 1);
  assert.equal(relay.lan, true);
  assert.equal(fs.existsSync(install.previousPath), false, 'port and token are the same: nothing to remember');
});

test('in a terminal the restart is a question; yes is the default, no leaves the relay findable', async (t) => {
  const yes = makeInstall(t, { config: EXISTING });
  const yesRelay = fakeRelay(yes, { port: 4100, token: 'old-token' });
  const yesPrompter = scripted([true]);
  await runSetup(yes.options({ argv: ['--port', '4150'], stdin: TTY, prompter: yesPrompter, fetchImpl: yesRelay.fetch }));
  assert.match(yesPrompter.asked[0], /The relay is running\. Restart it now to apply the change\?/);
  assert.equal(yesRelay.shutdowns.length, 1);

  const no = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(no, { port: 4100, token: 'old-token' });
  const result = await runSetup(no.options({ argv: ['--port', '4150', '--new-token'], stdin: TTY, prompter: scripted([false]), fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.deepEqual(relay.shutdowns, []);
  assert.match(no.output(), /keeps its earlier settings until it restarts: oar restart/);
  assert.equal(no.readConfig().port, 4150);
  assert.deepEqual(JSON.parse(fs.readFileSync(no.previousPath, 'utf8')), { port: 4100, authToken: 'old-token' });

  // The relay still runs on the old port with the old token: status says so,
  // start leaves it alone, and restart reaches it there.
  no.lines.length = 0;
  assert.equal((await runStatus(no.options({ fetchImpl: relay.fetch }))).code, 0);
  assert.match(no.output(), /The relay is running on port 4100/);
  assert.match(no.output(), /runs with its earlier settings/);
  assert.equal((await runStart(no.options({ fetchImpl: relay.fetch }))).code, 0);
  assert.deepEqual(no.spawned, []);
  assert.equal((await runRestart(no.options({ fetchImpl: relay.fetch }))).code, 0);
  assert.equal(relay.shutdowns[0].port, 4100);
  assert.equal(relay.shutdowns[0].auth, 'Bearer old-token');
  assert.equal(relay.port, 4150);
  assert.equal(fs.existsSync(no.previousPath), false);
});

test('the service is restarted by systemd, not through the relay', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  fs.mkdirSync(path.dirname(install.unitPath), { recursive: true });
  fs.writeFileSync(install.unitPath, '[Unit]\n');
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { active: true, relay });
  const result = await runSetup(install.options({ argv: ['--port', '4150'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.equal(result.code, 0);
  assert.deepEqual(relay.shutdowns, []);
  assert.ok(systemd.calls.includes('systemctl --user restart oar'));
  assert.equal(relay.port, 4150);
});

test('a relay that is busy restarts later by itself; one with fixed settings is reported', async (t) => {
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  const queued = await runSetup(busy.options({ argv: ['--new-token'], fetchImpl: busyRelay.fetch }));
  assert.equal(queued.code, 0);
  assert.match(busy.output(), /Waiting for the relay's running turns to finish/);
  assert.match(busy.output(), /restarts by itself when its running turns finish/);
  assert.equal(fs.existsSync(busy.previousPath), true, 'the relay stays findable until it has restarted');

  const fixed = makeInstall(t, { config: EXISTING });
  const fixedRelay = fakeRelay(fixed, { port: 4100, token: 'old-token', fixed: true });
  const result = await runSetup(fixed.options({ argv: ['--port', '4150'], fetchImpl: fixedRelay.fetch }));
  assert.deepEqual(result, { code: 1, reason: 'fixed-settings' });
  assert.match(fixed.output(), /came back on its earlier port and token/);
});

test('setup --start installs the service where systemd answers and starts the relay', async (t) => {
  const install = makeInstall(t);
  const relay = fakeRelay(install, { port: 3333, token: '', running: false });
  const systemd = fakeSystemd(install, { relay });
  const result = await runSetup(install.options({ argv: ['--defaults', '--start'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.deepEqual(result, { code: 0, reason: 'setup-complete' });
  const unit = fs.readFileSync(install.unitPath, 'utf8');
  assert.ok(unit.includes(`Environment=COPILOT_WEB_RELAY_CONFIG=${install.configPath}`));
  assert.ok(systemd.calls.includes('loginctl enable-linger dev'));
  assert.ok(systemd.calls.includes('systemctl --user enable --now oar'));
  assert.deepEqual(install.spawned, []);
  assert.match(install.output(), /running as a systemd user service/);

  // Without systemd the relay is started in the background.
  const plain = makeInstall(t);
  const plainRelay = fakeRelay(plain, { port: 3333, token: '', running: false });
  const started = await runSetup(plain.options({
    argv: ['--defaults', '--start'],
    fetchImpl: plainRelay.fetch,
    spawnImpl: (command, args) => { plain.spawned.push({ command, args }); plainRelay.loadConfig(); return { exitCode: null, unref() {} }; },
  }));
  assert.equal(started.code, 0);
  assert.equal(plain.spawned.length, 1);
  assert.equal(fs.existsSync(plain.unitPath), false);
});

// ─── WSL ─────────────────────────────────────────────────────────────────────

// Interop of a WSL distro whose Windows has `holders` (port → program) listening.
function fakeWindows(holders = {}) {
  const pids = Object.keys(holders).map((port, index) => [port, 7000 + index]);
  return (command, args = []) => {
    if (command.endsWith('netstat.exe')) {
      return { status: 0, stdout: pids.map(([port, pid]) => `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}`).join('\r\n') };
    }
    if (command.endsWith('tasklist.exe')) {
      const port = pids.find(([, pid]) => args[1] === `PID eq ${pid}`)?.[0];
      return { status: 0, stdout: `"${holders[port]}","0","Console","1","9 K"\r\n` };
    }
    if (command === 'wslinfo') return { status: 0, stdout: 'nat\n' };
    return { status: 1 };
  };
}
const WSL_ENV = { WSL_DISTRO_NAME: 'Distro' };

test('in WSL a fresh config skips a port a Windows program listens on', async (t) => {
  const install = makeInstall(t);
  const options = install.options({ argv: ['--defaults'], spawnSyncImpl: fakeWindows({ 3333: 'node.exe' }) });
  options.env = { ...options.env, ...WSL_ENV };
  assert.equal((await runSetup(options)).code, 0);
  assert.equal(install.readConfig().port, 3334);
  assert.match(install.output(), /Port 3333 is in use on Windows — using 3334\./);

  // An explicit port Windows holds is refused, naming the program.
  const refused = makeInstall(t);
  const refusedOptions = refused.options({ argv: ['--port', '3333'], spawnSyncImpl: fakeWindows({ 3333: 'node.exe' }) });
  refusedOptions.env = { ...refusedOptions.env, ...WSL_ENV };
  assert.deepEqual(await runSetup(refusedOptions), { code: 1, reason: 'port-taken' });
  assert.match(refused.output(), /Port 3333 is in use on Windows \(node\.exe\)\./);
});

test('in WSL without interop the port is chosen as on plain Linux', async (t) => {
  const install = makeInstall(t);
  const options = install.options({ argv: ['--defaults'], spawnSyncImpl: () => ({ status: null, error: new Error('ENOENT') }) });
  options.env = { ...options.env, ...WSL_ENV };
  assert.equal((await runSetup(options)).code, 0);
  assert.equal(install.readConfig().port, 3333);
  assert.doesNotMatch(install.output(), /Windows/);
});

test('start, status, doctor and setup warn when Windows holds the relay\'s port', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const options = (overrides = {}) => {
    const built = install.options({ fetchImpl: relay.fetch, spawnSyncImpl: fakeWindows({ 4100: 'node.exe' }), ...overrides });
    built.env = { ...built.env, ...WSL_ENV };
    return built;
  };
  const warning = /Windows holds port 4100 \(node\.exe\): a browser on Windows reaches that program, not this relay\. Pick another port: oar setup --port N/;
  for (const command of [runStart, runStatus, runDoctor]) {
    install.lines.length = 0;
    await command(options());
    assert.match(install.output(), warning, command.name);
  }
  install.lines.length = 0;
  await runSetup(options({ argv: ['--defaults'] }));
  assert.match(install.output(), warning);
});

test('LAN access inside WSL: the note instead of a QR code', async (t) => {
  const install = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const options = install.options({ spawnSyncImpl: fakeWindows() });
  options.env = { ...options.env, ...WSL_ENV };
  assert.equal((await runUrl(options)).code, 0);
  assert.match(install.output(), /Relay URL: http:\/\/192\.168\.7\.20:4100\/\?token=old-token/);
  assert.match(install.output(), /internal to WSL/);
  assert.deepEqual(install.qrCodes, []);
});

// ─── url, status ─────────────────────────────────────────────────────────────

test('url prints the URL, a QR code for a LAN address, and the tunnel a running relay reports', async (t) => {
  const lan = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const relay = fakeRelay(lan, { port: 4100, token: 'old-token', lan: true });
  relay.readyBanner = { remoteUrl: 'https://relay.example.com/' };
  assert.deepEqual(await runUrl(lan.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'url' });
  assert.deepEqual(lan.qrCodes, ['http://192.168.7.20:4100/?token=old-token', 'https://relay.example.com/?token=old-token']);
  assert.ok(lan.lines.includes('[oar] Tunnel URL: https://relay.example.com/?token=old-token'));

  const local = makeInstall(t, { config: EXISTING });
  await runUrl(local.options());
  assert.ok(local.lines.includes('[oar] Relay URL: http://localhost:4100/?token=old-token'));
  assert.deepEqual(local.qrCodes, []);
  assert.match(local.output(), /This machine only\. For a phone/);
  assert.match(local.output(), /The relay is not running\. Start it with: oar start/);

  const fresh = makeInstall(t);
  assert.deepEqual(await runUrl(fresh.options()), { code: 1, reason: 'no-config' });
});

test('status tells running, stopped, a foreign port holder and a missing config apart, without the token', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install);
  assert.deepEqual(await runStatus(install.options({ fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl })), { code: 0, reason: 'relay-running' });
  assert.deepEqual(install.lines, [
    '[oar] OAR 9.9.9',
    '[oar] The relay is running on port 4100 (this machine only): http://localhost:4100/',
    '[oar] Service: not installed',
  ]);

  install.lines.length = 0;
  relay.running = false;
  assert.deepEqual(await runStatus(install.options({ fetchImpl: relay.fetch })), { code: 3, reason: 'relay-stopped' });
  assert.match(install.output(), /The relay is stopped \(port 4100, this machine only\)\. Start it with: oar start/);
  assert.doesNotMatch(install.output(), /Service:/, 'no systemd here, so no service line');

  install.lines.length = 0;
  relay.running = true;
  relay.token = 'another-token';
  assert.deepEqual(await runStatus(install.options({ fetchImpl: relay.fetch })), { code: 3, reason: 'relay-taken' });
  assert.match(install.output(), /Port 4100 is held by another program, or by a relay with another token\./);
  assert.ok(!install.output().includes('old-token'));

  const fresh = makeInstall(t);
  assert.deepEqual(await runStatus(fresh.options()), { code: 3, reason: 'no-config' });
  assert.match(fresh.output(), /Not set up yet — run: oar setup/);
});

// ─── start, stop, restart ────────────────────────────────────────────────────

test('start needs a config, starts the relay detached and prints the URL without a QR code', async (t) => {
  const fresh = makeInstall(t);
  assert.deepEqual(await runStart(fresh.options()), { code: 1, reason: 'no-config' });

  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const result = await runStart(install.options({
    fetchImpl: relay.fetch,
    spawnImpl: (command, args, spawnOptions) => { install.spawned.push({ command, args, spawnOptions }); relay.running = true; return { exitCode: null, unref() {} }; },
  }));
  assert.deepEqual(result, { code: 0, reason: 'started' });
  assert.equal(install.spawned.length, 1);
  assert.equal(install.spawned[0].spawnOptions.detached, true);
  assert.equal(install.spawned[0].spawnOptions.env.COPILOT_WEB_RELAY_CONFIG, install.configPath);
  assert.match(install.output(), /Relay URL: http:\/\/localhost:4100\//);
  assert.deepEqual(install.qrCodes, []);
});

test('stop asks the relay to stop and waits until its port is closed', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  assert.deepEqual(await runStop(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'stopped' });
  assert.deepEqual(relay.shutdowns, [
    { port: 4100, auth: 'Bearer old-token', restart: false, reason: 'oar-cli', requestedBy: 'oar-cli' },
  ]);
  assert.match(install.output(), /The relay is stopped\./);

  // Already stopped.
  install.lines.length = 0;
  assert.deepEqual(await runStop(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'not-running' });
  assert.match(install.output(), /The relay is not running\./);
});

test('stop: a busy relay stops later, a foreign port holder is not touched, the service goes through systemd', async (t) => {
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  assert.deepEqual(await runStop(busy.options({ fetchImpl: busyRelay.fetch })), { code: 0, reason: 'stop-queued' });
  assert.match(busy.output(), /stops by itself when its running turns finish/);

  const foreign = makeInstall(t, { config: EXISTING });
  const foreignRelay = fakeRelay(foreign, { port: 4100, token: 'another-token' });
  assert.deepEqual(await runStop(foreign.options({ fetchImpl: foreignRelay.fetch })), { code: 1, reason: 'port-taken' });
  assert.deepEqual(foreignRelay.shutdowns, []);
  assert.doesNotMatch(foreign.output(), /A relay of this install/);

  // The install's own relay, started before its token was changed by hand:
  // the lock gives it away, and the message says what to do.
  fs.mkdirSync(path.join(foreign.stateRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(foreign.stateRoot, 'data', 'relay-server.lock'), JSON.stringify({ pid: 4242 }));
  const own = foreign.options({ fetchImpl: foreignRelay.fetch, isProcessAliveImpl: (pid) => pid === 4242 });
  assert.deepEqual(await runRestart(own), { code: 1, reason: 'port-taken' });
  assert.match(foreign.output(), /A relay of this install seems to run \(process 4242\).*restart it from its web UI/);

  const service = makeInstall(t, { config: EXISTING });
  fs.mkdirSync(path.dirname(service.unitPath), { recursive: true });
  fs.writeFileSync(service.unitPath, '[Unit]\n');
  const serviceRelay = fakeRelay(service, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(service, { active: true, relay: serviceRelay });
  assert.deepEqual(await runStop(service.options({ fetchImpl: serviceRelay.fetch, spawnSyncImpl: systemd.impl })), { code: 0, reason: 'stopped' });
  assert.ok(systemd.calls.includes('systemctl --user stop oar'));
  assert.deepEqual(serviceRelay.shutdowns, []);
});

test('restart restarts a running relay through its API, the service through systemd, and starts a stopped one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  assert.deepEqual(await runRestart(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'restarted' });
  assert.equal(relay.shutdowns[0].restart, true);
  assert.match(install.output(), /The relay restarted\./);
  assert.match(install.output(), /Relay URL:/);

  const service = makeInstall(t, { config: EXISTING });
  fs.mkdirSync(path.dirname(service.unitPath), { recursive: true });
  fs.writeFileSync(service.unitPath, '[Unit]\n');
  const serviceRelay = fakeRelay(service, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(service, { active: true, relay: serviceRelay });
  assert.equal((await runRestart(service.options({ fetchImpl: serviceRelay.fetch, spawnSyncImpl: systemd.impl }))).code, 0);
  assert.ok(systemd.calls.includes('systemctl --user restart oar'));
  assert.deepEqual(serviceRelay.shutdowns, []);

  const stopped = makeInstall(t, { config: EXISTING });
  const stoppedRelay = fakeRelay(stopped, { port: 4100, token: 'old-token', running: false });
  const result = await runRestart(stopped.options({
    fetchImpl: stoppedRelay.fetch,
    spawnImpl: () => { stopped.spawned.push('server'); stoppedRelay.running = true; return { exitCode: null, unref() {} }; },
  }));
  assert.deepEqual(result, { code: 0, reason: 'started' });
  assert.deepEqual(stopped.spawned, ['server']);
});

test('a relay that never comes back after a restart request is an error naming the log', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  relay.loadConfig = () => { relay.running = false; };
  assert.deepEqual(await runRestart(install.options({ fetchImpl: relay.fetch })), { code: 1, reason: 'server-not-ready' });
  assert.match(install.output(), /The relay did not come back — see .*server-err\.log/);
});

// ─── service ─────────────────────────────────────────────────────────────────

test('service install on Linux writes the unit, enables lingering and starts the service', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay });
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runService(options(['status'])), { code: 0, reason: 'service-status' });
  assert.match(install.output(), /Service: not installed/);

  assert.deepEqual(await runService(options(['install'])), { code: 0, reason: 'service-install' });
  const unit = fs.readFileSync(install.unitPath, 'utf8');
  assert.ok(unit.includes('ExecStart=/opt/node/bin/node '));
  assert.ok(unit.includes(`Environment=COPILOT_WEB_RELAY_DATA_DIR=${path.join(install.stateRoot, 'data')}`));
  assert.ok(systemd.calls.includes('loginctl enable-linger dev'));
  assert.ok(systemd.calls.includes('systemctl --user daemon-reload'));
  assert.ok(systemd.calls.includes('systemctl --user enable --now oar'));
  assert.equal(relay.running, true);
  assert.deepEqual(relay.shutdowns, []);

  install.lines.length = 0;
  await runService(options(['status']));
  assert.match(install.output(), /Service: installed, running/);
});

test('service install first stops a relay that was started by hand', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { relay });
  const result = await runService(install.options({ argv: ['install'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.deepEqual(result, { code: 0, reason: 'service-install' });
  assert.equal(relay.shutdowns.length, 1);
  assert.equal(relay.shutdowns[0].restart, false);
  assert.ok(systemd.calls.indexOf('systemctl --user enable --now oar') > -1);
  assert.equal(systemd.active, true);

  // A busy relay is not cut off: the service waits for the next start.
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  const busySystemd = fakeSystemd(busy, { relay: busyRelay });
  await runService(busy.options({ argv: ['install'], fetchImpl: busyRelay.fetch, spawnSyncImpl: busySystemd.impl }));
  assert.ok(busySystemd.calls.includes('systemctl --user enable oar'));
  assert.ok(!busySystemd.calls.includes('systemctl --user enable --now oar'));
  assert.match(busy.output(), /takes over at the next login/);
});

test('service remove on Linux disables the service, deletes the unit and reloads systemd', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  fs.mkdirSync(path.dirname(install.unitPath), { recursive: true });
  fs.writeFileSync(install.unitPath, '[Unit]\n');
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { active: true, relay });
  const options = install.options({ argv: ['remove'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runService(options), { code: 0, reason: 'service-remove' });
  assert.equal(fs.existsSync(install.unitPath), false);
  const disable = systemd.calls.indexOf('systemctl --user disable --now oar');
  assert.ok(disable > -1 && systemd.calls.indexOf('systemctl --user daemon-reload', disable) > disable);
  assert.equal(relay.running, false);

  install.lines.length = 0;
  assert.equal((await runService(options)).code, 0);
  assert.match(install.output(), /The service is not installed\./);
});

test('without systemd the service command explains and points at oar start', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  for (const argv of [['install'], ['remove'], ['status']]) {
    install.lines.length = 0;
    assert.deepEqual(await runService(install.options({ argv })), { code: 1, reason: 'no-systemd' });
    assert.match(install.output(), /No systemd user session here.*Start the relay with: oar start/);
    assert.doesNotMatch(install.output(), /WSL/);
  }
  const wsl = install.options({ argv: ['install'] });
  wsl.env = { ...wsl.env, ...WSL_ENV };
  install.lines.length = 0;
  await runService(wsl);
  assert.match(install.output(), /In WSL, switch systemd on: systemd=true under \[boot\] in \/etc\/wsl\.conf/);
  assert.equal(fs.existsSync(install.unitPath), false);
});

test('on win32 the service is the autostart entry of the web UI', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const autostart = { enabled: false, sets: [] };
  const windowsAutostartImpl = {
    getState: () => ({ supported: true, enabled: autostart.enabled }),
    setEnabled: (enabled) => { autostart.sets.push(enabled); autostart.enabled = enabled; },
  };
  const boot = { taskStatus: 'absent' };
  const options = (argv) => install.options({
    argv, platform: 'win32', windowsAutostartImpl, windowsBootAutostartImpl: { getState: async () => boot },
  });
  await runService(options(['status']));
  assert.match(install.lines.at(-1), /Autostart: off/);
  assert.deepEqual(await runService(options(['install'])), { code: 0, reason: 'service-install' });
  assert.match(install.lines.at(-1), /starts when you sign in to Windows/);
  await runService(options(['status']));
  assert.match(install.lines.at(-1), /Autostart: on, at sign-in/);
  assert.deepEqual(await runService(options(['remove'])), { code: 0, reason: 'service-remove' });
  assert.deepEqual(autostart.sets, [true, false]);

  // A boot task was set up in the web UI (it needs an elevation): reported, not changed.
  boot.taskStatus = 'ready';
  await runService(options(['status']));
  assert.match(install.lines.at(-1), /Autostart: on, at boot/);
  assert.deepEqual(await runService(options(['remove'])), { code: 1, reason: 'boot-task' });
  assert.match(install.lines.at(-1), /Settings → Autostart/);
  assert.deepEqual(autostart.sets, [true, false]);
});

test('the service is not there on macOS yet, and not for a git checkout', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  assert.deepEqual(await runService(install.options({ argv: ['install'], platform: 'darwin' })), { code: 1, reason: 'unsupported' });
  assert.match(install.output(), /not supported on macOS yet\. Start the relay with: oar start/);

  fs.mkdirSync(path.join(install.packageRoot, '.git'));
  install.lines.length = 0;
  assert.deepEqual(await runService(install.options({ argv: ['install'] })), { code: 1, reason: 'git-checkout' });
  assert.deepEqual(await runStart(install.options()), { code: 1, reason: 'git-checkout' });
});

test('status names the built-in tunnel only when the config switches it on, and says why it cannot start', async (t) => {
  const tunnel = { mode: 'managed', token: 'tunnel-token', binary: '/home/dev/absent/cloudflared' };
  const install = makeInstall(t, { config: { ...EXISTING, cloudflaredTunnel: tunnel } });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  assert.equal((await runStatus(install.options({ fetchImpl: relay.fetch }))).code, 3);
  assert.match(install.output(), /\[oar\] Tunnel: managed, cannot start: cloudflared was not found as configured/);
  assert.doesNotMatch(install.output(), /tunnel-token/);

  const plain = makeInstall(t, { config: EXISTING });
  const plainRelay = fakeRelay(plain, { port: 4100, token: 'old-token', running: false });
  await runStatus(plain.options({ fetchImpl: plainRelay.fetch }));
  assert.doesNotMatch(plain.output(), /Tunnel:/);
});

test('a command ends through the exit code, and is only forced out when something still holds the process', () => {
  const calls = [];
  const fakeProcess = { exitCode: undefined, exit: (code) => calls.push(code) };
  let scheduled = null;
  const timer = exitWhenIdle(3, {
    processImpl: fakeProcess,
    setTimeoutImpl: (fn, ms) => { scheduled = { fn, ms, unreffed: false }; return { unref() { scheduled.unreffed = true; } }; },
  });
  assert.ok(timer);
  assert.equal(fakeProcess.exitCode, 3);
  assert.deepEqual(calls, [], 'nothing is cut off right away');
  assert.equal(scheduled.unreffed, true, 'the timer itself never keeps the process alive');
  assert.equal(scheduled.ms, 3000);
  scheduled.fn();
  assert.deepEqual(calls, [3]);
});
