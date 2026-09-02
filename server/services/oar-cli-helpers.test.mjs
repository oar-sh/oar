import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildDefaultConfig,
  buildSystemdUnit,
  generateAuthToken,
  primaryLanAddress,
  relayUrl,
  renderDoctorReport,
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
    updateCheck: true,
  });
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
