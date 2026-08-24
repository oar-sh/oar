import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldDownscale,
  reencodeReason,
  isVisionSafeType,
  isDownscalableImage,
  computeTargetDimensions,
  pickOutputMimeType,
  renameForOutputType,
  downscaleImageFile,
  browserDownscaleDeps,
  DEFAULT_MAX_BYTES,
} from './image-downscale.mjs';

function fakeFile({ name = 'shot.png', type = 'image/png', size = 100 } = {}) {
  return { name, type, size };
}

function fakeDeps({ width = 4000, height = 3000, blobSize = 1000, blobType = 'image/jpeg', failEncode = false } = {}) {
  const calls = { drawn: null, canvas: null, closed: 0, encodeTypes: [] };
  return {
    calls,
    deps: {
      createImageBitmap: async () => ({ width, height }),
      createCanvas: (w, h) => {
        calls.canvas = { width: w, height: h };
        return {
          getContext: () => ({
            drawImage: (_bitmap, _x, _y, dw, dh) => { calls.drawn = { width: dw, height: dh }; },
          }),
          convertToBlob: async ({ type }) => {
            calls.encodeTypes.push(type);
            if (failEncode) return null;
            return { size: blobSize, type: blobType };
          },
        };
      },
      createFile: (blob, name, type) => ({ name, type, size: blob.size }),
      closeBitmap: () => { calls.closed += 1; },
    },
  };
}

test('small images are left alone', () => {
  assert.equal(shouldDownscale(fakeFile({ size: 1024 })), false);
});

test('oversized images are downscaled', () => {
  assert.equal(shouldDownscale(fakeFile({ size: DEFAULT_MAX_BYTES + 1 })), true);
});

test('gif and svg are never downscaled regardless of size', () => {
  assert.equal(isDownscalableImage('image/gif'), false);
  assert.equal(isDownscalableImage('image/svg+xml'), false);
  assert.equal(shouldDownscale(fakeFile({ type: 'image/gif', size: 50 * 1024 * 1024 })), false);
  assert.equal(shouldDownscale(fakeFile({ type: 'image/svg+xml', size: 50 * 1024 * 1024 })), false);
});

test('non-images are never downscaled', () => {
  assert.equal(shouldDownscale(fakeFile({ type: 'application/pdf', size: 50 * 1024 * 1024 })), false);
  assert.equal(shouldDownscale(null), false);
});

test('computeTargetDimensions preserves aspect ratio and only shrinks', () => {
  const shrunk = computeTargetDimensions(4000, 3000, 2560);
  assert.equal(shrunk.width, 2560);
  assert.equal(shrunk.height, 1920);
  assert.equal(shrunk.scaled, true);

  const untouched = computeTargetDimensions(800, 600, 2560);
  assert.deepEqual(untouched, { width: 800, height: 600, scaled: false });
});

test('computeTargetDimensions handles portrait orientation', () => {
  const shrunk = computeTargetDimensions(1000, 5000, 2500);
  assert.equal(shrunk.height, 2500);
  assert.equal(shrunk.width, 500);
});

// Regression: the downscaler used to emit WebP. Uploads and browser previews
// worked, but the image reached the model unreadable, silently destroying vision
// for every attachment over the size threshold. Copilot's docs call for PNG/JPEG.
test('the re-encoded output is never a format the model may not read', () => {
  for (const source of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp']) {
    const out = pickOutputMimeType(source);
    assert.ok(out === 'image/jpeg' || out === 'image/png', `${source} produced ${out}`);
    assert.notEqual(out, 'image/webp');
  }
});

test('screenshots may stay lossless when asked, everything else becomes jpeg', () => {
  assert.equal(pickOutputMimeType('image/png', { allowLossless: true }), 'image/png');
  assert.equal(pickOutputMimeType('image/jpeg', { allowLossless: true }), 'image/jpeg');
  assert.equal(pickOutputMimeType('image/png'), 'image/jpeg');
});

test('renameForOutputType swaps the extension', () => {
  assert.equal(renameForOutputType('shot.png', 'image/jpeg'), 'shot.jpg');
  assert.equal(renameForOutputType('no-extension', 'image/jpeg'), 'no-extension.jpg');
  assert.equal(renameForOutputType('', 'image/png'), 'image.png');
});

test('downscaleImageFile re-encodes an oversized image and frees the bitmap', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  const { deps, calls } = fakeDeps({ blobSize: 1000 });
  const result = await downscaleImageFile(file, {}, deps);

  assert.equal(result.size, 1000);
  assert.equal(result.name, 'shot.jpg');
  assert.equal(result.type, 'image/jpeg');
  assert.deepEqual(calls.canvas, { width: 2560, height: 1920 });
  assert.deepEqual(calls.drawn, { width: 2560, height: 1920 });
  assert.equal(calls.closed, 1, 'bitmap must be released');
});

test('downscaleImageFile keeps the original when the re-encode grows the file', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  const { deps } = fakeDeps({ blobSize: DEFAULT_MAX_BYTES + 500 });
  const result = await downscaleImageFile(file, {}, deps);
  assert.equal(result, file);
});

test('downscaleImageFile falls back to the original when encoding is unsupported', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  const { deps, calls } = fakeDeps({ failEncode: true });
  const result = await downscaleImageFile(file, {}, deps);
  assert.equal(result, file);
  assert.deepEqual(calls.encodeTypes, ['image/jpeg', 'image/png'], 'jpeg first, png as the fallback');
});

test('an engine that ignores the requested type cannot smuggle webp through', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  const { deps } = fakeDeps({ blobSize: 1000, blobType: 'image/webp' });
  const result = await downscaleImageFile(file, {}, deps);
  assert.equal(result, file, 'the untouched original is better than an unreadable image');
});

test('downscaleImageFile never throws when decoding fails', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  const result = await downscaleImageFile(file, {}, {
    createImageBitmap: async () => { throw new Error('decode failed'); },
    createCanvas: () => null,
    createFile: () => null,
  });
  assert.equal(result, file);
});

test('downscaleImageFile is a no-op without browser support', async () => {
  const file = fakeFile({ size: DEFAULT_MAX_BYTES + 1 });
  assert.equal(await downscaleImageFile(file, {}, {}), file);
});

test('browserDownscaleDeps returns nothing when the APIs are missing', () => {
  assert.deepEqual(browserDownscaleDeps({}), {});
  const deps = browserDownscaleDeps({
    createImageBitmap: () => {},
    OffscreenCanvas: function OffscreenCanvas() {},
    File: function File() {},
  });
  assert.equal(typeof deps.createImageBitmap, 'function');
  assert.equal(typeof deps.createCanvas, 'function');
});

// ─── format conversion ───────────────────────────────────────────────────────
// Size was never the only reason to re-encode. A WebP small enough to skip the
// downscaler still reaches the model unreadable, so format alone must trigger a
// conversion.

test('vision-safe formats are recognised', () => {
  assert.equal(isVisionSafeType('image/png'), true);
  assert.equal(isVisionSafeType('image/jpeg'), true);
  assert.equal(isVisionSafeType('image/gif'), true);
  assert.equal(isVisionSafeType('image/webp'), false);
  assert.equal(isVisionSafeType('image/avif'), false);
});

test('a small webp is re-encoded for format even though it is under the size cap', () => {
  const small = fakeFile({ name: 'shot.webp', type: 'image/webp', size: 50 * 1024 });
  assert.equal(shouldDownscale(small), false, 'size alone would skip it');
  assert.equal(reencodeReason(small), 'format');
});

test('a small png or jpeg is left completely untouched', () => {
  assert.equal(reencodeReason(fakeFile({ type: 'image/png', size: 50 * 1024 })), null);
  assert.equal(reencodeReason(fakeFile({ type: 'image/jpeg', size: 50 * 1024 })), null);
});

test('an oversized png is re-encoded for size', () => {
  assert.equal(reencodeReason(fakeFile({ type: 'image/png', size: DEFAULT_MAX_BYTES + 1 })), 'size');
});

test('gif and svg are still never re-encoded', () => {
  assert.equal(reencodeReason(fakeFile({ type: 'image/gif', size: DEFAULT_MAX_BYTES + 1 })), null);
  assert.equal(reencodeReason(fakeFile({ type: 'image/svg+xml', size: DEFAULT_MAX_BYTES + 1 })), null);
});

test('a format conversion keeps the original dimensions', async () => {
  const small = fakeFile({ name: 'shot.webp', type: 'image/webp', size: 50 * 1024 });
  const { deps, calls } = fakeDeps({ width: 800, height: 600, blobSize: 60 * 1024 });
  const result = await downscaleImageFile(small, {}, deps);
  assert.deepEqual(calls.canvas, { width: 800, height: 600 }, 'no scaling for a format-only conversion');
  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.name, 'shot.jpg');
});

test('a format conversion is kept even when the result is larger', async () => {
  const small = fakeFile({ name: 'shot.webp', type: 'image/webp', size: 50 * 1024 });
  const { deps } = fakeDeps({ width: 800, height: 600, blobSize: 90 * 1024 });
  const result = await downscaleImageFile(small, {}, deps);
  assert.notEqual(result, small, 'readability beats byte count');
  assert.equal(result.type, 'image/jpeg');
});

test('a size re-encode that grows the file is still abandoned', async () => {
  const big = fakeFile({ type: 'image/png', size: DEFAULT_MAX_BYTES + 1 });
  const { deps } = fakeDeps({ blobSize: DEFAULT_MAX_BYTES + 500 });
  assert.equal(await downscaleImageFile(big, {}, deps), big);
});

test('an unconvertible webp falls back to the original rather than being dropped', async () => {
  const small = fakeFile({ name: 'shot.webp', type: 'image/webp', size: 50 * 1024 });
  const result = await downscaleImageFile(small, {}, {
    createImageBitmap: async () => { throw new Error('decode failed'); },
    createCanvas: () => null,
    createFile: () => null,
  });
  assert.equal(result, small);
});
