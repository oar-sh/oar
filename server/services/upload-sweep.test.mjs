import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUnreferencedUploads,
  sweepUnreferencedUploads,
  UNREFERENCED_UPLOADS_QUERY,
  UNREFERENCED_UPLOAD_MAX_AGE_MS,
} from './upload-sweep.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

function ageMs(hours) {
  return new Date(NOW - hours * 60 * 60 * 1000).toISOString();
}

test('old unreferenced blobs are collected', () => {
  const stale = collectUnreferencedUploads(
    [{ sha256: SHA_A, created_at: ageMs(48) }],
    { now: NOW },
  );
  assert.deepEqual(stale, [SHA_A]);
});

test('a blob that could still be mid-upload is left alone', () => {
  const stale = collectUnreferencedUploads(
    [{ sha256: SHA_A, created_at: ageMs(1) }],
    { now: NOW },
  );
  assert.deepEqual(stale, [], 'recent uploads may still be on their way to a draft');
});

test('the age boundary is exclusive', () => {
  const exactlyAtCutoff = new Date(NOW - UNREFERENCED_UPLOAD_MAX_AGE_MS).toISOString();
  assert.deepEqual(collectUnreferencedUploads([{ sha256: SHA_A, created_at: exactlyAtCutoff }], { now: NOW }), []);
});

test('rows without a usable timestamp are never collected', () => {
  const rows = [
    { sha256: SHA_A, created_at: '' },
    { sha256: SHA_B, created_at: 'not-a-date' },
  ];
  assert.deepEqual(collectUnreferencedUploads(rows, { now: NOW }), []);
});

test('malformed hashes are ignored', () => {
  const rows = [{ sha256: 'short', created_at: ageMs(48) }, { sha256: SHA_A, created_at: ageMs(48) }];
  assert.deepEqual(collectUnreferencedUploads(rows, { now: NOW }), [SHA_A]);
});

test('an empty or missing row set yields nothing', () => {
  assert.deepEqual(collectUnreferencedUploads([], { now: NOW }), []);
  assert.deepEqual(collectUnreferencedUploads(null, { now: NOW }), []);
});

test('the sweep deletes exactly the stale blobs and reports the count', () => {
  const deleted = [];
  const count = sweepUnreferencedUploads({
    listUnreferenced: () => [
      { sha256: SHA_A, created_at: ageMs(48) },
      { sha256: SHA_B, created_at: ageMs(2) },
    ],
    deleteUploads: (hashes) => deleted.push(...hashes),
    now: NOW,
  });
  assert.equal(count, 1);
  assert.deepEqual(deleted, [SHA_A]);
});

test('the sweep does not call the deleter when there is nothing to do', () => {
  let called = false;
  const count = sweepUnreferencedUploads({
    listUnreferenced: () => [],
    deleteUploads: () => { called = true; },
    now: NOW,
  });
  assert.equal(count, 0);
  assert.equal(called, false);
});

test('a failing sweep never throws', () => {
  const count = sweepUnreferencedUploads({
    listUnreferenced: () => { throw new Error('database is locked'); },
    deleteUploads: () => {},
  });
  assert.equal(count, 0);
});

test('the sweep is inert without its dependencies', () => {
  assert.equal(sweepUnreferencedUploads({}), 0);
});

test('the query selects only blobs with no references at all', () => {
  assert.match(UNREFERENCED_UPLOADS_QUERY, /LEFT JOIN upload_refs/);
  assert.match(UNREFERENCED_UPLOADS_QUERY, /WHERE r\.id IS NULL/);
});
