import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveUploadMimeType } from '../services/mime-sniffer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, 'messages-routes.mjs'), 'utf8');

const MZ_EXECUTABLE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test('the upload route imports the sniffer', () => {
  assert.match(source, /import \{ resolveUploadMimeType \} from '\.\.\/services\/mime-sniffer\.mjs'/);
});

test('the upload route reconciles the claimed type before persisting', () => {
  const routeBlock = /app\.post\('\/api\/upload'[\s\S]*?\n  \}\);/.exec(source);
  assert.ok(routeBlock, 'the /api/upload route must exist');
  const block = routeBlock[0];

  assert.match(block, /const resolvedType = resolveUploadMimeType\(payload, claimedType\)/,
    'the raw payload must be sniffed');
  assert.match(block, /const fileType = resolvedType\.mimeType/,
    'the reconciled type, not the header, must be stored');

  // The header value must only reach the reconciler, never persistUploadBuffer.
  const persistCall = /persistUploadBuffer\(payload, \{ name: fileName, type: fileType \}\)/.exec(block);
  assert.ok(persistCall, 'persistUploadBuffer must receive the reconciled type');
  assert.doesNotMatch(block, /persistUploadBuffer\([^)]*claimedType/);
});

test('an executable disguised as an image is stored as an executable', () => {
  const resolved = resolveUploadMimeType(MZ_EXECUTABLE, 'image/png');
  assert.equal(resolved.corrected, true);
  assert.notEqual(resolved.mimeType, 'image/png');
});

test('a genuine image keeps its claimed type', () => {
  const resolved = resolveUploadMimeType(PNG, 'image/png');
  assert.equal(resolved.corrected, false);
  assert.equal(resolved.mimeType, 'image/png');
});

test('the response reports whether the type was corrected', () => {
  assert.match(source, /mimeTypeCorrected: resolvedType\.corrected/);
});

test('sending a message clears the draft attachment cache and its references', () => {
  assert.match(source, /updateConvDraftAttachments\.run\(null, now, sessionId \|\| null, convId\)/,
    'the draft attachment column must be cleared on send');
  assert.match(source, /stmts\.deleteDraftUploadRefs\?\.run\?\.\(convId\)/,
    'draft upload references must be released once the message owns the blobs');
});

test('the draft cleared broadcast reports empty attachments', () => {
  const emitBlock = /io\.emit\('conversation_draft_updated', \{[\s\S]*?\}\);/.exec(source);
  assert.ok(emitBlock);
  assert.match(emitBlock[0], /draftAttachments: \[\]/);
});
