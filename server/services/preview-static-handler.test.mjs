import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contentTypeForFile,
  isDeniedName,
  resolveStaticFile,
  validateStaticRoot,
} from './preview-static-handler.mjs';

// Real directories, real symlinks: the jail is a filesystem property, so the
// gauntlet runs against the filesystem rather than a mock that could lie.
function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-static-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  const site = path.join(workspace, 'dist');
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(site, 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(site, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(site, 'assets', 'style.css'), 'body{}');
  fs.writeFileSync(path.join(site, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(site, 'server.key'), 'KEY');
  fs.writeFileSync(path.join(site, 'cert.pem'), 'PEM');
  fs.writeFileSync(path.join(site, 'id_rsa'), 'PRIVATE');
  fs.mkdirSync(path.join(site, '.git'));
  fs.writeFileSync(path.join(site, '.git', 'config'), 'gitcfg');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the jail');
  fs.mkdirSync(path.join(site, 'docs'));
  fs.writeFileSync(path.join(site, 'docs', 'index.html'), '<h1>docs</h1>');
  fs.mkdirSync(path.join(site, 'no-index'));
  fs.writeFileSync(path.join(site, 'no-index', 'data.json'), '{}');

  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(site, 'escape.txt'));
    fs.symlinkSync(outside, path.join(site, 'escape-dir'));
  } catch {
    // Symlink creation can fail on exotic filesystems; the dedicated symlink
    // tests skip themselves when the links are absent.
  }

  return { base, workspace, outside, site };
}

// ─── registration jail ────────────────────────────────────────────────────────

test('validateStaticRoot accepts a dir inside the workspace, absolute or relative', (t) => {
  const { workspace, site } = makeFixture(t);
  const absolute = validateStaticRoot(site, { workspaceRoot: workspace });
  assert.equal(absolute.ok, true);
  assert.equal(absolute.rootDir, fs.realpathSync(site));

  const relative = validateStaticRoot('./dist', { workspaceRoot: workspace });
  assert.equal(relative.ok, true);
  assert.equal(relative.rootDir, fs.realpathSync(site));
});

test('validateStaticRoot refuses escapes, files, and missing paths', (t) => {
  const { workspace, outside, site } = makeFixture(t);

  const escape = validateStaticRoot(outside, { workspaceRoot: workspace });
  assert.equal(escape.ok, false);
  assert.match(escape.error, /inside the workspace root/);

  const dotdot = validateStaticRoot('../outside', { workspaceRoot: workspace });
  assert.equal(dotdot.ok, false);

  const file = validateStaticRoot(path.join(site, 'index.html'), { workspaceRoot: workspace });
  assert.match(file.error, /Not a directory/);

  const missing = validateStaticRoot('./nope', { workspaceRoot: workspace });
  assert.match(missing.error, /Directory not found/);

  const noWorkspace = validateStaticRoot(site, { workspaceRoot: '' });
  assert.match(noWorkspace.error, /workspace root/);
});

test('validateStaticRoot refuses a symlinked dir that resolves outside', (t) => {
  const { workspace, site } = makeFixture(t);
  const link = path.join(site, 'escape-dir');
  if (!fs.existsSync(link)) return t.skip('symlinks unavailable');
  const result = validateStaticRoot(link, { workspaceRoot: workspace });
  assert.equal(result.ok, false);
  assert.match(result.error, /inside the workspace root/);
});

// ─── request-time resolution ──────────────────────────────────────────────────

test('resolveStaticFile serves files and directory indexes', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);

  const index = resolveStaticFile(root, '/');
  assert.equal(index.kind, 'file');
  assert.equal(index.contentType, 'text/html; charset=utf-8');

  const js = resolveStaticFile(root, '/assets/app.js');
  assert.equal(js.kind, 'file');
  assert.equal(js.contentType, 'text/javascript; charset=utf-8');

  const nested = resolveStaticFile(root, '/docs/');
  assert.equal(nested.kind, 'file');
  assert.equal(nested.filePath.endsWith(`docs${path.sep}index.html`), true);
});

test('a directory without a trailing slash redirects; one without an index 404s', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);
  assert.deepEqual(resolveStaticFile(root, '/docs'), { kind: 'redirect', location: '/docs/' });
  assert.equal(resolveStaticFile(root, '/no-index/').kind, 'not-found');
});

test('the traversal gauntlet all lands on not-found', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);
  for (const attempt of [
    '/../outside/secret.txt',
    '/../../outside/secret.txt',
    '/assets/../../outside/secret.txt',
    '/%2e%2e/outside/secret.txt',
    '/..%2foutside/secret.txt',
    '/assets/%2e%2e/%2e%2e/outside/secret.txt',
    '/a\0b',
    '/%zz',
    '/./index.html',
  ]) {
    assert.equal(resolveStaticFile(root, attempt).kind, 'not-found', `${attempt} must not resolve`);
  }
});

test('dotfiles and key material are denied even though they exist', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);
  for (const denied of ['/.env', '/.git/config', '/server.key', '/cert.pem', '/id_rsa']) {
    assert.equal(resolveStaticFile(root, denied).kind, 'not-found', `${denied} must be denied`);
  }
});

test('a symlink escaping the root is refused at request time', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);
  if (!fs.existsSync(path.join(site, 'escape.txt'))) return t.skip('symlinks unavailable');
  assert.equal(resolveStaticFile(root, '/escape.txt').kind, 'not-found');
  assert.equal(resolveStaticFile(root, '/escape-dir/secret.txt').kind, 'not-found');
});

test('query strings are ignored for resolution', (t) => {
  const { site } = makeFixture(t);
  const root = fs.realpathSync(site);
  assert.equal(resolveStaticFile(root, '/assets/app.js?v=123').kind, 'file');
});

// ─── helpers ──────────────────────────────────────────────────────────────────

test('content types cover the web basics and default to octet-stream', () => {
  assert.equal(contentTypeForFile('x.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeForFile('x.svg'), 'image/svg+xml');
  assert.equal(contentTypeForFile('x.wasm'), 'application/wasm');
  assert.equal(contentTypeForFile('x.unknown'), 'application/octet-stream');
});

test('isDeniedName covers dotfiles, key material and empty names', () => {
  for (const denied of ['.env', '.git', 'a.key', 'a.pem', 'id_rsa', 'id_ed25519.pub', '']) {
    assert.equal(isDeniedName(denied), true, `${denied} should be denied`);
  }
  for (const allowed of ['index.html', 'app.js', 'keyboard.md', 'openssl.cnf']) {
    assert.equal(isDeniedName(allowed), false, `${allowed} should be allowed`);
  }
});
