/**
 * The browser libraries the page loads (server/public/vendor) are byte-for-byte
 * copies of the npm packages that are installed from the lockfile:
 * scripts/vendor-browser-libs.mjs makes them, this test proves it. The same
 * hashes guard index.html's integrity attributes and the service worker's
 * offline list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_NAME,
  VENDOR_DIR,
  VENDOR_SPEC,
  readInstalledPackage,
  sha256Hex,
  sriSha384,
  vendorRelativePath,
  vendorTarget,
} from '../scripts/vendor-browser-libs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'server', 'public');

const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, MANIFEST_NAME), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

test('every vendored file matches the manifest and the installed package, byte for byte', () => {
  assert.ok(manifest.files.length > 0, 'the manifest lists no files');
  for (const entry of manifest.files) {
    const label = `${entry.package}@${entry.version}/${entry.path}`;
    const committed = fs.readFileSync(path.join(VENDOR_DIR, vendorRelativePath(entry)));
    assert.equal(sha256Hex(committed), entry.sha256, `${label}: the committed file differs from the manifest`);
    assert.equal(sriSha384(committed), entry.integrity, `${label}: the manifest's integrity value is wrong`);
    const installed = readInstalledPackage(entry.package);
    assert.equal(installed.version, entry.version, `${label}: the installed ${entry.package} is ${installed.version}`);
    const original = fs.readFileSync(path.join(installed.packageDir, entry.path));
    assert.equal(sha256Hex(original), entry.sha256, `${label}: the installed package's file differs; run node scripts/vendor-browser-libs.mjs`);
  }
});

test('vendor/ holds no file the manifest does not list, and the manifest lists no missing file', () => {
  const listed = new Set(manifest.files.map(vendorRelativePath));
  assert.equal(listed.size, manifest.files.length, 'the manifest lists a file twice');
  const onDisk = listFiles(VENDOR_DIR).filter((rel) => rel !== MANIFEST_NAME);
  assert.deepEqual(onDisk.filter((rel) => !listed.has(rel)).sort(), [], 'files in vendor/ that the manifest does not list');
  assert.deepEqual([...listed].filter((rel) => !onDisk.includes(rel)).sort(), [], 'manifest entries without a file');
});

test('the manifest covers what the vendor script copies, at the versions package.json pins', () => {
  const needed = new Map();
  for (const spec of VENDOR_SPEC) {
    const { packageDir, version } = readInstalledPackage(spec.package);
    assert.equal(rootPackage.devDependencies?.[spec.package], version, `${spec.package} must be an exact devDependency`);
    for (const rel of spec.files) {
      if (rel.endsWith('/')) {
        for (const name of fs.readdirSync(path.join(packageDir, rel))) needed.set(`${spec.package}|${rel}${name}`, true);
      } else {
        needed.set(`${spec.package}|${rel}`, true);
      }
    }
  }
  const listed = new Set(manifest.files.map((entry) => `${entry.package}|${entry.path}`));
  assert.deepEqual([...needed.keys()].filter((key) => !listed.has(key)), [], 'files the script copies but the manifest lacks');
  assert.deepEqual([...listed].filter((key) => !needed.has(key)), [], 'manifest entries the script does not copy');
  for (const spec of VENDOR_SPEC) {
    assert.ok(manifest.files.some((e) => e.package === spec.package && /^LICENSE/.test(e.path)), `${spec.package}: licence file missing`);
  }
  // KaTeX's CSS names its fonts relative to itself; they must sit next to it.
  assert.ok(manifest.files.some((e) => e.package === 'katex' && /^dist\/fonts\/KaTeX_Main-Regular\.woff2$/.test(e.path)));
});

test('index.html loads every library from vendor/ under __APP_BASE, with the manifest\'s integrity hash', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const loaded = [...html.matchAll(/__APP_BASE_ATTR\+'\/vendor\/([^"']+)" integrity="([^"]+)"/g)]
    .map((match) => ({ file: match[1], integrity: match[2] }));
  const byFile = new Map(manifest.files.map((entry) => [vendorRelativePath(entry), entry]));
  assert.equal(loaded.length, 9, 'index.html should load nine vendored files');
  for (const { file, integrity } of loaded) {
    const entry = byFile.get(file);
    assert.ok(entry, `index.html loads vendor/${file}, which the manifest does not list`);
    assert.equal(integrity, entry.integrity, `vendor/${file}: integrity attribute differs from the manifest`);
  }
  // Every line that mentions vendor/ is a tag with an integrity hash (a new
  // tag without one, plain or written by document.write, fails here), and
  // goes through __APP_BASE: the page may sit under any base path.
  const vendorLines = html.split('\n').filter((line) => line.includes('vendor/'));
  assert.equal(vendorLines.length, loaded.length, 'a line of index.html mentions vendor/ without being a vendored tag with integrity');
  for (const line of vendorLines) {
    assert.match(line, /__APP_BASE_ATTR\+'\/vendor\/[^"']+" integrity="sha384-[A-Za-z0-9+/]+=*"/, `no integrity or no __APP_BASE: ${line.slice(0, 120)}`);
    assert.ok(!line.includes('crossorigin'), 'a vendored tag still has crossorigin');
  }
});

test('index.html loads no script, stylesheet, font or image from an absolute URL', () => {
  // The string pieces of a document.write ('<scr'+'ipt src="'+...) are joined
  // first, so a tag written that way is read like any other.
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replace(/'\s*\+\s*'/g, '');
  const ABSOLUTE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  const allowedScheme = /^\s*(?:data|blob):/i;
  const offenders = [];
  // Tags that load something: <a> and <form> navigate, they do not load.
  for (const tag of html.matchAll(/<(script|link|img|source|iframe|frame|video|audio|track|embed|object|input|image|use)\b[^>]*>/gi)) {
    for (const attr of tag[0].matchAll(/\s(src|href|srcset|data|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const value = attr[2] ?? attr[3] ?? '';
      if (ABSOLUTE.test(value) && !allowedScheme.test(value)) offenders.push(`${tag[1]} ${attr[1]}=${value.slice(0, 80)}`);
    }
  }
  // Stylesheets and inline styles: url(...) and @import.
  for (const match of html.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
    if (ABSOLUTE.test(match[1]) && !allowedScheme.test(match[1])) offenders.push(`url(${match[1].slice(0, 80)})`);
  }
  for (const match of html.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
    if (ABSOLUTE.test(match[1])) offenders.push(`@import ${match[1].slice(0, 80)}`);
  }
  assert.deepEqual(offenders, [], 'index.html loads from an absolute URL');
  // The reader's check works: a CDN tag in either form is caught.
  const probe = "<script>document.write('<scr'+'ipt src=\"https://cdn.example/x.js\"><\\/scr'+'ipt>');</script><link rel=\"stylesheet\" href=\"//cdn.example/x.css\">".replace(/'\s*\+\s*'/g, '');
  const found = [...probe.matchAll(/<(script|link)\b[^>]*>/gi)].flatMap((tag) => [...tag[0].matchAll(/\s(src|href)\s*=\s*"([^"]*)"/gi)].map((a) => a[2])).filter((v) => ABSOLUTE.test(v));
  assert.equal(found.length, 2);
});

test('the service worker caches the vendored scripts and styles, and only files that exist', () => {
  const sw = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  const listed = [...sw.matchAll(/^\s*'(vendor\/[^']+)',$/gm)].map((match) => match[1]);
  const byFile = new Set(manifest.files.map(vendorRelativePath));
  for (const rel of listed) assert.ok(byFile.has(rel.slice('vendor/'.length)), `sw.js caches ${rel}, which the manifest does not list`);
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const match of html.matchAll(/__APP_BASE_ATTR\+'\/(vendor\/[^"']+)"/g)) {
    assert.ok(listed.includes(match[1]), `sw.js does not cache ${match[1]}`);
  }
});

test('the vendor script refuses a version that is not x.y.z and a path that leaves vendor/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-vendor-root-'));
  try {
    const dir = path.join(root, 'node_modules', 'fake-lib');
    fs.mkdirSync(dir, { recursive: true });
    for (const [version, ok] of [['1.2.3', true], ['1.2.3-beta.1', false], ['../../x', false], ['1.2', false], ['', false]]) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake-lib', version }));
      if (ok) assert.equal(readInstalledPackage('fake-lib', { root }).version, version);
      else assert.throws(() => readInstalledPackage('fake-lib', { root }), /plain x\.y\.z/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(vendorTarget({ package: 'marked', version: '15.0.12', path: 'marked.min.js' }).startsWith(VENDOR_DIR + path.sep));
  for (const bad of ['../../../x.js', '../../x.js', '../../marked@15.0.12/x.js']) {
    assert.throws(() => vendorTarget({ package: 'marked', version: '15.0.12', path: bad }), /outside/);
  }
  assert.throws(() => vendorTarget({ package: '../../x', version: '1.0.0', path: 'x.js' }), /outside/);
});
