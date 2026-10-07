/**
 * Pure helpers behind the `oar` command line — everything here is
 * deterministic and unit-testable; the interactive glue stays in bin/oar.js.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const VALUE_OPTIONS = ['--port', '--migrate-from', '--to'];
const LAUNCHER_FLAGS = ['--install-extension', '--no-install-extension', '--migrate-from'];
const COMMAND_OPTIONS = { '--setup': 'setup', '--start': 'start', '--stop': 'stop', '--status': 'status' };
const CLI_COMMANDS = {
  menu: {},
  start: {},
  stop: {},
  restart: {},
  status: {},
  url: {},
  doctor: {},
  help: {},
  version: {},
  setup: { flags: ['--lan', '--local', '--new-token', '--defaults', '--start'], values: ['--port', '--migrate-from'] },
  service: { words: ['install', 'remove', 'status'] },
  update: { flags: ['--beta'], values: ['--to'] },
  copilot: { flags: ['--install-extension', '--no-install-extension'], values: ['--port', '--migrate-from'], forwards: true },
};

export function usageText() {
  return [
    'Usage: oar [command] [options]',
    '',
    '  oar                    Menu in a terminal; status and this text elsewhere',
    '  oar start              Start the relay in the background',
    '  oar stop               Stop the relay (waits for running turns)',
    '  oar restart            Restart the relay (waits for running turns)',
    '  oar status             Is the relay running, on which port, as a service',
    '  oar url                Relay URL, with a QR code when a phone can reach it',
    '  oar setup              Auth token, access and port; asks, or takes',
    '                         [--port <port>] [--lan | --local] [--new-token] [--defaults] [--start]',
    '  oar service install | remove | status',
    '                         Start the relay at login',
    '  oar copilot [--port <port>] [--install-extension] [--no-install-extension] [-- gh copilot args...]',
    '                         Relay plus a Copilot terminal session',
    '  oar doctor             Check the install and the provider CLIs',
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

/**
 * A systemd *user* unit for the relay server. The launcher is not used here —
 * the service runs server.js directly with the same env the launcher would set,
 * so a `gh copilot` session is not tied to the unit's lifetime.
 */
export function buildSystemdUnit({ nodeBin, packageRoot, configPath, dataDir, logDir, pathEnv = '' }) {
  // systemd units are Linux-only, so the path inside the unit is always
  // posix-joined — host-platform path.join would write backslashes when this
  // template is exercised on Windows (tests; the CLI never writes it there).
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
export const NPM_INSTALL_SCRIPT_PACKAGES = Object.freeze(['better-sqlite3', 'koffi']);
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

export function renderDoctorReport({
  version,
  nodeVersion,
  platform,
  layout,
  configPath,
  config,
  dbPath,
  dbSizeBytes,
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
  lines.push('  provider CLIs :');
  for (const probe of probes) {
    lines.push(`    ${probe.id.padEnd(14)}: ${probe.ok ? probe.version || 'installed' : 'not found'}`);
  }
  for (const warning of warnings) lines.push(`  warning       : ${warning}`);
  return lines.join('\n');
}
