import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_STOP_EXIT_CODE } from '../relay-exit-codes.mjs';
import { CLI_LONG_PROBE_TIMEOUT_MS } from './cli-process-runner.mjs';
import { cleanUpCopilotWrapperAtStart } from './retired-copilot-extension.mjs';

import {
  buildDefaultConfig,
  buildServicePath,
  buildSystemdUnit,
  buildSystemdUnit0919,
  classifySystemdUnit,
  copilotWrapperIsGenerated,
  copilotWrapperPath,
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_PROBES,
  generatedCopilotWrapperSources,
  removeGeneratedCopilotWrapper,
  systemdUnitRunsCheckout,
  describeRelayAddress,
  listSystemdDropIns,
  parseSystemdVersion,
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

test('default config carries the documented defaults and no token (the relay keeps its hash)', () => {
  const config = buildDefaultConfig();
  assert.deepEqual(config, {
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

test('relayUrl uses the LAN address only when localhostOnly is off; a token only when one is given', () => {
  const config = { port: 4000, localhostOnly: false };
  assert.equal(relayUrl({ config, lanAddress: '192.168.7.20' }), 'http://192.168.7.20:4000/');
  assert.equal(relayUrl({ config: { ...config, localhostOnly: true }, lanAddress: '192.168.7.20' }), 'http://localhost:4000/');
  assert.equal(relayUrl({ config }), 'http://localhost:4000/');
  // A token just made (oar setup shows it once) goes into the sign-in link.
  assert.equal(relayUrl({ config, lanAddress: '192.168.7.20', token: 'a b' }), 'http://192.168.7.20:4000/?token=a%20b');
  // A token left in a config from before this version is never put in a link.
  assert.equal(relayUrl({ config: { ...config, authToken: 'legacy' } }), 'http://localhost:4000/');
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
  // A relay that stopped on purpose (exit 78) is not restarted by systemd.
  assert.match(unit, /^Restart=on-failure$/m);
  assert.equal(RELAY_STOP_EXIT_CODE, 78);
  assert.match(unit, new RegExp(`^RestartPreventExitStatus=${RELAY_STOP_EXIT_CODE}$`, 'm'));
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

const GLOBAL_INSTALL = {
  nodeBin: '/home/dev/.oar/runtime/node/bin/node',
  packageRoot: '/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar',
  configPath: '/home/dev/.oar/config.json',
  dataDir: '/home/dev/.oar/data',
  logDir: '/home/dev/.oar/logs',
};
const CHECKOUT = { nodeBin: '/usr/bin/node', packageRoot: '/home/dev/git/oar', checkout: true };

test('the unit of a global install, line by line', () => {
  const unit = buildSystemdUnit({ ...GLOBAL_INSTALL, pathEnv: '/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin:/home/dev/.oar/runtime/node/bin', systemdVersion: 257 });
  assert.equal(unit, [
    '# Generated by `oar service install` for /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar.',
    '# OAR rewrites this file; put settings of your own in oar.service.d/*.conf next to it.',
    '[Unit]',
    'Description=OAR — Open Agent Relay',
    'After=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'ExecStart=/home/dev/.oar/runtime/node/bin/node /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar/server/server.js',
    'Environment=COPILOT_WEB_RELAY_CONFIG=/home/dev/.oar/config.json',
    'Environment=COPILOT_WEB_RELAY_DATA_DIR=/home/dev/.oar/data',
    'Environment=COPILOT_WEB_RELAY_LOG_DIR=/home/dev/.oar/logs',
    'Environment="PATH=/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin:/home/dev/.oar/runtime/node/bin"',
    'KillMode=mixed',
    'Restart=on-failure',
    '# 78: stopped on purpose (database or data folder needs a decision).',
    'RestartPreventExitStatus=78',
    'RestartSec=2',
    'RestartSteps=8',
    'RestartMaxDelaySec=300',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
});

test('the unit of a git checkout runs in the checkout, without state paths', () => {
  const unit = buildSystemdUnit({ ...CHECKOUT, pathEnv: '/home/dev/.local/bin:/usr/bin', systemdVersion: 262 });
  assert.equal(unit, [
    '# Generated by `oar service install` for /home/dev/git/oar.',
    '# OAR rewrites this file; put settings of your own in oar.service.d/*.conf next to it.',
    '[Unit]',
    'Description=OAR — Open Agent Relay',
    'After=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'ExecStart=/usr/bin/node /home/dev/git/oar/server/server.js',
    'WorkingDirectory=/home/dev/git/oar',
    'Environment="PATH=/home/dev/.local/bin:/usr/bin"',
    'KillMode=mixed',
    'Restart=on-failure',
    '# 78: stopped on purpose (database or data folder needs a decision).',
    'RestartPreventExitStatus=78',
    'RestartSec=2',
    'RestartSteps=8',
    'RestartMaxDelaySec=300',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
  assert.doesNotMatch(unit, /COPILOT_WEB_RELAY_/);
});

test('a systemd older than 254, or of an unknown version, gets a fixed restart delay', () => {
  for (const systemdVersion of [253, 249, null, undefined]) {
    const unit = buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion });
    assert.match(unit, /^RestartSec=10$/m);
    assert.doesNotMatch(unit, /RestartSteps|RestartMaxDelaySec|RestartSec=2/);
    assert.match(unit, /^StartLimitIntervalSec=0$/m);
  }
  assert.match(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion: 254 }), /^RestartSteps=8$/m);
  assert.equal(parseSystemdVersion('systemd 257 (257.9-1~deb13u1)\n+PAM +AUDIT'), 257);
  assert.equal(parseSystemdVersion('systemd 249 (249.11-0ubuntu3)'), 249);
  assert.equal(parseSystemdVersion(''), null);
  assert.equal(parseSystemdVersion(undefined), null);
  assert.equal(parseSystemdVersion('command not found'), null);
});

test('unit paths with a space, a quote, % or $ are quoted and escaped', () => {
  const unit = buildSystemdUnit({
    nodeBin: '/opt/my node/bin/node',
    packageRoot: '/srv/100% $x',
    configPath: '/home/dev/my state/config.json',
    dataDir: '/home/dev/50%/data',
    logDir: '/home/dev/.oar/logs',
    systemdVersion: 257,
  });
  assert.ok(unit.includes('ExecStart="/opt/my node/bin/node" "/srv/100%% $$x/server/server.js"\n'));
  assert.ok(unit.includes('Environment="COPILOT_WEB_RELAY_CONFIG=/home/dev/my state/config.json"\n'));
  assert.ok(unit.includes('Environment=COPILOT_WEB_RELAY_DATA_DIR=/home/dev/50%%/data\n'));
  assert.ok(unit.includes('Environment=COPILOT_WEB_RELAY_LOG_DIR=/home/dev/.oar/logs\n'));
  assert.ok(buildSystemdUnit({ ...CHECKOUT, packageRoot: '/home/dev/100% oar' }).includes('WorkingDirectory=/home/dev/100%% oar\n'));
  assert.ok(buildSystemdUnit({ ...CHECKOUT, nodeBin: '/opt/a"b\\c/node' }).includes('ExecStart="/opt/a\\"b\\\\c/node" /home/dev/git/oar/server/server.js\n'));
});

test('the unit 0.9.19 wrote stays as it was', () => {
  assert.equal(buildSystemdUnit0919({ ...GLOBAL_INSTALL, pathEnv: '/usr/bin' }), [
    '[Unit]',
    'Description=OAR — Open Agent Relay',
    'After=network-online.target',
    '',
    '[Service]',
    'ExecStart=/home/dev/.oar/runtime/node/bin/node /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar/server/server.js',
    'Environment=COPILOT_WEB_RELAY_CONFIG=/home/dev/.oar/config.json',
    'Environment=COPILOT_WEB_RELAY_DATA_DIR=/home/dev/.oar/data',
    'Environment=COPILOT_WEB_RELAY_LOG_DIR=/home/dev/.oar/logs',
    'Environment="PATH=/usr/bin"',
    'Restart=on-failure',
    'RestartPreventExitStatus=78',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
});

test('whose a unit is: generated, generated-earlier, other-install, hand-made', () => {
  const classify = (text, install = GLOBAL_INSTALL) => classifySystemdUnit({ text, install });
  // Whatever Node and PATH it was written with, and for either systemd variant.
  for (const systemdVersion of [257, 250]) {
    assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion, pathEnv: '/usr/bin' })), 'generated');
    assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion, nodeBin: '/usr/bin/node' })), 'generated');
    assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion, nodeBin: '/opt/my node/bin/node' })), 'generated');
    assert.equal(classify(buildSystemdUnit({ ...CHECKOUT, systemdVersion, pathEnv: '/bin' }), CHECKOUT), 'generated');
  }
  assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion: 257 }).replace(/\n/g, '\r\n')), 'generated');
  // 0.9.19's text, with any Node and PATH.
  assert.equal(classify(buildSystemdUnit0919({ ...GLOBAL_INSTALL, pathEnv: '/usr/bin' })), 'generated-earlier');
  assert.equal(classify(buildSystemdUnit0919({ ...GLOBAL_INSTALL, nodeBin: '/usr/bin/node' })), 'generated-earlier');
  // A checkout never had a 0.9.19 unit: that text is not its own.
  assert.equal(classify(buildSystemdUnit0919({ ...GLOBAL_INSTALL, packageRoot: CHECKOUT.packageRoot }), CHECKOUT), 'hand-made');
  // A generated unit edited by hand is hand-made.
  const edited = buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion: 257 }).replace('RestartSec=2', 'RestartSec=3');
  assert.equal(classify(edited), 'hand-made');
  assert.equal(classify(`${buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion: 257 })}Environment=EXTRA=1\n`), 'hand-made');
  // Another install's marker: a worktree, the global install beside a checkout.
  const worktree = { ...CHECKOUT, packageRoot: '/home/dev/git/oar-wt/feature' };
  assert.equal(classify(buildSystemdUnit({ ...CHECKOUT, systemdVersion: 257 }), worktree), 'other-install');
  assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, systemdVersion: 257 }), CHECKOUT), 'other-install');
  // The unit for this install written as a checkout's, or the other way round, is not this install's.
  assert.equal(classify(buildSystemdUnit({ ...GLOBAL_INSTALL, checkout: true, systemdVersion: 257 })), 'hand-made');
  // A unit someone wrote, and 0.9.19's unit for another path (no marker).
  assert.equal(classify('[Service]\nExecStart=/usr/bin/node /srv/oar/server/server.js\n'), 'hand-made');
  assert.equal(classify(buildSystemdUnit0919({ ...GLOBAL_INSTALL, packageRoot: '/srv/oar' })), 'hand-made');
});

test('a hand-made unit runs a checkout only when its ExecStart names its server.js', () => {
  const root = '/home/dev/git/oar-wt/feature';
  for (const unit of [
    `[Service]\nExecStart=/usr/local/bin/node ${root}/server/server.js\n`,
    `[Service]\nExecStart=/usr/local/bin/node ${root}/server/server.js --inspect\n`,
    `[Service]\nExecStart="/opt/my node/node" "${root}/server/../server/server.js"\n`,
    `[Service]\nWorkingDirectory=${root}/\nExecStart=/usr/bin/env node ${root}/server/server.js\n`,
  ]) {
    assert.equal(systemdUnitRunsCheckout(unit, root), true, unit);
    assert.equal(systemdUnitRunsCheckout(unit, `${root}/`), true, unit);
  }
  for (const unit of [
    '[Service]\nExecStart=/usr/bin/node /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar/server/server.js\n',
    '[Service]\nExecStart=/usr/bin/node /home/dev/git/oar/server/server.js\n',
    `[Service]\nExecStart=/usr/bin/node ${root}-other/server/server.js\n`,
    '[Service]\nExecStart=/usr/bin/node server/server.js\n',
    '[Service]\nWorkingDirectory=/home/dev/git/oar\nExecStart=/usr/bin/node server/server.js\n',
    '[Service]\nWorkingDirectory=~\nExecStart=/usr/bin/node server/server.js\n',
    // Running in the checkout alone is not enough: the unit may start anything there.
    `[Service]\nWorkingDirectory=${root}/\nExecStart=/usr/bin/env node server/server.js\n`,
    `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/npm start\n`,
    `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${root}/bin/other.js\n`,
    '',
  ]) {
    assert.equal(systemdUnitRunsCheckout(unit, root), false, unit);
  }
});

test('drop-ins next to the unit are listed, sorted, .conf only', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-dropins-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(listSystemdDropIns(home), []);
  const dir = path.join(home, '.config', 'systemd', 'user', 'oar.service.d');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['libstdcxx.conf', 'a-memory.conf', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '[Service]\n');
  assert.deepEqual(listSystemdDropIns(home), [path.join(dir, 'a-memory.conf'), path.join(dir, 'libstdcxx.conf')]);
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
    dbPath: path.join('/home/dev/.oar', 'data', 'oar.db'),
    dbSizeBytes: 2 * 1048576,
    probes: [
      { id: 'copilot', ok: true, version: 'GitHub Copilot CLI 1.0.9' },
      { id: 'grok', ok: false },
    ],
    ownerToken: 'set (hashed)',
  });
  assert.match(report, /OAR 0\.9\.0/);
  assert.match(report, /owner token {3}: set \(hashed\)/);
  assert.ok(!report.includes('super-secret'), 'token value must never render');
  assert.match(report, /tunnel {8}: managed/);
  assert.match(report, /2\.0 MB/);
  assert.match(report, /grok {10}: not found/);
  assert.match(report, /copilot {7}: GitHub Copilot CLI 1\.0\.9/);

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

test('doctor probes the copilot binary, not gh', () => {
  const copilot = DOCTOR_PROBES.find((probe) => probe.id === 'copilot');
  assert.deepEqual({ binary: copilot?.binary, args: copilot?.args }, { binary: 'copilot', args: ['--version'] });
  // Its first run after an install or an update unpacks its package first.
  assert.equal(copilot?.timeoutMs, CLI_LONG_PROBE_TIMEOUT_MS);
  assert.ok(CLI_LONG_PROBE_TIMEOUT_MS > DOCTOR_PROBE_TIMEOUT_MS);
  assert.deepEqual(DOCTOR_PROBES.filter((probe) => probe.timeoutMs).map((probe) => probe.id), ['copilot']);
  assert.ok(!DOCTOR_PROBES.some((probe) => probe.binary === 'gh'));
});

test('doctor report ends with the warnings it is given', () => {
  const report = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'linux',
    layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json',
    config: { authToken: 'tok', port: 3333 },
    dbPath: '/home/dev/.oar/data/oar.db',
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
});

test('the removed oar copilot, its flags and a bare "--" part say it was removed', () => {
  for (const argv of [
    ['copilot'],
    ['copilot', '--port', '3339', '--', '--model', 'x'],
    ['copilot', '--', '--help'],
    ['--', '--allow-all'],
    ['--port', '3339', '--', '--allow-all'],
    ['--no-install-extension'],
    ['--install-extension'],
  ]) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.command, undefined, argv.join(' '));
    assert.match(parsed.error, /^oar copilot was removed: .*oar start$/, argv.join(' '));
  }
  // --migrate-from belongs to setup now.
  assert.match(parseCliArgs(['--migrate-from', '/home/dev/old-checkout']).error, /--migrate-from needs a command/);
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
  for (const command of ['start', 'stop', 'restart', 'status', 'url', 'setup', 'service install | remove | status', 'doctor', 'update', 'build-native', 'help', '--version']) {
    assert.ok(usage.includes(`oar ${command}`), `usage lacks oar ${command}`);
  }
  assert.ok(!usage.includes('copilot'), 'the removed oar copilot');
  for (const flag of ['--port', '--lan', '--local', '--new-token', '--defaults', '--start']) assert.ok(usage.includes(flag), flag);
});

test('a QR code is offered only for an address a phone can reach', () => {
  const lan = describeRelayAddress({ config: { port: 3340, localhostOnly: false }, lanAddress: '192.168.7.20', token: 'tok' });
  assert.equal(lan.url, 'http://192.168.7.20:3340/?token=tok');
  assert.equal(lan.qrUrl, lan.url);
  assert.deepEqual(lan.lines, ['[oar] Relay URL: http://192.168.7.20:3340/?token=tok']);

  // Without a token just made: the address alone, and how to sign in.
  const plain = describeRelayAddress({ config: { port: 3340, localhostOnly: false }, lanAddress: '192.168.7.20' });
  assert.equal(plain.url, 'http://192.168.7.20:3340/');
  assert.equal(plain.qrUrl, plain.url);
  assert.match(plain.lines.at(-1), /Sign in with your relay token .*oar setup --new-token/);

  const local = describeRelayAddress({ config: { port: 3340, localhostOnly: true }, lanAddress: '192.168.7.20', token: 'tok' });
  assert.equal(local.url, 'http://localhost:3340/?token=tok');
  assert.equal(local.qrUrl, null);
  assert.match(local.lines[1], /This machine only\. For a phone.*oar setup --lan.*tunnel/);

  // A config without the key listens on this machine only, as the server reads it.
  assert.equal(describeRelayAddress({ config: {}, lanAddress: '192.168.7.20', token: 'tok' }).url, 'http://localhost:3333/?token=tok');

  const offline = describeRelayAddress({ config: { port: 3340, localhostOnly: false }, lanAddress: null, token: 'tok' });
  assert.equal(offline.qrUrl, null);
  assert.match(offline.lines[1], /no network address/);
});

test('a LAN address inside WSL gets a note instead of a QR code', () => {
  const wsl = describeRelayAddress({ config: { port: 3340, localhostOnly: false }, lanAddress: '172.20.5.9', wslNat: true, token: 'tok' });
  assert.equal(wsl.url, 'http://172.20.5.9:3340/?token=tok');
  assert.equal(wsl.qrUrl, null);
  assert.match(wsl.lines[1], /internal to WSL/);
  assert.match(wsl.lines[1], /tunnel/);
  assert.match(wsl.lines[1], /mirrored networking/);
});

test('a tunnel address a relay reports gets its own QR code, and a token only when one was just made', () => {
  const address = describeRelayAddress({
    config: { port: 3340, localhostOnly: true },
    tunnelBase: 'https://relay.example.com/oar/',
    token: 'tok en',
  });
  assert.equal(address.tunnelUrl, 'https://relay.example.com/oar/?token=tok%20en');
  assert.equal(describeRelayAddress({ config: { authToken: 'legacy' }, tunnelBase: 'https://relay.example.com/' }).tunnelUrl, 'https://relay.example.com/');
  assert.equal(describeRelayAddress({ config: {} }).tunnelUrl, null);
});

test('doctor report shows the tunnel finding it is given instead of the bare config value', () => {
  const report = renderDoctorReport({
    version: '0.9.0',
    nodeVersion: 'v24.0.0',
    platform: 'darwin',
    layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json',
    config: { authToken: 'tok', cloudflaredTunnel: { mode: 'managed' } },
    dbPath: '/home/dev/.oar/data/oar.db',
    dbSizeBytes: null,
    probes: [],
    tunnel: 'managed, cannot start: cloudflared is not installed — install it with: brew install cloudflared',
  });
  assert.match(report, /tunnel {8}: managed, cannot start: cloudflared is not installed — install it with: brew install cloudflared/);
});

// ─── the Copilot CLI wrapper of earlier versions ─────────────────────────────

// What `oar --install-extension` of earlier versions wrote for an install at
// /home/dev/.oar/npm/lib/node_modules/@oar-sh/oar, byte for byte.
const EARLIER_WRAPPER = [
  '// Auto-generated by oar to provide a stable user-global extension entrypoint.',
  '// Do not edit manually; regenerate via `oar --install-extension`.',
  '',
  'import path from "path";',
  '',
  'const PACKAGE_ROOT = "/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar";',
  'const cwd = path.resolve(process.cwd());',
  'const normalizedPackageRoot = path.resolve(PACKAGE_ROOT);',
  'const runningInsidePackage = cwd === normalizedPackageRoot || cwd.startsWith(`${normalizedPackageRoot}${path.sep}`);',
  'const forceGlobalExtension = process.env.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION === "true";',
  '',
  '// Avoid double-loading when the project-local extension is already discoverable from the repo itself.',
  'if (!runningInsidePackage || forceGlobalExtension) {',
  '  await import("file:///home/dev/.oar/npm/lib/node_modules/@oar-sh/oar/.github/extensions/web-relay/extension.mjs");',
  '}',
  '',
].join('\n');

test('the frozen wrapper sources are the ones earlier versions wrote, and the copilot-remote form', () => {
  const [current, renamed] = generatedCopilotWrapperSources('/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar', { platform: 'linux' });
  assert.equal(current, EARLIER_WRAPPER);
  assert.match(renamed, /^\/\/ Auto-generated by copilot-remote to provide/);
  assert.match(renamed, /regenerate via `copilot-remote --install-extension`/);
  const root = '/home/dev/.oar/npm/lib/node_modules/@oar-sh/oar';
  assert.equal(copilotWrapperIsGenerated(EARLIER_WRAPPER.replace(/\n/g, '\r\n'), root, { platform: 'linux' }), true, 'line endings do not count');
  assert.equal(copilotWrapperIsGenerated(renamed, root, { platform: 'linux' }), true);
  assert.equal(copilotWrapperIsGenerated(EARLIER_WRAPPER, '/home/dev/other-oar', { platform: 'linux' }), false, 'another install');
  assert.equal(copilotWrapperIsGenerated(`${EARLIER_WRAPPER}console.log("mine");\n`, root, { platform: 'linux' }), false, 'edited');
});

// A Copilot home with `source` as the wrapper (null: none), and an install
// at `root` whose extension is there or not.
function wrapperHome(t, { source = null, extension = false, extra = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-copilot-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const homeDir = path.join(dir, 'home');
  const root = path.join(dir, 'npm', 'node_modules', '@oar-sh', 'oar');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  if (extension) {
    fs.mkdirSync(path.join(root, '.github', 'extensions', 'web-relay'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'extensions', 'web-relay', 'extension.mjs'), '// the extension\n');
  }
  const wrapper = path.join(homeDir, '.copilot', 'extensions', 'web-relay', 'extension.mjs');
  const text = typeof source === 'function' ? source(root) : source;
  if (text !== null) {
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, text);
  }
  if (extra) fs.writeFileSync(path.join(path.dirname(wrapper), 'notes.txt'), 'kept');
  return { homeDir, root, wrapper, options: { env: {}, homeDir } };
}

test('the wrapper an earlier version generated is removed once its extension is gone, with its empty folder', (t) => {
  for (const form of [0, 1]) {
    const home = wrapperHome(t, { source: (root) => generatedCopilotWrapperSources(root)[form] });
    assert.deepEqual(removeGeneratedCopilotWrapper(home.options), { status: 'removed', path: home.wrapper });
    assert.equal(fs.existsSync(home.wrapper), false);
    assert.equal(fs.existsSync(path.dirname(home.wrapper)), false, 'the empty web-relay folder goes too');
    assert.equal(fs.existsSync(path.join(home.homeDir, '.copilot', 'extensions')), true, 'the extensions folder stays');
  }
});

test('a folder with other files in it stays when the wrapper goes', (t) => {
  const home = wrapperHome(t, { source: (root) => generatedCopilotWrapperSources(root)[0], extra: true });
  assert.equal(removeGeneratedCopilotWrapper(home.options).status, 'removed');
  assert.equal(fs.existsSync(home.wrapper), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(home.wrapper), 'notes.txt'), 'utf8'), 'kept');
});

test('a wrapper a person wrote or edited is left as it is', (t) => {
  for (const source of [
    (root) => `${generatedCopilotWrapperSources(root)[0]}console.log("mine");\n`,
    () => 'await import("/home/dev/my-extension/extension.mjs");\n',
    () => '',
  ]) {
    const home = wrapperHome(t, { source });
    const before = fs.readFileSync(home.wrapper, 'utf8');
    assert.deepEqual(removeGeneratedCopilotWrapper(home.options), { status: 'foreign', path: home.wrapper });
    assert.equal(fs.readFileSync(home.wrapper, 'utf8'), before, 'byte-identical');
  }
});

test('this install no longer has the extension: its generated wrapper goes, at relay start and on oar update', (t) => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.equal(fs.existsSync(path.join(packageRoot, '.github', 'extensions', 'web-relay')), false, 'the extension folder is gone');
  for (const form of [0, 1]) {
    const home = wrapperHome(t, { source: () => generatedCopilotWrapperSources(packageRoot)[form] });
    const lines = [];
    // The relay's start: server-runtime.mjs hands removeGeneratedCopilotWrapper to this.
    const result = cleanUpCopilotWrapperAtStart({ remove: () => removeGeneratedCopilotWrapper(home.options), log: (line) => lines.push(line) });
    assert.deepEqual(result, { status: 'removed', path: home.wrapper });
    assert.deepEqual(lines, [`removed the Copilot CLI extension wrapper of an earlier version: ${home.wrapper}`]);
    assert.equal(fs.existsSync(home.wrapper), false);
  }
});

test('a generated wrapper whose extension is still there is left: it works', (t) => {
  const home = wrapperHome(t, { source: (root) => generatedCopilotWrapperSources(root)[0], extension: true });
  assert.deepEqual(removeGeneratedCopilotWrapper(home.options), { status: 'in-use', path: home.wrapper });
  assert.equal(fs.existsSync(home.wrapper), true);
});

test('no wrapper, no folder: nothing to do and no error', (t) => {
  const home = wrapperHome(t);
  assert.deepEqual(removeGeneratedCopilotWrapper(home.options), { status: 'absent', path: home.wrapper });
  fs.mkdirSync(path.dirname(home.wrapper), { recursive: true });
  assert.equal(removeGeneratedCopilotWrapper(home.options).status, 'absent');
  assert.equal(fs.existsSync(path.dirname(home.wrapper)), true, 'an empty folder is not touched');
});

test('COPILOT_CONFIG_HOME names the Copilot home', (t) => {
  const home = wrapperHome(t);
  const copilotHome = path.join(home.homeDir, 'elsewhere');
  const wrapper = path.join(copilotHome, 'extensions', 'web-relay', 'extension.mjs');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, generatedCopilotWrapperSources(home.root)[0]);
  const options = { ...home.options, env: { COPILOT_CONFIG_HOME: copilotHome } };
  assert.equal(copilotWrapperPath(options), wrapper);
  assert.deepEqual(removeGeneratedCopilotWrapper(options), { status: 'removed', path: wrapper });
});

test('on Windows the wrapper is under USERPROFILE and names its install in Windows form', () => {
  const root = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar';
  const wrapper = 'C:\\Users\\dev\\.copilot\\extensions\\web-relay\\extension.mjs';
  assert.equal(copilotWrapperPath({ env: { USERPROFILE: 'C:\\Users\\dev' }, platform: 'win32', homeDir: 'C:\\Users\\other' }), wrapper);
  assert.equal(copilotWrapperPath({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\dev' }), wrapper, 'the home folder without USERPROFILE');
  const [source] = generatedCopilotWrapperSources(root, { platform: 'win32' });
  assert.ok(source.includes('const PACKAGE_ROOT = "C:\\\\Users\\\\dev\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@oar-sh\\\\oar";'));
  assert.ok(source.includes('await import("file:///C:/Users/dev/AppData/Roaming/npm/node_modules/@oar-sh/oar/.github/extensions/web-relay/extension.mjs");'));

  // On a Windows file system, as seen through fsImpl.
  const files = new Map([[wrapper, source.replace(/\n/g, '\r\n')]]);
  const removed = [];
  const fsImpl = {
    readFileSync: (file) => {
      if (files.has(file)) return files.get(file);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    existsSync: (file) => files.has(file),
    rmSync: (file) => { removed.push(file); files.delete(file); },
    rmdirSync: (dir) => { removed.push(dir); },
  };
  const options = { env: { USERPROFILE: 'C:\\Users\\dev' }, platform: 'win32', fsImpl };
  files.set(`${root}\\.github\\extensions\\web-relay\\extension.mjs`, '// the extension');
  assert.equal(removeGeneratedCopilotWrapper(options).status, 'in-use');
  files.delete(`${root}\\.github\\extensions\\web-relay\\extension.mjs`);
  assert.deepEqual(removeGeneratedCopilotWrapper(options), { status: 'removed', path: wrapper });
  assert.deepEqual(removed, [wrapper, 'C:\\Users\\dev\\.copilot\\extensions\\web-relay']);
});

test('a wrapper that cannot be removed is reported, not thrown', (t) => {
  const home = wrapperHome(t, { source: (root) => generatedCopilotWrapperSources(root)[0] });
  const fsImpl = { ...fs, rmSync: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } };
  const result = removeGeneratedCopilotWrapper({ ...home.options, fsImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /EPERM/);
  assert.equal(fs.existsSync(home.wrapper), true);
});
