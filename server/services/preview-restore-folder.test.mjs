import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPreviewRegistry, normalizePreviewsConfig } from './preview-registry-service.mjs';
import { createMemoryPreviewStore } from './preview-store.mjs';
import { resolveStaticFile, validateStaticRoot, validateStaticRootInAny } from './preview-static-handler.mjs';

// Restore runs the registration jail again on every stored folder. These run
// it for real, on real directories and symlinks, as the runtime wires it.

const TOKENS = {
  site: '1'.repeat(32),
  outside: '2'.repeat(32),
  dotdot: '3'.repeat(32),
  linkOut: '4'.repeat(32),
  other: '5'.repeat(32),
};

function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-restore-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const workspace = path.join(base, 'workspace');
  const otherWorkspace = path.join(base, 'other-workspace');
  const outside = path.join(base, 'outside');
  const site = path.join(workspace, 'dist');
  fs.mkdirSync(site, { recursive: true });
  fs.mkdirSync(path.join(otherWorkspace, 'site'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the jail');
  let symlinks = true;
  try {
    fs.symlinkSync(outside, path.join(workspace, 'link-out'));
  } catch {
    symlinks = false;
  }
  return { base, workspace, otherWorkspace, outside, site, symlinks };
}

function row(token, rootDir, conversationId = 'conv-1') {
  return { token, mode: 'static', conversationId, label: 'site', rootDir, createdAt: 1, hostBootId: 'linux:boot-1' };
}

function restoreWith(store, roots, logger = { log() {}, warn() {} }) {
  return createPreviewRegistry({
    config: normalizePreviewsConfig({ enabled: true, publicBaseUrl: 'https://preview.example.com' }, {
      env: {}, relayPort: 3333, relayHostnames: ['relay.example.com'],
    }),
    store,
    hostBootId: 'linux:boot-1',
    checkConversation: () => true,
    checkStaticRoot: (rootDir, conversationId) => validateStaticRootInAny(rootDir, roots(conversationId)),
    logger,
  });
}

test('restore keeps a folder inside the workspace and drops one outside, behind .., or through a symlink out', (t) => {
  const fx = makeFixture(t);
  const store = createMemoryPreviewStore();
  store.insert(row(TOKENS.site, fx.site));
  store.insert(row(TOKENS.outside, fx.outside));
  store.insert(row(TOKENS.dotdot, path.join(fx.site, '..', '..', 'outside')));
  if (fx.symlinks) store.insert(row(TOKENS.linkOut, path.join(fx.workspace, 'link-out')));

  const lines = [];
  const registry = restoreWith(store, () => [fx.workspace], { log() {}, warn: (line) => lines.push(line) });
  assert.deepEqual(registry.list().map((entry) => entry.token), [TOKENS.site]);
  assert.equal(registry.get(TOKENS.site).rootDir, fs.realpathSync(fx.site));
  assert.deepEqual(store.list().map((entry) => entry.token), [TOKENS.site], 'refused rows are deleted');
  assert.equal(lines.filter((line) => /inside the workspace root/.test(line)).length, fx.symlinks ? 3 : 2);
});

test('a folder root swapped for a symlink after restore serves nothing from outside', (t) => {
  const fx = makeFixture(t);
  if (!fx.symlinks) return t.skip('symlinks unavailable');
  const store = createMemoryPreviewStore();
  store.insert(row(TOKENS.site, fx.site));
  const registry = restoreWith(store, () => [fx.workspace]);
  const entry = registry.resolve(TOKENS.site);
  assert.equal(resolveStaticFile(entry.rootDir, '/index.html').kind, 'file');

  fs.renameSync(fx.site, `${fx.site}-old`);
  fs.symlinkSync(fx.outside, fx.site);
  assert.equal(resolveStaticFile(entry.rootDir, '/secret.txt').kind, 'not-found');
  assert.equal(resolveStaticFile(entry.rootDir, '/').kind, 'not-found');
});

test('a folder under any of the conversation\'s roots is kept at restore', (t) => {
  const fx = makeFixture(t);
  const store = createMemoryPreviewStore();
  // Registered while a worker ran in the other workspace; the configured root
  // (the one a start without workers sees first) is the first workspace.
  store.insert(row(TOKENS.other, path.join(fx.otherWorkspace, 'site')));
  const registry = restoreWith(store, () => [fx.workspace, fx.otherWorkspace, fx.workspace]);
  assert.deepEqual(registry.list().map((entry) => entry.token), [TOKENS.other]);
  assert.equal(validateStaticRoot(path.join(fx.otherWorkspace, 'site'), { workspaceRoot: fx.workspace }).ok, false);
});

test('an fs error other than a missing path is transient and keeps the row', (t) => {
  const fx = makeFixture(t);
  const denied = {
    ...fs,
    realpathSync: (target) => {
      if (String(target).startsWith(fx.site)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return fs.realpathSync(target);
    },
    statSync: fs.statSync,
  };
  const checked = validateStaticRoot(fx.site, { workspaceRoot: fx.workspace, fsImpl: denied });
  assert.equal(checked.ok, false);
  assert.equal(checked.transient, true);
  const missing = validateStaticRoot(path.join(fx.workspace, 'gone'), { workspaceRoot: fx.workspace });
  assert.equal(missing.ok, false);
  assert.equal(missing.transient, undefined);

  const store = createMemoryPreviewStore();
  store.insert(row(TOKENS.site, fx.site));
  const registry = createPreviewRegistry({
    config: normalizePreviewsConfig({ enabled: true, publicBaseUrl: 'https://preview.example.com' }, { env: {}, relayPort: 3333 }),
    store,
    checkConversation: () => true,
    checkStaticRoot: (rootDir) => validateStaticRootInAny(rootDir, [fx.workspace], { fsImpl: denied }),
    logger: { log() {}, warn() {} },
  });
  assert.equal(registry.size, 0);
  assert.equal(store.list().length, 1);
});
