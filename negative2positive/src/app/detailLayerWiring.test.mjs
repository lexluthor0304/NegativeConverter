import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { planDetailRegion, detailRegionServes, detailSlotSize, estimateDetailRoiBytes, snapPanToDevicePixels, copyRegionRows, DETAIL_SETTLE_MS } from './detailLayer.js';
import { displayTargetFor, displayLevelGeometry } from './displayPreview.js';
import { computeZoomGeometry } from './zoomGeometry.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';
import { regionFrame } from '../render/previewTables.js';

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
function fixture({ dpr = 2, container = { width: 600, height: 420 }, size = { width: W, height: H }, planningOnly = false, levelFactor = 1 } = {}) {
  const { width: W, height: H } = size;
  let nextId = 1;
  const timers = new Map();
  const conversionSource = { width: W, height: H };
  if (!planningOnly) {
    conversionSource.__image16 = { width: W, height: H, data: new Uint16Array(W * H * 4) };
    for (let i = 0; i < conversionSource.__image16.data.length; i += 97) conversionSource.__image16.data[i] = i & 0xffff;
  }
  const level = levelFactor > 1 ? { width: Math.floor(W / levelFactor), height: Math.floor(H / levelFactor) } : conversionSource;
  const levelGeometry = image => image === level ? { sourceWidth: W, sourceHeight: H, k: levelFactor } : displayLevelGeometry(image);
  const base = { width: 1160, height: 773 };
  const state = {
    conversionSourceImageData: conversionSource, displayLevelImageData: level,
    conversionPreviewImageData: displayTargetFor(level, base),
    processedImageData: { width: base.width, height: base.height }, processedImageDataIsPreview: true, fullResolutionPending: true,
    webglSourceImageData: { width: base.width, height: base.height },
    zoomLevel: 1, panX: 0, panY: 0, currentStep: 3, cropping: false, beforeAfterActive: false, samplingMode: null,
    geometryPending: false, sprocketPreviewEnabled: false, filmType: 'color', curves: { r: [], g: [], b: [] },
    dustRemoval: { enabled: false, revision: 3 }, repairStrokes: []
  };
  const roiCalls = [];
  const analyses = [];
  // The preview worker keeps this photo's level unless a test says otherwise.
  const heldLevel = { image: level };
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
    drawStep3: (values, width, height, options = {}) => { draws.push({ width, height, values, frame: options.frame || null }); return true; },
    startModesCompile: () => { renderer.modesCompiles = (renderer.modesCompiles || 0) + 1; },
    modesStatus: () => renderer.modes || 'linked'
  };
  const fit = Math.min((container.width - 20) / W, (container.height - 20) / H);
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, window: { devicePixelRatio: dpr, location: { search: '' } }, console, performance,
    // The typed arrays of this realm, which the fixture's planes are made in.
    Uint16Array, Uint8ClampedArray, ImageData, AbortController,
    coreReprocessSettledListeners: new Set(),
    _coreReprocessActive: 0, _coreReprocessPending: null, _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: null,
    _resolveCoreReprocessIdle: null, _coreReprocessIdle: null, backgroundGate: { bump() {} },
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    glDetailCanvas, canvasTransformWrapper: wrapper,
    DETAIL_LAYER_ENABLED: true, DETAIL_SETTLE_MS, WORKER_ABORTED: 'WORKER_ABORTED',
    detailLayer: { renderer, failed: false, timer: null, request: null, shown: null, visible: false, warmed: 'warm',
      counters: { requests: 0, conversions: 0, crops: 0, shown: 0, dropped: 0, failures: 0, lastReadyMs: null } },
    planDetailRegion, detailRegionServes, detailSlotSize, snapPanToDevicePixels, copyRegionRows, displayLevelGeometry: levelGeometry,
    webglState: { webgl2: true, sourceSize: { w: base.width, h: base.height } },
    canvasDisplayFit: { scale: fit }, previewTier: 'normal',
    isWebGLActive: () => true, canPaintAiBrush: () => false, usesSilverCoreConversion: () => true,
    hasSeparateConversionPreview: () => true, hasFrameRepairs: () => state.dustRemoval.enabled,
    getCanvasContainerSize: () => container,
    getZoomGeometry: () => computeZoomGeometry({ wrapperW: W * fit, wrapperH: H * fit, containerW: container.width, containerH: container.height, zoom: state.zoomLevel }),
    interimGeometryCss: () => '', webglStep3Values: () => ({ wb: [1, 1, 1], vib: 0, cmy: [0, 0, 0], stages: state.stages || null }),
    regionFrame, requestAnimationFrame: () => 1,
    gpuPreview: { lastDraw: 'step3' }, gpuPreviewScheduler: { isAhead: () => false },
    coreReprocessGeneration: 1, coreReprocessToken: 10, coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessBusy: () => false, processNegativeInFlight: null, corePreviewCommit: null, displayPreviewRebuild: null,
    runWhenIdle: () => {}, buildRouterSettings: () => ({ filmType: 'color' }), detailRenderer: () => renderer,
    // No repair pass owes anything unless a test says so.
    repairsNeedSettling: () => false, dustMaskIsStale: () => false, dustDetectionTimer: null, pendingBrushRepairs: 0,
    previewRequestImage: image => ({ imageData: image.__displayOf, display: { target: { width: image.width, height: image.height }, geometry: levelGeometry(image.__displayOf) } }),
    getColorAnalysisSample: () => null,
    convertPreviewFrameInWorker: {
      holds: (image) => image === heldLevel.image,
      analyze: async (frame) => { analyses.push(frame); heldLevel.image = frame.imageData; return {}; },
      roi: (request) => new Promise((resolve, reject) => roiCalls.push({ request, resolve, reject })),
      resample: async (image, target) => { resamples.push({ image, target }); return new ImageData(target.width, target.height); },
    },
  });
  vm.runInContext([
    ...DISPLAY_SESSION_HELPERS,
    'detailLayerAllowed', 'detailView', 'detailFullFrame', 'detailTag', 'detailTagCurrent', 'hideDetailLayer', 'dropDetailLayer',
    'positionDetailCanvas', 'drawDetailLayer', 'detailModesReady', 'syncDetailLayer', 'noteDetailViewChanged', 'scheduleDetailRequest',
    'scheduleDetailWarmUp', 'detailConversionBusy', 'wakeDetailAfterConversion', 'noteCoreReprocessSettled', 'requestDetailRegion', 'detailFromFrame', 'detailFromSource', 'showDetailRegion',
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
  return { context, state, roiCalls, resamples, draws, uploads, glDetailCanvas, wrapper, timers, runTimers, zoomTo, fit, conversionSource, base, container,
    analyses, heldLevel };
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
  f.context._coreReprocessActive = 1;
  f.context.syncDetailLayer(true);
  assert.equal(f.context.detailLayer.visible, false, 'a stale region is never drawn over a newer base');
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1, 'no region while the base still converts');
  f.context._coreReprocessActive = 0;
  f.context.noteCoreReprocessSettled();
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

// #253: with a look or a rescue on screen, the region is drawn with the mode
// programs of its own context once they link, at its place in the whole frame
// (u_frame), so the rescue's positions match the base's.
{
  const f = fixture();
  f.state.stages = { active: true, rescueOn: 1 };
  f.context.detailLayer.renderer.modes = 'pending';
  f.zoomTo(1 / (f.fit * 2));
  f.context.noteDetailViewChanged();
  await f.runTimers();
  const { request } = f.roiCalls[0];
  f.roiCalls[0].resolve(new ImageData(request.region.outWidth, request.region.outHeight));
  await settle();
  assert.equal(f.draws.length, 0, 'nothing drawn before the mode programs link');
  assert.equal(f.context.detailLayer.visible, false);
  assert.ok(f.context.detailLayer.renderer.modesCompiles >= 1, 'the layer compiles its mode programs');
  f.context.detailLayer.renderer.modes = 'linked';
  f.context.syncDetailLayer(true);
  assert.equal(f.context.detailLayer.visible, true);
  const draw = f.draws.at(-1);
  assert.equal(draw.values.stages, f.state.stages);
  const region = f.context.detailLayer.shown.plan;
  assert.deepEqual(draw.frame, regionFrame(region, request.region.outWidth, request.region.outHeight, W, H));
  // The last texel's centre maps back into the region's source rect.
  const u = draw.frame[0] + (request.region.outWidth - 0.5) * draw.frame[2];
  assert.ok(Math.abs(u * W - (region.x + region.width - 0.5 * region.width / request.region.outWidth)) < 1e-6);
}

// The snap is a fixed point of planning: a pan whose snap plans a region one
// source pixel further along is planned and snapped again, so the same view
// restored later (a photo's saved zoom on its return) keeps its pan.
{
  const f = fixture({ dpr: 1 });
  f.state.processedImageData = new ImageData(W, H);
  f.state.processedImageDataIsPreview = false;
  f.state.fullResolutionPending = false;
  f.zoomTo(1.953125 / (f.fit * 1.76));
  const start = { panX: f.state.panX, panY: f.state.panY };
  // A pan whose snap for its own region plans another one.
  let crossing = null;
  for (let step = 0; step < 400 && !crossing; step++) {
    const panY = start.panY - step * 0.37;
    const view = { ...f.context.detailView(), panY };
    const plan = planDetailRegion(view);
    const snapped = snapPanToDevicePixels(panY, view.baseY, f.state.zoomLevel, plan.y * view.fit, 1);
    if (planDetailRegion({ ...view, panY: snapped }).y !== plan.y) crossing = panY;
  }
  assert.ok(crossing !== null, 'a pan whose snap crosses a source row');
  f.state.panY = crossing;
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.context.detailLayer.counters.crops, 1);
  const settled = { panX: f.state.panX, panY: f.state.panY, region: { ...f.context.detailLayer.shown.plan } };
  const view = f.context.detailView();
  assert.deepEqual([planDetailRegion(view).x, planDetailRegion(view).y], [settled.region.x, settled.region.y],
    'the region shown is the one the settled pan plans');
  // Leave and come back to the same view: nothing moves.
  f.context.dropDetailLayer();
  f.wrapper.style.transform = 'restored';
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.context.detailLayer.counters.crops, 2);
  assert.deepEqual({ panX: f.state.panX, panY: f.state.panY }, { panX: settled.panX, panY: settled.panY }, 'the restored pan stays put');
  assert.equal(f.wrapper.style.transform, 'restored', 'the second request writes no transform');
}

// A warm photo switch converts nothing, so the preview worker may still keep
// the other photo's level: the base's analysis request puts it back first.
{
  const f = fixture();
  f.heldLevel.image = { width: 10, height: 10 };
  f.zoomTo(1 / (f.fit * 2));
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.analyses.length, 1, 'the level is sent again through the base analysis');
  assert.equal(f.analyses[0].imageData, f.conversionSource);
  assert.equal(f.roiCalls.length, 1);
  f.roiCalls[0].resolve(new ImageData(f.roiCalls[0].request.region.outWidth, f.roiCalls[0].request.region.outHeight));
  await settle();
  f.context.dropDetailLayer();
  f.context.noteDetailViewChanged();
  await f.runTimers();
  assert.equal(f.analyses.length, 1, 'not while the worker keeps it');
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

// A restored session may first rewarm its cached analysis. Cancellation during
// that await must prevent the later native row copy and ROI transfer too.
{
  const f = fixture();
  f.zoomTo(1 / (f.fit * 2));
  f.heldLevel.image = null;
  let finishAnalysis, rowCopies = 0;
  f.context.convertPreviewFrameInWorker.analyze = () => new Promise(resolve => { finishAnalysis = resolve; });
  f.context.copyRegionRows = (...args) => { rowCopies++; return copyRegionRows(...args); };
  const controller = new AbortController();
  const pending = f.context.detailFromSource(planDetailRegion(f.context.detailView()), controller.signal);
  assert.ok(finishAnalysis, 'the source analysis is pending');
  controller.abort();
  finishAnalysis({});
  assert.equal(await pending, null);
  assert.equal(rowCopies, 0, 'cancelled analysis cannot copy native rows');
  assert.equal(f.roiCalls.length, 0, 'cancelled analysis cannot post an ROI');
}

// The 60 MP descriptor is planning only: no 60 MP plane is allocated. These
// views used to copy a 16 MP cut after every base redraw.
for (const [container, zoom] of [[{ width: 1110, height: 700 }, 2], [{ width: 1600, height: 1000 }, 1.5]]) {
  const f = fixture({ container, size: { width: 9536, height: 6336 }, planningOnly: true, levelFactor: 3 });
  f.zoomTo(zoom);
  for (let i = 0; i < 10; i++) { f.context.syncDetailLayer(true); await f.runTimers(); }
  assert.equal(f.roiCalls.length, 1, 'ten redraws post only one pending ROI');
  const plan = f.context.detailLayer.request.plan;
  assert.ok(plan.fromLevel && detailRegionServes(plan, plan), 'the level covers the oversized view');
  assert.equal(f.roiCalls[0].request.rows, null, 'no native row copy');
  f.roiCalls[0].resolve(new ImageData(plan.outWidth, plan.outHeight));
  await settle();
  for (let i = 0; i < 10; i++) { f.context.syncDetailLayer(true); await f.runTimers(); }
  assert.equal(f.roiCalls.length, 1, 'a shown region also deduplicates');
  f.context.coreReprocessToken++;
  f.context.syncDetailLayer(true);
  await f.runTimers();
  const oldSignal = f.roiCalls[1].request.signal;
  f.context.coreReprocessToken++;
  f.context.syncDetailLayer(true);
  await f.runTimers();
  assert.equal(oldSignal.aborted, true, 'superseded rows/jobs are aborted');
  f.context.dropDetailLayer();
  assert.equal(f.roiCalls.at(-1).request.signal.aborted, true, 'photo/geometry invalidation aborts too');
  // A no-level fallback cut still serves itself, despite not covering visible.
  const cut = planDetailRegion({ ...f.context.detailView(), levelFactor: 1 });
  assert.ok(cut.width * cut.height < cut.visible.width * cut.visible.height);
  assert.equal(detailRegionServes(cut, cut), true);
}

// Retaining/committing a preview is an export barrier, not an ROI barrier.
// There is no 100 ms polling delay: the conversion-settled notification wakes
// the layer immediately, and an exact frame landing recrops it without a pan.
{
  const f = fixture();
  f.zoomTo(1 / (f.fit * 2));
  let clock = 0;
  f.context.performance = { now: () => clock };
  f.context._coreReprocessActive = 1;
  f.context.coreReprocessBusy = () => true; // retained plane remains busy
  f.context.corePreviewCommit = {};
  f.context.syncDetailLayer(true);
  await f.runTimers();
  assert.equal(f.roiCalls.length, 0);
  assert.equal(f.timers.size, 0, 'waits for a notification, never polls');
  clock = 180;
  f.context._coreReprocessActive = 0;
  f.context.noteCoreReprocessSettled();
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1, 'retained/committing preview does not delay ROI');
  clock = 240;
  const { request, resolve } = f.roiCalls[0];
  resolve(new ImageData(request.region.outWidth, request.region.outHeight));
  await settle();
  assert.equal(f.context.detailLayer.visible, true);
  assert.ok(clock <= 250, 'ready within 250 ms of release on fake timers');
  const exact = new ImageData(W, H);
  for (let i = 0; i < exact.data.length; i++) exact.data[i] = i % 251;
  f.state.processedImageData = exact;
  f.state.processedImageDataIsPreview = false;
  f.state.fullResolutionPending = false;
  assert.equal(f.context.detailTagCurrent(f.context.detailLayer.shown.tag), false);
  f.context.syncDetailLayer(true);
  await f.runTimers();
  assert.equal(f.roiCalls.length, 1, 'exact frame is cropped, never reconverted');
  assert.equal(f.context.detailLayer.shown.tag.full, exact);
  const shown = f.context.detailLayer.shown.plan;
  assert.deepEqual(f.uploads.at(-1).data, copyRegionRows(exact.data, W, shown), 'settled region equals the exact frame crop');
}

// Tier B has no native plane. Fog/mean positions still use the whole pending
// frame, rather than normalising to this cropped level region.
{
  const f = fixture({ size: { width: 9536, height: 6336 }, planningOnly: true, levelFactor: 3 });
  f.state.sourcePending = f.conversionSource;
  f.state.conversionSourceImageData = null;
  f.state.stages = { active: true, rescueOn: 1 };
  f.zoomTo(1.5);
  f.context.syncDetailLayer(true);
  await f.runTimers();
  const { request, resolve } = f.roiCalls[0];
  assert.equal(request.region.fromLevel, true);
  resolve(new ImageData(request.region.outWidth, request.region.outHeight));
  await settle();
  assert.deepEqual(f.draws.at(-1).frame, regionFrame(f.context.detailLayer.shown.plan,
    request.region.outWidth, request.region.outHeight, 9536, 6336));
}

// Documented peak estimate: exercise the maximum allowed native-row input,
// independently of a 60 MP descriptor's coverage preference. No planes allocated.
for (const [width, height, boundMiB] of [[1110, 700, 384], [1600, 1000, 512]]) {
  const slot = detailSlotSize(width, height, 2);
  const worstNative = { width: 4000, height: 4000, outWidth: slot.width, outHeight: slot.height, fromLevel: false };
  const estimate = estimateDetailRoiBytes(worstNative, slot);
  assert.ok(estimate <= boundMiB * 1024 * 1024, `${width}x${height} DPR 2: ${estimate} B`);
  console.log(`detail ROI allocation estimate ${width}x${height}: ${estimate} B <= ${boundMiB} MiB`);
}
