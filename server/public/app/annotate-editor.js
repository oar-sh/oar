// Marker-annotation editor: the DOM/controller half of the annotation feature.
//
// Everything that can be reasoned about without a DOM lives in annotate-core.mjs
// (stroke model, undo stack, coordinate mapping, drawing, export); this module
// only owns the modal, the gestures and the two buttons that end a session.
//
// Gestures are Pointer Events only — one code path for mouse, pen and touch —
// with the plan's core rule that a single pointer ALWAYS draws and a second
// pointer switches to pinch (see onStagePointerDown). The file preview's
// `imgZoom` singleton is bound to that modal, so its math is ported here rather
// than shared; the editor keeps its own {scale, panX, panY, minScale}.

import {
  ANNOTATE_COLORS,
  ANNOTATE_WIDTH_IDS,
  MARKER_ALPHA,
  strokeWidthFor,
  createStrokeStack,
  pushStroke,
  pushReset,
  undo,
  canUndo,
  visibleStrokes,
  clientPointToImagePoint,
  renderStrokes,
  composeAnnotatedImage,
} from './annotate-core.mjs';
import { browserDownscaleDeps } from './image-downscale.mjs';
import { showTransientRelayNotice } from './store.js';

const MAX_SCALE = 8;
// The fitted size is baked into the surface's CSS size (see layoutSurface), so
// the transform's own minimum — "fit" — is exactly 1.
const FIT_SCALE = 1;
const SCALE_EPS = 0.001;
const WHEEL_FACTOR = 1.15;
const DOUBLE_TAP_ZOOM = 3;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;
// Sub-pixel moves only bloat the stroke path without changing a pixel of output.
const MIN_POINT_DELTA_PX = 1.5;

const DEFAULT_COLOR_ID = ANNOTATE_COLORS[0]?.id || 'yellow';
const DEFAULT_WIDTH_ID = ANNOTATE_WIDTH_IDS[1] || 'medium';

let session = null;        // the single open session, or null
let opening = false;       // guards a second open() while the blob is loading
let listenersBound = false;
let activeColorId = DEFAULT_COLOR_ID;
let activeWidthId = DEFAULT_WIDTH_ID;

const view = { scale: FIT_SCALE, panX: 0, panY: 0, minScale: FIT_SCALE };

const pointers = new Map();   // pointerId -> { x, y }
let drawing = null;           // { pointerId, stroke }
let panning = null;           // { pointerId, x, y } — desktop middle/right drag
let pinch = null;             // { dist0, scale0, panX0, panY0, cx, cy }
let suppressDrawUntilIdle = false;
let lastTap = { t: 0, x: 0, y: 0, wasDot: false };
let redrawHandle = 0;

function el(id) {
  return document.getElementById(id);
}

function colorHexFor(id) {
  return ANNOTATE_COLORS.find((entry) => entry?.id === id)?.hex || ANNOTATE_COLORS[0]?.hex || '#ffdd00';
}

/* ---------------------------------------------------------------- layout */

/**
 * Sizes the surface so the image fits the stage at scale 1 and the canvas
 * overlays it exactly. The canvas backing store stays at natural resolution and
 * is CSS-scaled, which is what makes strokes land on real pixels — no two-stage
 * "crispen" like the file preview needs.
 */
function layoutSurface() {
  if (!session) return;
  const stage = el('annotate-stage');
  const surface = el('annotate-surface');
  const img = el('annotate-image');
  const canvas = el('annotate-canvas');
  if (!stage || !surface || !img || !canvas) return;
  const natW = session.width;
  const natH = session.height;
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (!natW || !natH || !stageW || !stageH) return;

  const fit = Math.min(1, stageW / natW, stageH / natH);
  const baseW = Math.max(1, Math.round(natW * fit));
  const baseH = Math.max(1, Math.round(natH * fit));
  session.baseW = baseW;
  session.baseH = baseH;
  surface.style.width = `${baseW}px`;
  surface.style.height = `${baseH}px`;
  img.style.width = `${baseW}px`;
  img.style.height = `${baseH}px`;
  canvas.style.width = `${baseW}px`;
  canvas.style.height = `${baseH}px`;
  if (canvas.width !== natW || canvas.height !== natH) {
    canvas.width = natW;
    canvas.height = natH;
  }
  clampView();
  applyView();
  scheduleRedraw();
}

function applyView() {
  const surface = el('annotate-surface');
  if (!surface) return;
  surface.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`;
}

function clampView() {
  view.scale = Math.max(view.minScale, Math.min(MAX_SCALE, view.scale));
  const stage = el('annotate-stage');
  if (stage && session?.baseW && session?.baseH) {
    const maxPanX = Math.max(0, (session.baseW * view.scale - stage.clientWidth) / 2);
    const maxPanY = Math.max(0, (session.baseH * view.scale - stage.clientHeight) / 2);
    view.panX = Math.max(-maxPanX, Math.min(maxPanX, view.panX));
    view.panY = Math.max(-maxPanY, Math.min(maxPanY, view.panY));
  }
  if (view.scale <= view.minScale + SCALE_EPS) {
    view.scale = view.minScale;
    view.panX = 0;
    view.panY = 0;
  }
}

function pointFromStageCenter(clientX, clientY) {
  const rect = el('annotate-stage')?.getBoundingClientRect();
  if (!rect) return { cx: 0, cy: 0 };
  return { cx: clientX - rect.left - rect.width / 2, cy: clientY - rect.top - rect.height / 2 };
}

function zoomAtPoint(factor, cx, cy) {
  const previous = view.scale;
  view.scale = previous * factor;
  if (view.scale !== previous) {
    view.panX = cx - (cx - view.panX) * (view.scale / previous);
    view.panY = cy - (cy - view.panY) * (view.scale / previous);
  }
  clampView();
  applyView();
}

function toggleZoomAt(clientX, clientY) {
  const { cx, cy } = pointFromStageCenter(clientX, clientY);
  if (view.scale > view.minScale + SCALE_EPS || view.panX !== 0 || view.panY !== 0) {
    view.scale = view.minScale;
    view.panX = 0;
    view.panY = 0;
    applyView();
    return;
  }
  zoomAtPoint(DOUBLE_TAP_ZOOM, cx, cy);
}

/* --------------------------------------------------------------- drawing */

function scheduleRedraw() {
  if (!session || redrawHandle) return;
  redrawHandle = requestAnimationFrame(() => {
    redrawHandle = 0;
    redrawNow();
  });
}

function redrawNow() {
  if (!session) return;
  const canvas = el('annotate-canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = visibleStrokes(session.stack);
  renderStrokes(ctx, drawing?.stroke ? strokes.concat([drawing.stroke]) : strokes, { alpha: MARKER_ALPHA });
}

function toImagePoint(clientX, clientY) {
  if (!session) return null;
  const canvas = el('annotate-canvas');
  if (!canvas) return null;
  // The canvas rect already reflects the live pan/zoom transform, so the
  // mapping needs no separate scale bookkeeping.
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return clientPointToImagePoint(clientX, clientY, rect, session.width, session.height);
}

function beginStroke(event) {
  const point = toImagePoint(event.clientX, event.clientY);
  if (!point) return;
  drawing = {
    pointerId: event.pointerId,
    stroke: {
      color: colorHexFor(activeColorId),
      widthPx: strokeWidthFor(activeWidthId, Math.max(session.width, session.height)),
      points: [point],
    },
  };
  scheduleRedraw();
}

function cancelActiveStroke() {
  if (!drawing) return;
  drawing = null;
  scheduleRedraw();
}

/* -------------------------------------------------------------- gestures */

function beginPinch() {
  const stage = el('annotate-stage');
  const [a, b] = [...pointers.values()];
  if (!stage || !a || !b) return;
  const rect = stage.getBoundingClientRect();
  pinch = {
    dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    scale0: view.scale,
    panX0: view.panX,
    panY0: view.panY,
    cx: (a.x + b.x) / 2 - rect.left - rect.width / 2,
    cy: (a.y + b.y) / 2 - rect.top - rect.height / 2,
  };
}

function updatePinch() {
  if (!pinch) return;
  const [a, b] = [...pointers.values()];
  if (!a || !b) return;
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const next = Math.max(view.minScale, Math.min(MAX_SCALE, pinch.scale0 * (dist / pinch.dist0)));
  view.scale = next;
  view.panX = pinch.cx - (pinch.cx - pinch.panX0) * (next / pinch.scale0);
  view.panY = pinch.cy - (pinch.cy - pinch.panY0) * (next / pinch.scale0);
  clampView();
  applyView();
}

function onStagePointerDown(event) {
  if (!session) return;
  event.preventDefault();
  // Frozen while exporting: a stroke committed mid-export would render on the
  // overlay but be missing from the file being saved.
  if (session.exporting) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try { el('annotate-stage')?.setPointerCapture?.(event.pointerId); } catch {}

  if (pointers.size >= 2) {
    // A second pointer landing mid-stroke always rescues an accidental touch:
    // the in-progress stroke is dropped (never committed) and the gesture
    // becomes a pinch. This is what makes "one pointer always draws" safe.
    cancelActiveStroke();
    panning = null;
    beginPinch();
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    return;
  }

  if (suppressDrawUntilIdle) return;

  const now = Date.now();
  const isDoubleTap = now - lastTap.t < DOUBLE_TAP_MS
    && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_SLOP_PX;
  if (isDoubleTap) {
    // The first tap of a double tap already committed a one-point dot, so it is
    // undone here — zooming must not leave a stray mark behind. Only when the
    // stack top really is that dot: a toolbar action can land in between.
    const top = session.stack.entries[session.stack.entries.length - 1];
    if (lastTap.wasDot && top?.kind === 'stroke' && top.stroke?.points?.length === 1) {
      undo(session.stack);
      scheduleRedraw();
      syncToolbarState();
    }
    lastTap = { t: 0, x: 0, y: 0, wasDot: false };
    toggleZoomAt(event.clientX, event.clientY);
    return;
  }

  lastTap = { t: now, x: event.clientX, y: event.clientY, wasDot: false };
  beginStroke(event);
}

function onStagePointerMove(event) {
  if (!session || !pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pinch && pointers.size >= 2) {
    event.preventDefault();
    updatePinch();
    return;
  }
  if (panning && panning.pointerId === event.pointerId) {
    event.preventDefault();
    view.panX += event.clientX - panning.x;
    view.panY += event.clientY - panning.y;
    panning.x = event.clientX;
    panning.y = event.clientY;
    clampView();
    applyView();
    return;
  }
  if (drawing && drawing.pointerId === event.pointerId) {
    event.preventDefault();
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    const points = drawing.stroke.points;
    const last = points[points.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DELTA_PX) return;
    points.push(point);
    // A drag is not a tap: without this, two quick strokes in the same spot
    // read as a double tap and the second becomes a surprise zoom.
    lastTap.t = 0;
    scheduleRedraw();
  }
}

function onStagePointerUp(event) {
  pointers.delete(event.pointerId);
  try { el('annotate-stage')?.releasePointerCapture?.(event.pointerId); } catch {}
  if (!session) return;

  if (pinch && pointers.size < 2) {
    pinch = null;
    // A finger left over from a pinch must not start a stroke on its own.
    suppressDrawUntilIdle = pointers.size > 0;
  }
  if (panning?.pointerId === event.pointerId) panning = null;

  if (drawing?.pointerId === event.pointerId) {
    const stroke = drawing.stroke;
    drawing = null;
    if (event.type === 'pointercancel') {
      scheduleRedraw();
    } else if (stroke.points.length >= 1) {
      // A tap is a legitimate one-point dot.
      pushStroke(session.stack, stroke);
      lastTap.wasDot = stroke.points.length === 1;
      scheduleRedraw();
      syncToolbarState();
    }
  }
  if (pointers.size === 0) suppressDrawUntilIdle = false;
}

function onStageWheel(event) {
  if (!session) return;
  event.preventDefault();
  const { cx, cy } = pointFromStageCenter(event.clientX, event.clientY);
  zoomAtPoint(event.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR, cx, cy);
}

function onStageContextMenu(event) {
  // Right-drag pans, so the menu would fire mid-gesture.
  if (session) event.preventDefault();
}

function onKeyDown(event) {
  if (event.key !== 'Escape' || !session) return;
  event.preventDefault();
  closeAnnotateEditor();
}

function onWindowResize() {
  layoutSurface();
}

/* --------------------------------------------------------------- toolbar */

function syncToolSelection() {
  for (const btn of document.querySelectorAll('.annotate-color')) {
    btn.classList.toggle('active', btn.dataset.color === activeColorId);
  }
  for (const btn of document.querySelectorAll('.annotate-width')) {
    btn.classList.toggle('active', btn.dataset.width === activeWidthId);
  }
}

function syncToolbarState() {
  const strokeCount = session ? visibleStrokes(session.stack).length : 0;
  const undoBtn = el('annotate-undo-btn');
  const resetBtn = el('annotate-reset-btn');
  const acceptBtn = el('annotate-accept-btn');
  const exporting = !!session?.exporting;
  if (undoBtn) undoBtn.disabled = !session || !canUndo(session.stack) || exporting;
  if (resetBtn) resetBtn.disabled = strokeCount === 0 || exporting;
  if (acceptBtn) acceptBtn.disabled = strokeCount === 0 || !session || exporting;
}

function selectColor(id) {
  if (!ANNOTATE_COLORS.some((entry) => entry?.id === id)) return;
  activeColorId = id;
  syncToolSelection();
}

function selectWidth(id) {
  if (!ANNOTATE_WIDTH_IDS.includes(id)) return;
  activeWidthId = id;
  syncToolSelection();
}

function onUndoClick() {
  if (!session) return;
  undo(session.stack);
  scheduleRedraw();
  syncToolbarState();
}

function onResetClick() {
  if (!session) return;
  // Reset is itself undoable, so a fat-fingered clear is never fatal.
  pushReset(session.stack);
  scheduleRedraw();
  syncToolbarState();
}

async function acceptAnnotations() {
  if (!session || session.exporting) return;
  const current = session;
  const strokes = visibleStrokes(current.stack);
  if (!strokes.length) return;
  current.exporting = true;
  syncToolbarState();
  try {
    const file = await composeAnnotatedImage(
      { bitmap: current.bitmap, strokes, name: current.name },
      browserDownscaleDeps(),
    );
    // The session can be closed (Escape) while the export awaited; the discard
    // then already happened and this result is simply dropped.
    if (session !== current) return;
    if (!file) throw new Error('the image could not be exported');
    const accepted = current.onAccept ? await current.onAccept(file) : false;
    if (session !== current) return;
    if (accepted) {
      finishClose();
      return;
    }
    // A falsy result means the caller rejected the file and has already shown
    // its own notice (over-cap, upload refused, …), so nothing is added here.
  } catch (error) {
    if (session !== current) return;
    showTransientRelayNotice(`Could not save annotations: ${String(error?.message || error || 'unknown error')}`);
  }
  if (session === current) {
    current.exporting = false;
    syncToolbarState();
  }
}

function bindListeners() {
  if (listenersBound) return true;
  const stage = el('annotate-stage');
  if (!stage) return false;
  stage.addEventListener('pointerdown', onStagePointerDown, { passive: false });
  stage.addEventListener('pointermove', onStagePointerMove, { passive: false });
  stage.addEventListener('pointerup', onStagePointerUp);
  stage.addEventListener('pointercancel', onStagePointerUp);
  stage.addEventListener('wheel', onStageWheel, { passive: false });
  stage.addEventListener('contextmenu', onStageContextMenu);
  el('annotate-close-btn')?.addEventListener('click', () => closeAnnotateEditor());
  el('annotate-undo-btn')?.addEventListener('click', onUndoClick);
  el('annotate-reset-btn')?.addEventListener('click', onResetClick);
  el('annotate-accept-btn')?.addEventListener('click', () => { void acceptAnnotations(); });
  for (const btn of document.querySelectorAll('.annotate-color')) {
    btn.addEventListener('click', () => selectColor(btn.dataset.color));
  }
  for (const btn of document.querySelectorAll('.annotate-width')) {
    btn.addEventListener('click', () => selectWidth(btn.dataset.width));
  }
  listenersBound = true;
  return true;
}

// `imageOrientation: 'from-image'` keeps rotated phone screenshots upright, but
// the option bag is rejected outright by older engines.
async function decodeUpright(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(blob);
  }
}

function finishClose() {
  document.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('resize', onWindowResize);
  if (redrawHandle) {
    cancelAnimationFrame(redrawHandle);
    redrawHandle = 0;
  }
  const canvas = el('annotate-canvas');
  const ctx = canvas?.getContext?.('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  const img = el('annotate-image');
  if (img) img.removeAttribute('src');
  if (session) {
    try { session.bitmap?.close?.(); } catch {}
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
  }
  session = null;
  pointers.clear();
  drawing = null;
  panning = null;
  pinch = null;
  suppressDrawUntilIdle = false;
  lastTap = { t: 0, x: 0, y: 0, wasDot: false };
  view.scale = FIT_SCALE;
  view.panX = 0;
  view.panY = 0;
  const modal = el('image-annotate-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  syncToolbarState();
}

/**
 * Opens the editor on one image. Exactly one session exists at a time — a call
 * while another is open (or still loading) is ignored.
 *
 * `getBlob()` supplies the source bytes; `onAccept(file)` receives the exported
 * PNG and decides the outcome: a truthy result closes the editor, a falsy one
 * leaves it open (the caller has already explained why). Failures to load or
 * decode surface as a transient notice and the editor never opens.
 *
 * Resolves to true when the editor is showing.
 */
export async function openAnnotateEditor({ name, getBlob, onAccept } = {}) {
  if (session || opening) return false;
  if (typeof getBlob !== 'function') return false;
  opening = true;

  let bitmap = null;
  let objectUrl = '';
  try {
    const blob = await getBlob();
    if (!blob) throw new Error('the image could not be loaded');
    bitmap = await decodeUpright(blob);
    if (!bitmap?.width || !bitmap?.height) throw new Error('the image could not be decoded');
    objectUrl = URL.createObjectURL(blob);
  } catch (error) {
    opening = false;
    try { bitmap?.close?.(); } catch {}
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    showTransientRelayNotice(`Could not open the annotation editor: ${String(error?.message || error || 'unknown error')}`);
    return false;
  }

  const modal = el('image-annotate-modal');
  const img = el('annotate-image');
  if (!modal || !img || !bindListeners()) {
    opening = false;
    try { bitmap.close?.(); } catch {}
    URL.revokeObjectURL(objectUrl);
    showTransientRelayNotice('Could not open the annotation editor.');
    return false;
  }

  session = {
    name: String(name || 'image.png'),
    onAccept: typeof onAccept === 'function' ? onAccept : null,
    bitmap,
    objectUrl,
    width: bitmap.width,
    height: bitmap.height,
    stack: createStrokeStack(),
    baseW: 0,
    baseH: 0,
    exporting: false,
  };
  opening = false;

  activeColorId = DEFAULT_COLOR_ID;
  activeWidthId = DEFAULT_WIDTH_ID;
  view.scale = FIT_SCALE;
  view.panX = 0;
  view.panY = 0;
  view.minScale = FIT_SCALE;
  pointers.clear();
  drawing = null;
  panning = null;
  pinch = null;
  suppressDrawUntilIdle = false;
  lastTap = { t: 0, x: 0, y: 0, wasDot: false };

  const title = el('annotate-title');
  if (title) title.textContent = session.name;
  img.src = objectUrl;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onWindowResize);
  syncToolSelection();
  syncToolbarState();
  applyView();
  // The stage has no measurable size until the modal is visible.
  requestAnimationFrame(() => layoutSurface());
  return true;
}

/** Discards the session; confirms first when there is something to lose. */
export function closeAnnotateEditor() {
  if (!session) return;
  if (visibleStrokes(session.stack).length && !window.confirm('Discard annotations?')) return;
  finishClose();
}

export function isAnnotateEditorOpen() {
  return !!session;
}
