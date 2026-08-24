import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeDraftAttachments,
  hydrateDraftAttachments,
  mergeDraftAttachmentUpdate,
  draftAttachmentsEqual,
  parseDraftAttachmentsColumn,
  isUploadedAttachment,
  isSha256,
  PENDING_CONVERSATION_KEY,
  DRAFT_UPLOAD_MESSAGE_ID,
} from './composer-attachment-cache.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function uploadedAttachment(sha256, overrides = {}) {
  return {
    name: 'shot.png',
    type: 'image/png',
    size: 1234,
    uploadState: 'uploaded',
    uploaded: { sha256, name: 'shot.png', type: 'image/png', size: 1234 },
    ...overrides,
  };
}

test('sha256 validation rejects malformed hashes', () => {
  assert.equal(isSha256(SHA_A), true);
  assert.equal(isSha256('not-a-hash'), false);
  assert.equal(isSha256(''), false);
});

test('serialize keeps only uploaded attachments', () => {
  const rows = serializeDraftAttachments([
    uploadedAttachment(SHA_A),
    { name: 'pending.png', type: 'image/png', uploadState: 'uploading' },
    { name: 'broken.png', type: 'image/png', uploadState: 'error' },
    uploadedAttachment(SHA_B, { name: 'b.png' }),
  ]);
  assert.deepEqual(rows.map((row) => row.sha256), [SHA_A, SHA_B]);
});

test('serialize never persists file bytes', () => {
  const [row] = serializeDraftAttachments([uploadedAttachment(SHA_A, { file: { huge: true } })]);
  assert.deepEqual(Object.keys(row).sort(), ['name', 'sha256', 'size', 'type']);
});

test('serialize deduplicates identical content', () => {
  const rows = serializeDraftAttachments([uploadedAttachment(SHA_A), uploadedAttachment(SHA_A)]);
  assert.equal(rows.length, 1);
});

test('serialize enforces the attachment cap', () => {
  const many = [SHA_A, SHA_B, SHA_C].map((sha) => uploadedAttachment(sha));
  assert.equal(serializeDraftAttachments(many, { max: 2 }).length, 2);
});

test('isUploadedAttachment requires a real hash', () => {
  assert.equal(isUploadedAttachment(uploadedAttachment(SHA_A)), true);
  assert.equal(isUploadedAttachment({ uploadState: 'uploading', uploaded: { sha256: SHA_A } }), false);
  assert.equal(isUploadedAttachment({ uploadState: 'uploaded' }), false);
  assert.equal(isUploadedAttachment(null), false);
});

test('hydrate rebuilds composer records pointing at server content', () => {
  const [record] = hydrateDraftAttachments([{ sha256: SHA_A, name: 'shot.png', type: 'image/png', size: 42 }]);
  assert.equal(record.sha256, SHA_A);
  assert.equal(record.uploadState, 'uploaded');
  assert.equal(record.isImage, true);
  assert.equal(record.previewUrl, `/api/upload/${SHA_A}/content`);
  assert.equal(record.previewUrlIsObjectUrl, false, 'server URLs must not be revoked');
  assert.equal(record.file, null);
});

test('hydrate uses the injected content URL builder', () => {
  const [record] = hydrateDraftAttachments(
    [{ sha256: SHA_A, type: 'image/png' }],
    { contentUrlFor: (sha) => `https://relay.example/files/${sha}` },
  );
  assert.equal(record.previewUrl, `https://relay.example/files/${SHA_A}`);
});

test('hydrate gives non-images no preview URL', () => {
  const [record] = hydrateDraftAttachments([{ sha256: SHA_B, name: 'spec.pdf', type: 'application/pdf' }]);
  assert.equal(record.isImage, false);
  assert.equal(record.previewUrl, '');
});

test('hydrate discards malformed rows', () => {
  const records = hydrateDraftAttachments([{ sha256: 'bogus' }, null, { sha256: SHA_A }, { sha256: SHA_A }]);
  assert.equal(records.length, 1);
});

test('round trip through serialize and hydrate is stable', () => {
  const original = serializeDraftAttachments([uploadedAttachment(SHA_A)]);
  const restored = serializeDraftAttachments(hydrateDraftAttachments(original));
  assert.deepEqual(restored, original);
});

test('parseDraftAttachmentsColumn tolerates junk and empty values', () => {
  assert.deepEqual(parseDraftAttachmentsColumn(''), []);
  assert.deepEqual(parseDraftAttachmentsColumn(null), []);
  assert.deepEqual(parseDraftAttachmentsColumn('{"not":"array"}'), []);
  assert.deepEqual(parseDraftAttachmentsColumn('nonsense'), []);
  assert.deepEqual(parseDraftAttachmentsColumn(`[{"sha256":"${SHA_A}"}]`), [{ sha256: SHA_A }]);
});

test('draftAttachmentsEqual compares by content hash order', () => {
  assert.equal(draftAttachmentsEqual([uploadedAttachment(SHA_A)], [uploadedAttachment(SHA_A)]), true);
  assert.equal(draftAttachmentsEqual([uploadedAttachment(SHA_A)], [uploadedAttachment(SHA_B)]), false);
  assert.equal(draftAttachmentsEqual([], []), true);
});

test('a local echo never overwrites composer state', () => {
  const existing = [uploadedAttachment(SHA_A)];
  const merged = mergeDraftAttachmentUpdate({
    existing,
    incoming: [],
    isLocalEcho: true,
  });
  assert.equal(merged.changed, false);
  assert.equal(merged.attachments, existing);
});

test('a stale broadcast cannot resurrect a removed attachment', () => {
  const existing = [];
  const merged = mergeDraftAttachmentUpdate({
    existing,
    incoming: [uploadedAttachment(SHA_A)],
    existingUpdatedAt: '2026-08-10T10:00:05.000Z',
    incomingUpdatedAt: '2026-08-10T10:00:01.000Z',
  });
  assert.equal(merged.changed, false);
  assert.equal(merged.reason, 'stale');
});

test('a newer broadcast is applied', () => {
  const incoming = [uploadedAttachment(SHA_A)];
  const merged = mergeDraftAttachmentUpdate({
    existing: [],
    incoming,
    existingUpdatedAt: '2026-08-10T10:00:01.000Z',
    incomingUpdatedAt: '2026-08-10T10:00:05.000Z',
  });
  assert.equal(merged.changed, true);
  assert.equal(merged.attachments, incoming);
});

test('an identical broadcast does not churn composer state', () => {
  const existing = [uploadedAttachment(SHA_A)];
  const merged = mergeDraftAttachmentUpdate({
    existing,
    incoming: [uploadedAttachment(SHA_A)],
    incomingUpdatedAt: '2026-08-10T10:00:05.000Z',
  });
  assert.equal(merged.changed, false);
  assert.equal(merged.reason, 'unchanged');
});

test('the pending conversation slot and draft ref sentinel are stable identifiers', () => {
  assert.equal(PENDING_CONVERSATION_KEY, '__new__');
  assert.equal(DRAFT_UPLOAD_MESSAGE_ID, '__draft__');
});
