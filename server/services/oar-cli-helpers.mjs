/**
 * Pure helpers behind `oar setup` and `oar doctor` — everything here is
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
export const NPM_INSTALL_SCRIPT_PACKAGES = Object.freeze(['better-sqlite3', 'cloudflared', 'koffi']);
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
    const tunnel = config.cloudflaredTunnel || {};
    lines.push(`  tunnel        : ${tunnel.enabled === true || tunnel.mode === 'managed' ? 'managed' : 'disabled'}`);
  }
  lines.push(`  database      : ${dbSizeBytes !== null ? `${dbPath} (${(dbSizeBytes / 1048576).toFixed(1)} MB)` : `${dbPath} (not created yet)`}`);
  lines.push('  provider CLIs :');
  for (const probe of probes) {
    lines.push(`    ${probe.id.padEnd(14)}: ${probe.ok ? probe.version || 'installed' : 'not found'}`);
  }
  return lines.join('\n');
}
