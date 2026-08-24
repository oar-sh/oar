import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKnownCwdOptions, normalizeKnownCwdPath } from './known-cwd-options.mjs';

// platform-agnostic: these helpers run in the browser, where the host OS is not
// the server's. They do regex string work on whatever path the server reported,
// so the win32 fixtures exercise the same code on any host.

test('normalizeKnownCwdPath strips trailing separators and restores drive roots', () => {
  assert.equal(normalizeKnownCwdPath(' C:\\dev\\project\\ '), 'C:\\dev\\project');
  assert.equal(normalizeKnownCwdPath('/home/dev/repo/'), '/home/dev/repo');
  assert.equal(normalizeKnownCwdPath('D:'), 'D:\\');
  assert.equal(normalizeKnownCwdPath('D:\\'), 'D:\\');
  assert.equal(normalizeKnownCwdPath(''), '');
  assert.equal(normalizeKnownCwdPath(null), '');
});

test('buildKnownCwdOptions orders session, relay, browser, then recents', () => {
  const options = buildKnownCwdOptions({
    currentSessionCwd: 'C:\\dev\\session',
    workspaceRootPath: 'C:\\dev\\relay',
    browserCwd: 'C:\\dev\\browser',
    recentRoots: ['C:\\dev\\recent-one', 'C:\\dev\\recent-two'],
  });
  assert.deepEqual(options.map((option) => option.path), [
    'C:\\dev\\session',
    'C:\\dev\\relay',
    'C:\\dev\\browser',
    'C:\\dev\\recent-one',
    'C:\\dev\\recent-two',
  ]);
  assert.deepEqual(options.map((option) => option.label), [
    'Current session CWD',
    'Relay workspace',
    'Current browser folder',
    'Recent CWD 1',
    'Recent CWD 2',
  ]);
});

test('buildKnownCwdOptions dedupes case-insensitively and keeps the first label', () => {
  const options = buildKnownCwdOptions({
    currentSessionCwd: 'C:\\Dev\\Project',
    workspaceRootPath: 'c:\\dev\\project\\',
    browserCwd: 'C:\\DEV\\PROJECT',
    recentRoots: ['C:\\dev\\project', 'C:\\dev\\other'],
  });
  assert.deepEqual(options.map((option) => option.path), ['C:\\Dev\\Project', 'C:\\dev\\other']);
  assert.equal(options[0].label, 'Current session CWD');
  assert.equal(options[1].label, 'Recent CWD 2');
});

test('buildKnownCwdOptions skips empty inputs and tolerates missing arguments', () => {
  assert.deepEqual(buildKnownCwdOptions(), []);
  const options = buildKnownCwdOptions({
    currentSessionCwd: '',
    workspaceRootPath: '/srv/relay',
    browserCwd: null,
    recentRoots: ['', null, '/srv/repo'],
  });
  assert.deepEqual(options.map((option) => option.path), ['/srv/relay', '/srv/repo']);
});

test('buildKnownCwdOptions normalizes drive-letter-only recents', () => {
  const options = buildKnownCwdOptions({ recentRoots: ['D:', 'd:\\'] });
  assert.deepEqual(options.map((option) => option.path), ['D:\\']);
});
