// Client-side image downscaling for oversized pastes/uploads.
// Every browser API is injected so the decision logic and the re-encode path can
// both be exercised in Node.

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_DIMENSION = 2560;
export const DEFAULT_QUALITY = 0.85;

// Re-encoding these throws away information a raster round-trip cannot restore:
// GIF loses animation and SVG stops being a vector.
const NEVER_DOWNSCALE = new Set(['image/gif', 'image/svg+xml', 'image/apng']);

// Formats the model is documented to read. Anything else has to be converted
// regardless of size, or it arrives as an image the model cannot see.
export const VISION_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

export function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase().split(';')[0];
}

export function isDownscalableImage(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized.startsWith('image/')) return false;
  return !NEVER_DOWNSCALE.has(normalized);
}

export function isVisionSafeType(mimeType) {
  return VISION_SAFE_TYPES.has(normalizeMimeType(mimeType));
}

/**
 * Size-based gate applied before an image is ever decoded. Dimension-based
 * downscaling is decided later, once the bitmap is available.
 */
export function shouldDownscale(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!file) return false;
  if (!isDownscalableImage(file.type)) return false;
  return Number(file.size || 0) > Math.max(0, Number(maxBytes) || 0);
}

/**
 * Why an image needs re-encoding, or null when it can be sent untouched.
 *
 * `'size'` keeps bandwidth down and may be abandoned if it fails to help.
 * `'format'` is about the model being able to see the image at all, so it is
 * worth doing even when the result is no smaller.
 */
export function reencodeReason(file, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!file) return null;
  if (!isDownscalableImage(file.type)) return null;
  if (!isVisionSafeType(file.type)) return 'format';
  return shouldDownscale(file, { maxBytes }) ? 'size' : null;
}

export function computeTargetDimensions(width, height, maxDimension = DEFAULT_MAX_DIMENSION) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const limit = Math.max(1, Math.round(Number(maxDimension) || DEFAULT_MAX_DIMENSION));
  if (!w || !h) return { width: w, height: h, scaled: false };
  const longest = Math.max(w, h);
  if (longest <= limit) return { width: w, height: h, scaled: false };
  const ratio = limit / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

// Vision input is the whole point of attaching an image, and Copilot's docs are
// explicit that PNG and JPEG are "the most widely supported formats". WebP
// compresses better, but a smaller image the model cannot read is worthless, so
// the re-encode never leaves the PNG/JPEG pair.
export function pickOutputMimeType(sourceType, { allowLossless = false } = {}) {
  const normalized = normalizeMimeType(sourceType);
  // PNG sources are usually screenshots/line art, where JPEG artefacts destroy
  // exactly the fine text an attached screenshot is meant to convey.
  if (allowLossless && normalized === 'image/png') return 'image/png';
  return 'image/jpeg';
}

export function renameForOutputType(name, outputMimeType) {
  const base = String(name || 'image').replace(/\.[^./\\]+$/, '') || 'image';
  const ext = outputMimeType === 'image/png' ? 'png' : 'jpg';
  return `${base}.${ext}`;
}

/**
 * Re-encodes an image when it is too large, or when its format is one the model
 * cannot read. Returns the ORIGINAL file whenever the re-encode fails or is
 * unsupported: the composer treats optimisation as best-effort, never required,
 * so this function must never reject.
 */
export async function downscaleImageFile(file, options = {}, deps = {}) {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    maxDimension = DEFAULT_MAX_DIMENSION,
    quality = DEFAULT_QUALITY,
  } = options;

  const {
    createImageBitmap: createBitmap,
    createCanvas,
    createFile,
    closeBitmap,
  } = deps;

  const reason = reencodeReason(file, { maxBytes });
  if (!reason) return file;
  if (typeof createBitmap !== 'function' || typeof createCanvas !== 'function' || typeof createFile !== 'function') {
    return file;
  }

  let bitmap = null;
  try {
    bitmap = await createBitmap(file, { imageOrientation: 'from-image' });
    // A format conversion keeps the original dimensions; only an oversized
    // image is scaled down.
    const target = reason === 'size'
      ? computeTargetDimensions(bitmap?.width, bitmap?.height, maxDimension)
      : { width: bitmap?.width, height: bitmap?.height, scaled: false };
    if (!target.width || !target.height) return file;

    const canvas = createCanvas(target.width, target.height);
    const context = canvas?.getContext?.('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, target.width, target.height);

    let outputType = pickOutputMimeType(file.type);
    let blob = await canvas.convertToBlob?.({ type: outputType, quality });
    if (!blob) {
      outputType = 'image/png';
      blob = await canvas.convertToBlob?.({ type: outputType, quality });
    }
    if (!blob) return file;

    // Shrinking that failed to shrink is a pessimisation, so the original wins.
    // A format conversion is kept even when it grows: a bigger image the model
    // can actually read beats a smaller one it cannot.
    if (reason === 'size' && Number(blob.size || 0) >= Number(file.size || 0)) return file;

    // Some engines silently ignore the requested type. Shipping a format the
    // model cannot read is worse than shipping the untouched original, so an
    // unexpected output type is rejected outright.
    const resultType = normalizeMimeType(blob.type) || outputType;
    if (!isVisionSafeType(resultType)) return file;

    const next = createFile(blob, renameForOutputType(file.name, resultType), resultType);
    return next || file;
  } catch {
    return file;
  } finally {
    if (bitmap && typeof closeBitmap === 'function') {
      try { closeBitmap(bitmap); } catch {}
    }
  }
}

/**
 * Builds the browser-backed dependency set. Returns an empty object when the
 * required APIs are unavailable, which makes downscaling a silent no-op.
 */
export function browserDownscaleDeps(scope = globalThis) {
  const hasBitmap = typeof scope?.createImageBitmap === 'function';
  const hasOffscreen = typeof scope?.OffscreenCanvas === 'function';
  const hasFile = typeof scope?.File === 'function';
  if (!hasBitmap || !hasOffscreen || !hasFile) return {};
  return {
    createImageBitmap: (file, opts) => scope.createImageBitmap(file, opts),
    createCanvas: (width, height) => new scope.OffscreenCanvas(width, height),
    createFile: (blob, name, type) => new scope.File([blob], name, { type }),
    closeBitmap: (bitmap) => bitmap?.close?.(),
  };
}
