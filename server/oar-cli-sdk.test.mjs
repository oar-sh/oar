// `oar sdk` and the agent SDK block of `oar doctor`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSdk } from '../bin/oar.js';
import { readAgentSdkPin } from './services/agent-sdk-paths.mjs';
import { describeAgentSdks, parseCliArgs, renderAgentSdkLines, renderDoctorReport } from './services/oar-cli-helpers.mjs';

const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-sdk-'));
  tempDirs.push(dir);
  return dir;
};

// A finished install of the pinned version, as the store leaves it.
function installPinned(root, id) {
  const pin = readAgentSdkPin(id);
  const dir = path.join(root, id, pin.dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.mjs'), 'export {};\n');
  const files = { 'entry.mjs': fs.statSync(path.join(dir, 'entry.mjs')).size };
  fs.writeFileSync(path.join(dir, 'oar-sdk.json'), JSON.stringify({
    format: 1, id, version: pin.version, hash: pin.hash, ...pin.host, libc: pin.host.libc || null, installedAt: new Date().toISOString(), files,
  }));
  return dir;
}

test('oar sdk takes status, or install with one SDK and --reinstall', () => {
  assert.deepEqual(parseCliArgs(['sdk']), { command: 'sdk', args: [] });
  assert.deepEqual(parseCliArgs(['sdk', 'status']), { command: 'sdk', args: ['status'] });
  assert.deepEqual(parseCliArgs(['sdk', 'install', 'claude', '--reinstall']), { command: 'sdk', args: ['install', 'claude', '--reinstall'] });
  assert.match(parseCliArgs(['sdk', 'install', 'somepkg']).error, /Unexpected argument: somepkg/);
  assert.match(parseCliArgs(['sdk', 'claude']).error, /Unexpected argument: claude/);
});

test('the doctor block: the folder and per SDK the pinned version and its state', () => {
  const root = tempRoot();
  installPinned(root, 'claude');
  // This host's own platform: the folders are made for it.
  const store = describeAgentSdks({ env: { OAR_AGENT_SDK_SOURCE: 'store', OAR_SDK_DIR: root }, platform: process.platform }); // host-platform: the folders are made for this host
  assert.equal(store.root, path.resolve(root));
  assert.deepEqual(store.rows.map((row) => row.id), process.platform === 'win32' ? ['claude', 'cursor', 'koffi'] : ['claude', 'cursor'], 'koffi only on Windows'); // host-platform: the block lists what this host installs
  const claude = store.rows.find((row) => row.id === 'claude');
  assert.equal(claude.installed, readAgentSdkPin('claude').version);
  assert.match(claude.state, /^ready/);
  assert.match(store.rows.find((row) => row.id === 'cursor').state, /not installed/);
  const lines = renderAgentSdkLines(store).join('\n');
  assert.match(lines, /agent SDKs {4}: .*oar-cli-sdk-/);
  assert.match(lines, /cursor {8}: \d+\.\d+\.\d+ not installed/);

  const checkout = describeAgentSdks({ env: {}, platform: 'win32' });
  assert.equal(checkout.fromCheckout, true, 'this worktree is a checkout');
  assert.deepEqual(checkout.rows.map((row) => row.id), ['claude', 'cursor', 'koffi']);
  assert.match(renderAgentSdkLines(checkout).join('\n'), /from the checkout's node_modules/);

  const report = renderDoctorReport({
    version: '0.9.0', nodeVersion: 'v24.0.0', platform: 'linux', layout: { checkout: false, root: '/home/dev/.oar' },
    configPath: '/home/dev/.oar/config.json', config: null, dbPath: '/home/dev/.oar/data/oar.db', dbSizeBytes: null, agentSdks: store,
  });
  assert.match(report, /provider CLIs :\n {2}agent SDKs/);
});

function fakeStore(script) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    factory: (options) => {
      calls.push(['create', options.env.OAR_SDK_DIR]);
      return {
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        install: (id, options) => { calls.push(['install', id, options.force]); return script.install(id, (log) => { for (const l of listeners) l({ sdks: { [id]: { log } } }); }); },
        ensure: async (id) => { calls.push(['ensure', id]); return script.ensure(id); },
        dispose: () => calls.push(['dispose']),
      };
    },
  };
}

function cliOptions(extra) {
  const out = { logs: [], errors: [], written: '' };
  return {
    out,
    options: {
      env: { OAR_SDK_DIR: '/tmp/sdks' },
      logger: { log: (line) => out.logs.push(line), error: (line) => out.errors.push(line) },
      stdout: { write: (text) => { out.written += text; } },
      prompter: {},
      ...extra,
    },
  };
}

test('oar sdk install runs the store, streams npm\'s output and exits by the outcome', async () => {
  const ready = { state: 'ready', label: 'Cursor SDK', installed: '1.3.1', dir: '/tmp/sdks/cursor/1.3.1-0123abcd' };
  const store = fakeStore({
    install: (id, push) => { push('added 12 packages\n'); push('added 12 packages\ndone\n'); return { ok: true, status: { state: 'installing' } }; },
    ensure: () => ready,
  });
  const { out, options } = cliOptions({ argv: ['install', 'cursor', '--reinstall'], createAgentSdkStore: store.factory });
  assert.deepEqual(await runSdk(options), { code: 0, reason: 'sdk-installed' });
  assert.equal(out.written, 'added 12 packages\ndone\n', 'each part once');
  assert.match(out.logs.at(-1), /Cursor SDK 1\.3\.1 is ready in /);
  assert.deepEqual(store.calls.map((call) => call[0]), ['create', 'install', 'ensure', 'dispose']);
  assert.equal(store.calls[1][2], true, '--reinstall forces');

  const failing = fakeStore({
    install: () => ({ ok: true, status: { state: 'installing' } }),
    ensure: () => ({ state: 'error', label: 'Claude Agent SDK', error: 'No connection to the npm registry.' }),
  });
  const failed = cliOptions({ argv: ['install', 'claude'], createAgentSdkStore: failing.factory });
  assert.deepEqual(await runSdk(failed.options), { code: 1, reason: 'sdk-install-failed' });
  assert.match(failed.out.errors.at(-1), /Claude Agent SDK: No connection/);

  const refused = fakeStore({ install: () => ({ ok: false, error: 'Windows helper (koffi) is not available on this platform (linux-x64).' }), ensure: () => null });
  const unsupported = cliOptions({ argv: ['install', 'koffi'], createAgentSdkStore: refused.factory });
  assert.equal((await runSdk(unsupported.options)).code, 1);
  assert.match(unsupported.out.errors.at(-1), /not available on this platform/);
  assert.deepEqual(refused.calls.at(-1), ['dispose']);
});

test('oar sdk alone prints the block and installs nothing', async () => {
  const { out, options } = cliOptions({ argv: [], createAgentSdkStore: () => assert.fail('no store for a status') });
  assert.deepEqual(await runSdk(options), { code: 0, reason: 'sdk-status' });
  assert.match(out.logs.join('\n'), /agent SDKs {4}:/);
});
