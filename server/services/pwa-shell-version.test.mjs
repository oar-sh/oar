import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computePwaShellVersion, formatPwaVersionTimestamp, shouldIncludeInPwaVersion } from './pwa-shell-version.mjs';

test('the shell is index.html, the worker, the manifest, the icons and the app folder\'s code', () => {
  for (const file of ['index.html', 'sw.js', 'manifest.webmanifest', 'app-icon.svg', 'app-icon-light-maskable-512.png', 'favicon.ico', 'app/store.js', 'app/a.mjs', 'app/b.css', 'app/c.html', '/index.html', 'app\\store.js']) {
    assert.equal(shouldIncludeInPwaVersion(file), true, file);
  }
  for (const file of ['', '.hidden/index.html', 'notes.txt', 'app/data.json', 'other/store.js', 'app-icon.webp']) {
    assert.equal(shouldIncludeInPwaVersion(file), false, file);
  }
});

test('the version is a UTC time stamp, or 0 for none', () => {
  assert.equal(formatPwaVersionTimestamp(Date.UTC(2026, 10, 17, 9, 5, 3)), '2026-11-17-09-05-03Z');
  assert.equal(formatPwaVersionTimestamp(Number.NaN), '0');
});

test('the newest shell file decides the version; other files and a missing folder do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-shell-version-'));
  try {
    fs.mkdirSync(path.join(root, 'app'));
    const stamp = (file, ms) => {
      fs.writeFileSync(path.join(root, file), 'x');
      fs.utimesSync(path.join(root, file), ms / 1000, ms / 1000);
    };
    stamp('index.html', Date.UTC(2026, 0, 1));
    stamp('app/store.js', Date.UTC(2026, 1, 2, 3, 4, 5));
    stamp('notes.txt', Date.UTC(2027, 0, 1));
    assert.equal(computePwaShellVersion(root), '2026-02-02-03-04-05Z');
    assert.equal(computePwaShellVersion(path.join(root, 'missing'), { now: () => Date.UTC(2026, 5, 6) }), '2026-06-06-00-00-00Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
