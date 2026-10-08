// #254 in main.js itself: the brush mapping, the display overlay's tint and
// strokes, and the live dodge-and-burn flow, as real main.js functions
// extracted with vm (as displayPath.test.mjs does) against stand-ins. The live
// flow runs against the real adapter in this process, standing in for the
// preview worker, and the texture it paints must equal the frame of the
// stored stroke.
// node negative2positive/src/app/brushWiring.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { live as adapter } from '../pipeline/oracle/adapterParity.mjs';
import {
  sanitizeLocalExposureForSettings, sanitizeLocalExposureStrokes, sanitizeStrokePoint, workingPointToBase, basePointToWorking,
  strokeBrush, createLiveStrokeCoverage, addLiveStrokePoints, unionRect, MAX_STROKE_POINTS,
} from './localExposure.js';
import {
  BRUSH_FEEDBACK_STYLES, pointerSamples, movedEnough, resampleStrokePoints, createStrokeRecorder, DENSE_STROKE_POINTS,
} from './brushFeedback.js';
import { buildDustTint, buildDustTintRect } from './dustTint.js';
import { applyPreparedAdjustmentsToBuffer, createAdjustmentLutScratch } from './adjustmentPipeline.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function drain() { for (let i = 0; i < 20; i++) await settle(); }

// ---- A.2: brushes map through the photo, inside the film border on either canvas ----
{
  const state = { sprocketPreviewEnabled: false, processedImageData: { width: 4000, height: 3000 } };
  const box = { left: 100, top: 50, width: 500, height: 400 };
  const canvas = { width: 1, height: 1, style: { display: 'none' }, getBoundingClientRect: () => box };
  const glCanvas = { style: { display: 'block' }, getBoundingClientRect: () => box };
  const framed = { frameWidth: 1000, frameHeight: 800, x: 100, y: 50, width: 800, height: 600 };
  const glBorder = { photo: null };
  const context = vm.createContext({ state, canvas, glCanvas, glBorder, mainCanvasPhoto: null, Math });
  vm.runInContext(['brushSurfaceRect', 'clientToImageCoords', 'canvasToImageCoords'].map(functionSource).join('\n'), context);
  assert.deepEqual({ ...context.brushSurfaceRect() }, box, 'no border: the canvas itself');
  // The border on the GL display (#253 D) and on #canvas: the photo inside the frame.
  state.sprocketPreviewEnabled = true;
  glBorder.photo = framed;
  const photo = { ...context.brushSurfaceRect() };
  assert.deepEqual(photo, { left: 150, top: 75, width: 400, height: 300 }, 'border on the GL display: the photo inside the frame');
  glCanvas.style.display = 'none';
  canvas.style.display = 'block';
  context.mainCanvasPhoto = framed;
  assert.deepEqual({ ...context.brushSurfaceRect() }, photo, 'border on #canvas: the same photo rectangle');
  assert.deepEqual({ ...context.clientToImageCoords(150, 75, photo) }, { x: 0, y: 0 });
  assert.deepEqual({ ...context.clientToImageCoords(550, 375, photo) }, { x: 4000, y: 3000 });
  // Without the border, the same image points as the mapping before #254 (+-1 px).
  state.sprocketPreviewEnabled = false;
  const rect = context.brushSurfaceRect();
  for (let i = 0; i < 500; i++) {
    const clientX = 100 + Math.random() * 500, clientY = 50 + Math.random() * 400;
    for (const canvasWidth of [1, 1809, 4000]) {
      canvas.width = canvasWidth; canvas.height = Math.round(canvasWidth * 0.75);
      const before = context.canvasToImageCoords((clientX - 100) * (canvas.width / 500), (clientY - 50) * (canvas.height / 400));
      const after = context.clientToImageCoords(clientX, clientY, rect);
      assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1, JSON.stringify({ before, after }));
    }
  }
}

// ---- B: the display overlay (#253's layer): the worker's tint, patches, strokes drawn once ----
{
  const W = 400, H = 300;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < 300; i++) mask[(i * 7919) % mask.length] = 255;
  const calls = [];
  const overlayContext = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : (...args) => calls.push([key, ...args])),
    set: (target, key, value) => { target[key] = value; calls.push(['set', key, value]); return true; },
  });
  const displayOverlay = { width: 1, height: 1, style: {}, getContext: () => overlayContext };
  const geometry = { baseWidth: 800, baseHeight: 600, rotatedWidth: 800, rotatedHeight: 600, rotationAngle: 0, mirrored: false,
    cropRegion: { x: 100, y: 100, width: 400, height: 300 } };
  const state = {
    currentStep: 3, cropping: false, beforeAfterActive: false, sprocketPreviewEnabled: false,
    processedImageData: { width: W, height: H }, previewSourceImageData: { width: 100, height: 75 },
    dustRemoval: { enabled: true, showMask: true, mask, maskTag: 5 },
    dodgeBurn: { active: false, showOverlay: true }, localExposure: null,
  };
  const ids = new WeakMap(); let nextId = 1;
  const context = vm.createContext({
    state, displayOverlay, Math, JSON, Boolean, console,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    dustTint: { mask: null, tag: null, width: 0, height: 0, image: null, building: null },
    displayOverlayState: { key: null, plan: null, tint: null, counters: { tintRects: 0, bandedBuilds: 0, workerTints: 0 } },
    displayDebugCounters: { overlayPaints: 0 },
    displaySourceImageData: () => state.previewSourceImageData || state.processedImageData,
    getDisplayPreviewSize: () => ({ width: 100, height: 75 }),
    gpuObjectId: (object) => { if (!object) return 0; if (!ids.has(object)) ids.set(object, nextId++); return ids.get(object); },
    localExposureGeometryFor: () => geometry, dodgeBurnGeometry: () => ({ ...geometry, width: W, height: H }),
    getSprocketFrameLayout: () => null, getSprocketFrameComposeOptions: () => ({}),
    strokeBrush, basePointToWorking,
    buildDustTintRect, buildDustTintInBands: async () => assert.fail('the worker tint is used'), yieldTaskForJob: async () => {},
  });
  vm.runInContext(['displayOverlaySize', 'dustTintWanted', 'dodgeStrokesWanted', 'dustTintCurrent', 'adoptDustTint', 'patchDustTint',
    'ensureDustTint', 'displayOverlayPlan', 'displayOverlayKey', 'drawDisplayOverlay', 'paintDisplayOverlay', 'syncDisplayOverlay', 'releaseDisplayOverlay',
    'renderDodgeBurnOverlay'].map(functionSource).join('\n'), context);
  const puts = () => calls.filter(([key]) => key === 'putImageData');
  const strokes = () => calls.filter(([key]) => key === 'stroke');
  // The worker's tint of the detection, of the overlay's size, is put once.
  context.adoptDustTint(mask, 5, { width: 100, height: 75, rgba: buildDustTint(mask, W, H, 100, 75) });
  context.syncDisplayOverlay();
  assert.deepEqual([displayOverlay.width, displayOverlay.height, displayOverlay.style.display], [100, 75, 'block']);
  assert.equal(puts().length, 1);
  for (let i = 0; i < 5; i++) context.syncDisplayOverlay();
  assert.equal(puts().length, 1, 'an unchanged overlay is not repainted');
  // A stroke changes the mask in a rect: only those cells are put.
  const rect = { x: 50, y: 40, width: 30, height: 20 };
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) mask[y * W + x] = 255;
  state.dustRemoval.maskTag = 6;
  context.patchDustTint(mask, 5, 6, rect, null);
  assert.equal(puts().length, 2);
  assert.equal(puts()[1].length, 8, 'a dirty-rect put (image, dx, dy and the cell rectangle)');
  assert.deepEqual(context.dustTint.image.data, buildDustTint(mask, W, H, 100, 75), 'the patched tint equals a new pool');
  context.syncDisplayOverlay();
  assert.equal(puts().length, 2, 'the patched overlay is current');
  // The worker's own cells for the next stroke are used as they are.
  const rect2 = { x: 300, y: 200, width: 10, height: 10 };
  for (let y = rect2.y; y < rect2.y + rect2.height; y++) for (let x = rect2.x; x < rect2.x + rect2.width; x++) mask[y * W + x] = 0;
  const cells = { ...buildDustTintRect(mask, W, H, 100, 75, rect2), tintWidth: 100, tintHeight: 75 };
  state.dustRemoval.maskTag = 7;
  context.patchDustTint(mask, 6, 7, rect2, cells);
  assert.deepEqual(context.dustTint.image.data, buildDustTint(mask, W, H, 100, 75), 'the worker cells patch the tint');
  assert.equal(context.displayOverlayState.counters.tintRects, 2);
  // Stored dodge strokes: one path each, at the width the raster paints
  // (strokeBrush: relative to the base's short side, with the crop), drawn once.
  state.dodgeBurn.active = true;
  state.localExposure = { strokes: [{ stops: 1, size: 0.1, feather: 0.5, points: [{ x: 0.3, y: 0.4, p: 1 }, { x: 0.5, y: 0.45, p: 1 }] },
    { stops: -1, size: 0.05, feather: 0.5, points: [{ x: 0.6, y: 0.6, p: 1 }] }] };
  calls.length = 0;
  context.syncDisplayOverlay();
  assert.equal(strokes().length, 2, 'one path per stroke');
  const widths = calls.filter(([key, name]) => key === 'set' && name === 'lineWidth').map(([, , value]) => value);
  const working = { ...geometry, width: 100, height: 75 };
  assert.deepEqual(widths, context.state.localExposure.strokes.map(stroke => Math.max(2, strokeBrush(stroke, working).radius * 2)));
  assert.ok(widths[0] > 0.1 * 75, 'the crop makes the brush wider than its share of the cropped frame');
  // A patch with strokes shown is not put on its own: the next sync repaints all.
  calls.length = 0;
  for (let y = 0; y < 5; y++) mask[y * W] = 255;
  state.dustRemoval.maskTag = 8;
  context.patchDustTint(mask, 7, 8, { x: 0, y: 0, width: 1, height: 5 }, null);
  assert.equal(puts().length, 0);
  context.syncDisplayOverlay();
  assert.deepEqual([puts().length, strokes().length], [1, 2], 'the tint and the strokes again');
  calls.length = 0;
  for (let i = 0; i < 5; i++) context.syncDisplayOverlay();
  assert.equal(calls.length, 0, 'nothing is redrawn while the list, the geometry and the size stay');
  state.localExposure = { strokes: state.localExposure.strokes.slice(0, 1) };
  context.syncDisplayOverlay();
  assert.equal(strokes().length, 1, 'a new list is drawn once');
  // Crop mode and the comparison hide it and let its backing go.
  state.cropping = true;
  context.syncDisplayOverlay();
  assert.deepEqual([displayOverlay.width, displayOverlay.style.display], [1, 'none']);
}

// ---- C: live dodge and burn, through the real adapter ----
const W = 90, H = 60;
function negative() {
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const t = (x + y * 0.7) / (W + H);
    data.set([Math.round(52000 - 30000 * t + (x * 131 % 900)), Math.round(36000 - 22000 * t + (y * 97 % 700)), Math.round(24000 - 15000 * t), 65535], i);
  }
  return { width: W, height: H, data };
}
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null };
const committed = sanitizeLocalExposureForSettings({ strokes: [{ stops: 0.7, size: 0.3, feather: 0.5, points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 }] }] });
const settingsFor = (localExposure) => ({ colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, localExposure, localExposureGeometry: geometry });

function liveFixture({ delta = false, cpu = false, border = false } = {}) {
  const worker = { store: null, committed: null, requests: 0 };
  const client = {
    exposureLiveEnd: async () => { worker.ends = (worker.ends || 0) + 1; worker.store = null; worker.committed = null; },
    liveFrameOf: (image) => (image.__liveSeq ? { seq: image.__liveSeq, slot: 'preview' } : null),
    exposureLive: async (request) => {
      await settle();
      worker.requests++;
      const working = adapter.liveExposureGeometry(request.frame.slot, request.frame.seq);
      if (!working) return { stale: true, rect: null };
      if (request.reset) worker.store = createLiveStrokeCoverage(request.stroke, working);
      let rect = addLiveStrokePoints(worker.store, request.points);
      if (request.fullStroke) rect = unionRect(rect, worker.store.bounds);
      if (!rect) return { rect: null };
      const reply = adapter.renderLiveExposureRect(request.frame.slot, { frameSeq: request.frame.seq, committed: request.committed,
        store: worker.store, rect, withCommitted: request.withCommitted });
      return { rect, rgba: reply.rgba, committedRgba: reply.committedRgba };
    }
  };
  const texture = { data: null, uploads: [], puts: [] };
  class TestImageData { constructor(a, b, c) { if (typeof a === 'number') Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }); else Object.assign(this, { data: a, width: b, height: c }); } }
  const adjustment = { curves: { r: [], g: [], b: [] }, wbR: 1.08, wbG: 0.96, wbB: 1.04, vibrance: 35, cyan: 6, magenta: -4, yellow: 3 };
  const photo = border ? { x: 11, y: 7 } : null;
  const state = { currentStep: 3, cropping: false, beforeAfterActive: false, localExposure: committed, previewSourceImageData: null,
    processedImageData: null, webglSourceImageData: null, displayImageData: null, sprocketPreviewEnabled: border };
  const webglState = { sourceDirty: false, sourceSize: { w: W, h: H } };
  const context = vm.createContext({
    state, webglState, glCanvas: { style: { display: cpu ? 'none' : 'block' } }, console, Math, Uint8ClampedArray,
    ImageData: TestImageData, mainCanvasPhoto: photo,
    applyPreparedAdjustmentsToBuffer, buildDisplayAdjustmentSettings: () => adjustment, adjustmentLutScratch: createAdjustmentLutScratch(),
    ctx: { putImageData: (image, x, y) => texture.puts.push({ image, x, y }) },
    convertPreviewFrameInWorker: client, LIVE_DODGE_ENABLED: true, lastLiveFrame: null, liveDodge: null, liveDisplaySerial: 0,
    staleLiveFrames: new Set(), exactDisplays: new WeakMap(), liveComposites: new WeakMap(), convertedPixelsRevision: 0, liveDodgeExactDisplays: true, localExposureGeometryFor: () => geometry, buildRouterSettings: () => structuredClone(settingsFor(state.localExposure)),
    getColorAnalysisSample: () => null, buildHistogramSourceImageData: (image) => ({ histogramOf: image }),
    liveDodgeCounters: { strokes: 0, requests: 0, rects: 0, deltaRects: 0, exactRects: 0, stale: 0, warmups: 0, uploads: 0, puts: 0, maxRectPixels: 0,
      restored: 0, adopted: 0, kept: 0, lastRect: null },
    isWebGLActive: () => !cpu, usesSilverCoreConversion: () => true,
    displaySourceImageData: () => state.previewSourceImageData || state.processedImageData,
    coreReprocessScheduled: null, _coreReprocessPending: null, _coreReprocessPreviewInFlight: false,
    gpuPreviewScheduler: { isAhead: () => false }, displayedFrameToken: 1, coreReprocessToken: 1, coreReprocessGeneration: 1,
    sanitizeStrokePoint, workingPointToBase,
    webglUploadRectRows: (rect, rows) => {
      texture.uploads.push({ ...rect });
      for (let y = 0; y < rect.height; y++) texture.data.set(rows.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * W + rect.x) * 4);
      return true;
    },
    renderWebGL: () => true, updatePreview: () => { texture.restored = true; },
    warmLiveDodge: () => assert.fail('the frame on screen is live'),
  });
  vm.runInContext(['noteLiveFrame', 'liveDodgeDisplay', 'liveDodgeTarget', 'exactDisplayTarget', 'beginLiveDodge', 'addLiveDodgePoints',
    'liveDodgeStillShown', 'retargetLiveDodge', 'flushLiveDodge', 'liveDeltaRows', 'applyLiveDodgeReply', 'writeRectRows', 'noteLiveComposite',
    'adoptLiveComposite', 'liveCompositeOf', 'keepLiveComposite', 'finishLiveDodge', 'releaseLiveDodge', 'endLiveDodge'].map(functionSource).join('\n'), context);
  return { context, state, texture, worker, webglState, delta, adjustment, photo, TestImageData };
}

for (const mode of ['exact', 'delta']) {
  adapter.invalidateSilverCoreCache();
  const f = liveFixture();
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  // On screen: the frame itself ('exact'), or another frame of the same size
  // with the worker's frame noted as the newest ('delta').
  const shown = mode === 'exact' ? frame : { width: W, height: H, data: frame.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 7))) };
  if (mode === 'delta') f.context.noteLiveFrame(frame, 1, 1);
  f.state.previewSourceImageData = shown;
  f.state.processedImageData = shown;
  f.state.webglSourceImageData = shown;
  f.texture.data = new Uint8ClampedArray(shown.data);
  const working = { ...geometry, width: W, height: H };
  const parameters = sanitizeLocalExposureStrokes({ strokes: [{ stops: 1.5, size: 0.2, feather: 0.3, points: [{ x: 0.5, y: 0.5 }] }] }).strokes[0];
  const points = Array.from({ length: 24 }, (_, k) => ({ x: 10 + k * 3, y: 40 - k * 1.2, p: 1 }));
  f.context.beginLiveDodge({ stops: parameters.stops, size: parameters.size, feather: parameters.feather }, working, points[0]);
  assert.equal(f.context.liveDodge.target.mode, mode);
  for (let k = 1; k < points.length; k += 5) {
    f.context.addLiveDodgePoints(points.slice(k, k + 5));
    await settle();
  }
  await drain();
  f.context.endLiveDodge(true);
  await drain();
  assert.ok(f.texture.uploads.length >= 2, 'rectangles, one request at a time');
  assert.ok(f.worker.requests <= 6, 'points gather while a request is in flight');
  // The stroke as the pen-up stores it.
  const stored = { ...parameters, points: points.map(p => ({ ...workingPointToBase(p, working), p: p.p })) };
  const after = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, stored] }))),
    { scratch: true, includeAnalysisPreview: false });
  if (mode === 'exact') {
    assert.deepEqual(f.texture.data, after.data, 'the live texture equals the stored stroke\'s frame');
  } else {
    // displayed + (live - committed), clamped; alpha as displayed.
    const expected = shown.data.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(255, v + after.data[i] - frame.data[i]))));
    assert.deepEqual(f.texture.data, expected, 'the delta frame');
    assert.ok(f.context.liveDodgeCounters.deltaRects > 0);
  }
  // A new frame on screen: late replies are dropped.
  const before = f.texture.uploads.length;
  f.state.previewSourceImageData = { ...shown };
  f.context.liveDodge.base.push(sanitizeStrokePoint({ x: 0.1, y: 0.1, p: 1 }));
  f.context.flushLiveDodge(f.context.liveDodge);
  await drain();
  assert.equal(f.texture.uploads.length, before, 'no rectangle over a newer frame');
}

// A live frame the worker answers stale for (its slot's planes moved on while
// the frame stayed on screen) is never painted over again: the stroke asks for
// a fresh frame instead of re-sending to the same one.
{
  adapter.invalidateSilverCoreCache();
  const f = liveFixture();
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  Object.assign(f.state, { previewSourceImageData: frame, processedImageData: frame, webglSourceImageData: frame });
  f.texture.data = new Uint8ClampedArray(frame.data);
  // Another conversion in the slot moves its planes on: the frame is stale.
  await adapter.convertColorWithSilverCore(negative(), { ...structuredClone(settingsFor(committed)), contrast: 25 }, { preview: true, includeAnalysisPreview: false });
  let warms = 0;
  f.context.warmLiveDodge = () => { warms++; };
  f.context.beginLiveDodge({ stops: 1, size: 0.2, feather: 0.5 }, { ...geometry, width: W, height: H }, { x: 45, y: 30, p: 1 });
  await drain();
  for (let k = 1; k < 6; k++) { f.context.addLiveDodgePoints([{ x: 45 + k * 3, y: 30, p: 1 }]); await drain(); }
  assert.equal(f.worker.requests, 1, 'one request to the stale frame, no loop');
  assert.equal(f.context.liveDodgeCounters.stale, 1);
  assert.ok(f.context.staleLiveFrames.has(frame.__liveFrame));
  assert.ok(warms >= 1, 'a fresh frame is asked for');
  assert.equal(f.texture.uploads.length, 0);
  f.context.endLiveDodge(false);
}

// A cancelled stroke draws the frame on screen again.
{
  adapter.invalidateSilverCoreCache();
  const f = liveFixture();
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  Object.assign(f.state, { previewSourceImageData: frame, processedImageData: frame, webglSourceImageData: frame });
  f.texture.data = new Uint8ClampedArray(frame.data);
  f.context.beginLiveDodge({ stops: 1, size: 0.2, feather: 0.5 }, { ...geometry, width: W, height: H }, { x: 45, y: 30, p: 1 });
  await drain();
  f.context.endLiveDodge(false);
  assert.equal(f.texture.restored, true);
  assert.equal(f.webglState.sourceDirty, true, 'the whole frame is uploaded again');
  assert.equal(f.context.liveDodge, null);
}

// #280: the dodge pointer handlers record the stroke that the live effect
// paints and the pen-up stores. A long pen stroke keeps every sample up to
// 400, then one per eighth of the brush radius, and its live texture is the
// frame of the stored stroke; a long mouse stroke is resampled to 400 points
// as before; a pen stroke of up to 400 samples is stored as recorded.
for (const { pointerType, count } of [{ pointerType: 'pen', count: 900 }, { pointerType: 'mouse', count: 700 }, { pointerType: 'pen', count: 250 }]) {
  adapter.invalidateSilverCoreCache();
  const f = liveFixture();
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  Object.assign(f.state, { previewSourceImageData: frame, processedImageData: frame, webglSourceImageData: frame,
    dodgeBurn: { active: true, mode: 'burn', stops: 0.6, size: 50, feather: 40 } });
  f.texture.data = new Uint8ClampedArray(frame.data);
  const working = { ...geometry, width: W, height: H };
  const rect = { left: 0, top: 0, width: W, height: H };
  const surface = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  let recorder = null;
  Object.assign(f.context, {
    window: { devicePixelRatio: 1 }, dodgeBurnDrawing: false, dustDrawing: false, dodgeBurnRecorder: null, dodgeBurnPointerId: null,
    dodgeBurnSurface: null, dodgeBurnRect: null, dodgeBurnLastSample: null, dodgeBurnBrush: null,
    canPaintDodgeBurn: () => true, brushSurfaceRect: () => rect, dodgeBurnGeometry: () => working, captureBrushPointer() {},
    brushFeedback: { begin() {}, add() {}, end() {} }, BRUSH_FEEDBACK_STYLES, strokeBrush, sanitizeLocalExposureStrokes,
    sanitizeLocalExposureForSettings, resampleStrokePoints, DENSE_STROKE_POINTS, MAX_STROKE_POINTS, pointerSamples, movedEnough,
    createStrokeRecorder: (options) => (recorder = createStrokeRecorder(options)),
    pushUndo() {}, markCurrentFileDirty() {}, updateDodgeBurnUI() {}, scheduleCoreReprocess() {}, syncDisplayOverlay() {},
  });
  vm.runInContext(['clientToImageCoords', 'pointerToWorkingPoint', 'dodgeBurnBrushValues', 'dodgeBurnStrokeParameters',
    'onDodgeBurnPointerDown', 'onDodgeBurnPointerMove', 'releaseDodgeBurnPointer', 'onDodgeBurnPointerUp'].map(functionSource).join('\n'), f.context);
  // Loops inside the frame, a pixel or so per sample, with fast pen pressure.
  const samples = Array.from({ length: count }, (_, k) => ({ clientX: 45 + 35 * Math.sin(k / 25), clientY: 30 + 22 * Math.sin(k / 18 + 0.5),
    pointerType, pressure: 0.3 + 0.7 * Math.abs(Math.sin(k / 15)) }));
  const event = (sample, extra = {}) => ({ ...sample, pointerId: 7, button: 0, currentTarget: surface, preventDefault() {}, stopPropagation() {}, ...extra });
  f.context.onDodgeBurnPointerDown(event(samples[0]));
  for (let k = 1; k < count; k += 4) {
    const batch = samples.slice(k, k + 4);
    f.context.onDodgeBurnPointerMove(event(batch.at(-1), { getCoalescedEvents: () => batch }));
    await settle();
  }
  const recorded = recorder.points.slice();
  f.context.onDodgeBurnPointerUp(event(samples.at(-1)));
  await drain();
  assert.equal(f.state.localExposure.strokes.length, committed.strokes.length + 1);
  const stored = f.state.localExposure.strokes.at(-1);
  const toBase = (point) => ({ ...workingPointToBase(point, working), p: point.p });
  const label = `${pointerType} ${count}`;
  if (pointerType === 'mouse') {
    assert.ok(recorded.length > DENSE_STROKE_POINTS, `${label}: ${recorded.length} samples recorded`);
    assert.deepEqual(stored.points, resampleStrokePoints(recorded).map(point => sanitizeStrokePoint(toBase(point))), `${label}: resampled to 400 as before`);
  } else {
    // The stored stroke is the recorder's points, the last sample included.
    assert.deepEqual(stored.points, recorder.points.map(point => sanitizeStrokePoint(toBase(point))), `${label}: stored as painted`);
    if (count < DENSE_STROKE_POINTS) {
      assert.equal(recorder.points.length, recorded.length, `${label}: every sample kept`);
    } else {
      assert.ok(stored.points.length > DENSE_STROKE_POINTS && stored.points.length <= MAX_STROKE_POINTS, `${label}: ${stored.points.length} points stored`);
      assert.deepEqual(recorder.points.slice(0, DENSE_STROKE_POINTS), recorded.slice(0, DENSE_STROKE_POINTS));
    }
    assert.ok(new Set(stored.points.map(point => point.p)).size > 10, `${label}: the stroke carries pen pressure`);
    const after = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(f.state.localExposure)), { scratch: true, includeAnalysisPreview: false });
    assert.deepEqual(f.texture.data, after.data, `${label}: the live texture is the stored stroke's frame`);
  }
  assert.equal(f.worker.ends, 1, `${label}: the stroke's live session is released once`);
}

console.log('brushWiring: border-aware mapping on both canvases (+-1 px of the old one), worker-pooled tint with dirty-rect patches and strokes drawn once on the display overlay, live dodge texture == stored stroke (exact) and displayed + (live - committed) (delta), a long pen stroke stored as painted through the pointer handlers');

// The CPU display puts only Step-3-adjusted live rows at the photo's offset,
// including a sprocket border. The whole-frame settled pass is the reference.
for (const border of [false, true]) {
  adapter.invalidateSilverCoreCache();
  const f = liveFixture({ cpu: true, border });
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  Object.assign(f.state, { previewSourceImageData: frame, processedImageData: frame, displayImageData: frame });
  const parameters = { stops: 1.5, size: 0.2, feather: 0.3 };
  const working = { ...geometry, width: W, height: H };
  const points = [{ x: 45, y: 30, p: 1 }, { x: 47, y: 31, p: 1 }];
  f.context.beginLiveDodge(parameters, working, points[0]);
  await drain();
  f.context.addLiveDodgePoints(points.slice(1));
  await drain();
  const rect = f.context.liveDodgeCounters.lastRect;
  f.context.endLiveDodge(true);
  await drain();
  const stored = { ...parameters, points: points.map(point => ({ ...workingPointToBase(point, working), p: 1 })) };
  const after = await adapter.convertColorWithSilverCore(negative(), settingsFor(sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, stored] })),
    { scratch: true, includeAnalysisPreview: false });
  const adjusted = new f.TestImageData(W, H);
  applyPreparedAdjustmentsToBuffer(after, f.adjustment, adjusted, { quality: 'full' });
  const put = f.texture.puts.at(-1);
  const expected = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) expected.set(adjusted.data.subarray(((rect.y + y) * W + rect.x) * 4,
    ((rect.y + y) * W + rect.x + rect.width) * 4), y * rect.width * 4);
  assert.deepEqual(put.image.data, expected, 'CPU live rows equal settled rows after Step 3');
  assert.deepEqual([put.x, put.y], [rect.x + (f.photo?.x || 0), rect.y + (f.photo?.y || 0)]);
  const diameter = parameters.size * Math.min(W, H);
  assert.ok(put.image.width * put.image.height <= (2 * diameter) ** 2, 'put stays within twice the brush diameter');
  assert.equal(f.worker.ends, 1, 'final flush releases the worker exactly once');
}

// A layout resize refits first at fit zoom, then remaps each active brush to
// the actual new photo rectangle; later points remain under the pointer.
{
  const container = {};
  let rect = { left: 100, top: 50, width: 500, height: 400 };
  const state = { processedImageData: { width: 4000, height: 3000 }, zoomLevel: 1 };
  const context = vm.createContext({ state, canvasContainer: container, histogramContainer: {}, curveCanvas: {},
    brushFeedback: { drawing: true, remap: () => {} }, dustDrawing: true, dodgeBurnDrawing: true, aiBrushDrawing: {},
    brushSurfaceRect: () => rect, dustBrushRect: rect, dodgeBurnRect: rect,
    refreshCanvasContainerSize() {}, refitCanvasToContainer: () => { rect = { left: 150, top: 75, width: 800, height: 600 }; },
    syncBrushTools: () => context.remapBrushStroke(), Math });
  vm.runInContext(['remapBrushStroke', 'clientToImageCoords', 'onLayoutResize'].map(functionSource).join('\n'), context);
  context.onLayoutResize([{ target: container }]);
  assert.equal(context.dodgeBurnRect, rect);
  assert.equal(context.dustBrushRect, rect);
  assert.equal(context.aiBrushDrawing.rect, rect);
  assert.deepEqual({ ...context.clientToImageCoords(550, 375, context.dodgeBurnRect) }, { x: 2000, y: 1500 });
}

// The standard and old WebKit DPR features are watched together, and the
// change handler refits before remapping the brush on the new display.
{
  let query, change;
  const order = [];
  const context = vm.createContext({ window: { devicePixelRatio: 2, matchMedia: value => {
    query = value; return { addEventListener: (type, callback) => { change = callback; }, removeEventListener() {} }; } },
    invalidateCanvasDisplayFit: () => order.push('invalidate'), refitCanvasToContainer: () => order.push('refit'),
    syncBrushTools: () => order.push('remap') });
  vm.runInContext(functionSource('watchDevicePixelRatio'), context);
  context.watchDevicePixelRatio();
  assert.equal(query, '(resolution: 2dppx), (-webkit-device-pixel-ratio: 2)');
  context.window.devicePixelRatio = 1;
  change();
  assert.equal(query, '(resolution: 1dppx), (-webkit-device-pixel-ratio: 1)');
  assert.deepEqual(order, ['invalidate', 'refit', 'remap']);
}

// A final reply for stroke A may arrive after B starts. A cannot send more
// points or reset B's worker store; its release is sent once with A's ID.
{
  const old = { id: 11, ended: 'commit', base: [{ x: 0.4, y: 0.3 }], sent: 0 };
  const next = { id: 12 };
  const released = [];
  let requests = 0;
  const context = vm.createContext({ liveDodge: next, console,
    convertPreviewFrameInWorker: { exposureLiveEnd: async id => released.push(id), exposureLive: () => { requests++; } } });
  vm.runInContext(['releaseLiveDodge', 'adoptLiveComposite', 'finishLiveDodge', 'flushLiveDodge'].map(functionSource).join('\n'), context);
  context.flushLiveDodge(old);
  context.flushLiveDodge(old);
  await settle();
  assert.equal(requests, 0, 'the previous stroke cannot reset or append to the next store');
  assert.deepEqual(released, [11]);
  assert.equal(context.liveDodge, next);
}

// #279 follow-up: the dust brush stores the pixel under the pointer (rounded,
// as it always has), and DustBrush stamps the committed disc around that
// pixel, centred on its centre. The live dab on #brushFeedback is drawn at
// that centre, not at the pixel's corner half a pixel up and left; the stored
// points are unchanged.
{
  const { rasterizeBrushStroke } = await import('../silvercore/engine/DustBrush.js');
  const W = 1500, H = 1000;
  const rect = { left: 210.25, top: 96.5, width: 871, height: 580.6666 };
  const feedback = { begun: null, points: [] };
  const state = { processedImageData: { width: W, height: H },
    dustRemoval: { enabled: true, showMask: true, mask: new Uint8Array(1), brushSize: 8, processing: false },
    processedImageDataIsPreview: false, fullResolutionPending: false, samplingMode: null, cropping: false };
  const surface = { setPointerCapture() {} };
  const context = vm.createContext({ state, Math, window: { devicePixelRatio: 1 }, dustDrawing: false, dustBrushPoints: [], dustBrushSource: null,
    dustBrushToken: null, dustBrushPointerId: null, dustBrushSurface: null, dustBrushRect: null, dustBrushLastSample: null, dustBrushMode: null,
    coreReprocessToken: 4, canPaintAiBrush: () => false, canPaintDodgeBurn: () => false, currentPhotoExact: () => true, getDustSource: () => ({}),
    captureBrushPointer() {}, brushSurfaceRect: () => rect, BRUSH_FEEDBACK_STYLES, movedEnough, pointerSamples,
    brushFeedback: { begin: (options) => { feedback.begun = options; }, add: (points) => feedback.points.push(...points) } });
  vm.runInContext(['clientToImageCoords', 'dustDiscCentre', 'onDustBrushStart', 'addDustBrushSamples', 'onDustBrushMove'].map(functionSource).join('\n'), context);
  const event = (clientX, clientY, extra = {}) => ({ clientX, clientY, pointerId: 3, pointerType: 'mouse', button: 0, altKey: true, currentTarget: surface,
    preventDefault() {}, stopImmediatePropagation() {}, ...extra });
  context.onDustBrushStart(event(600.3, 402.9));
  for (const [x, y] of [[604.1, 405.2], [611.8, 409.7]]) context.onDustBrushMove(event(x, y));
  const stored = Array.from(context.dustBrushPoints, point => ({ ...point }));
  assert.equal(context.dustBrushMode, 'direct');
  assert.deepEqual(stored, [[600.3, 402.9], [604.1, 405.2], [611.8, 409.7]].map(([x, y]) => ({
    x: Math.round((x - rect.left) * W / rect.width), y: Math.round((y - rect.top) * H / rect.height) })), 'the stored points: rounded pixels, as before');
  assert.deepEqual(Array.from(feedback.points, point => ({ ...point })), stored.map(point => ({ x: point.x + 0.5, y: point.y + 0.5 })),
    'the live dab at each pixel\'s centre');
  assert.equal(feedback.begun.radius, 8);
  // The committed disc of a point is centred exactly there.
  for (const [index, point] of stored.entries()) {
    const raster = rasterizeBrushStroke([point], 8, W, H);
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < raster.rect.height; y++) for (let x = 0; x < raster.rect.width; x++) {
      if (!raster.brush[y * raster.rect.width + x]) continue;
      sx += raster.rect.x + x + 0.5; sy += raster.rect.y + y + 0.5; n++;
    }
    assert.deepEqual({ x: sx / n, y: sy / n }, { ...feedback.points[index] }, `disc ${index}: centred on the live dab`);
  }
}

console.log('brushWiring: the live dust dab is drawn at the centre of the disc DustBrush commits for the stored pixel');

// #254 follow-up, the cause: a stroke painted over another frame than the
// preview worker's ('delta') ended with its pen-up frame, the worker's frame
// of the stored stroke, put on screen in place of the frame there, which
// changed every pixel where the two frames differ, inside the stroke or not.
// Now what the rectangles left on screen becomes the display at the pen-up
// (adoptLiveComposite) and the pen-up frame leaves it (applyPreviewFrame): no
// pixel outside the rectangles changes, and the texture is not uploaded again.
for (const cpu of [false, true]) {
  const { displayFilterOf, displayResampleMode } = await import('./displayPreview.js');
  adapter.invalidateSilverCoreCache();
  const f = liveFixture({ cpu });
  const landing = { applyProcessed: 0 };
  Object.assign(f.context, {
    releaseCorePreviewRetained() {}, cancelDisplayPreviewRebuild() {}, buildPreviewSourceImageData: (image) => image,
    initWebGLRenderer: () => true, fitStep3CanvasBox() {}, histogramSourceFor: () => 'histogram', exactFrames: new WeakMap(),
    displayFilterOf, displayResampleMode, applyProcessedImageToState: () => { landing.applyProcessed++; },
  });
  vm.runInContext(['applyPreviewFrame', 'applyPreviewProcessedImageToState', 'installDisplayPreview', 'noteExactDisplay', 'exactDisplayFilterK']
    .map(functionSource).join('\n'), f.context);
  const frame = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(committed)), { preview: true, includeAnalysisPreview: false });
  frame.__liveSeq = frame.__liveFrame;
  // On screen: another frame of the same size and settings (as a full
  // render's display is), the worker's frame noted as the newest.
  const shown = { width: W, height: H, data: frame.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 7))) };
  f.context.noteLiveFrame(frame, 1, 1);
  Object.assign(f.state, { previewSourceImageData: shown, webglSourceImageData: shown, processedImageData: { width: W * 2, height: H * 2 },
    processedImageDataIsPreview: false });
  f.texture.data = new Uint8ClampedArray(shown.data);
  // A CPU display: the adjusted frame on screen, which the live rows are put over.
  const adjustedBefore = new f.TestImageData(W, H);
  applyPreparedAdjustmentsToBuffer(shown, f.adjustment, adjustedBefore, { quality: 'full' });
  if (cpu) f.state.displayImageData = adjustedBefore;
  const working = { ...geometry, width: W, height: H };
  const parameters = sanitizeLocalExposureStrokes({ strokes: [{ stops: 1.5, size: 0.2, feather: 0.3, points: [{ x: 0.5, y: 0.5 }] }] }).strokes[0];
  const points = Array.from({ length: 24 }, (_, k) => ({ x: 10 + k * 3, y: 40 - k * 1.2, p: 1 }));
  f.context.beginLiveDodge({ stops: parameters.stops, size: parameters.size, feather: parameters.feather }, working, points[0]);
  assert.equal(f.context.liveDodge.target.mode, 'delta');
  for (let k = 1; k < points.length; k += 5) { f.context.addLiveDodgePoints(points.slice(k, k + 5)); await settle(); }
  await drain();
  // The pen-up as onDodgeBurnPointerUp ends it: the last points, then its token.
  f.context.endLiveDodge(true);
  f.context.coreReprocessToken = 2;
  const session = f.context.liveDodge;
  Object.assign(session, { commitToken: 2, storedPoints: points.length });
  f.context.adoptLiveComposite(session);
  await drain();
  const composite = f.state.previewSourceImageData;
  assert.notEqual(composite, shown, 'the composite is the display from the pen-up on');
  // What the screen shows: the texture, or the adjusted frame with the rows put over it.
  const canvas = new Uint8ClampedArray(adjustedBefore.data);
  for (const put of f.texture.puts) {
    for (let y = 0; y < put.image.height; y++) canvas.set(put.image.data.subarray(y * put.image.width * 4, (y + 1) * put.image.width * 4), ((put.y + y) * W + put.x) * 4);
  }
  if (!cpu) assert.deepEqual(composite.data, f.texture.data, 'it is what the texture shows');
  else {
    assert.ok(f.texture.puts.length > 0);
    assert.deepEqual(f.state.displayImageData.data, canvas, 'the CPU display keeps the adjusted frame it shows');
  }
  assert.equal(f.webglState.sourceDirty, false, 'the texture is not uploaded again');
  assert.equal(f.context.liveComposites.get(composite).token, 2);
  assert.equal(f.context.exactDisplays.has(composite), false, 'delta rectangles are no exact display');
  // The pen-up frame lands: the worker's frame of the stored stroke.
  const stored = { ...parameters, points: points.map(p => ({ ...workingPointToBase(p, working), p: p.p })) };
  const penUp = await adapter.convertColorWithSilverCore(negative(), structuredClone(settingsFor(sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, stored] }))),
    { preview: true, includeAnalysisPreview: false });
  assert.equal(f.context.applyPreviewFrame(penUp, { token: 2 }), true);
  assert.equal(f.state.previewSourceImageData, composite, 'the pen-up frame leaves the composite on screen');
  assert.equal(f.state.webglSourceImageData, composite);
  assert.equal(f.webglState.sourceDirty, false);
  if (cpu) assert.deepEqual(f.state.displayImageData.data, canvas, 'and the adjusted frame on the CPU display');
  assert.equal(f.state.fullResolutionPending, true, 'the exact frame is still owed');
  const box = f.context.liveDodgeCounters.box;
  let outside = 0, changedByWorkerFrame = 0, changedNow = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
    const i = (y * W + x) * 4;
    outside++;
    if ([0, 1, 2].some(c => penUp.data[i + c] !== shown.data[i + c])) changedByWorkerFrame++;
    if ([0, 1, 2].some(c => composite.data[i + c] !== shown.data[i + c])) changedNow++;
  }
  assert.ok(outside > 0 && changedByWorkerFrame > outside * 0.9, `the worker's frame would change ${changedByWorkerFrame} of ${outside} pixels outside the stroke`);
  assert.equal(changedNow, 0, 'nothing outside the stroke changes at its pen-up');
  // A frame of other settings (superseded token) is put on screen as before.
  assert.equal(f.context.applyPreviewFrame(frame, { token: null }), false);
  assert.equal(f.state.previewSourceImageData, frame);
  assert.equal(f.webglState.sourceDirty, true);
  assert.equal(landing.applyProcessed, 0);
  console.log(`brushWiring (${cpu ? 'CPU' : 'GPU'} display): a delta stroke's pen-up keeps what its rectangles left on screen (the worker's frame would have changed ${changedByWorkerFrame} of ${outside} pixels outside the stroke; now 0), no texture upload`);
}

// #254 follow-up, exact rectangles: over the display preview of a
// full-resolution frame, a stroke is painted with that display's own pixels
// (exposureExact in the real worker handler, in this process), and its pen-up
// leaves a composite that is the exact display of the stored stroke in both
// planes, registered as such for the next stroke.
{
  globalThis.ImageData = class {
    constructor(a, b, c) {
      if (typeof a === 'number') Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) });
      else Object.assign(this, { data: a, width: b, height: c });
    }
  };
  const replies = new Map();
  globalThis.self = { postMessage: (payload, transfers = []) => { replies.set(payload.id, structuredClone(payload, { transfer: transfers })); } };
  await import('../workers/conversionWorker.js');
  let nextId = 0;
  const send = async (message) => {
    const id = ++nextId;
    await self.onmessage({ data: structuredClone({ ...message, id }) });
    const reply = replies.get(id);
    replies.delete(id);
    if (reply.type === 'error') throw new Error(reply.message);
    return reply;
  };
  const FW = 150, FH = 100, target = { width: 97, height: 64 };
  const source = new Uint16Array(FW * FH * 4);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const i = (y * FW + x) * 4, t = (x + y * 0.7) / (FW + FH), edge = x % 31 < 2 ? 0.4 : 1;
    source.set([Math.round((52000 - 30000 * t) * edge + (x * 131 % 900)), Math.round((36000 - 22000 * t) * edge + (y * 97 % 700)), Math.round((24000 - 15000 * t) * edge), 65535], i);
  }
  const full = { baseWidth: FW, baseHeight: FH, rotatedWidth: FW, rotatedHeight: FH, rotationAngle: 0, mirrored: false, cropRegion: null };
  const fullSettings = (localExposure) => ({ colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, localExposure, localExposureGeometry: full });
  const render = async (localExposure) => {
    const reply = await send({ type: 'convert', width: FW, height: FH, image16: source.slice().buffer, settings: fullSettings(localExposure),
      options: { forceFullProcess: true, includeAnalysisPreview: false, returnAnalysis: true, displayTarget: target } });
    const display = new ImageData(new Uint8ClampedArray(reply.displayPreview.rgba), target.width, target.height);
    display.__image16 = { width: target.width, height: target.height, data: new Uint16Array(reply.displayPreview.image16) };
    return { display, analysis: reply.analysis };
  };
  const before = await render(committed);
  // The preview worker caches the source as its level (k = 1).
  await send({ type: 'convert', cacheInput: true, reuseSource: false, reuseAnalysis: false, width: FW, height: FH, image16: source.slice().buffer,
    display: { target, geometry: { sourceWidth: FW, sourceHeight: FH, k: 1 } }, settings: fullSettings(committed), options: { preview: true, includeAnalysisPreview: false } });
  const sourceImage = { width: FW, height: FH };
  const texture = { data: new Uint8ClampedArray(before.display.data), uploads: 0 };
  const state = { currentStep: 3, cropping: false, beforeAfterActive: false, localExposure: committed, sprocketPreviewEnabled: false,
    previewSourceImageData: before.display, webglSourceImageData: before.display, processedImageData: { width: FW, height: FH },
    displayImageData: null, conversionSourceImageData: sourceImage, displayLevelImageData: sourceImage };
  const webglState = { sourceDirty: false, sourceSize: { w: target.width, h: target.height } };
  const exactDisplays = new WeakMap();
  exactDisplays.set(before.display, { token: 1, generation: 1, analysis: before.analysis, k: 1, revision: 0 });
  const requests = [];
  const client = {
    holds: (image) => image === sourceImage,
    liveFrameOf: () => null,
    exposureLive: async () => assert.fail('no delta requests over an exact display'),
    exposureLiveEnd: async (strokeId) => send({ type: 'exposureLive', end: true, strokeId }),
    exposureExact: async (request) => {
      requests.push(request);
      const reply = await send({ type: 'exposureExact', strokeId: request.strokeId, stroke: request.stroke, points: request.points,
        reset: request.reset, fullStroke: request.fullStroke, ...(request.reset ? { exact: request.exact } : {}) });
      if (!reply.rect) return { rect: null, stale: Boolean(reply.stale), needsReset: Boolean(reply.needsReset) };
      return { rect: reply.rect, rgba: new Uint8ClampedArray(reply.rgba), image16: new Uint16Array(reply.image16) };
    }
  };
  const context = vm.createContext({
    state, webglState, glCanvas: { style: { display: 'block' } }, console, Math, Uint8ClampedArray, Uint16Array, ImageData: globalThis.ImageData,
    convertPreviewFrameInWorker: client, LIVE_DODGE_ENABLED: true, lastLiveFrame: null, liveDodge: null, liveDisplaySerial: 0,
    staleLiveFrames: new Set(), exactDisplays, liveComposites: new WeakMap(), convertedPixelsRevision: 0, liveDodgeExactDisplays: true,
    localExposureGeometryFor: () => full, buildRouterSettings: () => structuredClone(fullSettings(state.localExposure)),
    getColorAnalysisSample: () => null, buildHistogramSourceImageData: (image) => ({ histogramOf: image }),
    liveDodgeCounters: { strokes: 0, requests: 0, rects: 0, deltaRects: 0, exactRects: 0, stale: 0, warmups: 0, uploads: 0, puts: 0, maxRectPixels: 0,
      restored: 0, adopted: 0, kept: 0, lastRect: null, box: null },
    isWebGLActive: () => true, usesSilverCoreConversion: () => true, displaySourceImageData: () => state.previewSourceImageData || state.processedImageData,
    coreReprocessScheduled: null, _coreReprocessPending: null, _coreReprocessPreviewInFlight: {}, gpuPreviewScheduler: { isAhead: () => false },
    displayedFrameToken: 1, coreReprocessToken: 1, coreReprocessGeneration: 1, sanitizeStrokePoint, workingPointToBase,
    webglUploadRectRows: (rect, rows) => {
      texture.uploads++;
      for (let y = 0; y < rect.height; y++) texture.data.set(rows.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * target.width + rect.x) * 4);
      return true;
    },
    renderWebGL: () => true, updatePreview: () => assert.fail('nothing is redrawn'), warmLiveDodge: () => assert.fail('an exact display needs no warm frame'),
  });
  vm.runInContext(['noteLiveFrame', 'liveDodgeDisplay', 'liveDodgeTarget', 'exactDisplayTarget', 'beginLiveDodge', 'addLiveDodgePoints',
    'liveDodgeStillShown', 'retargetLiveDodge', 'flushLiveDodge', 'liveDeltaRows', 'applyLiveDodgeReply', 'writeRectRows', 'noteLiveComposite',
    'adoptLiveComposite', 'liveCompositeOf', 'keepLiveComposite', 'finishLiveDodge', 'releaseLiveDodge', 'endLiveDodge'].map(functionSource).join('\n'), context);
  const working = { ...full, width: FW, height: FH };
  const parameters = { stops: 1.2, size: 0.25, feather: 0.5 };
  const points = Array.from({ length: 30 }, (_, k) => ({ x: 20 + k * 3.6, y: 70 - k * 1.5, p: 0.4 + (k % 6) * 0.1 }));
  // A conversion still in flight does not hold an exact stroke back.
  context.beginLiveDodge(parameters, working, points[0]);
  assert.equal(context.liveDodge.target.mode, 'display');
  assert.deepEqual({ ...context.liveDodge.target.exact.display }, { width: target.width, height: target.height, k: 1 });
  for (let k = 1; k < points.length; k += 4) { context.addLiveDodgePoints(points.slice(k, k + 4)); await settle(); }
  // The pen-up sends the rest at once, behind any request in flight.
  context.addLiveDodgePoints(points.slice(-1));
  context.endLiveDodge(true);
  const stored = sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, { ...parameters, points: points.concat(points.slice(-1))
    .map(p => ({ ...workingPointToBase(p, working), p: p.p })) }] });
  state.localExposure = stored;
  context.coreReprocessToken = 2;
  const session = context.liveDodge;
  Object.assign(session, { commitToken: 2, storedPoints: stored.strokes.at(-1).points.length });
  context.adoptLiveComposite(session);
  for (let i = 0; i < 40 && !session.released; i++) await settle();
  assert.ok(session.released, 'the stroke is released once its last rectangle is on screen');
  assert.ok(requests.length >= 2 && requests[0].reset && !requests.slice(1).some(r => r.reset));
  const after = await render(stored);
  assert.deepEqual(texture.data, after.display.data, 'the painted texture is the exact display of the stored stroke');
  const composite = state.previewSourceImageData;
  assert.notEqual(composite, before.display);
  assert.deepEqual(composite.data, after.display.data, 'the composite is that display (8-bit)');
  assert.deepEqual(composite.__image16.data, after.display.__image16.data, '... and its 16-bit plane');
  assert.equal(context.exactDisplays.get(composite)?.token, 2, 'registered as the exact display of the pen-up settings');
  assert.equal(webglState.sourceDirty, false);
  assert.ok(context.liveDodgeCounters.exactRects > 0 && context.liveDodgeCounters.deltaRects === 0);
  // The next stroke paints exactly over it, with the stored strokes.
  context.beginLiveDodge(parameters, working, { x: 60, y: 30, p: 1 });
  assert.equal(context.liveDodge.target.mode, 'display');
  assert.equal(context.liveDodge.target.exact.settings.localExposure.strokes.length, 2);
  context.endLiveDodge(false);
  console.log('brushWiring: over a full-resolution display, exact rectangles from the real worker handler paint the exact display of the stored stroke (both planes); its pen-up composite is registered for the next stroke');
}
