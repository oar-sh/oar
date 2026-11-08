// The type and pixel size of a PNG, JPEG or WebP image, read from its first
// bytes alone (no decoding). Anything else, or a header that does not hold
// together, gives null.
//
// SDK-free and side-effect free: imported by the server and the browser.

// Enough for every PNG and WebP header and for the JPEG frame header after
// usual EXIF/ICC blocks; a JPEG whose frame header lies further in gives null.
export const IMAGE_HEADER_BYTES = 256 * 1024;

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

function u16be(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32be(bytes, at) {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function u24le(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

function ascii(bytes, at, length) {
  let text = '';
  for (let index = at; index < at + length && index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

function sized(mime, width, height) {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

function readPng(bytes) {
  // Signature, then IHDR as the first chunk: length 13, width, height.
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  return sized('image/png', u32be(bytes, 16), u32be(bytes, 20));
}

function readJpeg(bytes) {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Fill bytes, and markers without a length.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return sized('image/jpeg', u16be(bytes, at + 7), u16be(bytes, at + 5));
    at += 2 + length;
  }
  return null;
}

function readWebp(bytes) {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') return sized('image/webp', u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  if (chunk === 'VP8 ') {
    // Key frame start code, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return sized('image/webp', (bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** `{ mime, width, height }` of a PNG, JPEG or WebP image's first bytes, or null. */
export function readImageHeader(input) {
  const bytes = asBytes(input);
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return readPng(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return readJpeg(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return readWebp(bytes);
  return null;
}
