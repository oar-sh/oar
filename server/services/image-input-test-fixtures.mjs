// Tiny image files for the imagePaths tests: real headers, no pixel data.
// readImageHeader (shared/image-header.mjs) reads only these first bytes.

export function pngBytes(width, height, { animated = false, filler = 0 } = {}) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []),
    chunk('IDAT', Buffer.alloc(4 + filler)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function jpegBytes(width, height) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(9)]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff;
  frame[1] = 0xc0;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.from([0xff, 0xd9])]);
}

export function webpBytes(width, height, { animated = false } = {}) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes[20] = animated ? 0x02 : 0x00;
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

export const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([16, 0, 16, 0]), Buffer.alloc(20)]);
