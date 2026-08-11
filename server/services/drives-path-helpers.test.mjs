import test from 'node:test';
import assert from 'node:assert/strict';

// platform-agnostic: drives-path-helpers.mjs pins path.win32 / path.posix per
// helper rather than following the host, so both families are exercised anywhere.
import {
  normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath,
  toDriveWebPath,
  normalizeLinuxAbsolutePath,
} from './drives-path-helpers.mjs';

// ---------------------------------------------------------------------------
// normalizeLinuxAbsolutePath
// ---------------------------------------------------------------------------

test('normalizeLinuxAbsolutePath: accepts root /', () => {
  assert.equal(normalizeLinuxAbsolutePath('/'), '/');
});

test('normalizeLinuxAbsolutePath: accepts /etc', () => {
  assert.equal(normalizeLinuxAbsolutePath('/etc'), '/etc');
});

test('normalizeLinuxAbsolutePath: accepts nested path', () => {
  assert.equal(normalizeLinuxAbsolutePath('/home/user/file.txt'), '/home/user/file.txt');
});

test('normalizeLinuxAbsolutePath: normalizes double slashes', () => {
  assert.equal(normalizeLinuxAbsolutePath('/home//user///docs'), '/home/user/docs');
});

test('normalizeLinuxAbsolutePath: rejects empty string', () => {
  assert.equal(normalizeLinuxAbsolutePath(''), '');
});

test('normalizeLinuxAbsolutePath: rejects relative path', () => {
  assert.equal(normalizeLinuxAbsolutePath('etc/hosts'), '');
});

test('normalizeLinuxAbsolutePath: resolves traversal via .. (posix.normalize handles it)', () => {
  assert.equal(normalizeLinuxAbsolutePath('/etc/../etc/shadow'), '/etc/shadow');
});

test('normalizeLinuxAbsolutePath: rejects Windows drive path', () => {
  assert.equal(normalizeLinuxAbsolutePath('C:\\Windows'), '');
});

test('normalizeLinuxAbsolutePath: rejects null bytes', () => {
  assert.equal(normalizeLinuxAbsolutePath('/etc/\0hosts'), '/etc/hosts');
});

test('normalizeLinuxAbsolutePath: URL-decodes encoded path', () => {
  assert.equal(normalizeLinuxAbsolutePath('/home%2Fuser'), '/home/user');
});

test('normalizeLinuxAbsolutePath: resolves path ending in /.. (posix.normalize handles it)', () => {
  assert.equal(normalizeLinuxAbsolutePath('/home/user/..'), '/home');
});

// ---------------------------------------------------------------------------
// normalizeDriveAbsolutePath — should still reject Linux paths
// ---------------------------------------------------------------------------

test('normalizeDriveAbsolutePath: accepts Windows root C:\\', () => {
  assert.equal(normalizeDriveAbsolutePath('C:\\'), 'C:\\');
});

test('normalizeDriveAbsolutePath: accepts Windows path C:\\Users\\foo', () => {
  assert.equal(normalizeDriveAbsolutePath('C:\\Users\\foo'), 'C:\\Users\\foo');
});

test('normalizeDriveAbsolutePath: accepts web-form Windows path C:/Users/foo', () => {
  assert.equal(normalizeDriveAbsolutePath('C:/Users/foo'), 'C:\\Users\\foo');
});

test('normalizeDriveAbsolutePath: rejects Linux path /etc', () => {
  assert.equal(normalizeDriveAbsolutePath('/etc'), '');
});

test('normalizeDriveAbsolutePath: rejects empty string', () => {
  assert.equal(normalizeDriveAbsolutePath(''), '');
});

// ---------------------------------------------------------------------------
// driveRootFromAbsolutePath
// ---------------------------------------------------------------------------

test('driveRootFromAbsolutePath: returns drive root for nested path', () => {
  assert.equal(driveRootFromAbsolutePath('C:\\Users\\foo\\bar.txt'), 'C:\\');
});

test('driveRootFromAbsolutePath: returns empty string for invalid path', () => {
  assert.equal(driveRootFromAbsolutePath('/etc/hosts'), '');
});

// ---------------------------------------------------------------------------
// toDriveWebPath
// ---------------------------------------------------------------------------

test('toDriveWebPath: converts drive root to web form', () => {
  assert.equal(toDriveWebPath('C:\\'), 'C:');
});

test('toDriveWebPath: converts nested path to web form', () => {
  assert.equal(toDriveWebPath('C:\\Users\\foo'), 'C:/Users/foo');
});

test('toDriveWebPath: returns empty string for Linux path', () => {
  assert.equal(toDriveWebPath('/home/user'), '');
});
