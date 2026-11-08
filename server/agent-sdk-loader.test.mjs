import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_SDK_MISSING_CODE, AgentSdkMissingError, agentSdkDirEnvName, loadAgentSdk, resolveAgentSdkSource, setAgentSdkStore } from './agent-sdk-loader.mjs';
import { hostPlatform } from './services/agent-sdk-paths.mjs';

const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => setAgentSdkStore(null));

// A finished install as the store leaves it, whose entry exports `marker`.
function installedFolder(id, marker, { entries = { main: 'entry.mjs' }, valid = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sdk-loader-'));
  tempDirs.push(root);
  const dir = path.join(root, id, `1.0.0-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [name, file] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, file), `export const marker = ${JSON.stringify(`${marker}:${name}`)};\n`);
    files[file] = fs.statSync(path.join(dir, file)).size;
  }
  const host = hostPlatform();
  fs.writeFileSync(path.join(dir, 'oar-sdk.json'), JSON.stringify({
    format: 1, id, version: '1.0.0', hash: 'f'.repeat(64), ...host, libc: host.libc || null,
    installedAt: new Date().toISOString(), files: valid ? files : { ...files, 'entry.mjs': 1 },
  }));
  return dir;
}

test('a worker takes the folder it was launched with, and leases it', async () => {
  const dir = installedFolder('cursor', 'launched', { entries: { main: 'entry.mjs', sqlite: 'entry-sqlite.mjs' } });
  const env = { [agentSdkDirEnvName('cursor')]: dir };
  assert.equal(agentSdkDirEnvName('cursor'), 'OAR_AGENT_SDK_DIR_CURSOR');
  assert.deepEqual(resolveAgentSdkSource('cursor', { env, fromCheckout: false }), { source: 'env', dir });
  assert.equal((await loadAgentSdk('cursor', { env, fromCheckout: false })).marker, 'launched:main');
  assert.equal((await loadAgentSdk('cursor', { entry: 'sqlite', env, fromCheckout: false })).marker, 'launched:sqlite');
  const leases = fs.readdirSync(path.join(path.dirname(dir), '.leases', path.basename(dir)));
  assert.equal(leases.length, 1, 'one lease per folder and process');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(dir), '.leases', path.basename(dir), leases[0]), 'utf8')).pid, process.pid);
});

test('a folder that does not check out is not imported', async () => {
  const dir = installedFolder('cursor', 'broken', { valid: false });
  await assert.rejects(
    loadAgentSdk('cursor', { env: { OAR_AGENT_SDK_DIR_CURSOR: dir }, fromCheckout: false }),
    (error) => error instanceof AgentSdkMissingError && error.code === AGENT_SDK_MISSING_CODE && error.sdk === 'cursor' && /not a finished install/.test(error.message),
  );
});

test('the relay takes the store\'s ready folder and never the environment\'s', async () => {
  const fromStore = installedFolder('claude', 'store');
  const fromEnv = installedFolder('claude', 'env');
  const store = { readyDir: (id) => (id === 'claude' ? fromStore : null) };
  setAgentSdkStore(store);
  const env = { OAR_AGENT_SDK_DIR_CLAUDE: fromEnv };
  assert.equal((await loadAgentSdk('claude', { env, fromCheckout: false })).marker, 'store:main');
  assert.equal(resolveAgentSdkSource('cursor', { env: { OAR_AGENT_SDK_DIR_CURSOR: fromEnv }, fromCheckout: false }), null, 'a relay with a store ignores the environment');
});

test('a checkout falls back to its devDependency; elsewhere a missing SDK is a typed error', async () => {
  assert.deepEqual(resolveAgentSdkSource('claude', { env: {}, fromCheckout: true }), { source: 'checkout', dir: null });
  await assert.rejects(loadAgentSdk('claude', { env: {}, fromCheckout: false }), { name: 'AgentSdkMissingError', message: 'Claude Agent SDK is not installed.' });
  await assert.rejects(loadAgentSdk('claude', { entry: 'sqlite', env: {} }), /Unknown agent SDK entry/);
});

test('in this checkout the Claude entry carries zod as z', async () => {
  const sdk = await loadAgentSdk('claude', { env: {}, fromCheckout: true });
  assert.equal(typeof sdk.query, 'function');
  assert.equal(typeof sdk.z.object, 'function');
});
