import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeDraftAttachmentsInput,
  diffDraftAttachmentHashes,
  parseDraftAttachmentsColumn,
  MAX_CONVERSATION_DRAFT_ATTACHMENTS,
  DRAFT_UPLOAD_MESSAGE_ID,
} from './sessions-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function uploadLookup(known = {}) {
  return (sha256) => known[sha256] || null;
}

const KNOWN = uploadLookup({
  [SHA_A]: { original_name: 'shot.png', mime_type: 'image/png', size_bytes: 1234 },
  [SHA_B]: { original_name: 'spec.pdf', mime_type: 'application/pdf', size_bytes: 4321 },
});

test('an omitted field leaves stored attachments untouched', () => {
  const result = normalizeDraftAttachmentsInput(undefined, { lookupUploadFile: KNOWN });
  assert.equal(result.ok, true);
  assert.equal(result.provided, false);
});

test('an explicit null clears the attachments', () => {
  const result = normalizeDraftAttachmentsInput(null, { lookupUploadFile: KNOWN });
  assert.equal(result.ok, true);
  assert.equal(result.provided, true);
  assert.deepEqual(result.attachments, []);
});

test('a draft may only reference blobs the server already holds', () => {
  const result = normalizeDraftAttachmentsInput([{ sha256: SHA_C }], { lookupUploadFile: KNOWN });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown draft attachment/);
});

test('malformed attachment ids are rejected', () => {
  const result = normalizeDraftAttachmentsInput([{ sha256: 'nope' }], { lookupUploadFile: KNOWN });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid draft attachment id/);
});

test('a non-array payload is rejected', () => {
  const result = normalizeDraftAttachmentsInput({ sha256: SHA_A }, { lookupUploadFile: KNOWN });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be an array/);
});

test('the attachment cap is enforced', () => {
  const tooMany = Array.from({ length: MAX_CONVERSATION_DRAFT_ATTACHMENTS + 1 }, () => ({ sha256: SHA_A }));
  const result = normalizeDraftAttachmentsInput(tooMany, { lookupUploadFile: KNOWN });
  assert.equal(result.ok, false);
  assert.match(result.error, /At most 6/);
});

test('metadata falls back to the stored upload row', () => {
  const result = normalizeDraftAttachmentsInput([{ sha256: SHA_A }], { lookupUploadFile: KNOWN });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attachments, [{
    sha256: SHA_A,
    name: 'shot.png',
    type: 'image/png',
    size: 1234,
  }]);
});

test('duplicate references are collapsed', () => {
  const result = normalizeDraftAttachmentsInput(
    [{ sha256: SHA_A }, { sha256: SHA_A }],
    { lookupUploadFile: KNOWN },
  );
  assert.equal(result.attachments.length, 1);
});

test('client supplied names and types are normalized and bounded', () => {
  const result = normalizeDraftAttachmentsInput(
    [{ sha256: SHA_A, name: 'X'.repeat(400), type: 'IMAGE/PNG', size: -5 }],
    { lookupUploadFile: KNOWN },
  );
  const [row] = result.attachments;
  assert.equal(row.name.length, 255);
  assert.equal(row.type, 'image/png');
  assert.equal(row.size, 0);
});

test('the diff drives reference inserts and releases', () => {
  const diff = diffDraftAttachmentHashes([{ sha256: SHA_A }, { sha256: SHA_B }], [{ sha256: SHA_B }]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, [SHA_A]);
});

test('adding an attachment is reported as an addition', () => {
  const diff = diffDraftAttachmentHashes([], [{ sha256: SHA_A }]);
  assert.deepEqual(diff.added, [SHA_A]);
  assert.deepEqual(diff.removed, []);
});

test('an unchanged set produces no reference churn', () => {
  const diff = diffDraftAttachmentHashes([{ sha256: SHA_A }], [{ sha256: SHA_A }]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('the stored column tolerates junk', () => {
  assert.deepEqual(parseDraftAttachmentsColumn(null), []);
  assert.deepEqual(parseDraftAttachmentsColumn('not json'), []);
  assert.deepEqual(parseDraftAttachmentsColumn('{}'), []);
  assert.deepEqual(parseDraftAttachmentsColumn(`[{"sha256":"${SHA_A}"}]`), [{ sha256: SHA_A }]);
});

test('the draft reference sentinel is stable', () => {
  assert.equal(DRAFT_UPLOAD_MESSAGE_ID, '__draft__');
});

// ─── reference release safety ────────────────────────────────────────────────
// Upload blobs are content-addressed and therefore shared between conversations.
// A blob with no references at all is either owned by another conversation or
// still mid-upload, so releasing must be driven by rows this conversation
// actually deleted, never by the hashes the caller asked about.

const routeSource = fs.readFileSync(path.join(__dirname, 'sessions-routes.mjs'), 'utf8');

test('only draft references this conversation actually held are reclaimed', () => {
  const helper = /function releaseDraftUploadReferences\([\s\S]*?\n  \}/.exec(routeSource);
  assert.ok(helper, 'the release helper must exist');
  const body = helper[0];

  assert.match(body, /const result = stmts\.deleteDraftUploadRef\?\.run\?\.\(conversationId, sha256\)/);
  assert.match(body, /if \(Number\(result\?\.changes \|\| 0\) > 0\) released\.push\(sha256\)/,
    'only rows that were really deleted may be reclaimed');
  assert.match(body, /if \(released\.length && typeof deleteOrphanedUploads === 'function'\)/);
  assert.doesNotMatch(body, /deleteOrphanedUploads\(list\)/,
    'the caller-supplied hash list must never be passed straight to the collector');
});

test('there is no route that deletes a draft attachment by raw hash', () => {
  // Such a route let any caller destroy a freshly uploaded, not-yet-referenced
  // blob belonging to another conversation.
  assert.doesNotMatch(routeSource, /app\.delete\('\/api\/conversation\/:id\/draft-attachment/);
});
