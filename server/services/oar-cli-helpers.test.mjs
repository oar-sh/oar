import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildDefaultConfig,
  buildServicePath,
  buildSystemdUnit,
  describeRelayAddress,
  resolveNpmInvocation,
  generateAuthToken,
  parseCliArgs,
  primaryLanAddress,
  relayUrl,
  renderDoctorReport,
  usageText,
} from './oar-cli-helpers.mjs';

test('generated tokens are long, urlsafe, and unique', () => {
  const a = generateAuthToken();
  const b = generateAuthToken();
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(a, b);
});

test('default config carries the documented defaults and a token', () => {
  const config = buildDefaultConfig({ token: 't0k3n' });
  assert.deepEqual(config, {
    authToken: 't0k3n',
    port: 3333,
    localhostOnly: true,
    pollIntervalMs: 3000,
    processingTimeoutMs: 600000,
    conversationSessionMode: 'isolated',
  });
  // Zero telemetry out of the box: no updateCheck key — automatic update
  // checking is an opt-in app setting, never a config default.
  assert.equal('updateCheck' in config, false);
});

test('primaryLanAddress skips internal and IPv6 entries', () => {
  assert.equal(primaryLanAddress({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.7.20' },
    ],
  }), '192.168.7.20');
  assert.equal(primaryLanAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), null);
});

test('relayUrl uses the LAN address only when localhostOnly is off', () => {
  const config = { authToken: 'a b', port: 4000, localhostOnly: false };
  assert.equal(relayUrl({ config, lanAddress: '192.168.7.20' }), 'http://192.168.7.20:4000/?token=a%20b');
  assert.equal(relayUrl({ config: { ...config, localhostOnly: true }, lanAddress: '192.168.7.20' }), 'http://localhost:4000/?token=a%20b');
  assert.equal(relayUrl({ config }), 'http://localhost:4000/?token=a%20b');
});

test('systemd unit points at server.js with the state env pinned', () => {
  const unit = buildSystemdUnit({
    nodeBin: '/usr/bin/node',
    packageRoot: '/home/dev/lib/node_modules/@oar-sh/oar',
    configPath: '/home/dev/.oar/config.json',
    dataDir: '/home/dev/.oar/data',
    logDir: '/home/dev/.oar/logs',
  });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/dev\/lib\/node_modules\/@oar-sh\/oar\/server\/server\.js/);
  assert.match(unit, /Environment=COPILOT_WEB_RELAY_CONFIG=\/home\/dev\/\.oar\/config\.json/);
  assert.match(unit, /Environment=COPILOT_WEB_RELAY_DATA_DIR=\/home\/dev\/\.oar\/data/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.doesNotMatch(unit, /PATH=/);
});

test('systemd unit carries the given PATH, quoted and escaped', () => {
  const unit = buildSystemdUnit({
    nodeBin: '/usr/bin/node',
    packageRoot: '/home/dev/lib/node_modules/@oar-sh/oar',
    configPath: '/home/dev/.oar/config.json',
    dataDir: '/home/dev/.oar/data',
    logDir: '/home/dev/.oar/logs',
    pathEnv: '/home/dev/.local/bin:/mnt/c/Program Files/tool:/opt/100%/bin',
  });
  assert.ok(unit.includes('Environment="PATH=/home/dev/.local/bin:/mnt/c/Program Files/tool:/opt/100%%/bin"'));
});

test('the service PATH is the shell PATH plus the directory of the relay Node', () => {
  assert.equal(
    buildServicePath({ nodeBin: '/home/dev/.oar/runtime/node/bin/node', envPath: '/usr/local/bin:/usr/bin' }),
    '/usr/local/bin:/usr/bin:/home/dev/.oar/runtime/node/bin',
  );
  assert.equal(buildServicePath({ nodeBin: '/usr/bin/node', envPath: '/usr/local/bin:/usr/bin' }), '/usr/local/bin:/usr/bin');
  assert.equal(buildServicePath({ nodeBin: '/usr/bin/node', envPath: '' }), '/usr/bin');
  // ~/.local/bin leads when the shell did not have it, and is not repeated when it did.
  assert.equal(
    buildServicePath({ nodeBin: '/usr/bin/node', envPath: '/usr/local/bin:/usr/bin', homeDir: '/home/dev' }),
    '/home/dev/.local/bin:/usr/local/bin:/usr/bin',
  );
  assert.equal(
    buildServicePath({ nodeBin: '/usr/bin/node', envPath: '/usr/bin:/home/dev/.local/bin', homeDir: '/home/dev' }),
    '/usr/bin:/home/dev/.local/bin',
  );
});

test('npm for an update: the one beside this Node, this Node first on PATH, the package prefix', () => {
  const beside = resolveNpmInvocation({
    execPath: '/home/dev/.oar/runtime/node/bin/node',
    packageRoot: '/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar',
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/dev' },
    existsImpl: (candidate) => candidate === '/home/dev/.oar/runtime/node/bin/npm',
  });
  assert.equal(beside.command, '/home/dev/.oar/runtime/node/bin/npm');
  assert.deepEqual(beside.prefixArgs, ['--prefix', '/home/dev/.oar/npm']);
  assert.equal(beside.env.PATH, '/home/dev/.oar/runtime/node/bin:/usr/bin:/bin');
  assert.equal(beside.env.HOME, '/home/dev');

  // No npm beside this Node: the one on PATH. A package outside an npm
  // prefix layout gets no prefix.
  const fromPath = resolveNpmInvocation({
    execPath: '/usr/bin/node',
    packageRoot: '/srv/oar',
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    existsImpl: () => false,
  });
  assert.equal(fromPath.command, 'npm');
  assert.deepEqual(fromPath.prefixArgs, []);
  assert.equal(fromPath.env.PATH, '/usr/bin:/bin');

  const windows = resolveNpmInvocation({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    packageRoot: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar',
    platform: 'win32',
    env: { PATH: 'C:\\Windows' },
  });
  assert.deepEqual({ command: windows.command, prefixArgs: windows.prefixArgs }, { command: 'npm.cmd', prefixArgs: [] });
});

test('doctor report renders both healthy and missing states without leaking the token', () => {
  const report = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'linux',
    layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json',
    config: { authToken: 'super-secret', port: 3333, localhostOnly: true, cloudflaredTunnel: { enabled: true } },
    dbPath: path.join('/home/dev/.oar', 'data', 'copilot.db'),
    dbSizeBytes: 2 * 1048576,
    probes: [
      { id: 'gh (Copilot)', ok: true, version: 'gh version 2.80.0' },
      { id: 'grok', ok: false },
    ],
  });
  assert.match(report, /OAR 0\.9\.0/);
  assert.match(report, /auth token {4}: set/);
  assert.ok(!report.includes('super-secret'), 'token value must never render');
  assert.match(report, /tunnel {8}: managed/);
  assert.match(report, /2\.0 MB/);
  assert.match(report, /grok {10}: not found/);

  const missing = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'linux',
    layout: { checkout: true },
    configPath: '/home/dev/repo/server/config.json',
    config: null,
    dbPath: '/home/dev/repo/server/data/copilot.db',
    dbSizeBytes: null,
    probes: [],
  });
  assert.match(missing, /missing — run: oar setup/);
  assert.match(missing, /not created yet/);
});

test('doctor report ends with the warnings it is given', () => {
  const report = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'linux',
    layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json',
    config: { authToken: 'tok', port: 3333 },
    dbPath: '/home/dev/.oar/data/copilot.db',
    dbSizeBytes: null,
    warnings: ['Windows holds port 3333 (node.exe)'],
  });
  assert.match(report.split('\n').at(-1), /warning {7}: Windows holds port 3333 \(node\.exe\)/);
});

test('the command may follow options, and --setup style options name it', () => {
  assert.deepEqual(parseCliArgs(['setup', '--port', '3339']), { command: 'setup', args: ['--port', '3339'] });
  assert.deepEqual(parseCliArgs(['--port', '3339', 'setup']), { command: 'setup', args: ['--port', '3339'] });
  assert.deepEqual(parseCliArgs(['--port=3339', 'setup', '--lan']), { command: 'setup', args: ['--port=3339', '--lan'] });
  assert.deepEqual(parseCliArgs(['--setup']), { command: 'setup', args: [] });
  assert.deepEqual(parseCliArgs(['--setup', '--port', '3339', '--start']), { command: 'setup', args: ['--port', '3339', '--start'] });
  assert.deepEqual(parseCliArgs(['setup', '--defaults', '--start']), { command: 'setup', args: ['--defaults', '--start'] });
  assert.deepEqual(parseCliArgs(['--start']), { command: 'start', args: [] });
  assert.deepEqual(parseCliArgs(['--stop']), { command: 'stop', args: [] });
  assert.deepEqual(parseCliArgs(['--status']), { command: 'status', args: [] });
  assert.deepEqual(parseCliArgs(['service', 'install']), { command: 'service', args: ['install'] });
  assert.deepEqual(parseCliArgs(['update', '--to', '0.9.9', '--beta']), { command: 'update', args: ['--to', '0.9.9', '--beta'] });
});

test('no command means the menu, help and version are found anywhere before "--"', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'menu', args: [] });
  assert.deepEqual(parseCliArgs(['--help']), { command: 'help', args: [] });
  assert.deepEqual(parseCliArgs(['setup', '-h']), { command: 'help', args: [] });
  assert.deepEqual(parseCliArgs(['help']), { command: 'help', args: [] });
  assert.deepEqual(parseCliArgs(['--version']), { command: 'version', args: [] });
  assert.deepEqual(parseCliArgs(['-v']), { command: 'version', args: [] });
  // Behind "--" everything belongs to gh copilot.
  assert.deepEqual(parseCliArgs(['copilot', '--', '--help']), { command: 'copilot', args: ['--', '--help'] });
});

test('the launcher flags without a command still mean the Copilot session', () => {
  assert.deepEqual(parseCliArgs(['--no-install-extension']), { command: 'copilot', args: ['--no-install-extension'] });
  assert.deepEqual(parseCliArgs(['--install-extension']), { command: 'copilot', args: ['--install-extension'] });
  assert.deepEqual(
    parseCliArgs(['--port', '3339', '--', '--allow-all']),
    { command: 'copilot', args: ['--port', '3339', '--', '--allow-all'] },
  );
  assert.deepEqual(
    parseCliArgs(['--migrate-from', '/home/dev/old-checkout']),
    { command: 'copilot', args: ['--migrate-from', '/home/dev/old-checkout'] },
  );
  assert.deepEqual(
    parseCliArgs(['copilot', '--port', '3339', '--', '--model', 'x']),
    { command: 'copilot', args: ['--port', '3339', '--', '--model', 'x'] },
  );
});

test('an unknown command or option is an error, never a launch', () => {
  assert.match(parseCliArgs(['strat']).error, /Unknown command: strat/);
  assert.match(parseCliArgs(['--frobnicate']).error, /Unknown option: --frobnicate/);
  assert.match(parseCliArgs(['--port', '3339']).error, /--port needs a command/);
  assert.match(parseCliArgs(['setup', '--port']).error, /--port needs a value/);
  assert.match(parseCliArgs(['setup', '--tunnel']).error, /Unknown option for oar setup: --tunnel/);
  assert.match(parseCliArgs(['start', '--port', '3339']).error, /Unknown option for oar start: --port/);
  assert.match(parseCliArgs(['setup', 'now']).error, /Unexpected argument: now/);
  assert.match(parseCliArgs(['service', 'install', 'remove']).error, /Unexpected argument: remove/);
  assert.match(parseCliArgs(['service', 'enable']).error, /Unexpected argument: enable/);
  assert.match(parseCliArgs(['start', '--', 'x']).error, /takes no "--" part/);
  assert.match(parseCliArgs(['constructor']).error, /Unknown command/);
});

test('the usage names every command', () => {
  const usage = usageText();
  for (const command of ['start', 'stop', 'restart', 'status', 'url', 'setup', 'service install | remove | status', 'copilot', 'doctor', 'update', 'help', '--version']) {
    assert.ok(usage.includes(`oar ${command}`), `usage lacks oar ${command}`);
  }
  for (const flag of ['--port', '--lan', '--local', '--new-token', '--defaults', '--start']) assert.ok(usage.includes(flag), flag);
});

test('a QR code is offered only for an address a phone can reach', () => {
  const lan = describeRelayAddress({ config: { authToken: 'tok', port: 3340, localhostOnly: false }, lanAddress: '192.168.7.20' });
  assert.equal(lan.url, 'http://192.168.7.20:3340/?token=tok');
  assert.equal(lan.qrUrl, lan.url);
  assert.deepEqual(lan.lines, ['[oar] Relay URL: http://192.168.7.20:3340/?token=tok']);

  const local = describeRelayAddress({ config: { authToken: 'tok', port: 3340, localhostOnly: true }, lanAddress: '192.168.7.20' });
  assert.equal(local.url, 'http://localhost:3340/?token=tok');
  assert.equal(local.qrUrl, null);
  assert.match(local.lines[1], /This machine only\. For a phone.*oar setup --lan.*tunnel/);

  // A config without the key listens on this machine only, as the server reads it.
  assert.equal(describeRelayAddress({ config: { authToken: 'tok' }, lanAddress: '192.168.7.20' }).url, 'http://localhost:3333/?token=tok');

  const offline = describeRelayAddress({ config: { authToken: 'tok', port: 3340, localhostOnly: false }, lanAddress: null });
  assert.equal(offline.qrUrl, null);
  assert.match(offline.lines[1], /no network address/);
});

test('a LAN address inside WSL gets a note instead of a QR code', () => {
  const wsl = describeRelayAddress({ config: { authToken: 'tok', port: 3340, localhostOnly: false }, lanAddress: '172.20.5.9', wslNat: true });
  assert.equal(wsl.url, 'http://172.20.5.9:3340/?token=tok');
  assert.equal(wsl.qrUrl, null);
  assert.match(wsl.lines[1], /internal to WSL/);
  assert.match(wsl.lines[1], /tunnel/);
  assert.match(wsl.lines[1], /mirrored networking/);
});

test('a tunnel address a relay reports gets the token and its own QR code', () => {
  const address = describeRelayAddress({
    config: { authToken: 'tok en', port: 3340, localhostOnly: true },
    tunnelBase: 'https://relay.example.com/oar/',
  });
  assert.equal(address.tunnelUrl, 'https://relay.example.com/oar/?token=tok%20en');
  assert.equal(describeRelayAddress({ config: { authToken: 'tok' } }).tunnelUrl, null);
});

test('doctor report shows the tunnel finding it is given instead of the bare config value', () => {
  const report = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'darwin',
    layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json',
    config: { authToken: 'tok', cloudflaredTunnel: { mode: 'managed' } },
    dbPath: '/home/dev/.oar/data/copilot.db',
    dbSizeBytes: null,
    probes: [],
    tunnel: 'managed, cannot start: cloudflared is not installed — install it with: brew install cloudflared',
  });
  assert.match(report, /tunnel {8}: managed, cannot start: cloudflared is not installed — install it with: brew install cloudflared/);
});
