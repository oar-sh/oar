// A sign-in link's QR code on a <canvas> (Settings → Security → Sign in
// another device). The relay encodes it (server/services/qr-matrix.mjs, the
// encoder `oar url --sign-in` uses) and sends the matrix with the link:
// `{ size, bits }`, bits base64, row-major, most significant bit first,
// 1 = dark, no quiet zone. This page draws it with a quiet zone of 4 modules,
// dark on white whatever the theme, so a phone's camera reads it.

export const QR_QUIET_ZONE = 4;
// QR versions 1 to 40.
const QR_MIN_SIZE = 21;
const QR_MAX_SIZE = 177;

function decodeBase64(text) {
  const value = String(text || '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    if (typeof atob === 'function') {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The matrix as `{ size, dark(x, y) }`, or null when `qr` is no usable one
 * (no matrix, a size off the QR versions, too few bits).
 */
export function decodeQrMatrix(qr) {
  const size = Number(qr?.size);
  if (!Number.isInteger(size) || size < QR_MIN_SIZE || size > QR_MAX_SIZE || (size - QR_MIN_SIZE) % 4 !== 0) return null;
  const bytes = decodeBase64(qr?.bits);
  if (!bytes || bytes.length < Math.ceil((size * size) / 8)) return null;
  function dark(x, y) {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const index = y * size + x;
    return ((bytes[index >> 3] >> (7 - (index & 7))) & 1) === 1;
  }
  return { size, dark };
}

/**
 * Draws `qr` into `canvas` at `scale` px per module with the quiet zone.
 * Returns the side in modules (quiet zone included), or 0 when nothing was
 * drawn (the canvas is then emptied).
 */
export function drawQrCode(canvas, qr, { scale = 6, quietZone = QR_QUIET_ZONE } = {}) {
  const matrix = decodeQrMatrix(qr);
  const context = matrix ? canvas?.getContext?.('2d') : null;
  if (!matrix || !context) {
    clearQrCode(canvas);
    return 0;
  }
  const modules = matrix.size + quietZone * 2;
  const px = Math.max(1, Math.floor(scale));
  canvas.width = modules * px;
  canvas.height = modules * px;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.dark(x, y)) context.fillRect((x + quietZone) * px, (y + quietZone) * px, px, px);
    }
  }
  return modules;
}

/** Leaves nothing of a code on `canvas`. */
export function clearQrCode(canvas) {
  if (!canvas) return;
  try { canvas.getContext?.('2d')?.clearRect?.(0, 0, canvas.width || 0, canvas.height || 0); } catch {}
  canvas.width = 0;
  canvas.height = 0;
}
