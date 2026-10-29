/**
 * Pure helpers behind the `oar` command line — everything here is
 * deterministic and unit-testable; the interactive glue stays in bin/oar.js.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatMegabytes } from './db-backup-service.mjs';

export function generateAuthToken() {
  return randomBytes(32).toString('base64url');
}

export function buildDefaultConfig({ token = generateAuthToken(), port = 3333, localhostOnly = true } = {}) {
  return {
    authToken: token,
    port,
    localhostOnly,
    pollIntervalMs: 3000,
    processingTimeoutMs: 600000,
    conversationSessionMode: 'isolated',
    // No updateCheck key: automatic update checking is opt-in from the web
    // UI (app_settings), never a config default — zero telemetry out of the box.
  };
}

/** First non-internal IPv4 address, for the phone-facing URL when LAN access is on. */
export function primaryLanAddress(interfaces = os.networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

export function relayUrl({ config, lanAddress = null } = {}) {
  const host = !config?.localhostOnly && lanAddress ? lanAddress : 'localhost';
  const token = String(config?.authToken || '').trim();
  return `http://${host}:${config?.port || 3333}/?token=${encodeURIComponent(token)}`;
}

/**
 * What `oar setup` and `oar url` print about the relay's address. `qrUrl` is
 * set only for an address a phone can reach: the LAN address when LAN access
 * is on, and never one that is internal to WSL. `tunnelUrl` is the address a
 * running relay reports for its tunnel, with the token added.
 */
export function describeRelayAddress({ config, lanAddress = null, wslNat = false, tunnelBase = '' } = {}) {
  const lan = config?.localhostOnly === false;
  const url = relayUrl({ config: { ...config, localhostOnly: !lan }, lanAddress });
  const lines = [`[oar] Relay URL: ${url}`];
  let qrUrl = null;
  if (!lan) {
    lines.push('[oar] This machine only. For a phone, switch on LAN access (oar setup --lan) or use a tunnel (README: Remote access).');
  } else if (!lanAddress) {
    lines.push('[oar] LAN access is on, but this machine has no network address.');
  } else if (wslNat) {
    lines.push('[oar] That address is internal to WSL; other devices cannot reach it. Ways out: a tunnel (README: Remote access), or WSL\'s mirrored networking (networkingMode=mirrored in .wslconfig).');
  } else {
    qrUrl = url;
  }
  const base = String(tunnelBase || '').trim().replace(/\/+$/, '');
  const tunnelUrl = base ? `${base}/?token=${encodeURIComponent(String(config?.authToken || '').trim())}` : null;
  return { url, lines, qrUrl, tunnelUrl };
}

const VALUE_OPTIONS = ['--port', '--migrate-from', '--to', '--autostart', '--reason'];
const LAUNCHER_FLAGS = ['--install-extension', '--no-install-extension', '--migrate-from'];
const COMMAND_OPTIONS = { '--setup': 'setup', '--start': 'start', '--stop': 'stop', '--status': 'status' };
const CLI_COMMANDS = {
  menu: {},
  start: {},
  stop: { flags: ['--now'] },
  restart: { flags: ['--now'] },
  status: {},
  url: {},
  doctor: {},
  backup: { values: ['--reason'] },
  help: {},
  version: {},
  setup: { flags: ['--lan', '--local', '--new-token', '--defaults', '--start'], values: ['--port', '--migrate-from', '--autostart'] },
  service: { words: ['install', 'remove', 'status'], flags: ['--replace'] },
  autostart: { words: ['signin', 'boot', 'off', 'status'], flags: ['--replace'] },
  uninstall: { flags: ['--purge'] },
  update: { flags: ['--beta'], values: ['--to'] },
  copilot: { flags: ['--install-extension', '--no-install-extension'], values: ['--port', '--migrate-from'], forwards: true },
};

export function usageText() {
  return [
    'Usage: oar [command] [options]',
    '',
    '  oar                    Menu in a terminal; status and this text elsewhere',
    '  oar start              Start the relay in the background',
    '  oar stop [--now]       Stop the relay (waits for running turns; --now does not)',
    '  oar restart [--now]    Restart the relay (waits for running turns; --now does not)',
    '  oar status             Is the relay running, on which port, as a service',
    '  oar url                Relay URL, with a QR code when a phone can reach it',
    '  oar setup              Auth token, access, port and autostart; asks, or takes',
    '                         [--port <port>] [--lan | --local] [--new-token] [--autostart signin|boot|off]',
    '                         [--defaults] [--start]',
    '  oar autostart signin | boot | off | status [--replace]',
    '                         Start the relay at sign-in or at boot (Windows: boot asks for an admin once);',
    '                         --replace replaces hand-made entries, keeping a copy',
    '  oar service install | remove | status [--replace]',
    '                         Start the relay at boot and keep it running (Linux: a systemd user service);',
    '                         --replace replaces a hand-made unit, keeping a copy',
    '  oar uninstall [--purge]',
    '                         Remove autostart and the package; the data stays (--purge deletes it)',
    '  oar copilot [--port <port>] [--install-extension] [--no-install-extension] [-- gh copilot args...]',
    '                         Relay plus a Copilot terminal session',
    '  oar doctor             Check the install and the provider CLIs',
    '  oar backup [--reason <text>]',
    '                         A copy of the database into the backup folder (safe while the relay runs)',
    '  oar update [--beta] [--to <version>]',
    '  oar help               This text',
    '  oar --version',
  ].join('\n');
}

/**
 * Reads the command line into `{ command, args }`, or `{ error }` for anything
 * `oar` does not know, so nothing starts by accident. The command may follow
 * options (`oar --port 3339 setup`), and `--setup`, `--start`, `--stop` and
 * `--status` name it too. Without a command the launcher's own flags (or a
 * `--` part) mean the Copilot session, and nothing at all means the menu.
 */
export function parseCliArgs(argv = []) {
  const all = (Array.isArray(argv) ? argv : []).map((arg) => String(arg));
  const separator = all.indexOf('--');
  const head = separator === -1 ? all : all.slice(0, separator);
  const forwarded = separator === -1 ? [] : all.slice(separator);
  if (head.includes('--help') || head.includes('-h')) return { command: 'help', args: [] };

  let command = null;
  let args = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (VALUE_OPTIONS.includes(arg)) {
      if (index + 1 >= head.length) return { error: `${arg} needs a value.` };
      args.push(arg, head[index += 1]);
    } else if (arg.startsWith('-') || command) {
      args.push(arg);
    } else {
      command = arg;
    }
  }
  if (!command) {
    const named = args.includes('--setup') ? '--setup' : args.find((arg) => COMMAND_OPTIONS[arg]);
    if (args.includes('--version') || args.includes('-v')) return { command: 'version', args: [] };
    if (named) {
      command = COMMAND_OPTIONS[named];
      args.splice(args.indexOf(named), 1);
    } else if (forwarded.length || args.some((arg) => LAUNCHER_FLAGS.includes(arg))) {
      command = 'copilot';
    } else if (!args.length) {
      command = 'menu';
    } else {
      // An option this command line knows needs its command; any other is unknown.
      const known = [...VALUE_OPTIONS, '--lan', '--local', '--new-token', '--defaults', '--beta'];
      return { error: known.includes(args[0]) ? `${args[0]} needs a command.` : `Unknown option: ${args[0]}` };
    }
  }

  const spec = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command] : null;
  if (!spec) return { error: `Unknown command: ${command}` };
  if (forwarded.length && !spec.forwards) return { error: `oar ${command} takes no "--" part.` };
  let words = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = arg.startsWith('--') ? arg.split('=')[0] : arg;
    if (spec.values?.includes(name)) {
      if (arg === name) index += 1;
    } else if (spec.words?.includes(arg) && words === 0) {
      words += 1;
    } else if (!spec.flags?.includes(arg)) {
      return { error: arg.startsWith('-') ? `Unknown option for oar ${command}: ${arg}` : `Unexpected argument: ${arg}` };
    }
  }
  return { command, args: [...args, ...forwarded] };
}

// The first systemd version with RestartSteps= and RestartMaxDelaySec=.
const SYSTEMD_BACKOFF_VERSION = 254;
const UNIT_MARKER = /^# Generated by `oar service install` for (.*)\.$/m;

/** The version `systemctl --version` prints first (`systemd 257 (257.9-1)`), or null. */
export function parseSystemdVersion(text) {
  const version = Number(String(text || '').match(/^systemd (\d+)/m)?.[1]);
  return Number.isInteger(version) && version > 0 ? version : null;
}

/**
 * A systemd *user* unit for the relay server. The launcher is not used here —
 * the service runs server.js directly, so a `gh copilot` session is not tied
 * to the unit's lifetime. A global install pins its state paths; a git
 * checkout (`checkout`) runs in the checkout and finds its config, data and
 * logs as `npm start` does. Crashes are restarted with a backoff that never
 * gives up; a systemd older than 254 (or one whose version is unknown) has no
 * backoff, and gets a longer fixed delay instead.
 */
export function buildSystemdUnit({
  nodeBin, packageRoot, configPath, dataDir, logDir, pathEnv = '', checkout = false, systemdVersion = null,
}) {
  // systemd units are Linux-only, so the paths inside the unit are always
  // posix-joined — host-platform path.join would write backslashes when this
  // template is exercised on Windows (tests; the CLI never writes it there).
  const backoff = Number(systemdVersion) >= SYSTEMD_BACKOFF_VERSION;
  return [
    `# Generated by \`oar service install\` for ${packageRoot}.`,
    '# OAR rewrites this file; put settings of your own in oar.service.d/*.conf next to it.',
    '[Unit]',
    'Description=OAR — Open Agent Relay',
    'After=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    `ExecStart=${systemdExecWord(nodeBin)} ${systemdExecWord(path.posix.join(packageRoot, 'server', 'server.js'))}`,
    ...(checkout
      ? [`WorkingDirectory=${String(packageRoot).replace(/%/g, '%%')}`]
      : [
        systemdEnvironmentLine('COPILOT_WEB_RELAY_CONFIG', configPath),
        systemdEnvironmentLine('COPILOT_WEB_RELAY_DATA_DIR', dataDir),
        systemdEnvironmentLine('COPILOT_WEB_RELAY_LOG_DIR', logDir),
      ]),
    // A user service starts with systemd's bare PATH: without this line the
    // relay's sessions find neither the provider CLIs in ~/.local/bin nor, on
    // an install with a private Node, `node` and `npm` themselves.
    ...(pathEnv ? [`Environment="PATH=${escapeSystemdValue(pathEnv)}"`] : []),
    // The supervisor alone gets the SIGTERM of a stop, and stops its runtime
    // itself; whatever is left then gets SIGKILL. Session workers run in
    // scopes of their own and are not part of the unit.
    'KillMode=mixed',
    'Restart=on-failure',
    // 78 (RELAY_STOP_EXIT_CODE): the relay stopped on purpose, its database
    // or data folder needs a decision; restarting it cannot help.
    '# 78: stopped on purpose (database or data folder needs a decision).',
    'RestartPreventExitStatus=78',
    ...(backoff ? ['RestartSec=2', 'RestartSteps=8', 'RestartMaxDelaySec=300'] : ['RestartSec=10']),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * The unit 0.9.19 wrote, frozen: a unit with this text is OAR's own, of an
 * earlier version (classifySystemdUnit). Never change it.
 */
export function buildSystemdUnit0919({ nodeBin, packageRoot, configPath, dataDir, logDir, pathEnv = '' }) {
  return [
    '[Unit]',
    'Description=OAR — Open Agent Relay',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${nodeBin} ${path.posix.join(packageRoot, 'server', 'server.js')}`,
    `Environment=COPILOT_WEB_RELAY_CONFIG=${configPath}`,
    `Environment=COPILOT_WEB_RELAY_DATA_DIR=${dataDir}`,
    `Environment=COPILOT_WEB_RELAY_LOG_DIR=${logDir}`,
    // A user service starts with systemd's bare PATH: without this line the
    // relay's sessions find neither the provider CLIs in ~/.local/bin nor, on
    // an install with a private Node, `node` and `npm` themselves.
    ...(pathEnv ? [`Environment="PATH=${escapeSystemdValue(pathEnv)}"`] : []),
    'Restart=on-failure',
    // 78 (RELAY_STOP_EXIT_CODE): the relay stopped on purpose, its database
    // or data folder needs a decision; restarting it cannot help.
    'RestartPreventExitStatus=78',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// Inside a quoted systemd assignment a backslash and a quote need escaping,
// and `%` opens a specifier.
function escapeSystemdValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
}

// Characters that end or change a word of an unquoted systemd value.
const SYSTEMD_NEEDS_QUOTES = /[\s"'\\]/;

// One word of ExecStart=: quoted when it has to be; `%` and `$` (a specifier,
// a variable) are doubled either way.
function systemdExecWord(value) {
  const text = String(value).replace(/\$/g, '$$$$');
  return SYSTEMD_NEEDS_QUOTES.test(text) ? `"${escapeSystemdValue(text)}"` : text.replace(/%/g, '%%');
}

// `Environment=KEY=value`, quoted only when the value has to be: a path
// without a space is written as 0.9.19 wrote it.
function systemdEnvironmentLine(name, value) {
  const text = String(value);
  return SYSTEMD_NEEDS_QUOTES.test(text)
    ? `Environment="${name}=${escapeSystemdValue(text)}"`
    : `Environment=${name}=${text.replace(/%/g, '%%')}`;
}

// The first word of a unit's ExecStart= line: `written` as it stands, `value`
// unquoted and unescaped as systemdExecWord wrote it.
function readExecStartNode(text) {
  const line = String(text || '').match(/^ExecStart=(.*)$/m)?.[1] || '';
  if (line.startsWith('"')) {
    const written = line.match(/^"((?:[^"\\]|\\.)*)"/)?.[0] || '';
    const value = written.slice(1, -1).replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$');
    return { written, value };
  }
  const written = line.split(' ')[0];
  return { written, value: written.replace(/%%/g, '%').replace(/\$\$/g, '$') };
}

// The words of a unit's ExecStart= line, unquoted and unescaped.
function readExecStartWords(text) {
  const line = String(text || '').match(/^ExecStart=(.*)$/m)?.[1] || '';
  const words = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const word = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
    words.push(word.replace(/%%/g, '%').replace(/\$\$/g, '$'));
  }
  return words;
}

/**
 * Whether a unit without OAR's marker runs the relay of the checkout at
 * `root`: its ExecStart names `<root>/server/server.js`. A unit that only
 * runs in `<root>` (WorkingDirectory) does not count: it may start anything
 * there. A hand-made unit of another install is not a checkout's service.
 */
export function systemdUnitRunsCheckout(text, root) {
  const resolve = (value) => path.posix.resolve(String(value));
  const server = path.posix.join(resolve(root), 'server', 'server.js');
  return readExecStartWords(text).some((word) => word.startsWith('/') && resolve(word) === server);
}

/** The install a unit's marker names, or ''. */
export function systemdUnitMarkerRoot(text) {
  return String(text || '').match(UNIT_MARKER)?.[1] || '';
}

/**
 * Whose a unit is, for this install (`{ nodeBin, packageRoot, configPath,
 * dataDir, logDir, checkout }`): 'generated' (the text this version writes for
 * it, with the Node of its own ExecStart and for either systemd variant),
 * 'generated-earlier' (the text 0.9.19 wrote for it), 'other-install' (OAR's
 * marker for another install path), or 'hand-made' (anything else, a
 * generated unit edited by hand too). The PATH line does not count: it is the
 * PATH of the shell that ran the install.
 */
export function classifySystemdUnit({ text, install }) {
  const strip = (unit) => String(unit).replace(/\r\n/g, '\n').split('\n')
    .filter((line) => !line.startsWith('Environment="PATH=')).join('\n').trim();
  const given = strip(text);
  const node = readExecStartNode(text);
  const args = { ...install, nodeBin: node.value || install.nodeBin };
  if ([null, SYSTEMD_BACKOFF_VERSION].some((systemdVersion) => strip(buildSystemdUnit({ ...args, systemdVersion })) === given)) {
    return 'generated';
  }
  if (!install.checkout && strip(buildSystemdUnit0919({ ...install, nodeBin: node.written || install.nodeBin })) === given) {
    return 'generated-earlier';
  }
  const root = systemdUnitMarkerRoot(text);
  if (root && path.posix.resolve(root) !== path.posix.resolve(String(install.packageRoot))) return 'other-install';
  return 'hand-made';
}

/** The drop-ins next to the unit (`oar.service.d/*.conf`), sorted; OAR never writes or deletes them. */
export function listSystemdDropIns(homeDir, { fsImpl = fs } = {}) {
  const dir = path.join(homeDir, '.config', 'systemd', 'user', 'oar.service.d');
  try {
    return fsImpl.readdirSync(dir).filter((name) => name.endsWith('.conf')).sort().map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * The PATH a relay service gets: the PATH `oar setup` ran with (the user's
 * shell, so their tools), with two directories added when they are not on it:
 * `~/.local/bin`, where the provider CLIs install themselves and which a
 * shell only picks up once it exists, and the directory of the Node that runs
 * the relay.
 */
export function buildServicePath({ nodeBin, envPath = '', homeDir = '' } = {}) {
  const entries = String(envPath || '').split(':').filter(Boolean);
  const localBin = homeDir ? path.posix.join(String(homeDir), '.local', 'bin') : '';
  if (localBin && !entries.includes(localBin)) entries.unshift(localBin);
  const nodeDir = nodeBin ? path.posix.dirname(String(nodeBin)) : '';
  if (nodeDir && !entries.includes(nodeDir)) entries.push(nodeDir);
  return entries.join(':');
}

/**
 * The dependencies whose install scripts OAR needs (they fetch or build a
 * native binary). npm 12 runs no install script it was not told to allow, and
 * a global install has no package.json of its own to say so; npm 10 and 11
 * accept the flag and run the scripts as before. `npm-install-scripts.test.mjs`
 * holds this list to the lockfile.
 */
// @oar-sh/oar itself: its preinstall copies the data an earlier version
// kept inside the package before npm deletes it (package-data-rescue.mjs).
export const NPM_INSTALL_SCRIPT_PACKAGES = Object.freeze(['@oar-sh/oar', 'better-sqlite3', 'koffi']);
export const NPM_ALLOW_SCRIPTS_ARG = `--allow-scripts=${NPM_INSTALL_SCRIPT_PACKAGES.join(',')}`;

/**
 * How to run `npm install -g` so the update lands in the install that is
 * running. Away from Windows: the npm that belongs to this Node (a relay
 * service or a private Node has no `npm` on PATH, and a version manager may
 * put another Node's there), this Node first on the child's PATH because npm
 * is a `node` script, and the prefix this package sits in, so an install made
 * with `--prefix` is updated in place.
 */
export function resolveNpmInvocation({
  execPath = process.execPath,
  packageRoot = '',
  platform = process.platform,
  env = process.env,
  existsImpl = fs.existsSync,
} = {}) {
  if (platform === 'win32') return { command: 'npm.cmd', prefixArgs: [], env: { ...env } };
  const nodeDir = path.posix.dirname(String(execPath || ''));
  const beside = path.posix.join(nodeDir, 'npm');
  const command = nodeDir && existsImpl(beside) ? beside : 'npm';
  const envPath = String(env?.PATH || '');
  const childPath = envPath.split(':')[0] === nodeDir ? envPath : [nodeDir, envPath].filter(Boolean).join(':');
  const suffix = '/lib/node_modules/@oar-sh/oar';
  const root = String(packageRoot || '').replace(/\/+$/, '');
  const prefixArgs = root.endsWith(suffix) && root.length > suffix.length
    ? ['--prefix', root.slice(0, -suffix.length)]
    : [];
  return { command, prefixArgs, env: { ...env, PATH: childPath } };
}

/**
 * Provider CLIs `oar doctor` probes, with the args that answer fast. Cursor is
 * deliberately absent: the relay drives it through the bundled @cursor/sdk npm
 * package and never invokes a cursor-agent binary.
 */
export const DOCTOR_PROBES = Object.freeze([
  { id: 'gh (Copilot)', binary: 'gh', args: ['--version'] },
  { id: 'claude', binary: 'claude', args: ['--version'] },
  { id: 'grok', binary: 'grok', args: ['--version'] },
]);


function doctorAge(at, now) {
  const ms = now - Date.parse(String(at || ''));
  if (!Number.isFinite(ms)) return 'unknown age';
  const hours = Math.floor(ms / 3_600_000);
  return hours < 1 ? 'less than an hour ago' : (hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`);
}

// The backup lines of `oar doctor` (db-backup-service.mjs describeBackups).
function renderBackupLines(backups, now) {
  const pad = '                  ';
  const lines = [`  backups       : ${backups.dir || '(no folder)'}${backups.problem ? `  (${backups.problem})` : ''}`];
  lines.push(`${pad}at start: ${backups.enabled ? 'on' : 'off (dbBackups.enabled is false)'}, keep ${backups.keep}`);
  for (const warning of backups.warnings || []) lines.push(`${pad}warning: ${warning}`);
  const last = backups.lastResult;
  if (last) {
    const what = last.status === 'written' ? `written ${last.file} (${formatMegabytes(last.bytes)})` : `${last.status}: ${last.reason || ''}`;
    lines.push(`${pad}last: ${what}, ${doctorAge(last.at, now)}`);
  }
  if (backups.own?.length) {
    lines.push(`${pad}this relay's (${backups.own.length} of ${backups.keep}):`);
    for (const entry of backups.own) lines.push(`${pad}  ${entry.file}  ${formatMegabytes(entry.bytes)}, ${doctorAge(entry.at, now)}`);
  } else {
    lines.push(`${pad}this relay's: none yet`);
  }
  if (backups.changed?.length) {
    lines.push(`${pad}changed since written, not rotated:`);
    for (const entry of backups.changed) lines.push(`${pad}  ${entry.file}  ${formatMegabytes(entry.bytes)}`);
  }
  if (backups.others?.length) {
    lines.push(`${pad}other files here (not rotated):`);
    for (const entry of backups.others) lines.push(`${pad}  ${entry.name}${entry.folder ? '/' : ''}  ${formatMegabytes(entry.bytes)}`);
  }
  return lines;
}

export function renderDoctorReport({
  version,
  nodeVersion,
  platform,
  layout,
  configPath,
  config,
  dbPath,
  dbSizeBytes,
  databaseNotes = [],
  backups = null,
  now = Date.now(),
  probes = [],
  warnings = [],
  tunnel = '',
}) {
  const yesNo = (v) => (v ? 'yes' : 'no');
  const lines = [
    `OAR ${version}`,
    `  node          : ${nodeVersion} (${platform})`,
    `  mode          : ${layout?.checkout ? 'git checkout' : 'global install'}`,
    `  state root    : ${layout?.checkout ? '(repo-local server/)' : layout?.root}`,
    `  config        : ${configPath}${config ? '' : '  (missing — run: oar setup)'}`,
  ];
  if (config) {
    lines.push(`  port          : ${config.port ?? 3333} (localhostOnly: ${yesNo(config.localhostOnly !== false)})`);
    lines.push(`  auth token    : ${String(config.authToken || '').trim() ? 'set' : 'MISSING'}`);
    // `tunnel` is the caller's finding (describeConfiguredTunnel: is the tunnel
    // on, and is there a cloudflared to run it); without one, the config's word.
    const tunnelConfig = config.cloudflaredTunnel || {};
    const configured = tunnelConfig.enabled === true || tunnelConfig.mode === 'managed' ? 'managed' : 'disabled';
    lines.push(`  tunnel        : ${tunnel || configured}`);
  }
  lines.push(`  database      : ${dbSizeBytes !== null ? `${dbPath} (${(dbSizeBytes / 1048576).toFixed(1)} MB)` : `${dbPath} (not created yet)`}`);
  for (const note of databaseNotes) lines.push(`                  ${note}`);
  if (backups) lines.push(...renderBackupLines(backups, now));
  lines.push('  provider CLIs :');
  for (const probe of probes) {
    lines.push(`    ${probe.id.padEnd(14)}: ${probe.ok ? probe.version || 'installed' : 'not found'}`);
  }
  for (const warning of warnings) lines.push(`  warning       : ${warning}`);
  return lines.join('\n');
}
