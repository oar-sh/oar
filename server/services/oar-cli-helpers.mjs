/**
 * Pure helpers behind `oar setup` and `oar doctor` — everything here is
 * deterministic and unit-testable; the interactive glue stays in bin/oar.js.
 */

import { randomBytes } from 'node:crypto';
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
    updateCheck: true,
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
export function buildSystemdUnit({ nodeBin, packageRoot, configPath, dataDir, logDir }) {
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
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
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
