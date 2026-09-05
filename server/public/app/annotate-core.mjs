// Pure annotation logic for the screenshot marker editor: palette, stroke
// widths, the undo stack, coordinate mapping, and the single drawing routine
// shared by the live overlay and the PNG export.
//
// Nothing here touches the DOM. The canvas/File constructors are injected the
// same way `browserDownscaleDeps` injects them in image-downscale.mjs, so the
// composition path can be exercised in Node.

export const ANNOTATE_COLORS = Object.freeze([
  Object.freeze({ id: 'yellow', hex: '#ffdd00' }),
  Object.freeze({ id: 'red', hex: '#ff3b30' }),
  Object.freeze({ id: 'green', hex: '#34c759' }),
  Object.freeze({ id: 'blue', hex: '#0a84ff' }),
]);

export const ANNOTATE_WIDTH_IDS = Object.freeze(['thin', 'medium', 'thick']);

// Marker translucency: dark enough to read as a highlight, light enough that
// black text under a mark stays legible.
export const MARKER_ALPHA = 0.4;

// Widths are a fraction of the image's longest side so a mark covers the same
// visual share of a phone screenshot and a 4K capture alike.
const WIDTH_FRACTIONS = Object.freeze({ thin: 0.008, medium: 0.016, thick: 0.032 });
const MIN_STROKE_PX = 4;

/**
 * Stroke width in image pixels. Unknown ids fall back to 'medium' so a stale
 * saved preference can never produce a zero-width (invisible) stroke.
 */
export function strokeWidthFor(widthId, imageLongestSide) {
  const fraction = WIDTH_FRACTIONS[widthId] ?? WIDTH_FRACTIONS.medium;
  const longest = Math.max(0, Number(imageLongestSide) || 0);
  return Math.max(MIN_STROKE_PX, Math.round(longest * fraction));
}

/**
 * The undo stack holds `{ kind: 'stroke', stroke }` and `{ kind: 'reset' }`
 * entries. A reset is an entry rather than a truncation so 🗑️ stays undoable.
 */
export function createStrokeStack() {
  return { entries: [] };
}

export function pushStroke(stack, stroke) {
  stack.entries.push({ kind: 'stroke', stroke });
  return stack;
}

/**
 * Records an undoable clear. Resetting an already-empty canvas would push an
 * entry that undo has to eat before it can reach real work, so it is skipped.
 */
export function pushReset(stack) {
  if (!visibleStrokes(stack).length) return false;
  stack.entries.push({ kind: 'reset' });
  return true;
}

export function undo(stack) {
  if (!stack?.entries?.length) return false;
  stack.entries.pop();
  return true;
}

export function canUndo(stack) {
  return Boolean(stack?.entries?.length);
}

/** Strokes drawn after the most recent reset, in draw order. */
export function visibleStrokes(stack) {
  const entries = stack?.entries || [];
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind === 'reset') {
      start = i + 1;
      break;
    }
  }
  const out = [];
  for (let i = start; i < entries.length; i += 1) {
    if (entries[i]?.kind === 'stroke') out.push(entries[i].stroke);
  }
  return out;
}

function clamp(value, min, max) {
  if (!(value > min)) return min;
  return value > max ? max : value;
}

/**
 * Viewport point → image pixel. The overlay canvas carries the same CSS
 * transform as the image, so its live bounding rect already encodes zoom and
 * pan: no separate scale/pan bookkeeping is needed here. Points are clamped
 * because a pointer can be dragged outside the image mid-stroke.
 */
export function clientPointToImagePoint(clientX, clientY, rect, naturalW, naturalH) {
  const width = Math.max(0, Number(naturalW) || 0);
  const height = Math.max(0, Number(naturalH) || 0);
  const rectWidth = Number(rect?.width) || 0;
  const rectHeight = Number(rect?.height) || 0;
  const offsetX = (Number(clientX) || 0) - (Number(rect?.left) || 0);
  const offsetY = (Number(clientY) || 0) - (Number(rect?.top) || 0);
  return {
    x: rectWidth > 0 ? clamp(offsetX * (width / rectWidth), 0, width) : 0,
    y: rectHeight > 0 ? clamp(offsetY * (height / rectHeight), 0, height) : 0,
  };
}

/**
 * Draws strokes onto a context sized to the image's natural resolution. Used
 * for both the live overlay and the export so what is drawn is what is saved.
 */
export function renderStrokes(ctx, strokes, { alpha = MARKER_ALPHA } = {}) {
  if (!ctx || !Array.isArray(strokes) || !strokes.length) return;
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  try {
    for (const stroke of strokes) {
      const points = stroke?.points;
      if (!Array.isArray(points) || !points.length) continue;
      const widthPx = Math.max(1, Number(stroke.widthPx) || 1);
      if (points.length === 1) {
        // moveTo+lineTo to the same coordinate paints nothing in some engines,
        // so a tap becomes an explicit dot the width of the nib.
        ctx.beginPath();
        ctx.fillStyle = stroke.color;
        ctx.arc(points[0].x, points[0].y, widthPx / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // One path for the whole stroke: stroking segment by segment would let a
      // translucent marker darken everywhere it crosses itself.
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = widthPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
  } finally {
    ctx.globalAlpha = previousAlpha;
  }
}

export function annotatedFileName(originalName) {
  const base = String(originalName || '').trim().replace(/\.[^./\\]+$/, '') || 'screenshot';
  return `${base}-annotated.png`;
}

/**
 * Flattens the decoded image plus its strokes into a PNG `File` at natural
 * resolution. Returns null when the injected APIs are missing or the encode
 * produces nothing; decode/encode exceptions propagate so the editor can show a
 * notice and stay open. The bitmap belongs to the caller and is never closed.
 */
export async function composeAnnotatedImage({ bitmap, strokes, name }, deps = {}) {
  const { createCanvas, createFile } = deps;
  if (!bitmap) return null;
  if (typeof createCanvas !== 'function' || typeof createFile !== 'function') return null;

  const width = Math.max(0, Math.round(Number(bitmap.width) || 0));
  const height = Math.max(0, Math.round(Number(bitmap.height) || 0));
  if (!width || !height) return null;

  const canvas = createCanvas(width, height);
  const context = canvas?.getContext?.('2d');
  if (!context) return null;

  context.drawImage(bitmap, 0, 0, width, height);
  renderStrokes(context, strokes);

  const blob = await canvas.convertToBlob?.({ type: 'image/png' });
  if (!blob) return null;
  // createFile matches browserDownscaleDeps' shape — (blob, name, type), the
  // dep itself wraps the blob into the File parts array.
  return createFile(blob, annotatedFileName(name), 'image/png') || null;
}
