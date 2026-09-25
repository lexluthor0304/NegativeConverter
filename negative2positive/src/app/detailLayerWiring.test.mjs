import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { planDetailRegion, detailRegionServes, detailSlotSize, snapPanToDevicePixels, copyRegionRows, DETAIL_SETTLE_MS } from './detailLayer.js';
import { displayTargetFor, displayLevelGeometry } from './displayPreview.js';
import { computeZoomGeometry } from './zoomGeometry.js';

// #248 part 5 in main.js (extracted with vm): when the detail layer asks for a
// region, from what, how it is placed, and that a stale region is never drawn.
globalThis.ImageData = class {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') Object.assign(this, { width: dataOrWidth, height: width, data: new Uint8ClampedArray(dataOrWidth * width * 4) });
    else Object.assign(this, { data: dataOrWidth, width, height });
  }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);

const W = 2400, H = 1600;
function fixture({ dpr = 2, container = { width: 600, height: 420 } } = {}) {
  let nextId = 1;
  const timers = new Map();
  const conversionSource = { width: W, height: H, __image16: { width: W, height: H, data: new Uint16Array(W * H * 4) } };
  for (let i = 0; i < conversionSource.__image16.data.length; i += 97) conversionSource.__image16.data[i] = i & 0xffff;
  const base = { width: 1160, height: 773 };
  const state = {
    conversionSourceImageData: conversionSource, displayLevelImageData: conversionSource,
    conversionPreviewImageData: displayTargetFor(conversionSource, base),
    processedImageData: { width: base.width, height: base.height }, processedImageDataIsPreview: true, fullResolutionPending: true,
    webglSourceImageData: { width: base.width, height: base.height },
    zoomLevel: 1, panX: 0, panY: 0, currentStep: 3, cropping: false, beforeAfterActive: false, samplingMode: null,
    geometryPending: false, sprocketPreviewEnabled: false, filmType: 'color', curves: { r: [], g: [], b: [] },
    dustRemoval: { enabled: false, revision: 3 }, repairStrokes: []
  };
  const roiCalls = [];
  const resamples = [];
  const draws = [];
  const uploads = [];
  const style = {};
  const glDetailCanvas = { width: 0, height: 0, style };
  const wrapper = { style: {} };
  const renderer = {
    gl: { getParameter: () => 8192, MAX_TEXTURE_SIZE: 1 },
    uploadExact: (image) => { uploads.push(image); return true; },
    uploadCurves: () => {},
    drawStep3: (values, width, height) => draws.push({ width, height })
  };
  const fit = Math.min((container.width - 20) / W, (container.height - 20) / H);
  const context = vm.createContext({
    state, window: { devicePixelRatio: dpr, location: { search: '' } }, console, performance,
    // The typed arrays of this realm, which the fixture's planes are made in.
    Uint16Array, Uint8ClampedArray, ImageData,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    glDetailCanvas, canvasTransformWrapper: wrapper,
    DETAIL_LAYER_ENABLED: true, DETAIL_SETTLE_MS, WORKER_ABORTED: 'WORKER_ABORTED',
    detailLayer: { renderer, failed: false, timer: null, request: null, shown: null, visible: false, warmed: 'warm',
      counters: { requests: 0, conversions: 0, crops: 0, shown: 0, dropped: 0, failures: 0, lastReadyMs: null } },
    planDetailRegion, detailRegionServes, detailSlotSize, snapPanToDevicePixels, copyRegionRows, displayLevelGeometry,
    webglState: { webgl2: true, sourceSize: { w: base.width, h: base.height } },
    canvasDisplayFit: { scale: fit }, previewTier: 'normal',
    isWebGLActive: () => true, canPaintAiBrush: () => false, usesSilverCoreConversion: () => true,
    hasSeparateConversionPreview: () => true, hasFrameRepairs: () => state.dustRemoval.enabled,
    getCanvasContainerSize: () => container,
    getZoomGeometry: () => computeZoomGeometry({ wrapperW: W * fit, wrapperH: H * fit, containerW: container.width, containerH: container.height, zoom: state.zoomLevel }),
    interimGeometryCss: () => '', webglStep3Values: () => ({ wb: [1, 1, 1], vib: 0, cmy: [0, 0, 0] }),
    gpuPreview: { lastDraw: 'step3' }, gpuPreviewScheduler: { isAhead: () => false },
    coreReprocessGeneration: 1, coreReprocessToken: 10, coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessBusy: () => false, processNegativeInFlight: null, corePreviewCommit: null, displayPreviewRebuild: null,
    runWhenIdle: () => {}, buildRouterSettings: () => ({ filmType: 'color' }), detailRenderer: () => renderer,
    // No repair pass owes anything unless a test says so.
    repairsNeedSettling: () => false, dustMaskIsStale: () => false, dustDetectionTimer: null, pendingBrushRepairs: 0,
    previewRequestImage: image => ({ imageData: image.__displayOf, display: { target: { width: image.width, height: image.height }, geometry: displayLevelGeometry(image.__displayOf) } }),
    convertPreviewFrameInWorker: {
      roi: (request) => new Promise((resolve, reject) => roiCalls.push({ request, resolve, reject })),
      resample: async (image, target) => { resamples.push({ image, target }); return new ImageData(target.width, target.height); },
    },
  });
  vm.runInContext([
    'detailLayerAllowed', 'detailView', 'detailFullFrame', 'detailTag', 'detailTagCurrent', 'hideDetailLayer', 'dropDetailLayer',
    'positionDetailCanvas', 'drawDetailLayer', 'syncDetailLayer', 'noteDetailViewChanged', 'scheduleDetailRequest',
    'scheduleDetailWarmUp', 'requestDetailRegion', 'detailFromFrame', 'detailFromSource', 'showDetailRegion',
  ].map(functionSource).join('\n'), context);
  const runTimers = async () => {
    for (let round = 0; round < 4; round++) {
      for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
      await settle();
    }
  };
  // zoom100: one source pixel per device pixel, centred.
  const zoomTo = (zoom) => {
    const geometry = context.getZoomGeometry();
    const cx = container.width / 2, cy = container.height / 2;
    const contentX = (cx - geometry.baseX - state.panX) / state.zoomLevel;
    const contentY = (cy - geometry.baseY - state.panY) / state.zoomLevel;
    state.zoomLevel = zoom;
    const next = context.getZoomGeometry();
    state.panX = cx - next.baseX - contentX * zoom;
    state.panY = cy - next.baseY - contentY * zoom;
  };
  return { context, state, roiCalls, resamples, draws, uploads, glDetailCanvas, wrapper, timers, runTimers, zoomTo, fit, conversionSource, base, container };
}

// At fit the base is sharp enough: no region, nothing asked.
{
  const f = fixture();
  f.context.syncDetailLayer(true);
  await f.runTimers();
  assert.equal(f.roiCalls.length, 0);
  assert.equal(f.context.detailLayer.visible, false);
}

// True 100 %: one region of native rows, placed at its pre-transform rect,
// backing store = its pixels, the pan snapped to whole device pixels.
{
  const f = fixture();
  const zoom100 = 1 / (f.fit * 2);
  f.zoomTo(zoom100);
  f.context.noteDetailViewChanged();
  assert.equal(f.roiCalls.length, 0, 'the region waits for the view to settle');
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1);
  const { request } = f.roiCalls[0];
  const plan = planDetailRegion(f.context.detailView());
  assert.equal(request.region.fromLevel, false);
  assert.equal(request.region.outWidth, request.region.width, 'native density');
  assert.equal(request.rows.length, request.region.width * request.region.height * 4, 'native 16-bit rows of the region');
  assert.equal(request.base.levelWidth, W);
  assert.equal(request.base.display.target.width, f.base.width, 'with the base display target, whose analysis it shares');
  assert.ok(request.region.slotWidth >= request.region.outWidth && request.region.slotWidth % 256 === 0);
  // Snapped: the region's corner on a whole device pixel.
  const geometry = f.context.getZoomGeometry();
  const device = (geometry.baseX + f.state.panX + zoom100 * request.region.x * f.fit) * 2;
  assert.ok(Math.abs(device - Math.round(device)) < 1e-6, 'the pan is snapped to device pixels');
  assert.ok(plan);
  f.roiCalls[0].resolve(new ImageData(request.region.outWidth, request.region.outHeight));
  await settle();
  assert.equal(f.context.detailLayer.visible, true);
  assert.equal(f.glDetailCanvas.width, request.region.outWidth);
  assert.equal(f.glDetailCanvas.style.left, `${request.region.x * f.fit}px`);
  assert.equal(f.glDetailCanvas.style.width, `${request.region.width * f.fit}px`);
  assert.equal(f.draws.length, 1);

  // A small pan inside the margin keeps it; a base redraw (a Step-3 edit)
  // redraws it with the new uniforms and asks for nothing.
  f.state.panX += 20;
  f.context.noteDetailViewChanged();
  await f.runTimers();
  f.context.syncDetailLayer(true);
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1, 'no new region for a pan inside the margin');
  assert.equal(f.draws.length, 2);

  // A SilverCore edit: the base shows newer settings, so the region hides at
  // once and a new one is asked for once the base has settled.
  f.context.coreReprocessToken = 11;
  f.context.coreReprocessBusy = () => true;
  f.context.syncDetailLayer(true);
  assert.equal(f.context.detailLayer.visible, false, 'a stale region is never drawn over a newer base');
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1, 'no region while the base still converts');
  f.context.coreReprocessBusy = () => false;
  await f.runTimers();
  assert.equal(f.roiCalls.length, 2);
  // Superseded while it converts: it is not shown.
  f.context.coreReprocessToken = 12;
  f.roiCalls[1].resolve(new ImageData(f.roiCalls[1].request.region.outWidth, f.roiCalls[1].request.region.outHeight));
  await settle();
  assert.equal(f.context.detailLayer.visible, false);
  // A GPU frame ahead of its exact frame (#239) hides it too.
  f.context.gpuPreview.lastDraw = 'apply';
  f.context.syncDetailLayer(true);
  assert.equal(f.context.detailLayer.visible, false);
  // A photo switch, rotate or crop (resetZoomPan) drops it.
  f.context.dropDetailLayer();
  assert.equal(f.context.detailLayer.shown, null);
}

// A current full-resolution frame (after a settle, an export or a repair
// pass) is cropped instead of converted; with repairs and no current frame
// there is no layer at all (a region from the source would bring the dust back).
{
  const f = fixture();
  f.state.processedImageData = new ImageData(W, H);
  f.state.processedImageDataIsPreview = false;
  f.state.fullResolutionPending = false;
  f.zoomTo(1 / (f.fit * 2));
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.roiCalls.length, 0);
  assert.equal(f.context.detailLayer.counters.crops, 1);
  assert.equal(f.context.detailLayer.visible, true);
  // Below full density the crop is reduced in the preview worker.
  f.context.dropDetailLayer();
  f.zoomTo(f.state.zoomLevel * 0.7);
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.resamples.length, 1);
  assert.ok(f.resamples[0].target.width < f.resamples[0].image.width);

  const g = fixture();
  g.state.dustRemoval.enabled = true;
  g.zoomTo(1 / (g.fit * 2));
  g.context.noteDetailViewChanged();
  await g.runTimers();
  assert.equal(g.roiCalls.length + g.context.detailLayer.counters.crops, 0, 'repairs pending: no region');
  // An exact frame whose detection has not landed yet is not cropped either.
  g.state.processedImageData = new ImageData(W, H);
  g.state.processedImageDataIsPreview = false;
  g.state.fullResolutionPending = false;
  g.context.repairsNeedSettling = () => true;
  g.context.noteDetailViewChanged();
  await g.runTimers();
  assert.equal(g.context.detailLayer.counters.crops, 0, 'no dusty exact frame under the repaired view');
  g.context.repairsNeedSettling = () => false;
  g.context.noteDetailViewChanged();
  await g.runTimers();
  assert.equal(g.context.detailLayer.counters.crops, 1, 'the repaired frame once repairs settled');
}

// The modes that draw something else hide the layer.
for (const [label, set] of [
  ['before/after', f => { f.state.beforeAfterActive = true; }],
  ['sampling', f => { f.state.samplingMode = 'gray'; }],
  ['AI brush', f => { f.context.canPaintAiBrush = () => true; }],
  ['CPU display modes (crop, dust mask, dodge and burn, sprocket, look)', f => { f.context.isWebGLActive = () => false; }],
  ['legacy positive engine', f => { f.state.filmType = 'positive'; f.state.positiveEngine = 'legacy'; }],
  ['reduced preview tier', f => { f.context.previewTier = 'reduced'; }],
  ['WebGL1', f => { f.context.webglState.webgl2 = false; }],
]) {
  const f = fixture();
  f.zoomTo(1 / (f.fit * 2));
  set(f);
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.roiCalls.length, 0, `${label}: no region`);
  assert.equal(f.context.detailLayerAllowed(), false, label);
}

console.log('detailLayerWiring: regions only when the base is soft, native rows at 100 %, snapped pan, crops of current frames, never stale, hidden in other modes');
