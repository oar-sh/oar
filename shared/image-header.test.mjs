import test from 'node:test';
import assert from 'node:assert/strict';

import { readImageHeader } from './image-header.mjs';

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height, { frameMarker = 0xc0 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = frameMarker;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunk, body) {
  const bytes = Buffer.alloc(20 + body.length);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'latin1');
  bytes.write(chunk, 12, 'latin1');
  bytes.writeUInt32LE(body.length, 16);
  body.copy(bytes, 20);
  return bytes;
}

test('PNG: width and height from IHDR', () => {
  assert.deepEqual(readImageHeader(png(1536, 1024)), { mime: 'image/png', width: 1536, height: 1024 });
  assert.equal(readImageHeader(png(0, 1024)), null);
});

test('JPEG: the frame header after APP and DHT segments; progressive too', () => {
  assert.deepEqual(readImageHeader(jpeg(1024, 1536)), { mime: 'image/jpeg', width: 1024, height: 1536 });
  assert.deepEqual(readImageHeader(jpeg(640, 480, { frameMarker: 0xc2 })), { mime: 'image/jpeg', width: 640, height: 480 });
  // Cut before the frame header: unknown size.
  assert.equal(readImageHeader(jpeg(640, 480).subarray(0, 30)), null);
});

test('WebP: VP8X, lossy VP8 and lossless VP8L', () => {
  const x = Buffer.alloc(10);
  x.writeUIntLE(3840 - 1, 4, 3);
  x.writeUIntLE(2160 - 1, 7, 3);
  assert.deepEqual(readImageHeader(riff('VP8X', x)), { mime: 'image/webp', width: 3840, height: 2160 });

  const lossy = Buffer.alloc(10);
  lossy[3] = 0x9d; lossy[4] = 0x01; lossy[5] = 0x2a;
  lossy.writeUInt16LE(1024, 6);
  lossy.writeUInt16LE(768, 8);
  assert.deepEqual(readImageHeader(riff('VP8 ', lossy)), { mime: 'image/webp', width: 1024, height: 768 });

  const lossless = Buffer.alloc(10);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(((512 - 1) | ((256 - 1) << 14)) >>> 0, 1);
  assert.deepEqual(readImageHeader(riff('VP8L', lossless)), { mime: 'image/webp', width: 512, height: 256 });
});

test('anything else is no image', () => {
  assert.equal(readImageHeader(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1')), null);
  assert.equal(readImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(readImageHeader(Buffer.alloc(0)), null);
  assert.equal(readImageHeader('not bytes'), null);
  assert.equal(readImageHeader(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')), null);
});
