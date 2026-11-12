// The `oar` commands (setup, start, stop, restart, status, url, service, the
// dispatch) run for real against a throwaway global-install layout. The relay,
// systemd, Windows and the terminal are fakes, the platform is injected, and
// every writable path points into a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  exitWhenIdle, launchRelay, main, runBackup, runDoctor, runRestart, runService, runSetup, runStart, runStatus, runStop, runUninstall, runUrl,
} from '../bin/oar.js';
import { PromptAborted } from './services/oar-cli-menu.mjs';
import { OWNER_HASH_SETTING_KEY, createOwnerSecretStore } from './services/owner-secret-store.mjs';
import { processIdentity } from './services/relay-singleton-guard.mjs';
import { agentKeyBytes, hashOwnerToken, mintAgentTokenWithKey, verifyAgentTokenWithKey } from '../shared/relay-credentials.mjs';

// What a relay that ran once leaves in its data folder: the owner token's hash
// and the agent key. The commands call the relay with the `cli` agent token
// derived from that key, never with the owner token.
function writeRelaySecrets(dataDir, ownerToken = 'old-token') {
  fs.mkdirSync(dataDir, { recursive: true });
  const agentKey = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dataDir, 'relay-secrets.json'), JSON.stringify({
    version: 1,
    owner: { hash: hashOwnerToken(ownerToken), createdAt: '2026-01-01T00:00:00.000Z', rotatedAt: null, legacyPlaintext: false },
    agentKey,
  }));
}

function readRelaySecrets(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'relay-secrets.json'), 'utf8'));
  } catch {
    return null;
  }
}

function cliTokenIn(dataDir) {
  const key = agentKeyBytes(readRelaySecrets(dataDir)?.agentKey);
  return key ? mintAgentTokenWithKey(key, { kind: 'c' }) : '';
}

const noFile = () => { throw new Error('ENOENT'); };
const LAN = { eth0: [{ family: 'IPv4', internal: false, address: '192.168.7.20' }] };

// A relay as the commands see it: it answers its status call on one port for
// the agent tokens of its own agent key (relay-secrets.json in its data
// folder, read at each call), and a restart request makes it read the config
// again, as the supervisor's new runtime does. The cli agent token may stop
// it and restart it now over loopback; `refuseStop` answers as a relay that
// takes only a queued restart from it (one from before that). `foreign`: a
// relay of another agent key (another install), which refuses this install's
// tokens.
function fakeRelay(install, { port, lan = false, running = true, busy = false, fixed = false, foreign = false, refuseStop = false } = {}) {
  // `signInAnswer`: what POST /api/auth/signin-codes/terminal answers (null: a
  // made-up code, valid 10 minutes).
  const relay = { port, running, busy, foreign, refuseStop, requests: [], shutdowns: [], shutdown: 'idle', lan, readyBanner: null, signInAnswer: null, signInCodes: [] };
  relay.loadConfig = () => {
    const config = JSON.parse(fs.readFileSync(install.configPath, 'utf8'));
    Object.assign(relay, { port: config.port, lan: config.localhostOnly === false, running: true, shutdown: 'idle' });
  };
  relay.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const auth = String(options.headers?.Authorization || '');
    relay.requests.push({ port: Number(target.port), path: target.pathname, auth });
    if (!relay.running || Number(target.port) !== relay.port) throw new Error('connect ECONNREFUSED');
    const key = agentKeyBytes(readRelaySecrets(install.dataDir)?.agentKey);
    const agent = key && !relay.foreign ? verifyAgentTokenWithKey(key, auth.replace(/^Bearer /, '')) : null;
    if (!agent) return { ok: false, status: 401 };
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
      // A relay from before the cli stop: the agent token may only queue a restart.
      if (relay.refuseStop && (!body.restart || body.immediate)) return { ok: false, status: 403, json: async () => ({ code: 'AUTH_PERSON_REQUIRED' }) };
      if (relay.busy && !body.immediate) relay.shutdown = 'queued';
      else if (body.restart && !fixed) relay.loadConfig();
      else if (!body.restart) relay.running = false;
      return { ok: true, json: async () => ({ ok: true, queue: { processingCount: relay.busy ? 1 : 0 } }) };
    }
    if (target.pathname === '/api/auth/signin-codes/terminal' && options.method === 'POST') {
      if (agent.kind !== 'c') return { ok: false, status: 403, json: async () => ({ code: 'AUTH_PERSON_REQUIRED' }) };
      if (relay.signInAnswer) return relay.signInAnswer;
      const code = `oarc1_${crypto.randomBytes(32).toString('base64url')}`;
      relay.signInCodes.push(code);
      return { ok: true, status: 200, json: async () => ({ code, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }) };
    }
    return { ok: false, status: 404 };
  };
  return relay;
}

// systemctl and loginctl of a host with (or without) a systemd user session.
// `activeState` is what `is-active` prints while the unit is not plainly
// active or inactive (activating during a restart backoff, deactivating).
function fakeSystemd(install, { available = true, active = false, relay = null, activeState = null, version = 257, linger = 'yes' } = {}) {
  const state = { active, activeState, calls: [] };
  state.impl = (command, args = []) => {
    const line = [command, ...args].join(' ');
    if (command === 'systemctl') {
      if (!available) return { status: 1 };
      state.calls.push(line);
      if (args.includes('--version')) return { status: 0, stdout: `systemd ${version} (${version}.1-1)\n+PAM +AUDIT\n` };
      if (args.includes('is-active')) {
        const answer = state.activeState || (state.active ? 'active' : 'inactive');
        return { status: answer === 'active' ? 0 : 3, stdout: `${answer}\n` };
      }
      if (args.includes('--now') && args.includes('enable')) { state.active = true; relay?.loadConfig(); }
      if (args.includes('restart')) relay?.loadConfig();
      if (args.includes('stop') || args.includes('disable')) { state.active = false; if (relay) relay.running = false; }
      return { status: 0 };
    }
    if (command === 'loginctl') {
      state.calls.push(line);
      return args.includes('show-user') ? { status: 0, stdout: `${linger}\n` } : { status: 0 };
    }
    return { status: 1 };
  };
  return state;
}

// A git checkout as `makeInstall` lays it out: `.git` beside the package, the
// config in server/.
function makeCheckout(t, { config = EXISTING } = {}) {
  const install = makeInstall(t);
  fs.mkdirSync(path.join(install.packageRoot, '.git'), { recursive: true });
  install.configPath = path.join(install.packageRoot, 'server', 'config.json');
  install.dataDir = path.join(install.packageRoot, 'server', 'data');
  install.readConfig = () => JSON.parse(fs.readFileSync(install.configPath, 'utf8'));
  if (config) {
    fs.writeFileSync(install.configPath, JSON.stringify(config));
    writeRelaySecrets(install.dataDir);
  }
  return install;
}

// What `oar service install` writes for `install` (generated: this version's).
async function unitFor(install, { checkout = false, earlier = false, nodeBin = '/opt/node/bin/node' } = {}) {
  const { buildServicePath, buildSystemdUnit, buildSystemdUnit0919 } = await import('./services/oar-cli-helpers.mjs');
  const args = {
    nodeBin,
    packageRoot: install.packageRoot,
    configPath: install.configPath,
    dataDir: path.join(install.stateRoot, 'data'),
    logDir: path.join(install.stateRoot, 'logs'),
    pathEnv: buildServicePath({ nodeBin, envPath: '/usr/bin', homeDir: install.homeDir }),
    checkout,
    systemdVersion: 257,
  };
  return earlier ? buildSystemdUnit0919(args) : buildSystemdUnit(args);
}

function writeUnit(install, text) {
  fs.mkdirSync(path.dirname(install.unitPath), { recursive: true });
  fs.writeFileSync(install.unitPath, text);
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

// `relayRan`: an install with a config has a relay that ran once (its data
// folder holds the token hash and agent key); false leaves the folder unmade.
function makeInstall(t, { config = null, relayRan = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-commands-'));
  // Retries only as extra safety on Windows: every test closes its own
  // databases before this runs.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
  install.dataDir = path.join(stateRoot, 'data');
  install.readConfig = () => JSON.parse(fs.readFileSync(install.configPath, 'utf8'));
  install.readSecrets = () => readRelaySecrets(install.dataDir);
  // The Authorization the commands send: the cli agent token of the relay's agent key.
  install.cliAuth = () => `Bearer ${cliTokenIn(install.dataDir)}`;
  install.output = () => install.lines.join('\n');
  if (config) {
    fs.writeFileSync(install.configPath, JSON.stringify(config));
    if (relayRan) writeRelaySecrets(install.dataDir);
  }
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
// A config of this version: no token in it (the relay keeps the hash).
const EXISTING = { port: 4100, localhostOnly: true, pollIntervalMs: 3000 };

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
  assert.equal(config.authToken, undefined, 'no token in the config');
  assert.equal(config.cloudflaredTunnel, undefined, 'the tunnel is not set up here any more');
  // A fresh install gets a new token, its hash in the data folder. Without a
  // terminal it is not printed (the output may go to a log agents can read):
  // the line says how to get one that can be seen.
  assert.doesNotMatch(install.output(), /oaro1_/, 'no token without a terminal');
  assert.doesNotMatch(install.output(), /\?token=/);
  assert.match(install.output(), /A new relay token was made and stored as a hash; it is not printed without a terminal\. To get one you can see, run in a terminal on this host: oar setup --new-token/);
  assert.match(install.readSecrets().owner.hash, /^[0-9a-f]{64}$/);
  assert.ok(install.lines.includes('[oar] Relay URL: http://localhost:3333/'), install.output());
  assert.deepEqual(install.qrCodes, [], 'no QR code for a localhost URL');
  assert.match(install.output(), /This machine only\. For a phone/);
  assert.match(install.output(), /Start the relay with: oar start/);
  assert.equal(fs.existsSync(install.unitPath), false, 'no service without --start');
});

test('setup in a terminal asks access and port for a fresh config, not the token', async (t) => {
  const install = makeInstall(t);
  const prompter = scripted(['2', '']);
  const result = await runSetup(install.options({ argv: [], stdin: TTY, stdout: TTY, prompter }));
  assert.equal(result.code, 0);
  assert.equal(prompter.asked.length, 2);
  assert.match(prompter.asked[0], /Access: 1 = this machine only, 2 = LAN .*\[1\]: $/);
  assert.equal(prompter.asked[1], 'Port [3333]: ');
  const config = install.readConfig();
  assert.equal(config.localhostOnly, false);
  assert.equal(config.port, 3333);
  // LAN access: the LAN address in the URL and in the QR code, with the new
  // token this once.
  const token = /Relay token \(shown once[^)]*\): (\S+)/.exec(install.output())?.[1];
  const url = `http://192.168.7.20:3333/?token=${token}`;
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
  assert.match(prompter.asked[0], /New relay token\? The current one stops working\./);
  assert.match(prompter.asked[1], /\[2\]: $/);
  assert.equal(prompter.asked[2], 'Port [4100]: ');
  assert.equal(prompter.asked.length, 3, 'nothing changed, so no restart question');
  const config = install.readConfig();
  assert.deepEqual(
    [config.authToken, config.port, config.localhostOnly, config.customKey],
    [undefined, 4100, false, 'kept'],
  );
  assert.equal(install.readSecrets().owner.hash, hashOwnerToken('old-token'), 'the token is kept');
  assert.deepEqual(relay.shutdowns, []);
  assert.doesNotMatch(install.output(), /Start the relay with/);
});

test('setup --defaults keeps everything of an existing config', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--defaults'], stdin: TTY, fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.equal(install.readSecrets().owner.hash, hashOwnerToken('old-token'));
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

test('--new-token without a terminal, or without NEW typed, changes nothing', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100 });
  const before = fs.readFileSync(path.join(install.dataDir, 'relay-secrets.json'), 'utf8');
  assert.deepEqual(await runSetup(install.options({ argv: ['--new-token'], fetchImpl: relay.fetch })), { code: 1, reason: 'new-token-needs-terminal' });
  // A terminal on one side only: the token would never be shown, or would
  // land in a file or a pipe. Nothing is rotated.
  const askedNothing = scripted([]);
  assert.deepEqual(await runSetup(install.options({ argv: ['--new-token'], stdin: TTY, prompter: askedNothing, fetchImpl: relay.fetch })), { code: 1, reason: 'new-token-needs-terminal' });
  assert.deepEqual(await runSetup(install.options({ argv: ['--new-token'], stdout: TTY, prompter: askedNothing, fetchImpl: relay.fetch })), { code: 1, reason: 'new-token-needs-terminal' });
  assert.deepEqual(askedNothing.asked, [], 'NEW is not even asked for');
  const typedOther = scripted(['yes']);
  assert.deepEqual(
    await runSetup(install.options({ argv: ['--new-token'], stdin: TTY, stdout: TTY, prompter: typedOther, fetchImpl: relay.fetch })),
    { code: 1, reason: 'new-token-not-confirmed' },
  );
  assert.match(typedOther.asked[0], /Type NEW/);
  assert.equal(fs.readFileSync(path.join(install.dataDir, 'relay-secrets.json'), 'utf8'), before, 'the token is untouched');
  assert.deepEqual(relay.shutdowns, []);
});

test('--new-token with NEW rotates the token in the data folder and restarts the running relay with the cli agent token', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100 });
  const agentKeyBefore = install.readSecrets().agentKey;
  const prompter = scripted(['NEW', true]);
  const result = await runSetup(install.options({ argv: ['--new-token'], stdin: TTY, stdout: TTY, prompter, fetchImpl: relay.fetch }));
  assert.deepEqual(result, { code: 0, reason: 'setup-complete' });
  assert.match(prompter.asked[1], /The relay is running\. Restart it now/);
  const token = /Relay token \(shown once[^)]*\): (oaro1_\S+)/.exec(install.output())?.[1];
  assert.ok(token);
  const secrets = install.readSecrets();
  assert.equal(secrets.owner.hash, hashOwnerToken(token));
  assert.equal(secrets.owner.rotatedVia, 'cli');
  assert.equal(secrets.agentKey, agentKeyBefore, 'agent tokens survive the rotation');
  assert.equal(install.readConfig().authToken, undefined);
  assert.deepEqual(relay.shutdowns, [
    { port: 4100, auth: install.cliAuth(), restart: true, reason: 'oar-cli', requestedBy: 'oar-cli' },
  ]);
  assert.deepEqual(relay.requests.at(-1), { port: 4100, path: '/api/status', auth: install.cliAuth() });
  assert.match(install.output(), /The relay restarted\./);
  assert.equal(fs.existsSync(install.previousPath), false);
  assert.equal(install.output().split('old-token').length, 1, 'the old token is never printed');
});

test('--new-token records the new hash in the relay database itself: its next start raises no alarm', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100 });
  // The relay's database, with the record its last start wrote.
  const dbPath = path.join(install.dataDir, 'oar.db');
  const before = install.readSecrets().owner.hash;
  {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(OWNER_HASH_SETTING_KEY, JSON.stringify({ hash: before, at: '2026-01-01T00:00:00.000Z' }), '2026-01-01T00:00:00.000Z');
    db.close();
  }
  const result = await runSetup(install.options({ argv: ['--new-token'], stdin: TTY, stdout: TTY, prompter: scripted(['NEW', false]), fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  const after = install.readSecrets().owner.hash;
  assert.notEqual(after, before);
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(OWNER_HASH_SETTING_KEY);
  db.close();
  assert.equal(JSON.parse(row.value).hash, after, 'the copy follows the file');
  // The relay's next start compares the two: no alarm.
  const settings = new Map([[OWNER_HASH_SETTING_KEY, row.value]]);
  const store = createOwnerSecretStore({ dataDir: install.dataDir, logger: { log() {}, warn() {} } });
  store.bootstrap({ config: {}, configPath: install.configPath });
  assert.equal(store.reconcileWithSettings({ readSetting: (key) => settings.get(key) ?? null, writeSetting: (key, value) => settings.set(key, value) }).alert, null);
});

test('a new port is asked for on the old port and awaited on the new one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const result = await runSetup(install.options({ argv: ['--port', '4150'], fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.equal(relay.shutdowns[0].port, 4100);
  assert.equal(relay.shutdowns[0].restart, true);
  assert.deepEqual(relay.requests.at(-1), { port: 4150, path: '/api/status', auth: install.cliAuth() });
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
  const result = await runSetup(no.options({ argv: ['--port', '4150', '--new-token'], stdin: TTY, stdout: TTY, prompter: scripted(['NEW', false]), fetchImpl: relay.fetch }));
  assert.equal(result.code, 0);
  assert.deepEqual(relay.shutdowns, []);
  assert.match(no.output(), /keeps its earlier settings until it restarts: oar restart/);
  assert.match(no.output(), /The new token works once the relay has restarted/);
  assert.equal(no.readConfig().port, 4150);
  assert.deepEqual(JSON.parse(fs.readFileSync(no.previousPath, 'utf8')), { port: 4100 }, 'no token in it');

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
  assert.equal(relay.shutdowns[0].auth, no.cliAuth());
  assert.equal(relay.port, 4150);
  assert.equal(fs.existsSync(no.previousPath), false);
});

test('setup restarts the service through the relay, which waits for its turns', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  writeUnit(install, '[Unit]\n');
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { active: true, relay });
  const result = await runSetup(install.options({ argv: ['--port', '4150'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.equal(result.code, 0);
  // Asked on the port it runs on; its supervisor hands the restart to systemd.
  assert.deepEqual(relay.shutdowns.map(({ port, restart }) => ({ port, restart })), [{ port: 4100, restart: true }]);
  assert.ok(!systemd.calls.some((call) => /systemctl --user (restart|stop)/.test(call)), systemd.calls.join('\n'));
  assert.equal(relay.port, 4150);
});

test('setup under the service falls back to systemd when the relay refuses the restart', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  writeUnit(install, '[Unit]\n');
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const answer = relay.fetch;
  relay.fetch = async (url, options) => (String(url).endsWith('/api/relay/shutdown') ? { ok: false, status: 501 } : answer(url, options));
  const systemd = fakeSystemd(install, { active: true, relay });
  const result = await runSetup(install.options({ argv: ['--port', '4150'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.equal(result.code, 0);
  assert.ok(systemd.calls.indexOf('systemctl --user reset-failed oar') < systemd.calls.indexOf('systemctl --user restart oar'));
  assert.ok(systemd.calls.includes('systemctl --user restart oar'));
  assert.equal(relay.port, 4150);
});

test('a relay that is busy restarts later by itself; one with fixed settings is reported', async (t) => {
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  const queued = await runSetup(busy.options({ argv: ['--new-token'], stdin: TTY, stdout: TTY, prompter: scripted(['NEW', true]), fetchImpl: busyRelay.fetch }));
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
  // The unit as the generator writes it: a state path with a backslash (a
  // Windows temp folder, where this runs on win32) is quoted and escaped.
  const unit = fs.readFileSync(install.unitPath, 'utf8');
  assert.equal(unit, await unitFor(install));
  assert.match(unit, /^Environment="?COPILOT_WEB_RELAY_CONFIG=/m);
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

// ─── setup: --migrate-from ───────────────────────────────────────────────────

// A pre-rename git checkout beside the install: a database with one
// conversation, its config and one upload.
function oldCheckout(install) {
  const checkout = path.join(install.root, 'old-checkout');
  fs.mkdirSync(path.join(checkout, 'server', 'data'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'server', 'uploads'), { recursive: true });
  const db = new Database(path.join(checkout, 'server', 'data', 'copilot.db'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO conversations VALUES (?)').run('c1');
  db.close();
  fs.writeFileSync(path.join(checkout, 'server', 'config.json'), JSON.stringify({ authToken: 'checkout-token', port: 3333 }));
  fs.writeFileSync(path.join(checkout, 'server', 'uploads', 'blob'), 'attachment');
  return checkout;
}

// The state root's database: as the installer's first relay start leaves it
// (tables, no rows), or with conversations.
function stateRootDb(install, { conversations = 0 } = {}) {
  fs.mkdirSync(path.join(install.stateRoot, 'data'), { recursive: true });
  const db = new Database(path.join(install.stateRoot, 'data', 'copilot.db'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY)');
  for (let i = 0; i < conversations; i += 1) db.prepare('INSERT INTO conversations VALUES (?)').run(`kept-${i}`);
  db.close();
}

test('setup --migrate-from runs behind the marker of an earlier automatic run and says what it did', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  // An earlier release's installer run found nothing and wrote the marker anyway.
  fs.writeFileSync(path.join(install.stateRoot, '.migrated'), '2026-01-01T00:00:00.000Z nothing-to-migrate\n');
  const checkout = oldCheckout(install);
  const result = await runSetup(install.options({ argv: ['--migrate-from', checkout, '--defaults'] }));
  assert.equal(result.code, 0);
  // Database and upload land where the relay `oar` starts reads them.
  assert.ok(fs.existsSync(path.join(install.stateRoot, 'data', 'copilot.db')));
  assert.equal(fs.readFileSync(path.join(install.stateRoot, 'data', 'uploads', 'blob'), 'utf8'), 'attachment');
  assert.equal(install.readConfig().port, 4100, 'the existing config is kept');
  assert.match(install.output(), /Migrated .*old-checkout.* into /);
  assert.match(install.output(), /Kept the existing .*config\.json/);
});

test('setup --migrate-from refuses to overwrite a state root database with conversations and stops', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  stateRootDb(install, { conversations: 1 });
  const before = fs.readFileSync(path.join(install.stateRoot, 'data', 'copilot.db'));
  const checkout = oldCheckout(install);
  const result = await runSetup(install.options({ argv: ['--migrate-from', checkout, '--port', '4200'] }));
  assert.deepEqual(result, { code: 1, reason: 'migration-refused' });
  assert.deepEqual(fs.readFileSync(path.join(install.stateRoot, 'data', 'copilot.db')), before);
  assert.equal(install.readConfig().port, 4100, 'setup stopped before changing the config');
  assert.match(install.output(), /already has a database with conversations/);
  assert.match(install.output(), /oar stop/);
});

test('setup --migrate-from after the installer: the fresh database is moved aside and the checkout migrated', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  stateRootDb(install);
  const checkout = oldCheckout(install);
  const result = await runSetup(install.options({ argv: ['--migrate-from', checkout, '--defaults'] }));
  assert.equal(result.code, 0);
  const db = new Database(path.join(install.stateRoot, 'data', 'copilot.db'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  db.close();
  const backups = fs.readdirSync(path.join(install.stateRoot, 'backups')).filter((name) => name !== 'MIGRATION.md');
  assert.equal(backups.length, 1);
  assert.ok(fs.existsSync(path.join(install.stateRoot, 'backups', backups[0], 'copilot.db')));
  assert.match(install.output(), /had no conversations yet .*moved it aside to .*backups/);
  assert.match(install.output(), /Migrated .*old-checkout.* into /);
});

test('setup --migrate-from with a relay running on the fresh database: stop the relay first', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  stateRootDb(install);
  fs.writeFileSync(path.join(install.stateRoot, 'data', 'relay-server.lock'), JSON.stringify({ pid: 7171 }));
  const checkout = oldCheckout(install);
  const result = await runSetup(install.options({
    argv: ['--migrate-from', checkout],
    isProcessAliveImpl: (pid) => pid === 7171,
  }));
  assert.deepEqual(result, { code: 1, reason: 'migration-relay-running' });
  assert.match(install.output(), /stop the relay first \(oar stop\)/);
  assert.equal(fs.existsSync(path.join(install.stateRoot, 'backups')), false);
});

test('setup --migrate-from a folder without relay state says why nothing was done', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const empty = path.join(install.root, 'not-a-checkout');
  fs.mkdirSync(empty);
  const result = await runSetup(install.options({ argv: ['--migrate-from', empty] }));
  assert.deepEqual(result, { code: 1, reason: 'migration-nothing' });
  assert.match(install.output(), /Nothing to migrate from .*not-a-checkout/);
  assert.equal(fs.existsSync(path.join(install.stateRoot, '.migrated')), false);
});

test('setup without --migrate-from and nothing to migrate writes no marker', async (t) => {
  const install = makeInstall(t);
  assert.equal((await runSetup(install.options({ argv: [] }))).code, 0);
  assert.equal(fs.existsSync(path.join(install.stateRoot, '.migrated')), false);
});

test('setup --migrate-from the same checkout again says it is already migrated and goes on', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const checkout = oldCheckout(install);
  assert.equal((await runSetup(install.options({ argv: ['--migrate-from', checkout, '--defaults'] }))).code, 0);
  install.lines.length = 0;
  const again = await runSetup(install.options({ argv: ['--migrate-from', checkout, '--defaults'] }));
  assert.equal(again.code, 0);
  assert.match(install.output(), /already migrated from .*old-checkout/);
  assert.doesNotMatch(install.output(), /aside|oar stop/);
});

test('oar copilot --migrate-from that is refused warns and still starts the session', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  stateRootDb(install, { conversations: 1 });
  const checkout = oldCheckout(install);
  // The install's relay already answers; the session is a gh process that exits 0.
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const started = [];
  const { packageRoot, env, logger, cwd, isProcessAliveImpl } = install.options();
  const result = await launchRelay({
    argv: ['--no-install-extension', '--migrate-from', checkout],
    packageRoot,
    env,
    logger,
    cwd,
    fetchImpl: relay.fetch,
    isProcessAliveImpl,
    lockGraceMs: 10,
    spawnSyncImpl: () => ({ status: 0 }),
    spawnImpl: (command) => {
      started.push(command);
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.kill = () => {};
      setImmediate(() => { proc.exitCode = 0; proc.emit('exit', 0, null); });
      return proc;
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(started, ['gh']);
  assert.match(install.output(), /already has a database with conversations/);
  const db = new Database(path.join(install.stateRoot, 'data', 'copilot.db'), { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1, 'the state root is untouched');
  db.close();
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
  assert.ok(install.lines.includes('[oar] Relay URL: http://192.168.7.20:4100/'), install.output());
  assert.match(install.output(), /internal to WSL/);
  assert.deepEqual(install.qrCodes, []);
});

// ─── url, status ─────────────────────────────────────────────────────────────

test('url prints the URL, a QR code for a LAN address, and the tunnel a running relay reports', async (t) => {
  const lan = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const relay = fakeRelay(lan, { port: 4100, token: 'old-token', lan: true });
  relay.readyBanner = { remoteUrl: 'https://relay.example.com/' };
  assert.deepEqual(await runUrl(lan.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'url' });
  // No token link: no file holds the token (only its hash is kept).
  assert.deepEqual(lan.qrCodes, ['http://192.168.7.20:4100/', 'https://relay.example.com/']);
  assert.ok(lan.lines.includes('[oar] Tunnel URL: https://relay.example.com/'));
  assert.match(lan.output(), /Sign in with your relay token \(keep it in your password manager\)\. Lost it\? oar setup --new-token/);
  assert.ok(!lan.output().includes('token='));
  assert.ok(!lan.output().includes('signin='), 'plain oar url makes no sign-in link');
  assert.ok(!relay.requests.some((request) => request.path === '/api/auth/signin-codes/terminal'));

  const local = makeInstall(t, { config: EXISTING });
  await runUrl(local.options());
  assert.ok(local.lines.includes('[oar] Relay URL: http://localhost:4100/'));
  assert.deepEqual(local.qrCodes, []);
  assert.match(local.output(), /This machine only\. For a phone/);
  assert.match(local.output(), /The relay is not running\. Start it with: oar start/);

  const fresh = makeInstall(t);
  assert.deepEqual(await runUrl(fresh.options()), { code: 1, reason: 'no-config' });
});

// `oar url --sign-in` (agent auth §13.2, 2c). The codes are made up by the
// fake relay at run time; assertions on them say yes or no.
test('url --sign-in in a terminal prints the link to the address a phone reaches, its QR code and how long it works', async (t) => {
  const lan = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const relay = fakeRelay(lan, { port: 4100, lan: true });
  const result = await runUrl(lan.options({ fetchImpl: relay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY }));
  assert.deepEqual(result, { code: 0, reason: 'sign-in-link' });
  const [code] = relay.signInCodes;
  assert.ok(code, 'one code was asked for');
  const link = `http://192.168.7.20:4100/?signin=${code}`;
  assert.ok(lan.lines.includes(`[oar] Sign-in link: ${link}`), 'the LAN link');
  assert.equal(lan.lines.filter((line) => line.includes(code)).length, 2, 'the link once, and its QR code');
  assert.deepEqual(lan.qrCodes, [link]);
  assert.ok(lan.lines.some((line) => /^\[oar\] Works once, until \d\d:\d\d; a new code replaces this one\. Anyone who sees this can sign in as you\.$/.test(line)));
  // Called on loopback with the cli agent token, never the owner token.
  const call = relay.requests.find((request) => request.path === '/api/auth/signin-codes/terminal');
  assert.equal(call.auth, lan.cliAuth());

  // A tunnel wins over the LAN address.
  const tunnelled = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const tunnelRelay = fakeRelay(tunnelled, { port: 4100, lan: true });
  tunnelRelay.readyBanner = { remoteUrl: 'https://relay.example.com/' };
  await runUrl(tunnelled.options({ fetchImpl: tunnelRelay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY }));
  assert.deepEqual(tunnelled.qrCodes, [`https://relay.example.com/?signin=${tunnelRelay.signInCodes[0]}`]);

  // This machine only: the local link, no QR code, and why.
  const local = makeInstall(t, { config: EXISTING });
  const localRelay = fakeRelay(local, { port: 4100 });
  await runUrl(local.options({ fetchImpl: localRelay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY }));
  assert.ok(local.lines.includes(`[oar] Sign-in link: http://localhost:4100/?signin=${localRelay.signInCodes[0]}`));
  assert.deepEqual(local.qrCodes, []);
  assert.match(local.output(), /this machine's only; a phone needs LAN access/);
});

test('url --sign-in is refused without a terminal (--yes included), with OAR_AGENT_TOKEN set, with the relay down, and on a refusal', async (t) => {
  const install = makeInstall(t, { config: { ...EXISTING, localhostOnly: false } });
  const relay = fakeRelay(install, { port: 4100, lan: true });
  const asked = () => relay.requests.filter((request) => request.path === '/api/auth/signin-codes/terminal').length;
  for (const [stdin, stdout] of [[{ isTTY: false }, TTY], [TTY, { isTTY: false }], [{ isTTY: false }, { isTTY: false }]]) {
    for (const argv of [['--sign-in'], ['--sign-in', '--yes']]) {
      install.lines.length = 0;
      assert.deepEqual(await runUrl(install.options({ fetchImpl: relay.fetch, argv, stdin, stdout })), { code: 1, reason: 'needs-terminal' });
      assert.match(install.output(), /only in a terminal \(stdin and stdout\); --yes does not change that/);
    }
  }
  const agentShell = install.options({ fetchImpl: relay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY });
  agentShell.env = { ...agentShell.env, OAR_AGENT_TOKEN: 'oara1_made-up' };
  install.lines.length = 0;
  assert.deepEqual(await runUrl(agentShell), { code: 1, reason: 'agent-env' });
  assert.match(install.output(), /OAR_AGENT_TOKEN is set/);
  assert.equal(asked(), 0, 'nothing reached the relay so far');

  relay.running = false;
  assert.deepEqual(await runUrl(install.options({ fetchImpl: relay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY })), { code: 1, reason: 'not-running' });
  relay.running = true;

  relay.signInAnswer = { ok: false, status: 403, json: async () => ({ code: 'AUTH_PERSON_REQUIRED' }) };
  install.lines.length = 0;
  assert.deepEqual(await runUrl(install.options({ fetchImpl: relay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY })), { code: 1, reason: 'refused' });
  assert.match(install.output(), /made no sign-in link: this relay does not make sign-in links for the oar command/);
  relay.signInAnswer = { ok: false, status: 429, json: async () => ({ retryAfterSeconds: 400 }) };
  install.lines.length = 0;
  assert.deepEqual(await runUrl(install.options({ fetchImpl: relay.fetch, argv: ['--sign-in'], stdin: TTY, stdout: TTY })), { code: 1, reason: 'rate-limited' });
  assert.match(install.output(), /at most 3 sign-in links in 10 minutes; try again in 7 min/);
  assert.ok(!install.output().includes('signin='), 'no link printed on a refusal');
  assert.deepEqual(install.qrCodes, []);
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
    '[oar] Owner token: set (hashed)',
  ]);

  install.lines.length = 0;
  relay.running = false;
  assert.deepEqual(await runStatus(install.options({ fetchImpl: relay.fetch })), { code: 3, reason: 'relay-stopped' });
  assert.match(install.output(), /The relay is stopped \(port 4100, this machine only\)\. Start it with: oar start/);
  assert.doesNotMatch(install.output(), /Service:/, 'no systemd here, so no service line');

  install.lines.length = 0;
  relay.running = true;
  relay.foreign = true;
  assert.deepEqual(await runStatus(install.options({ fetchImpl: relay.fetch })), { code: 3, reason: 'relay-taken' });
  assert.match(install.output(), /Port 4100 is in use by another program, or by a relay with another token\./);
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

test('start while the relay brings over its earlier database says it is still running, not that it did not come up', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ format: 2, pid: 5151, tokenHash: 'x', holder: null }));
  fs.writeFileSync(path.join(dataDir, 'earlier-database-progress.json'), JSON.stringify({
    pid: 5151, from: path.join(install.packageRoot, 'server', 'data', 'copilot.db'), bytes: 630 * 1048576, step: 'check',
  }));
  const result = await runStart(install.options({ isProcessAliveImpl: (pid) => pid === 5151 }));
  assert.deepEqual(result, { code: 0, reason: 'bringing-over' });
  assert.deepEqual(install.spawned, []);
  assert.match(install.output(), /The relay \(process 5151\) is bringing over the database it ran on until now \(.+copilot\.db, 630 MB\) and is still running; it answers once that is done\./);
  assert.doesNotMatch(install.output(), /did not come up/);
});

test('a relay that did not come up beside a held lock: stop its relay when the holder is known, delete the lock only when not', async (t) => {
  // Known: a live process whose identity is the one the lock records.
  const relay = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => relay.kill());
  await new Promise((resolve) => relay.once('spawn', resolve));
  // Unknown: a live Node process the lock records no identity for, since
  // this boot (on Windows a lock from before it, or a pid that runs another
  // program, would be stale).
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => other.kill());
  await new Promise((resolve) => other.once('spawn', resolve));
  const cases = [
    { pid: relay.pid, holder: processIdentity(relay.pid), startedAt: '2026-10-21T08:00:00.000Z' },
    { pid: other.pid, holder: null, startedAt: new Date().toISOString() },
  ];
  const outputs = [];
  for (const { pid, holder, startedAt } of cases) {
    const install = makeInstall(t, { config: EXISTING });
    const lockPath = path.join(install.stateRoot, 'data', 'relay-server.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid, tokenHash: 'x', startedAt, holder }));
    // The CLI's own check, not the harness's stand-in.
    const result = await runStart(install.options({ isProcessAliveImpl: undefined, readyWaitMs: 100 }));
    assert.deepEqual(result, { code: 1, reason: 'server-not-ready' });
    outputs.push({ install, lockPath, pid });
  }
  const [known, unknown] = outputs;
  assert.ok(known.install.lines.some((line) => line.includes(`The lock ${known.lockPath} is held by relay process ${known.pid} (started 2026-10-21T08:00:00.000Z): oar stop, or end process ${known.pid}.`)), known.install.output());
  assert.doesNotMatch(known.install.output(), /delete/);
  assert.ok(unknown.install.lines.some((line) => line.includes(`The lock ${unknown.lockPath} names process ${unknown.pid}, which cannot be told to be a relay: if no relay is running, end process ${unknown.pid} or delete the lock.`)), unknown.install.output());
});

// The CLI calls with its cli agent token, which the relay takes for a stop
// and a restart now over loopback.
test('stop asks the relay to stop (the cli agent token, over loopback) and waits until its port is closed', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  assert.deepEqual(await runStop(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'stopped' });
  assert.deepEqual(relay.shutdowns, [
    { port: 4100, auth: install.cliAuth(), restart: false, reason: 'oar-cli', requestedBy: 'oar-cli' },
  ]);
  assert.match(install.output(), /The relay is stopped\./);
  assert.equal(relay.running, false);

  // Already stopped.
  install.lines.length = 0;
  assert.deepEqual(await runStop(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'not-running' });
  assert.match(install.output(), /The relay is not running\./);

  // A relay from before this version takes only a queued restart from the cli token: it says so.
  const older = makeInstall(t, { config: EXISTING });
  const olderRelay = fakeRelay(older, { port: 4100, refuseStop: true });
  assert.deepEqual(await runStop(older.options({ fetchImpl: olderRelay.fetch })), { code: 1, reason: 'stop-refused' });
  assert.match(older.output(), /The relay refused: stopping it is for you to do in the web UI/);
  assert.equal(olderRelay.running, true);
});

test('stop --now, restart --now and uninstall ask y/N on a terminal; a script needs --yes', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100 });
  const declined = scripted([false]);
  assert.deepEqual(await runStop(install.options({ argv: ['--now'], fetchImpl: relay.fetch, stdin: TTY, prompter: declined })), { code: 1, reason: 'not-confirmed' });
  assert.equal(declined.asked[0], 'Stop the relay now? Running turns are cut off.');
  assert.deepEqual(relay.shutdowns, [], 'nothing was sent');
  assert.match(install.output(), /Not confirmed\. Nothing was changed\./);

  const restartDeclined = scripted([false]);
  assert.deepEqual(await runRestart(install.options({ argv: ['--now'], fetchImpl: relay.fetch, stdin: TTY, prompter: restartDeclined })), { code: 1, reason: 'not-confirmed' });
  assert.equal(restartDeclined.asked[0], 'Restart the relay now? Running turns are cut off.');
  assert.deepEqual(relay.shutdowns, []);

  const uninstallDeclined = scripted([false]);
  assert.deepEqual(await runUninstall(install.options({ argv: [], fetchImpl: relay.fetch, stdin: TTY, prompter: uninstallDeclined })), { code: 1, reason: 'not-confirmed' });
  assert.match(uninstallDeclined.asked[0], /^Uninstall OAR\?/);
  assert.deepEqual(relay.shutdowns, []);

  // Yes on a terminal: done.
  assert.deepEqual(await runStop(install.options({ argv: ['--now'], fetchImpl: relay.fetch, stdin: TTY, prompter: scripted([true]) })), { code: 0, reason: 'stopped' });
  assert.deepEqual(relay.shutdowns.map(({ restart, immediate }) => ({ restart, immediate })), [{ restart: false, immediate: true }]);
  // A plain stop asks nothing.
  relay.running = true;
  assert.deepEqual(await runStop(install.options({ argv: [], fetchImpl: relay.fetch, stdin: TTY, prompter: scripted([]) })), { code: 0, reason: 'stopped' });
  // A script (no terminal) is refused without --yes, with a line naming it, and sends nothing.
  relay.running = true;
  const sent = relay.shutdowns.length;
  for (const [run, argv, command] of [
    [runStop, ['--now'], 'oar stop --now --yes'],
    [runRestart, ['--now'], 'oar restart --now --yes'],
    [runUninstall, [], 'oar uninstall --yes'],
    [runUninstall, ['--purge'], 'oar uninstall --purge --yes'],
  ]) {
    install.lines.length = 0;
    assert.deepEqual(await run(install.options({ argv, fetchImpl: relay.fetch, prompter: scripted([]) })), { code: 1, reason: 'needs-yes' }, command);
    assert.ok(install.output().includes(`No terminal to ask on. To go ahead without the question, run: ${command}`), install.output());
  }
  assert.equal(relay.shutdowns.length, sent, 'nothing was sent');
  // With --yes a script goes ahead without a question, and so does a terminal.
  assert.equal((await runRestart(install.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, prompter: scripted([]) }))).code, 0);
  assert.deepEqual(relay.shutdowns.at(-1), { port: 4100, auth: install.cliAuth(), restart: true, immediate: true, reason: 'oar-cli', requestedBy: 'oar-cli' });
  relay.running = true;
  assert.deepEqual(await runStop(install.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, stdin: TTY, prompter: scripted([]) })), { code: 0, reason: 'stopped' });
});

test('stop: a busy relay stops later, a foreign port holder is not touched, the service goes through systemd', async (t) => {
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  assert.deepEqual(await runStop(busy.options({ fetchImpl: busyRelay.fetch })), { code: 0, reason: 'stop-queued' });
  assert.match(busy.output(), /stops by itself when its running turns finish/);

  const foreign = makeInstall(t, { config: EXISTING });
  const foreignRelay = fakeRelay(foreign, { port: 4100, foreign: true });
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

});

test('stop under the service goes through the relay; --now and a silent relay go to systemd', async (t) => {
  const service = makeInstall(t, { config: EXISTING });
  writeUnit(service, '[Unit]\n');
  const serviceRelay = fakeRelay(service, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(service, { active: true, relay: serviceRelay });
  const options = (argv, overrides = {}) => service.options({ argv, fetchImpl: serviceRelay.fetch, spawnSyncImpl: systemd.impl, ...overrides });
  assert.deepEqual(await runStop(options([])), { code: 0, reason: 'stopped' });
  assert.deepEqual(serviceRelay.shutdowns.map(({ restart, immediate }) => ({ restart, immediate })), [{ restart: false, immediate: undefined }]);
  assert.ok(!systemd.calls.includes('systemctl --user stop oar'));
  assert.match(service.output(), /The relay is stopped\. The service stays enabled: it starts again at the next boot, or with: oar start/);

  // A busy relay stops once its turns finish; the unit stays enabled.
  const busy = makeInstall(t, { config: EXISTING });
  writeUnit(busy, '[Unit]\n');
  const busyRelay = fakeRelay(busy, { port: 4100, busy: true });
  const busySystemd = fakeSystemd(busy, { active: true, relay: busyRelay });
  assert.deepEqual(await runStop(busy.options({ argv: [], fetchImpl: busyRelay.fetch, spawnSyncImpl: busySystemd.impl })), { code: 0, reason: 'stop-queued' });
  assert.match(busy.output(), /stops by itself when its running turns finish \(at once: oar stop --now\)\. The service stays enabled/);
  assert.ok(!busySystemd.calls.includes('systemctl --user stop oar'));

  // A relay from before this version refuses the cli token a stop: the service stops it.
  const older = makeInstall(t, { config: EXISTING });
  writeUnit(older, '[Unit]\n');
  const olderRelay = fakeRelay(older, { port: 4100, refuseStop: true });
  const olderSystemd = fakeSystemd(older, { active: true, relay: olderRelay });
  assert.deepEqual(await runStop(older.options({ argv: [], fetchImpl: olderRelay.fetch, spawnSyncImpl: olderSystemd.impl })), { code: 0, reason: 'stopped' });
  assert.ok(olderSystemd.calls.includes('systemctl --user stop oar'));
  assert.match(older.output(), /The relay service is stopped\./);

  // --now: systemd, without asking the relay.
  serviceRelay.running = true;
  systemd.active = true;
  serviceRelay.shutdowns.length = 0;
  service.lines.length = 0;
  assert.deepEqual(await runStop(options(['--now', '--yes'])), { code: 0, reason: 'stopped' });
  assert.ok(systemd.calls.includes('systemctl --user stop oar'));
  assert.deepEqual(serviceRelay.shutdowns, []);
  assert.match(service.output(), /The relay service is stopped\./);

  // A unit in its restart backoff: nothing answers, systemd stops it.
  systemd.calls.length = 0;
  systemd.activeState = 'activating';
  assert.deepEqual(await runStop(options([])), { code: 0, reason: 'stopped' });
  assert.ok(systemd.calls.includes('systemctl --user stop oar'));
  systemd.activeState = null;

  // A relay that answers with another token (changed by hand): systemd too.
  const changed = makeInstall(t, { config: EXISTING });
  writeUnit(changed, '[Unit]\n');
  const changedRelay = fakeRelay(changed, { port: 4100, foreign: true });
  const changedSystemd = fakeSystemd(changed, { active: true, relay: changedRelay });
  assert.deepEqual(await runStop(changed.options({ argv: [], fetchImpl: changedRelay.fetch, spawnSyncImpl: changedSystemd.impl })), { code: 0, reason: 'stopped' });
  assert.ok(changedSystemd.calls.includes('systemctl --user stop oar'));
});

test('under the service, a relay still on its earlier port is asked there', async (t) => {
  const install = makeInstall(t, { config: { ...EXISTING, port: 4150 } });
  writeUnit(install, '[Unit]\n');
  fs.mkdirSync(path.dirname(install.previousPath), { recursive: true });
  fs.writeFileSync(install.previousPath, JSON.stringify({ port: 4100 }));
  const relay = fakeRelay(install, { port: 4100 });
  const systemd = fakeSystemd(install, { active: true, relay });
  assert.deepEqual(await runRestart(install.options({ argv: [], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(relay.shutdowns.map(({ port, auth, restart }) => ({ port, auth, restart })), [{ port: 4100, auth: install.cliAuth(), restart: true }]);
  assert.ok(!systemd.calls.includes('systemctl --user restart oar'));
  assert.equal(relay.port, 4150);
  assert.equal(fs.existsSync(install.previousPath), false);
});

test('--now of a relay without a service asks it not to wait for its turns (the cli agent token may, over loopback)', async (t) => {
  // systemd is there, but no unit: --now never goes to systemctl.
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', busy: true });
  const systemd = fakeSystemd(install, { relay });
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runStop(options(['--now', '--yes'])), { code: 0, reason: 'stopped' });
  assert.equal(relay.shutdowns[0].immediate, true);
  assert.equal(relay.shutdowns[0].restart, false);
  relay.running = true;
  assert.equal((await runRestart(options(['--now', '--yes']))).code, 0);
  assert.deepEqual(relay.shutdowns.slice(1).map(({ restart, immediate }) => ({ restart, immediate })), [{ restart: true, immediate: true }]);
  assert.deepEqual(systemd.calls.filter((call) => /stop|restart|reset-failed|enable/.test(call)), []);
  // Without --now the request waits for the turns, as before.
  relay.busy = false;
  await runStop(options([]));
  assert.equal(relay.shutdowns.at(-1).immediate, undefined);

  // A relay from before this version refuses the cli token a restart now, and says where to do it.
  const older = makeInstall(t, { config: EXISTING });
  const olderRelay = fakeRelay(older, { port: 4100, refuseStop: true });
  assert.equal((await runRestart(older.options({ argv: ['--now', '--yes'], fetchImpl: olderRelay.fetch }))).code, 1);
  assert.match(older.output(), /restarting it without waiting is for you to do in the web UI/);
});

test('restart restarts a running relay through its API, the service through systemd, and starts a stopped one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  assert.deepEqual(await runRestart(install.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'restarted' });
  assert.equal(relay.shutdowns[0].restart, true);
  assert.match(install.output(), /The relay restarted\./);
  assert.match(install.output(), /Relay URL:/);

  // Under the service: through the relay too, which waits for its turns.
  const service = makeInstall(t, { config: EXISTING });
  writeUnit(service, '[Unit]\n');
  const serviceRelay = fakeRelay(service, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(service, { active: true, relay: serviceRelay });
  const options = (argv) => service.options({ argv, fetchImpl: serviceRelay.fetch, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runRestart(options([])), { code: 0, reason: 'restarted' });
  assert.equal(serviceRelay.shutdowns.length, 1);
  assert.equal(serviceRelay.shutdowns[0].restart, true);
  assert.ok(!systemd.calls.includes('systemctl --user restart oar'));

  // --now: systemd at once, its backoff cleared first.
  assert.deepEqual(await runRestart(options(['--now', '--yes'])), { code: 0, reason: 'restarted' });
  assert.equal(serviceRelay.shutdowns.length, 1);
  const reset = systemd.calls.indexOf('systemctl --user reset-failed oar');
  assert.ok(reset > -1 && systemd.calls.indexOf('systemctl --user restart oar') > reset);

  // A relay that does not answer (its unit restarting, or hung): systemd.
  systemd.calls.length = 0;
  serviceRelay.running = false;
  assert.deepEqual(await runRestart(options([])), { code: 0, reason: 'restarted' });
  assert.deepEqual(systemd.calls.filter((call) => /reset-failed|restart/.test(call)), ['systemctl --user reset-failed oar', 'systemctl --user restart oar']);
  assert.equal(serviceRelay.shutdowns.length, 1);

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
  assert.equal(unit, await unitFor(install));
  assert.match(unit, /^Environment="?COPILOT_WEB_RELAY_DATA_DIR=/m);
  assert.ok(systemd.calls.includes('loginctl enable-linger dev'));
  assert.ok(systemd.calls.includes('systemctl --user daemon-reload'));
  assert.ok(systemd.calls.includes('systemctl --user enable --now oar'));
  assert.equal(relay.running, true);
  assert.deepEqual(relay.shutdowns, []);

  install.lines.length = 0;
  await runService(options(['status']));
  assert.match(install.output(), /Service: installed, running/);
});

test('service install first stops a relay that was started by hand; one that refuses, the service takes over later', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { relay });
  const result = await runService(install.options({ argv: ['install'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.deepEqual(result, { code: 0, reason: 'service-install' });
  assert.equal(relay.shutdowns.length, 1);
  assert.equal(relay.shutdowns[0].restart, false);
  assert.ok(systemd.calls.indexOf('systemctl --user enable --now oar') > -1);
  assert.equal(systemd.active, true);

  // A relay from before this version refuses the cli token a stop: the running relay is not cut off.
  const older = makeInstall(t, { config: EXISTING });
  const olderRelay = fakeRelay(older, { port: 4100, refuseStop: true });
  const olderSystemd = fakeSystemd(older, { relay: olderRelay });
  await runService(older.options({ argv: ['install'], fetchImpl: olderRelay.fetch, spawnSyncImpl: olderSystemd.impl }));
  assert.ok(olderSystemd.calls.includes('systemctl --user enable oar'));
  assert.ok(!olderSystemd.calls.includes('systemctl --user enable --now oar'));
  assert.match(older.output(), /takes over at the next boot/);

  // A busy relay is not cut off: the service waits for the next start.
  const busy = makeInstall(t, { config: EXISTING });
  const busyRelay = fakeRelay(busy, { port: 4100, token: 'old-token', busy: true });
  const busySystemd = fakeSystemd(busy, { relay: busyRelay });
  await runService(busy.options({ argv: ['install'], fetchImpl: busyRelay.fetch, spawnSyncImpl: busySystemd.impl }));
  assert.ok(busySystemd.calls.includes('systemctl --user enable oar'));
  assert.ok(!busySystemd.calls.includes('systemctl --user enable --now oar'));
  assert.match(busy.output(), /takes over at the next boot/);
});

test('service remove on Linux disables the service, deletes the unit and reloads systemd', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  writeUnit(install, await unitFor(install));
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
  assert.match(install.lines.at(-1), /Settings → General → Autostart \(Windows\)/);
  assert.deepEqual(autostart.sets, [true, false]);
});

test('the service is not there on macOS yet, nor for a git checkout outside Linux', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  assert.deepEqual(await runService(install.options({ argv: ['install'], platform: 'darwin' })), { code: 1, reason: 'unsupported' });
  assert.match(install.output(), /not supported on macOS yet\. Start the relay with: oar start/);

  const checkout = makeCheckout(t);
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(await runService(checkout.options({ argv: ['install'], platform })), { code: 1, reason: 'git-checkout' });
    assert.deepEqual(await runStart(checkout.options({ platform })), { code: 1, reason: 'git-checkout' });
  }
  // On Linux without systemd: no service, and npm start for the relay.
  checkout.lines.length = 0;
  assert.deepEqual(await runService(checkout.options({ argv: ['install'] })), { code: 1, reason: 'no-systemd' });
  assert.match(checkout.output(), /Start the relay with: npm start/);
  // Without its unit a checkout is not started in the background.
  assert.deepEqual(await runStart(checkout.options({ spawnSyncImpl: fakeSystemd(checkout).impl })), { code: 1, reason: 'git-checkout' });
  assert.match(checkout.output(), /npm start, or run it as a service: node bin\/oar\.js service install/);
  assert.deepEqual(checkout.spawned, []);
});

test('service install in a git checkout writes the checkout unit and starts it through systemd', async (t) => {
  const install = makeCheckout(t);
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay });
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runService(options(['install'])), { code: 0, reason: 'service-install' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), await unitFor(install, { checkout: true }));
  const unit = fs.readFileSync(install.unitPath, 'utf8');
  assert.ok(unit.includes(`WorkingDirectory=${install.packageRoot}\n`));
  assert.doesNotMatch(unit, /COPILOT_WEB_RELAY_/);
  assert.ok(systemd.calls.includes('loginctl enable-linger dev'));
  const reload = systemd.calls.indexOf('systemctl --user daemon-reload');
  const reset = systemd.calls.indexOf('systemctl --user reset-failed oar');
  const enable = systemd.calls.indexOf('systemctl --user enable --now oar');
  assert.ok(reload > -1 && reset > reload && enable > reset, systemd.calls.join('\n'));
  assert.deepEqual(install.spawned, []);

  install.lines.length = 0;
  assert.deepEqual(await runService(options(['status'])), { code: 0, reason: 'service-status' });
  assert.match(install.output(), /Service: installed, running/);
  assert.match(install.output(), new RegExp(`Unit: ${install.unitPath.replace(/[\\.]/g, '\\$&')} \\(written by OAR for this install\\)`));

  // start, status and stop of the checkout go through the unit.
  assert.deepEqual(await runStop(options([])), { code: 0, reason: 'stopped' });
  assert.equal(relay.shutdowns.at(-1).restart, false);
  assert.match(install.output(), /starts again at the next boot, or with: node bin\/oar\.js start/);
  systemd.active = false;
  systemd.calls.length = 0;
  assert.deepEqual(await runStart(options([])), { code: 0, reason: 'started' });
  assert.ok(systemd.calls.indexOf('systemctl --user reset-failed oar') < systemd.calls.indexOf('systemctl --user enable --now oar'));
  install.lines.length = 0;
  assert.equal((await runStatus(options([]))).code, 0);
  assert.match(install.output(), /Service: installed, running/);
  assert.deepEqual(install.spawned, []);
});

test('a checkout service install warns about relay paths of the shell, and about a versioned Node', async (t) => {
  const install = makeCheckout(t);
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay });
  const options = install.options({
    argv: ['install'],
    fetchImpl: relay.fetch,
    spawnSyncImpl: systemd.impl,
    nodeBin: '/home/dev/.nvm/versions/node/v24.1.0/bin/node',
  });
  options.env = { ...options.env, COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/scratch' };
  assert.equal((await runService(options)).code, 0);
  assert.match(install.output(), /COPILOT_WEB_RELAY_DATA_DIR is set in this shell; the service does not get it/);
  assert.doesNotMatch(install.output(), /COPILOT_WEB_RELAY_CONFIG is set/);
  assert.match(install.output(), /runs the Node at \/home\/dev\/\.nvm\/versions\/node\/v24\.1\.0\/bin\/node; after switching Node versions, run node bin\/oar\.js service install again/);
  assert.doesNotMatch(fs.readFileSync(install.unitPath, 'utf8'), /scratch/);
});

test('a checkout service waits for the lock of the data folder its config names', async (t) => {
  const install = makeCheckout(t);
  const dataDir = path.join(install.root, 'elsewhere-data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(install.configPath, JSON.stringify({ ...EXISTING, dataDir }));
  // The relay of that data folder ran there before: its secrets are there.
  install.dataDir = dataDir;
  writeRelaySecrets(dataDir);
  const lockPath = path.join(dataDir, 'relay-server.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242 }));
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay });
  writeUnit(install, await unitFor(install, { checkout: true }));
  // No relay answers and the lock's process is alive: the leftover lock goes first.
  const result = await runStart(install.options({ fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl, isProcessAliveImpl: (pid) => pid === 4242 }));
  assert.equal(result.code, 0);
  assert.match(install.output(), new RegExp(`Removing a leftover relay lock \\(${lockPath.replace(/[\\.]/g, '\\$&')}\\)`));
});

test('a hand-made unit is left byte-identical; --replace keeps a copy and writes the generated one', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { relay, active: true });
  const handMade = '[Unit]\nDescription=my relay\n\n[Service]\nExecStart=/usr/local/bin/node /srv/oar/server/server.js\n';
  writeUnit(install, handMade);
  const dropIns = path.join(path.dirname(install.unitPath), 'oar.service.d');
  fs.mkdirSync(dropIns);
  fs.writeFileSync(path.join(dropIns, 'libstdcxx.conf'), '[Service]\nEnvironment=LD_PRELOAD=/opt/lib/libstdc++.so.6\n');
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });

  await runService(options(['status']));
  assert.match(install.output(), /Service: installed, running/);
  assert.match(install.output(), /Unit: .*oar\.service \(hand-made\)/);
  assert.match(install.output(), /OAR leaves it as it is\. To replace it with this install's, keeping a copy: oar service install --replace/);
  assert.match(install.output(), /Drop-in: .*libstdcxx\.conf \(your own settings, kept\)/);

  install.lines.length = 0;
  systemd.calls.length = 0;
  assert.deepEqual(await runService(options(['install'])), { code: 1, reason: 'hand-made-unit' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), handMade);
  assert.match(install.output(), /Left as it is: .*oar\.service \(hand-made\)\. To replace it with this install's, keeping a copy: oar service install --replace/);
  assert.deepEqual(systemd.calls.filter((call) => !call.includes('show-environment') && !call.includes('is-active')), []);

  // remove leaves it too.
  assert.deepEqual(await runService(options(['remove'])), { code: 1, reason: 'hand-made-unit' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), handMade);
  assert.match(install.output(), /To remove it, keeping a copy: oar service remove --replace/);
  assert.ok(!systemd.calls.includes('systemctl --user disable --now oar'));

  install.lines.length = 0;
  assert.deepEqual(await runService(options(['install', '--replace'])), { code: 0, reason: 'service-install' });
  const backup = `${install.unitPath}.bak`;
  assert.equal(fs.readFileSync(backup, 'utf8'), handMade);
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), await unitFor(install));
  assert.match(install.output(), /Kept a copy of .*oar\.service as .*oar\.service\.bak/);
  assert.match(install.output(), /The new unit applies at the next restart: oar restart --now/);
  assert.equal(fs.readFileSync(path.join(dropIns, 'libstdcxx.conf'), 'utf8'), '[Service]\nEnvironment=LD_PRELOAD=/opt/lib/libstdc++.so.6\n');

  // A second replace keeps the first copy.
  writeUnit(install, `${handMade}# again\n`);
  assert.equal((await runService(options(['install', '--replace']))).code, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), handMade);
  assert.equal(fs.readFileSync(`${backup}-2`, 'utf8'), `${handMade}# again\n`);

  // remove --replace keeps a copy and removes it.
  writeUnit(install, handMade);
  assert.deepEqual(await runService(options(['remove', '--replace'])), { code: 0, reason: 'service-remove' });
  assert.equal(fs.existsSync(install.unitPath), false);
  assert.equal(fs.readFileSync(`${backup}-3`, 'utf8'), handMade);
  assert.ok(systemd.calls.includes('systemctl --user disable --now oar'));
});

test('a unit of 0.9.19 is rewritten; one of this version again only says so when its text changed', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token' });
  const systemd = fakeSystemd(install, { relay, active: true });
  writeUnit(install, await unitFor(install, { earlier: true }));
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  await runService(options(['status']));
  assert.match(install.output(), /\(written by an earlier OAR version\)/);
  assert.match(install.output(), /from an earlier OAR version; write this version's with: oar service install/);

  install.lines.length = 0;
  assert.deepEqual(await runService(options(['install'])), { code: 0, reason: 'service-install' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), await unitFor(install));
  assert.equal(fs.existsSync(`${install.unitPath}.bak`), false);
  assert.match(install.output(), /applies at the next restart: oar restart --now/);
  assert.deepEqual(relay.shutdowns, []);

  install.lines.length = 0;
  assert.equal((await runService(options(['install']))).code, 0);
  assert.doesNotMatch(install.output(), /applies at the next restart/);
});

test('a systemd older than 254 gets the unit without the backoff', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay, version: 249 });
  assert.equal((await runService(install.options({ argv: ['install'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }))).code, 0);
  const unit = fs.readFileSync(install.unitPath, 'utf8');
  assert.match(unit, /^RestartSec=10$/m);
  assert.doesNotMatch(unit, /RestartSteps/);
});

test('a worktree leaves the unit of the checkout it came from, and does not start that relay', async (t) => {
  const main = makeCheckout(t);
  const mainRelay = fakeRelay(main, { port: 4100, token: 'old-token', running: false });
  const mainSystemd = fakeSystemd(main, { relay: mainRelay });
  assert.equal((await runService(main.options({ argv: ['install'], spawnSyncImpl: mainSystemd.impl, fetchImpl: mainRelay.fetch }))).code, 0);
  const mainUnit = fs.readFileSync(main.unitPath, 'utf8');

  const worktree = makeCheckout(t);
  const systemd = fakeSystemd(worktree, { active: true });
  const options = (argv) => worktree.options({ argv, homeDir: main.homeDir, spawnSyncImpl: systemd.impl });
  assert.deepEqual(await runService(options(['install'])), { code: 1, reason: 'hand-made-unit' });
  assert.equal(fs.readFileSync(main.unitPath, 'utf8'), mainUnit);
  assert.match(worktree.output(), new RegExp(`Left as it is: .*oar\\.service \\(written by OAR for another install \\(${main.packageRoot.replace(/[\\.]/g, '\\$&')}\\)\\)\\. To replace it with this install's, keeping a copy: node bin/oar\\.js service install --replace`));

  worktree.lines.length = 0;
  await runService(options(['status']));
  assert.match(worktree.output(), /Service: not installed for this install/);
  assert.match(worktree.output(), /written by OAR for another install/);
  await runStatus(options([]));
  assert.match(worktree.output(), /Service: not installed \(oar\.service belongs to another OAR install\)/);

  // start and stop of the worktree leave the other relay's unit alone.
  systemd.calls.length = 0;
  assert.deepEqual(await runStart(options([])), { code: 1, reason: 'git-checkout' });
  assert.equal((await runStop(options([]))).reason, 'not-running');
  assert.deepEqual(systemd.calls.filter((call) => /enable|stop|restart|reset-failed/.test(call)), []);
});

test('a checkout leaves a hand-made unit of another relay alone: no systemctl change for start, stop, restart, --now', async (t) => {
  // A global install's hand-made unit (no OAR marker), and a worktree with a config of its own, its relay not running.
  const worktree = makeCheckout(t, { config: { ...EXISTING, port: 4200 } });
  const handMade = '[Service]\nExecStart=/home/dev/.nvm/versions/node/v22.1.0/bin/node /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar/server/server.js\nEnvironment=COPILOT_WEB_RELAY_CONFIG=/home/dev/.oar/config.json\n';
  writeUnit(worktree, handMade);
  const systemd = fakeSystemd(worktree, { active: true });
  const options = (argv) => worktree.options({ argv, spawnSyncImpl: systemd.impl });
  const mutations = () => systemd.calls.filter((call) => /\b(stop|restart|enable|reset-failed|disable|daemon-reload)\b/.test(call));

  assert.deepEqual(await runStart(options([])), { code: 1, reason: 'git-checkout' });
  assert.equal((await runStop(options([]))).reason, 'not-running');
  assert.equal((await runStop(options(['--now']))).reason, 'not-running');
  assert.deepEqual(await runRestart(options([])), { code: 1, reason: 'git-checkout' });
  assert.deepEqual(await runRestart(options(['--now'])), { code: 1, reason: 'git-checkout' });
  assert.deepEqual(mutations(), []);
  assert.deepEqual(worktree.spawned, []);

  worktree.lines.length = 0;
  await runService(options(['status']));
  assert.match(worktree.output(), /Service: not installed for this install/);
  assert.match(worktree.output(), /\(hand-made, not for this checkout\)/);
  await runStatus(options([]));
  assert.match(worktree.output(), /oar\.service belongs to another OAR install/);
  // install and remove keep refusing it.
  assert.deepEqual(await runService(options(['install'])), { code: 1, reason: 'hand-made-unit' });
  assert.deepEqual(await runService(options(['remove'])), { code: 1, reason: 'hand-made-unit' });
  assert.equal(fs.readFileSync(worktree.unitPath, 'utf8'), handMade);
  assert.deepEqual(mutations(), []);
});

// A checkout's root is a real temp folder here, so a POSIX one; on win32 it
// has a drive letter, which no Linux unit names (the rule itself is tested
// with POSIX paths on every platform in oar-cli-helpers.test.mjs).
test('a hand-made unit that runs this checkout is its service', { skip: process.platform === 'win32' && 'a checkout root is a POSIX path' }, async (t) => {
  for (const unit of [
    (root) => `[Service]\nExecStart=/usr/local/bin/node ${root}/server/server.js\n`,
    (root) => `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/env node ${root}/server/server.js\n`,
    (root) => `[Service]\nExecStart="/opt/my node/node" "${root}/server/../server/server.js"\n`,
  ]) {
    const install = makeCheckout(t);
    writeUnit(install, unit(install.packageRoot));
    const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
    const systemd = fakeSystemd(install, { relay });
    const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
    assert.deepEqual(await runStart(options([])), { code: 0, reason: 'started' });
    assert.ok(systemd.calls.includes('systemctl --user enable --now oar'));
    install.lines.length = 0;
    await runService(options(['status']));
    assert.match(install.output(), /Service: installed, running/);
    assert.match(install.output(), /\(hand-made\)\n/);
  }
});

test('a hand-made unit that only runs in the checkout is not its service, and is kept', { skip: process.platform === 'win32' && 'a checkout root is a POSIX path' }, async (t) => {
  const install = makeCheckout(t);
  const handMade = `[Service]\nWorkingDirectory=${install.packageRoot}\nExecStart=/usr/bin/env node server/server.js\n`;
  writeUnit(install, handMade);
  const relay = fakeRelay(install, { port: 4100, token: 'old-token', running: false });
  const systemd = fakeSystemd(install, { relay, active: true });
  const options = (argv) => install.options({ argv, fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl });
  const mutations = () => systemd.calls.filter((call) => /\b(stop|restart|enable|reset-failed|disable|daemon-reload)\b/.test(call));

  await runService(options(['status']));
  assert.match(install.output(), /Service: not installed for this install/);
  assert.match(install.output(), /\(hand-made, not for this checkout\)/);
  assert.deepEqual(await runStart(options([])), { code: 1, reason: 'git-checkout' });
  assert.deepEqual(await runService(options(['install'])), { code: 1, reason: 'hand-made-unit' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), handMade);
  assert.deepEqual(mutations(), []);
});

test('a unit that is starting (restart backoff) or stopping counts as the running service', async (t) => {
  for (const activeState of ['activating', 'reloading', 'deactivating']) {
    const install = makeInstall(t, { config: EXISTING });
    const systemd = fakeSystemd(install, { activeState });
    writeUnit(install, await unitFor(install));
    const options = (argv) => install.options({ argv, spawnSyncImpl: systemd.impl });
    await runService(options(['status']));
    assert.match(install.output(), /Service: installed, running/);
    assert.deepEqual(await runStop(options([])), { code: 0, reason: 'stopped' });
    assert.ok(systemd.calls.includes('systemctl --user stop oar'), activeState);
  }
  for (const activeState of ['failed', 'inactive']) {
    const install = makeInstall(t, { config: EXISTING });
    writeUnit(install, await unitFor(install));
    await runService(install.options({ argv: ['status'], spawnSyncImpl: fakeSystemd(install, { activeState }).impl }));
    assert.match(install.output(), /Service: installed, not running/);
  }
});

test('service status says when lingering is off', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  writeUnit(install, await unitFor(install));
  await runService(install.options({ argv: ['status'], spawnSyncImpl: fakeSystemd(install, { linger: 'no' }).impl }));
  assert.match(install.output(), /Lingering is off: the relay stops when you log out/);
  const on = makeInstall(t, { config: EXISTING });
  writeUnit(on, await unitFor(on));
  await runService(on.options({ argv: ['status'], spawnSyncImpl: fakeSystemd(on).impl }));
  assert.doesNotMatch(on.output(), /Lingering/);
});

test('setup --start leaves a hand-made unit as it is and starts the relay through it', async (t) => {
  const install = makeInstall(t);
  const relay = fakeRelay(install, { port: 3333, token: '', running: false });
  const systemd = fakeSystemd(install, { relay });
  const handMade = '[Service]\nExecStart=/usr/bin/node /srv/oar/server/server.js\n';
  writeUnit(install, handMade);
  const result = await runSetup(install.options({ argv: ['--defaults', '--start'], fetchImpl: relay.fetch, spawnSyncImpl: systemd.impl }));
  assert.deepEqual(result, { code: 0, reason: 'setup-complete' });
  assert.equal(fs.readFileSync(install.unitPath, 'utf8'), handMade);
  assert.match(install.output(), /Left as it is: .*oar\.service \(hand-made\)/);
  assert.ok(systemd.calls.includes('systemctl --user enable --now oar'));
  assert.ok(!systemd.calls.includes('loginctl enable-linger dev'));
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

test('doctor names the database file the relay runs on, oar.db or copilot.db, and creates none', async (t) => {
  const install = makeInstall(t, { config: EXISTING, relayRan: false });
  const dataDir = path.join(install.stateRoot, 'data');
  const doctor = async () => {
    install.lines.length = 0;
    assert.equal((await runDoctor(install.options({ spawnSyncImpl: () => ({ status: 1 }) }))).code, 0);
    return install.output();
  };
  assert.match(await doctor(), new RegExp(`database      : ${path.join(dataDir, 'oar.db').replace(/[\\.]/g, '\\$&')} \\(not created yet\\)`));
  assert.equal(fs.existsSync(dataDir), false, 'nothing created');

  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'copilot.db'), Buffer.alloc(2 * 1048576));
  assert.match(await doctor(), new RegExp(`database      : ${path.join(dataDir, 'copilot.db').replace(/[\\.]/g, '\\$&')} \\(2\\.0 MB\\)`));
  assert.deepEqual(fs.readdirSync(dataDir), ['copilot.db']);

  fs.writeFileSync(path.join(dataDir, 'oar.db'), Buffer.alloc(1048576));
  const both = await doctor();
  assert.match(both, /database      : .*oar\.db \(1\.0 MB\)/);
  assert.match(both, /\n {18}.*copilot\.db is also there; the next start compares the two/);

  fs.rmSync(path.join(dataDir, 'copilot.db'));
  fs.writeFileSync(path.join(dataDir, 'copilot.db-wal'), 'missed by a rename');
  assert.match(await doctor(), /\n {18}.*copilot\.db-wal is there without its database \(not used, never deleted\)/);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['copilot.db-wal', 'oar.db']);
});

// ─── oar backup ──────────────────────────────────────────────────────────────

// A disk with room (the test machine's may not pass the backup's check).
const roomyDisk = { ...fs, statfsSync: () => ({ bavail: 1e12, bsize: 1, blocks: 1e12 }) };

function seedRelayDatabase(install, name = 'oar.db') {
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, name));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE conversations (id TEXT PRIMARY KEY)');
  db.prepare("INSERT INTO app_settings VALUES ('db_last_run', '{\"version\":\"9.9.8\"}', 'x')").run();
  db.prepare("INSERT INTO conversations VALUES ('c1')").run();
  return { dataDir, db, backupDir: path.join(install.stateRoot, 'backups') };
}

const backupFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.db')).sort() : []);

test('oar backup beside a running relay: a checked copy named after this version, db_last_run untouched', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const { db, backupDir } = seedRelayDatabase(install);
  // Closed in the test itself, before makeInstall's folder removal (the
  // after hooks run in the order they were added; Windows refuses to
  // remove a folder with an open database in it).
  try {
    // The relay's connection stays open and writes on.
    db.pragma('wal_autocheckpoint = 0');
    db.prepare("INSERT INTO conversations VALUES ('only-in-the-wal')").run();
    const result = await runBackup(install.options({ argv: ['--reason', 'Pre Rename!'], fsImpl: roomyDisk }));
    assert.equal(result.code, 0, install.output());
    assert.equal(result.reason, 'backup-written');
    const [file] = backupFiles(backupDir);
    assert.match(file, /^oar-9\.9\.9-\d{8}-\d{6}-pre-rename\.db$/);
    const copy = new Database(path.join(backupDir, file), { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2, 'the -wal rows too');
    copy.close();
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'db_last_run'").get().value, '{"version":"9.9.8"}');
    assert.match(install.output(), /\[oar\] written .*oar-9\.9\.9-.*-pre-rename\.db \(.* MB, quick_check ok, .* s\)/);
  } finally {
    db.close();
  }
});

test('oar backup counts toward keep and rotates; with dbBackups.enabled false it still runs', async (t) => {
  const install = makeInstall(t, { config: { ...EXISTING, dbBackups: { enabled: false, keep: 1 } } });
  const { db, backupDir } = seedRelayDatabase(install);
  // The relay's connection is not needed open here: closed before the run.
  db.close();
  assert.equal((await runBackup(install.options({ argv: [], fsImpl: roomyDisk }))).code, 0);
  const [first] = backupFiles(backupDir);
  assert.match(first, /-manual\.db$/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await runBackup(install.options({ argv: ['--reason', 'second'], fsImpl: roomyDisk }))).code, 0);
  assert.deepEqual(backupFiles(backupDir).map((name) => name.replace(/\d{8}-\d{6}/, 'T')), ['oar-9.9.9-T-second.db'], 'keep 1: the first rotated out');
});

test('oar backup with no database fails and creates none; with both names it backs up oar.db', async (t) => {
  const install = makeInstall(t, { config: EXISTING, relayRan: false });
  const dataDir = path.join(install.stateRoot, 'data');
  const none = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  assert.deepEqual(none, { code: 1, reason: 'no-database' });
  assert.match(install.output(), /No database in .*data to back up \(neither oar\.db nor copilot\.db\)/);
  assert.equal(fs.existsSync(dataDir), false);

  const legacy = seedRelayDatabase(install, 'copilot.db');
  legacy.db.close();
  const current = seedRelayDatabase(install, 'oar.db');
  current.db.prepare("INSERT INTO conversations VALUES ('c2')").run();
  current.db.close();
  assert.equal((await runBackup(install.options({ argv: [], fsImpl: roomyDisk }))).code, 0);
  const copy = new Database(path.join(current.backupDir, backupFiles(current.backupDir)[0]), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2, 'oar.db, not copilot.db');
  copy.close();
});

test('oar backup: a guarded folder is a skip (exit 0, said); a copy that fails is exit 1; --reason needs a value', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const { db, backupDir } = seedRelayDatabase(install);
  db.close();
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'DO_NOT_TOUCH.md'), '');
  const skipped = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  assert.deepEqual([skipped.code, skipped.reason], [0, 'backup-skipped']);
  assert.match(install.output(), /\[oar\] skipped: .*DO_NOT_TOUCH\.md guards .*: nothing is written there/);
  fs.rmSync(path.join(backupDir, 'DO_NOT_TOUCH.md'));

  fs.writeFileSync(path.join(install.stateRoot, 'data', 'oar.db'), 'not a database at all, just text that is long enough');
  for (const side of ['-wal', '-shm']) fs.rmSync(path.join(install.stateRoot, 'data', `oar.db${side}`), { force: true });
  const failed = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  assert.equal(failed.code, 1);
  assert.deepEqual(backupFiles(backupDir), []);

  install.lines.length = 0;
  assert.deepEqual(await main(install.options({ argv: ['backup', '--reason'] })), { code: 2, reason: 'usage' });
  assert.match(install.output(), /--reason needs a value/);
});

test('start while the relay backs up its database says so, not that it did not come up', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ format: 2, pid: 5151, tokenHash: 'x', holder: null }));
  fs.writeFileSync(path.join(dataDir, 'db-backup-progress.json'), JSON.stringify({ pid: 5151, task: 'backup', from: path.join(dataDir, 'oar.db'), bytes: 351 * 1048576 }));
  const result = await runStart(install.options({ isProcessAliveImpl: (pid) => pid === 5151 }));
  assert.deepEqual(result, { code: 0, reason: 'bringing-over' });
  assert.match(install.output(), /The relay \(process 5151\) is backing up its database \(.+oar\.db, 351 MB\) before this version's migrations and is still running/);
  fs.rmSync(path.join(dataDir, 'db-backup-progress.json'));
  fs.writeFileSync(path.join(dataDir, 'earlier-database-progress.json'), JSON.stringify({ pid: 5151, task: 'compare', from: path.join(dataDir, 'copilot.db'), bytes: 2 * 1048576 }));
  install.lines.length = 0;
  await runStart(install.options({ isProcessAliveImpl: (pid) => pid === 5151 }));
  assert.match(install.output(), /is comparing its two database files \(.+copilot\.db, 2 MB\)/);
});

test('doctor lists the backups: folder, settings, this relay\'s, the last result, and other files here, not rotated', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const { db, backupDir } = seedRelayDatabase(install);
  db.close();
  await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  fs.writeFileSync(path.join(backupDir, 'main-0.9.19-20261020.db'), Buffer.alloc(1048576));
  fs.writeFileSync(path.join(backupDir, 'MIGRATION.md'), 'receipt');
  install.lines.length = 0;
  await runDoctor(install.options({ spawnSyncImpl: () => ({ status: 1 }) }));
  const output = install.output();
  assert.match(output, new RegExp(`backups       : ${backupDir.replace(/[\\.]/g, '\\$&')}\n`));
  assert.match(output, /at start: on, keep 2/);
  assert.match(output, /last: written oar-9\.9\.9-\d{8}-\d{6}-manual\.db \(0\.0 MB\), less than an hour ago/);
  assert.match(output, /this relay's \(1 of 2\):\n {20}oar-9\.9\.9-.*-manual\.db/);
  assert.match(output, /other files here \(not rotated\):\n {20}main-0\.9\.19-20261020\.db  1\.0 MB\n {20}MIGRATION\.md  0\.0 MB/);
});

test('oar backup and doctor use the data folder the relay runs on: a checkout\'s config dataDir, COPILOT_WEB_RELAY_DATA_DIR', async (t) => {
  const install = makeInstall(t);
  // A checkout (.git beside the package): server/config.json names dataDir,
  // and an old server/data/copilot.db is still there.
  fs.mkdirSync(path.join(install.packageRoot, '.git'));
  const live = path.join(install.root, 'live-data');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(install.packageRoot, 'server', 'config.json'), JSON.stringify({ ...EXISTING, dataDir: live, dbBackups: { dir: path.join(install.root, 'bk') } }));
  const stale = seedRelayDatabase({ stateRoot: path.join(install.packageRoot, 'server') }, 'copilot.db');
  stale.db.close();
  const relayDb = new Database(path.join(live, 'oar.db'));
  relayDb.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE conversations (id TEXT PRIMARY KEY)');
  relayDb.prepare("INSERT INTO conversations VALUES ('live-1'), ('live-2')").run();
  relayDb.close();
  const result = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  assert.equal(result.code, 0, install.output());
  const copy = new Database(result.file, { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2, 'the live database, not the stale one');
  copy.close();
  assert.ok(fs.existsSync(path.join(live, 'db-backups.json')), 'the manifest beside the live database');
  install.lines.length = 0;
  await runDoctor(install.options({ spawnSyncImpl: () => ({ status: 1 }) }));
  assert.match(install.output(), new RegExp(`database      : ${path.join(live, 'oar.db').replace(/[\\.]/g, '\\$&')}`));

  // A global install: COPILOT_WEB_RELAY_DATA_DIR wins over the state root's data.
  const global = makeInstall(t, { config: EXISTING });
  const pinned = path.join(global.root, 'pinned');
  fs.mkdirSync(pinned);
  new Database(path.join(pinned, 'oar.db')).close();
  const options = global.options({ argv: [], fsImpl: roomyDisk });
  options.env = { ...options.env, COPILOT_WEB_RELAY_DATA_DIR: pinned };
  assert.equal((await runBackup(options)).code, 0, global.output());
  assert.ok(fs.existsSync(path.join(pinned, 'db-backups.json')));
});

test('oar backup while another live process backs the same database up: refused with a line, its progress file untouched', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const { db, dataDir } = seedRelayDatabase(install);
  db.close();
  const progress = path.join(dataDir, 'db-backup-progress.json');
  fs.writeFileSync(progress, JSON.stringify({ pid: 5151, task: 'backup' }));
  const result = await runBackup(install.options({ argv: [], fsImpl: roomyDisk, isProcessAliveImpl: (pid) => pid === 5151 }));
  assert.deepEqual(result, { code: 1, reason: 'backup-busy' });
  assert.match(install.output(), /\[oar\] Not backing up now: another backup of this database is running \(process 5151\); run oar backup again once it is done\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(progress, 'utf8')), { pid: 5151, task: 'backup' });
});

test('oar backup: an unexpected error is one [oar] line and exit 1, not a crash', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  // A folder named oar.db: opening it throws past backupDatabase.
  fs.mkdirSync(path.join(install.stateRoot, 'data', 'oar.db'), { recursive: true });
  const result = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  assert.deepEqual(result, { code: 1, reason: 'backup-failed' });
  assert.match(install.output(), /^\[oar\] The backup of .*oar\.db failed: /m);
});

test('start: a stale take-over progress file does not hide the backup in progress', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ format: 2, pid: 5151, tokenHash: 'x', holder: null }));
  fs.writeFileSync(path.join(dataDir, 'earlier-database-progress.json'), JSON.stringify({ pid: 4040, from: 'old', bytes: 1 }));
  fs.writeFileSync(path.join(dataDir, 'db-backup-progress.json'), JSON.stringify({ pid: 5151, task: 'backup', from: path.join(dataDir, 'oar.db'), bytes: 1048576 }));
  await runStart(install.options({ isProcessAliveImpl: (pid) => pid === 5151 }));
  assert.match(install.output(), /is backing up its database/);
});

test('doctor names backups whose size changed since they were written: listed apart, not rotated', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const { db, backupDir } = seedRelayDatabase(install);
  db.close();
  const result = await runBackup(install.options({ argv: [], fsImpl: roomyDisk }));
  fs.appendFileSync(result.file, 'changed');
  install.lines.length = 0;
  await runDoctor(install.options({ spawnSyncImpl: () => ({ status: 1 }) }));
  assert.match(install.output(), new RegExp(`changed since written, not rotated:\\n {20}${path.basename(result.file).replace(/[.]/g, '\\.')}`));
  assert.ok(backupFiles(backupDir).length === 1);
});

test('start while the relay waits for oar backup: it is left running and said to be waiting, not that it did not come up', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  const dataDir = path.join(install.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ format: 2, pid: 5151, tokenHash: 'x', holder: null }));
  fs.writeFileSync(path.join(dataDir, 'db-backup-progress.json'), JSON.stringify({ pid: 6262, task: 'backup' }));
  fs.writeFileSync(path.join(dataDir, 'db-backup-wait.json'), JSON.stringify({ pid: 5151, task: 'wait-backup', waitingFor: 6262 }));
  const result = await runStart(install.options({ isProcessAliveImpl: (pid) => pid === 5151 || pid === 6262 }));
  assert.deepEqual(result, { code: 0, reason: 'bringing-over' });
  assert.deepEqual(install.spawned, [], 'not started again, not killed');
  assert.match(install.output(), /The relay \(process 5151\) is waiting for `oar backup` \(process 6262\) to finish before its own backup and is still running/);
  assert.doesNotMatch(install.output(), /did not come up/);
});

// ─── the relay token and agent tokens ────────────────────────────────────────

test('oar agent-token prints the cli agent token, never the relay token; none before the relay ran', async (t) => {
  const install = makeInstall(t, { config: EXISTING });
  assert.deepEqual(await main(install.options({ argv: ['agent-token'] })), { code: 0, reason: 'agent-token' });
  const printed = install.lines.at(-1);
  assert.match(printed, /^oara1_c\./);
  assert.equal(`Bearer ${printed}`, install.cliAuth());
  assert.ok(!install.output().includes('old-token'));

  const fresh = makeInstall(t, { config: EXISTING, relayRan: false });
  assert.deepEqual(await main(fresh.options({ argv: ['agent-token'] })), { code: 1, reason: 'no-agent-key' });
  assert.match(fresh.output(), /No agent token yet/);
});

test('setup on a config from before this version moves the token out of it, and shows none', async (t) => {
  const legacyToken = crypto.randomUUID();
  const install = makeInstall(t, { config: { ...EXISTING, authToken: legacyToken }, relayRan: false });
  fs.mkdirSync(install.dataDir, { recursive: true });
  fs.writeFileSync(install.previousPath, JSON.stringify({ port: 4000, authToken: legacyToken }));
  const result = await runSetup(install.options({ argv: ['--defaults'] }));
  assert.equal(result.code, 0);
  assert.equal(install.readConfig().authToken, undefined);
  assert.equal(install.readConfig().port, 4100);
  assert.equal(install.readSecrets().owner.hash, hashOwnerToken(legacyToken), 'the same token keeps working');
  assert.equal(install.readSecrets().owner.legacyPlaintext, true);
  assert.ok(!install.output().includes(legacyToken), 'never printed');
  assert.doesNotMatch(install.output(), /shown once/);
  assert.ok(!install.output().includes('token='));
  assert.ok(!fs.existsSync(install.previousPath) || !fs.readFileSync(install.previousPath, 'utf8').includes(legacyToken));
});
