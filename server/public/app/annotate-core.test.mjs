import test from 'node:test';
import assert from 'node:assert/strict';
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
  annotatedFileName,
  composeAnnotatedImage,
} from './annotate-core.mjs';

function fakeStroke({ color = '#ffdd00', widthPx = 41, points = [{ x: 0, y: 0 }, { x: 10, y: 10 }] } = {}) {
  return { color, widthPx, points };
}

// Records the calls the drawing routine makes, snapshotting the style state at
// the moment of each paint so the assertions can check ordering and alpha.
function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: null,
    fillStyle: null,
    lineWidth: 0,
    lineCap: null,
    lineJoin: null,
    drawImage(_bitmap, x, y, width, height) {
      calls.push({ op: 'drawImage', x, y, width, height });
    },
    beginPath() { calls.push({ op: 'beginPath' }); },
    moveTo(x, y) { calls.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { calls.push({ op: 'lineTo', x, y }); },
    arc(x, y, radius) { calls.push({ op: 'arc', x, y, radius }); },
    fill() {
      calls.push({ op: 'fill', fillStyle: ctx.fillStyle, alpha: ctx.globalAlpha });
    },
    stroke() {
      calls.push({
        op: 'stroke',
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        lineCap: ctx.lineCap,
        lineJoin: ctx.lineJoin,
        alpha: ctx.globalAlpha,
      });
    },
  };
  return { ctx, calls, ops: () => calls.map((call) => call.op) };
}

function fakeComposeDeps({ blobSize = 2048, missingContext = false, failEncode = false } = {}) {
  const recorder = fakeCtx();
  const calls = { canvas: null, ctx: recorder, files: [] };
  return {
    calls,
    deps: {
      createCanvas: (width, height) => {
        calls.canvas = { width, height };
        return {
          getContext: () => (missingContext ? null : recorder.ctx),
          convertToBlob: async ({ type }) => {
            if (failEncode) return null;
            return { size: blobSize, type };
          },
        };
      },
      // Mirrors browserDownscaleDeps' shape: (blob, name, type) — the dep
      // wraps the blob into the File parts array itself.
      createFile: (blob, name, type) => {
        const file = { blob, name, type, size: blob?.size };
        calls.files.push(file);
        return file;
      },
    },
  };
}

test('the palette and width ids are the four colors and three widths of the spec', () => {
  assert.deepEqual(ANNOTATE_COLORS.map((color) => color.id), ['yellow', 'red', 'green', 'blue']);
  assert.deepEqual(ANNOTATE_COLORS.map((color) => color.hex), ['#ffdd00', '#ff3b30', '#34c759', '#0a84ff']);
  assert.deepEqual([...ANNOTATE_WIDTH_IDS], ['thin', 'medium', 'thick']);
  assert.equal(MARKER_ALPHA, 0.4);
});

test('stroke widths are proportional to the longest side', () => {
  assert.equal(strokeWidthFor('thin', 2560), 20);
  assert.equal(strokeWidthFor('medium', 2560), 41);
  assert.equal(strokeWidthFor('thick', 2560), 82);
  // Doubling the image doubles the mark.
  assert.equal(strokeWidthFor('medium', 5120), 82);
});

test('stroke widths never fall below the visibility floor', () => {
  assert.equal(strokeWidthFor('thin', 300), 4, '2.4px would be a hairline');
  assert.equal(strokeWidthFor('medium', 300), 5);
  assert.equal(strokeWidthFor('thick', 300), 10);
  assert.equal(strokeWidthFor('thin', 0), 4);
  assert.equal(strokeWidthFor('thin', undefined), 4);
});

test('an unknown width id draws like medium', () => {
  assert.equal(strokeWidthFor('gigantic', 2560), strokeWidthFor('medium', 2560));
  assert.equal(strokeWidthFor(undefined, 1000), strokeWidthFor('medium', 1000));
});

test('a fresh stack is empty and cannot undo', () => {
  const stack = createStrokeStack();
  assert.deepEqual(stack.entries, []);
  assert.equal(canUndo(stack), false);
  assert.deepEqual(visibleStrokes(stack), []);
  assert.equal(undo(stack), false, 'nothing to pop');
});

test('strokes come back in draw order and undo pops the last one', () => {
  const stack = createStrokeStack();
  const first = fakeStroke({ color: '#ffdd00' });
  const second = fakeStroke({ color: '#ff3b30' });
  pushStroke(stack, first);
  pushStroke(stack, second);
  assert.deepEqual(visibleStrokes(stack), [first, second]);
  assert.equal(canUndo(stack), true);

  assert.equal(undo(stack), true);
  assert.deepEqual(visibleStrokes(stack), [first]);
  assert.equal(undo(stack), true);
  assert.equal(canUndo(stack), false);
  assert.deepEqual(visibleStrokes(stack), []);
});

test('reset hides every stroke and undoing the reset restores them', () => {
  const stack = createStrokeStack();
  const first = fakeStroke({ color: '#ffdd00' });
  const second = fakeStroke({ color: '#34c759' });
  pushStroke(stack, first);
  pushStroke(stack, second);

  assert.equal(pushReset(stack), true);
  assert.deepEqual(visibleStrokes(stack), [], 'the canvas looks cleared');
  assert.equal(canUndo(stack), true, 'a fat-finger reset must be recoverable');

  assert.equal(undo(stack), true);
  assert.deepEqual(visibleStrokes(stack), [first, second]);
});

test('resetting an already-empty canvas pushes nothing', () => {
  const stack = createStrokeStack();
  assert.equal(pushReset(stack), false);
  assert.equal(canUndo(stack), false);

  const only = fakeStroke();
  pushStroke(stack, only);
  pushReset(stack);
  assert.equal(pushReset(stack), false, 'the second reset has nothing left to clear');
  assert.equal(stack.entries.length, 2);

  // One undo must reach the reset, not a useless duplicate entry.
  assert.equal(undo(stack), true);
  assert.deepEqual(visibleStrokes(stack), [only]);
});

test('visibleStrokes only reports strokes drawn after the last reset', () => {
  const stack = createStrokeStack();
  const before = fakeStroke({ color: '#ffdd00' });
  const afterOne = fakeStroke({ color: '#ff3b30' });
  const afterTwo = fakeStroke({ color: '#0a84ff' });
  pushStroke(stack, before);
  pushReset(stack);
  pushStroke(stack, afterOne);
  pushStroke(stack, afterTwo);
  assert.deepEqual(visibleStrokes(stack), [afterOne, afterTwo]);

  pushReset(stack);
  pushStroke(stack, before);
  assert.deepEqual(visibleStrokes(stack), [before]);

  // Unwinding past both resets brings the whole history back in order.
  undo(stack);
  undo(stack);
  assert.deepEqual(visibleStrokes(stack), [afterOne, afterTwo]);
  undo(stack);
  undo(stack);
  undo(stack);
  assert.deepEqual(visibleStrokes(stack), [before]);
});

test('an unzoomed overlay at the origin maps one to one', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  assert.deepEqual(clientPointToImagePoint(0, 0, rect, 800, 600), { x: 0, y: 0 });
  assert.deepEqual(clientPointToImagePoint(123, 45, rect, 800, 600), { x: 123, y: 45 });
  assert.deepEqual(clientPointToImagePoint(800, 600, rect, 800, 600), { x: 800, y: 600 });
});

test('a fitted (half size) overlay scales points back up to image pixels', () => {
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  assert.deepEqual(clientPointToImagePoint(100, 60, rect, 800, 600), { x: 200, y: 120 });
  assert.deepEqual(clientPointToImagePoint(400, 300, rect, 800, 600), { x: 800, y: 600 });
});

test('the rect offset is subtracted before scaling', () => {
  const rect = { left: 50, top: 20, width: 400, height: 300 };
  assert.deepEqual(clientPointToImagePoint(50, 20, rect, 800, 600), { x: 0, y: 0 });
  assert.deepEqual(clientPointToImagePoint(150, 170, rect, 800, 600), { x: 200, y: 300 });
});

test('a zoomed overlay maps the visible detail back to image pixels', () => {
  // 4x zoom on a 800x600 image, panned so the rect starts off-screen.
  const rect = { left: -1200, top: -900, width: 3200, height: 2400 };
  assert.deepEqual(clientPointToImagePoint(0, 0, rect, 800, 600), { x: 300, y: 225 });
});

test('points outside the image are clamped to its bounds', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 };
  assert.deepEqual(clientPointToImagePoint(-40, -10, rect, 800, 600), { x: 0, y: 0 });
  assert.deepEqual(clientPointToImagePoint(9000, 9000, rect, 800, 600), { x: 800, y: 600 });
  assert.deepEqual(clientPointToImagePoint(500, -5, rect, 800, 600), { x: 500, y: 0 });
});

test('a degenerate rect cannot produce NaN coordinates', () => {
  assert.deepEqual(clientPointToImagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 800, 600), { x: 0, y: 0 });
  assert.deepEqual(clientPointToImagePoint(10, 10, null, 800, 600), { x: 0, y: 0 });
});

test('a multi-point stroke is drawn as exactly one round-capped path', () => {
  const { ctx, calls, ops } = fakeCtx();
  renderStrokes(ctx, [fakeStroke({
    color: '#ff3b30',
    widthPx: 12,
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }],
  })]);

  assert.deepEqual(ops(), ['beginPath', 'moveTo', 'lineTo', 'lineTo', 'stroke']);
  const painted = calls.at(-1);
  assert.equal(painted.strokeStyle, '#ff3b30');
  assert.equal(painted.lineWidth, 12);
  assert.equal(painted.lineCap, 'round');
  assert.equal(painted.lineJoin, 'round');
  assert.equal(painted.alpha, MARKER_ALPHA);
  assert.deepEqual(calls[1], { op: 'moveTo', x: 1, y: 2 });
  assert.deepEqual(calls[3], { op: 'lineTo', x: 5, y: 6 });
});

test('the marker alpha is set for drawing and restored afterwards', () => {
  const { ctx } = fakeCtx();
  ctx.globalAlpha = 0.9;
  renderStrokes(ctx, [fakeStroke()]);
  assert.equal(ctx.globalAlpha, 0.9, 'the caller keeps its own alpha');

  const custom = fakeCtx();
  renderStrokes(custom.ctx, [fakeStroke()], { alpha: 0.75 });
  assert.equal(custom.calls.at(-1).alpha, 0.75);
  assert.equal(custom.ctx.globalAlpha, 1);
});

test('a single-point stroke is painted as a filled dot', () => {
  const { ctx, calls, ops } = fakeCtx();
  renderStrokes(ctx, [fakeStroke({ color: '#34c759', widthPx: 20, points: [{ x: 7, y: 8 }] })]);

  assert.deepEqual(ops(), ['beginPath', 'arc', 'fill'], 'a zero-length line paints nothing in some engines');
  assert.deepEqual(calls[1], { op: 'arc', x: 7, y: 8, radius: 10 });
  assert.equal(calls[2].fillStyle, '#34c759');
  assert.equal(calls[2].alpha, MARKER_ALPHA);
});

test('strokes are drawn in order, one path each', () => {
  const { ctx, calls, ops } = fakeCtx();
  renderStrokes(ctx, [
    fakeStroke({ color: '#ffdd00', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
    fakeStroke({ color: '#0a84ff', points: [{ x: 2, y: 2 }] }),
    fakeStroke({ color: '#ff3b30', points: [{ x: 3, y: 3 }, { x: 4, y: 4 }] }),
  ]);

  assert.equal(ops().filter((op) => op === 'beginPath').length, 3);
  assert.equal(ops().filter((op) => op === 'stroke').length, 2);
  assert.deepEqual(
    calls.filter((call) => call.op === 'stroke' || call.op === 'fill').map((call) => call.strokeStyle || call.fillStyle),
    ['#ffdd00', '#0a84ff', '#ff3b30'],
  );
});

test('renderStrokes ignores empty input and pointless strokes', () => {
  const { ctx, calls } = fakeCtx();
  renderStrokes(ctx, []);
  renderStrokes(ctx, null);
  renderStrokes(null, [fakeStroke()]);
  renderStrokes(ctx, [{ color: '#ffdd00', widthPx: 8, points: [] }, { color: '#ff3b30', widthPx: 8, points: null }]);
  assert.deepEqual(calls, []);
  assert.equal(ctx.globalAlpha, 1);
});

test('annotatedFileName replaces the extension with the annotated png suffix', () => {
  assert.equal(annotatedFileName('shot.png'), 'shot-annotated.png');
  assert.equal(annotatedFileName('a.b.jpeg'), 'a.b-annotated.png');
  assert.equal(annotatedFileName('no-extension'), 'no-extension-annotated.png');
  assert.equal(annotatedFileName(''), 'screenshot-annotated.png');
  assert.equal(annotatedFileName(null), 'screenshot-annotated.png');
  assert.equal(annotatedFileName(undefined), 'screenshot-annotated.png');
});

test('composeAnnotatedImage flattens the image and its strokes into a png file', async () => {
  const { deps, calls } = fakeComposeDeps({ blobSize: 4096 });
  const bitmap = { width: 1290, height: 2796 };
  const stroke = fakeStroke({ color: '#ffdd00', widthPx: 45, points: [{ x: 10, y: 10 }, { x: 90, y: 90 }] });

  const file = await composeAnnotatedImage({ bitmap, strokes: [stroke], name: 'IMG_0042.HEIC' }, deps);

  assert.deepEqual(calls.canvas, { width: 1290, height: 2796 }, 'export happens at natural resolution');
  assert.equal(file.name, 'IMG_0042-annotated.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, 4096);
  assert.equal(file.blob.type, 'image/png');
});

test('composeAnnotatedImage draws the bitmap before the strokes', async () => {
  const { deps, calls } = fakeComposeDeps();
  const bitmap = { width: 800, height: 600 };
  await composeAnnotatedImage({ bitmap, strokes: [fakeStroke()], name: 'shot.png' }, deps);

  const ops = calls.ctx.ops();
  assert.deepEqual(calls.ctx.calls[0], { op: 'drawImage', x: 0, y: 0, width: 800, height: 600 });
  assert.ok(ops.indexOf('drawImage') < ops.indexOf('stroke'), 'strokes must land on top of the image');
  assert.equal(calls.ctx.calls.at(-1).alpha, MARKER_ALPHA);
});

test('composeAnnotatedImage never closes the bitmap it was handed', async () => {
  const { deps } = fakeComposeDeps();
  let closed = 0;
  // The caller may still need the bitmap for the live overlay after an export.
  const bitmap = { width: 100, height: 100, close: () => { closed += 1; } };
  await composeAnnotatedImage({ bitmap, strokes: [], name: 'shot.png' }, deps);
  assert.equal(closed, 0);
});

test('composeAnnotatedImage exports a plain flattened image when there are no strokes', async () => {
  const { deps, calls } = fakeComposeDeps();
  const file = await composeAnnotatedImage({ bitmap: { width: 20, height: 20 }, strokes: [], name: 'shot.png' }, deps);
  assert.equal(file.name, 'shot-annotated.png');
  assert.deepEqual(calls.ctx.ops(), ['drawImage']);
});

test('composeAnnotatedImage yields nothing when it cannot compose', async () => {
  const bitmap = { width: 100, height: 100 };
  const strokes = [fakeStroke()];
  assert.equal(await composeAnnotatedImage({ bitmap, strokes, name: 'shot.png' }, {}), null);
  assert.equal(await composeAnnotatedImage({ bitmap: null, strokes, name: 'shot.png' }, fakeComposeDeps().deps), null);
  assert.equal(
    await composeAnnotatedImage({ bitmap: { width: 0, height: 0 }, strokes, name: 'shot.png' }, fakeComposeDeps().deps),
    null,
  );
  assert.equal(
    await composeAnnotatedImage({ bitmap, strokes, name: 'shot.png' }, fakeComposeDeps({ missingContext: true }).deps),
    null,
  );
  assert.equal(
    await composeAnnotatedImage({ bitmap, strokes, name: 'shot.png' }, fakeComposeDeps({ failEncode: true }).deps),
    null,
  );
});
