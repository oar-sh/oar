import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffMimeType,
  reconcileMimeType,
  resolveUploadMimeType,
  normalizeClaimedMimeType,
} from './mime-sniffer.mjs';

function bytes(...values) {
  return Buffer.from(values);
}

function withHeader(header, length = 32) {
  const buffer = Buffer.alloc(length);
  Buffer.from(header).copy(buffer, 0);
  return buffer;
}

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const GIF = Buffer.from('GIF89a-payload');
const PDF = Buffer.from('%PDF-1.7\n...');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const MZ = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01);

test('detects common image formats', () => {
  assert.equal(sniffMimeType(PNG), 'image/png');
  assert.equal(sniffMimeType(JPEG), 'image/jpeg');
  assert.equal(sniffMimeType(GIF), 'image/gif');
  assert.equal(sniffMimeType(bytes(0x42, 0x4d, 0x00, 0x00)), 'image/bmp');
});

test('detects webp through the RIFF container', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBP')]);
  assert.equal(sniffMimeType(webp), 'image/webp');
});

test('a RIFF container that is not webp is not reported as an image', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WAVE')]);
  assert.equal(sniffMimeType(wav), 'audio/wav');
});

test('detects avif and heic through ftyp brands', () => {
  assert.equal(sniffMimeType(withHeader(Buffer.concat([bytes(0, 0, 0, 24), Buffer.from('ftypavif')]))), 'image/avif');
  assert.equal(sniffMimeType(withHeader(Buffer.concat([bytes(0, 0, 0, 24), Buffer.from('ftypheic')]))), 'image/heic');
});

test('detects documents and archives', () => {
  assert.equal(sniffMimeType(PDF), 'application/pdf');
  assert.equal(sniffMimeType(ZIP), 'application/zip');
  assert.equal(sniffMimeType(bytes(0x1f, 0x8b, 0x08)), 'application/gzip');
});

test('detects executables', () => {
  assert.equal(sniffMimeType(MZ), 'application/vnd.microsoft.portable-executable');
  assert.equal(sniffMimeType(ELF), 'application/x-elf');
  assert.equal(sniffMimeType(Buffer.from('#!/bin/sh\necho hi')), 'text/x-shellscript');
});

test('unrecognised and empty buffers report nothing', () => {
  assert.equal(sniffMimeType(Buffer.from('name,value\n1,2\n')), '');
  assert.equal(sniffMimeType(Buffer.alloc(0)), '');
  assert.equal(sniffMimeType(null), '');
});

test('an executable disguised as a png is corrected', () => {
  const result = resolveUploadMimeType(MZ, 'image/png');
  assert.equal(result.corrected, true);
  assert.equal(result.mimeType, 'application/vnd.microsoft.portable-executable');
  assert.equal(result.claimed, 'image/png');
});

test('a truthful claim is left untouched', () => {
  const result = resolveUploadMimeType(PNG, 'image/png');
  assert.equal(result.corrected, false);
  assert.equal(result.mimeType, 'image/png');
});

test('unrecognised bytes keep the claimed type', () => {
  const result = resolveUploadMimeType(Buffer.from('id,name\n1,a\n'), 'text/csv');
  assert.equal(result.corrected, false);
  assert.equal(result.mimeType, 'text/csv');
});

test('missing claim falls back to a generic type', () => {
  const result = reconcileMimeType('', '');
  assert.equal(result.mimeType, 'application/octet-stream');
  assert.equal(result.corrected, false);
});

test('jpg and jpeg spellings are treated as agreement', () => {
  const result = reconcileMimeType('image/jpg', 'image/jpeg');
  assert.equal(result.corrected, false);
  assert.equal(result.mimeType, 'image/jpeg');
});

test('office documents keep their specific type over the zip container', () => {
  const result = reconcileMimeType(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  );
  assert.equal(result.corrected, false);
  assert.match(result.mimeType, /wordprocessingml/);
});

test('a zip claiming to be a png is still corrected', () => {
  const result = reconcileMimeType('image/png', 'application/zip');
  assert.equal(result.corrected, true);
  assert.equal(result.mimeType, 'application/zip');
});

test('claimed types are normalized before comparison', () => {
  assert.equal(normalizeClaimedMimeType('  IMAGE/PNG; charset=binary '), 'image/png');
  const result = resolveUploadMimeType(PNG, 'IMAGE/PNG');
  assert.equal(result.corrected, false);
});
