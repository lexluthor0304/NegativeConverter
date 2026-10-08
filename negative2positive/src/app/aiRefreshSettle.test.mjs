// After MI-GAN was released (#236's idle rule, #241's hidden window), the
// dust and AI repair brushes bring it back: a dust-brush stroke's refresh
// loads the model and drains its queue, so a photo with repair strokes
// settles and a switch keeps its snapshot and history; a model that cannot be
// loaded drains the queue too. The refresh's repair-stroke mask goes with the
// photo (switch, New session). An armed AI brush shows no busy cursor after a
// release and takes its first stroke. Runs the real functions from main.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inpaintWithModel, TILE, CONTEXT } from './aiInpaint.js';
import { amendDustDelta, applyStrokePatch, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';
import { createRepairStamps } from './repairReuse.js';
import { createAiModelLoader } from './aiModelLoading.js';
import { createPhotoSessionCache } from './photoSessionCache.js';
import { exactSettingsKey } from './settingsKey.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';
import { createHarness, makeBase, settle } from './geometryTestHarness.mjs';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const turn = async (count = 4) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)); };
// The failed loads below are expected.
const quiet = { ...console, warn: () => {} };

// ---- 1. A released model, repair strokes and one dust-brush stroke ----------
const width = 1200, height = 800;
function frame(fill) {
  const image = new ImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);
  image.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(fill * 257) };
  return image;
}
// The stroke's rect R, a speck in it, and an AI-brush repair stroke beside it.
const rect = { x: 580, y: 380, width: 40, height: 40 };
const strokeMask = new Uint8Array(width * height);
for (let y = 385; y < 415; y++) for (let x = 605; x < 616; x++) strokeMask[y * width + x] = 255;
const repairStroke = { size: 0.01, points: [{ x: 0.5, y: 0.5 }] };

function settleFixture({ loadFails = false } = {}) {
  const clean = frame(100);
  // The committed repair: MI-GAN painted 30 over the speck and the stroke.
  const repaired = frame(100);
  const mask = new Uint8Array(width * height);
  for (let y = 395; y < 405; y++) for (let x = 595; x < 605; x++) mask[y * width + x] = 255;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !strokeMask[i]) continue;
    for (let c = 0; c < 3; c++) { repaired.data[i * 4 + c] = 30; repaired.__image16.data[i * 4 + c] = 30 * 257; }
  }
  const item = { file: { name: 'a.dng' }, settings: { repairStrokes: [repairStroke] } };
  const state = {
    loadedFile: item.file, loadedBaseImageData: clean, originalImageData: clean, conversionSourceImageData: clean,
    processedImageData: repaired, previewSourceImageData: repaired, currentStep: 3,
    processedImageDataIsPreview: false, fullResolutionPending: false, rawDecodePending: false, rawMetadata: null,
    flatFields: {}, repairStrokes: [repairStroke], zoomLevel: 1, panX: 0, panY: 0, filmEdge: null,
    dustRemoval: { enabled: true, strength: 3, maxParticleSize: 40, ai: true, processing: false, mask,
      cleanSource: clean, inpaintedImageData: repaired, particleCount: 1, revision: 5, maskTag: 1 },
    fileQueue: [item],
  };
  const timers = [], loads = [], displayed = [], toasts = [];
  let runs = 0;
  // A stand-in MI-GAN: paints 30 over the masked pixels.
  const run = async (image, tileMask, size) => {
    runs++;
    const out = image.slice();
    for (let i = 0; i < tileMask.length; i++) if (tileMask[i]) for (let c = 0; c < 3; c++) out[c * size * size + i] = 30 / 255;
    return out;
  };
  const context = vm.createContext({
    state, console: quiet, DOMException, ImageData, performance, File: globalThis.File, Uint8Array, structuredClone,
    undoStack: [], redoStack: [], coreReprocessToken: 2, pendingBrushRepairs: 0, brushRepairWaiters: [],
    dustAiRefresh: { rects: [], timer: null }, inpaintWithModel, copyImageRect, pasteImageRect, amendDustDelta,
    applyStrokePatch, AI_TILE: TILE, AI_CONTEXT: CONTEXT, localExposureGeometryFor: () => ({}),
    buildRepairMask: () => ({ mask: strokeMask, bounds: { x: 605, y: 385, width: 11, height: 30 } }),
    refreshDustDisplay: (target, rects) => displayed.push(rects), showToast: message => toasts.push(message),
    repairStamps: createRepairStamps(), forgetDustMaskInfo: () => {}, patchDustTint: () => {},
    showDustParticleCount: () => {}, pushUndoDelta: (label, dustDelta) => context.undoStack.push({ label, dustDelta }),
    aiRepair: { release: null, trim: null, resident: null, status: 'idle', provider: '', run: null, source: '', sourceRef: null,
      prefer: '', released: false, error: '', percent: 0, tiles: 0, ms: 0, revision: 0 },
    aiRepairRunsInFlight: 0, aiRepairIdleTimer: null, aiRepairLastUsed: 0, activeLongJobs: 0, dustDetectionTimer: null,
    fullResolutionRenderTimer: null,
    AI_REPAIR_IDLE_RELEASE_MS: 300_000, AI_REPAIR_IDLE_RECHECK_MS: 30_000, getPerfNow: () => 0,
    DEFAULT_MODEL_URL: '/models/migan.onnx', defaultInferencePreference: () => 'wasm',
    fetchModelBytes: async () => {
      if (context.failLoads) throw new Error('Failed to fetch');
      return new Uint8Array(4);
    },
    failLoads: false,
    createInpaintSessionInWorker: async (bytes, { prefer }) => ({ provider: prefer, run, release: async () => {} }),
    updateAiRepairUI: () => {}, hasFrameRepairs: () => true, scheduleDustDetection: () => {},
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout: () => {},
    photoSessions: createPhotoSessionCache({ maxBytes: 1 << 30 }), photoPreviews: createPhotoSessionCache({ maxBytes: 1 << 30 }),
    hiddenJobs: { safeMode: false }, exactSettingsKey, processNegativeInFlight: null, coreReprocessTimer: null,
    coreReprocessBusy: () => false, dustDrawing: false, previewTier: 'normal', displayIsReduced: () => false,
    captureSnapshot: () => ({ refs: { processedImageData: state.processedImageData,
      dustInpaintedImageData: state.dustRemoval.inpaintedImageData, dustMask: state.dustRemoval.mask } }),
    schedulePostPaintTask: () => {}, currentConvertedPreviewSource: () => state.processedImageData,
    samplePhotoPreviewSource: image => ({ width: image.width, height: image.height }),
    buildAdjustmentSettings: () => ({ curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    adjustPhotoPreviewSample: sample => sample, geometryDiagnostics: { coldSessions: false },
    ...displaySessionStubs(),
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'photoSettingsKey', 'rememberPhotoSession', 'commitDustStroke',
    'queueDustAiRefresh', 'mergeDustRefreshRects', 'dustAiWindow', 'cropDustImage', 'cropDustMask', 'repairStrokeMaskFor',
    'runDustAiRefresh', 'noteBrushRepairSettled', 'aiRepairReady', 'dustPassUsesAi', 'settleAiRepairModel',
    'aiRepairLoadArgs', 'assertRepairCurrent', 'countAiRepairRun', 'noteAiRepairUsed', 'releaseIdleAiRepair',
    'canReleaseIdleAiRepair', 'releaseAiRepairSession', 'performAiRepairModelLoad'].map(functionSource).join('\n')
    + '\nlet dustRefreshRepairMask = null;', context);
  const loader = createAiModelLoader(context.performAiRepairModelLoad, context.DEFAULT_MODEL_URL);
  context.loadAiRepairModel = (...args) => { loads.push(JSON.stringify(args)); return loader(...args); };
  context.failLoads = loadFails;
  return { context, state, item, clean, repaired, mask, timers, loads, displayed, toasts, runs: () => runs };
}

// The worker's TELEA patch over R: the clean source, TELEA (here 60) on the
// speck. It undoes the repair stroke's pixels inside R.
function strokePatch(f) {
  const rgba8 = new Uint8ClampedArray(rect.width * rect.height * 4);
  const rgba16 = new Uint16Array(rect.width * rect.height * 4);
  const maskBytes = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const i = (y * rect.width + x), at = (rect.y + y) * width + rect.x + x;
    const value = f.mask[at] ? 60 : 100;
    for (let c = 0; c < 3; c++) { rgba8[i * 4 + c] = value; rgba16[i * 4 + c] = value * 257; }
    rgba8[i * 4 + 3] = 255; rgba16[i * 4 + 3] = 65535;
    maskBytes[i] = f.mask[at];
  }
  return { rect, rgba8, rgba16, maskRect: rect, maskBytes, particleCount: 1, countBefore: 1, tint: null };
}

// Drives the refresh's debounce timers (200 ms) until none is armed; the
// idle-release timer is left alone.
async function drainRefreshes(f) {
  for (let round = 0; round < 6; round++) {
    const index = f.timers.findIndex(timer => timer.ms === 200);
    if (index < 0) break;
    const [{ callback }] = f.timers.splice(index, 1);
    callback();
    await turn(8);
  }
}

for (const loadFails of [false, true]) {
  const f = settleFixture({ loadFails: false });
  const c = f.context;
  await c.loadAiRepairModel(c.DEFAULT_MODEL_URL, { prefer: 'wasm', refresh: false });
  assert.equal(c.aiRepair.status, 'ready');
  const revision = c.aiRepair.revision;
  assert.equal(await c.releaseAiRepairSession(), true, 'the idle rule or a hidden window releases the model');
  assert.equal(c.aiRepair.status, 'idle');
  c.failLoads = loadFails;
  f.loads.length = 0;
  f.timers.length = 0;
  c.commitDustStroke(strokePatch(f), { baseTag: 1, tag: 2 });
  assert.equal(c.undoStack.length, 1, 'the stroke is in history');
  assert.equal(JSON.stringify(c.dustAiRefresh.rects), JSON.stringify([rect]), 'its rect is queued for MI-GAN');
  c.rememberPhotoSession(f.item);
  assert.equal(c.photoSessions.peek(f.item).snapshot, null, 'a queued refresh is not a settled view');
  c.photoSessions.clear();

  await drainRefreshes(f);
  assert.equal(JSON.stringify(f.loads), JSON.stringify([JSON.stringify([c.DEFAULT_MODEL_URL, { refresh: false, prefer: 'wasm' }])]),
    'the refresh loads the released model on its provider');
  assert.equal(c.dustAiRefresh.rects.length, 0, `the queue drains without another stroke (${loadFails ? 'failed load' : 'model back'})`);
  assert.equal(c.pendingBrushRepairs, 0);
  const entry = c.undoStack[0].dustDelta;
  if (loadFails) {
    assert.equal(c.aiRepair.status, 'error');
    assert.equal(f.runs(), 0);
    assert.equal(c.repairStamps.recipeOf(f.repaired), null, 'export repairs it from scratch');
    assert.equal(entry.aiCleanAfter, false);
  } else {
    assert.equal(c.aiRepair.status, 'ready');
    assert.equal(c.aiRepair.revision, revision, 'the same model under the same revision');
    assert.equal(f.runs(), 2, 'the dust and the repair stroke in R are inferred again');
    assert.equal(entry.aiCleanAfter, true, 'the stroke entry is amended');
    // The repair stroke's pixels inside R are repaired again.
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const at = y * width + x;
      if (strokeMask[at] || f.mask[at]) assert.equal(f.repaired.data[at * 4], 30, `MI-GAN at ${x},${y}`);
    }
  }
  // A switch now stores the settled view with its history.
  const stored = c.rememberPhotoSession(f.item);
  assert.equal(stored, true);
  const session = c.photoSessions.peek(f.item);
  assert.ok(session.snapshot, 'a switch stores a settled snapshot');
  assert.equal(session.snapshot.refs.dustInpaintedImageData, f.repaired);
  assert.equal(session.undo.length, 1, 'with its undo stack');
  assert.equal(session.undo[0].dustDelta, entry, 'the dust-brush stroke stays undoable');
}

// ---- 2. The refresh's repair-stroke mask goes with the photo ---------------
// A real switch (cold to B, then warm back to A, which skips
// releaseOutgoingPhotoPlanes) and a real New session, in the geometry
// harness. The mask holds A's clean source and a frame-sized mask.
{
  const base = makeBase(64, 48, 3);
  const h = createHarness(base), c = h.context;
  c.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: { left: 4, top: 4, width: 40, height: 26 } });
  await h.state.geometryReady;
  assert.ok(h.state.croppedImageData, 'A is cropped');
  h.state.currentStep = 3;
  h.state.processedImageData = h.state.croppedImageData;
  const itemA = { file: { name: 'a.png' }, settings: null, isDirty: true };
  const itemB = { file: { name: 'b.png' }, settings: null };
  Object.assign(h.state, { fileQueue: [itemA, itemB], currentFileIndex: 0, loadedFile: itemA.file });
  h.target.getCurrentQueueItem = () => h.state.fileQueue[h.state.currentFileIndex];
  h.target.persistCurrentFileSettings = () => {
    const item = h.state.fileQueue[h.state.currentFileIndex];
    item.settings = { rotationAngle: h.state.rotationAngle, mirrored: h.state.mirrored, cropRegion: h.state.cropRegion };
  };
  h.target.loadFile = async file => {
    const other = makeBase(40, 30, 9);
    Object.assign(h.state, { loadedFile: file, loadedBaseImageData: other, originalImageData: other, croppedImageData: null,
      cropRegion: null, rotationAngle: 0, mirrored: false, processedImageData: null, currentStep: 1 });
    return { status: 'loaded' };
  };
  const kept = () => ({ strokes: [repairStroke], source: h.state.processedImageData, mask: new Uint8Array(64 * 48) });
  h.target.dustRefreshRepairMask = kept();
  await c.switchToFile(1);
  await settle();
  assert.equal(h.state.loadedFile, itemB.file);
  assert.equal(h.target.dustRefreshRepairMask, null, 'a cold switch drops the outgoing photo\'s mask and source');
  h.state.currentStep = 3;
  h.state.processedImageData = h.state.originalImageData;
  h.target.dustRefreshRepairMask = kept();
  await c.switchToFile(0);
  await settle();
  assert.equal(h.state.loadedFile, itemA.file);
  assert.equal(h.state.loadedBaseImageData, base, 'A came back from its warm session, without a decode');
  assert.equal(h.state.processedImageData, h.state.croppedImageData);
  assert.equal(h.target.dustRefreshRepairMask, null, 'so does a warm one');

  // New session: closePhotoSession and its dust reset, for real.
  Object.assign(h.target, {
    thumbnailSources: { clear() {} }, watchRollSamples: { clear() {} }, previewRepairWorker: { dispose() {} },
    composeDisplaySprocketFrame: { clear() {} }, zoomControls: { style: {} }, fileInput: { value: '', click() {} },
  });
  h.target.document.getElementById = () => ({ style: {} });
  vm.runInContext(['closePhotoSession', 'clearDustState'].map(functionSource).join('\n'), c);
  h.target.dustRefreshRepairMask = kept();
  c.closePhotoSession();
  assert.equal(h.state.loadedFile, null, 'the session closed');
  assert.equal(h.target.dustRefreshRepairMask, null, 'New session drops it');
  // A new clean source (a reconversion of the same photo) does too.
  vm.runInContext(functionSource('resetDustForCleanSource'), c);
  h.target.dustRefreshRepairMask = kept();
  c.resetDustForCleanSource(makeBase(8, 8, 1));
  assert.equal(h.target.dustRefreshRepairMask, null, 'a new clean source drops it');
}

// ---- 3. An armed AI brush after a forced release ----------------------------
// The cursor over the viewer, from studio.css's rules for #canvasContainer
// with :has() conditions (the last matching rule of equal specificity wins).
const studioCss = readFileSync(new URL('../styles/studio.css', import.meta.url), 'utf8');
const cursorRules = [...studioCss.matchAll(/^(\.studio(?::has\([^{]*?\))+) #canvasContainer \{ cursor: ([\w-]+); \}$/gm)]
  .map(([, selector, cursor]) => ({ cursor, conditions: [...selector.matchAll(/:has\(([^)]*\))\)|:has\(([^)]*)\)/g)].map(m => m[1] || m[2]) }));
for (const cursor of ['crosshair', 'progress', 'not-allowed']) {
  assert.ok(cursorRules.some(rule => rule.cursor === cursor), `studio.css has the ${cursor} rule of the AI brush`);
}
for (const rule of cursorRules.filter(rule => rule.cursor === 'progress')) {
  assert.ok(rule.conditions.some(condition => condition.includes('[data-model-pending]')), 'progress needs a pending model');
}
function viewerCursor(facts) {
  let cursor = 'default';
  for (const rule of cursorRules) if (rule.conditions.every(condition => facts.has(condition))) cursor = rule.cursor;
  return cursor;
}

function brushFixture() {
  const attributes = new Set();
  const elements = {
    aiBrushEnabled: { checked: true }, dustAiEnabled: { checked: true }, dustAiLoadBtn: { disabled: false },
    dustAiStatus: { textContent: '' },
    aiBrushSection: { toggleAttribute: (name, on) => { if (on) attributes.add(name); else attributes.delete(name); } },
    'studioTab-repair': { getAttribute: name => (name === 'aria-selected' ? 'true' : null) },
  };
  const toasts = [], loads = [];
  const context = vm.createContext({
    console: quiet, File: globalThis.File, document: { getElementById: id => elements[id] || null },
    state: { currentStep: 3, cropping: false, samplingMode: null, dustRemoval: { ai: true } },
    aiRepair: { release: null, trim: null, resident: null, status: 'idle', provider: '', run: null, source: '', sourceRef: null,
      prefer: '', released: false, error: '', percent: 0, tiles: 0, ms: 0, revision: 0 },
    aiRepairRunsInFlight: 0, pendingBrushRepairs: 0, aiRepairLoadWatcher: null,
    noteAiRepairUsed: () => {}, hasFrameRepairs: () => false, scheduleDustDetection: () => {},
    DEFAULT_MODEL_URL: '/models/migan.onnx', defaultInferencePreference: () => 'wasm', inpaintBackends: () => ({ webgpu: false }),
    failLoads: false,
    fetchModelBytes: async () => { if (context.failLoads) throw new Error('Failed to fetch'); return new Uint8Array(4); },
    createInpaintSessionInWorker: async (bytes, { prefer }) => ({ provider: prefer, run: async () => {}, release: async () => {} }),
    getLocalizedText: (key, fallback) => `${key}|${fallback}`, getInterpolatedText: (key, values, fallback) => `${key}|${fallback}`,
    showToast: message => toasts.push(message),
  });
  vm.runInContext(['updateAiRepairUI', 'retouchTabSelected', 'canPaintAiBrush', 'aiBrushTakesStroke', 'ensureAiRepairPreload',
    'releaseAiRepairSession', 'performAiRepairModelLoad', 'aiRepairLoadArgs'].map(functionSource).join('\n'), context);
  const loader = createAiModelLoader(context.performAiRepairModelLoad, context.DEFAULT_MODEL_URL);
  context.loadAiRepairModel = (...args) => { loads.push(JSON.stringify(args)); return loader(...args); };
  const facts = () => new Set([
    '#aiBrushEnabled:checked', '#studioTab-repair[aria-selected="true"]',
    ...[...attributes].map(name => `#aiBrushSection[${name}]`)
  ]);
  return { context, elements, attributes, toasts, loads, cursor: () => viewerCursor(facts()) };
}

{
  const f = brushFixture(), c = f.context;
  await c.loadAiRepairModel(c.DEFAULT_MODEL_URL, { prefer: 'wasm', refresh: false });
  assert.equal(c.aiRepair.status, 'ready');
  assert.equal(f.cursor(), 'crosshair', 'the armed brush');
  // Forced release, as #236's idle rule or #241's hidden window makes it.
  assert.equal(await c.releaseAiRepairSession(), true);
  assert.equal(c.aiRepair.status, 'idle');
  assert.notEqual(f.cursor(), 'progress', 'nothing loads: no busy cursor');
  assert.equal(f.cursor(), 'crosshair');
  assert.ok(f.elements.dustAiStatus.textContent.startsWith('dustAiStatusIdleRetouch|'),
    'on Retouch the status line does not say the model loads when Retouch opens');
  assert.ok(!f.elements.dustAiStatus.textContent.includes('open Retouch'));
  f.loads.length = 0;
  assert.equal(c.aiBrushTakesStroke(), true, 'the first stroke is accepted');
  assert.deepEqual(f.toasts, [], 'without the still-loading toast');
  assert.equal(JSON.stringify(f.loads), JSON.stringify([JSON.stringify([c.DEFAULT_MODEL_URL, { refresh: false, prefer: 'wasm' }])]),
    'and the released model starts loading for its repair');
  await Promise.resolve();
  await Promise.resolve();
  // While that load runs the brush waits, and says so.
  assert.equal(c.aiRepair.status, 'loading');
  assert.equal(f.cursor(), 'progress', 'a load in flight shows the busy cursor');
  assert.equal(c.aiBrushTakesStroke(), false);
  assert.ok(f.toasts.at(-1).startsWith('aiBrushModelLoading|'));
  await turn();
  assert.equal(c.aiRepair.status, 'ready');
  assert.equal(f.cursor(), 'crosshair');

  // A load that fails: an error state, never a busy cursor for the rest of the session.
  await c.releaseAiRepairSession();
  c.failLoads = true;
  f.toasts.length = 0;
  assert.equal(c.aiBrushTakesStroke(), true);
  await turn();
  assert.equal(c.aiRepair.status, 'error');
  assert.equal(f.cursor(), 'not-allowed', 'a failed model: the brush cannot paint');
  assert.ok(f.attributes.has('data-model-error') && !f.attributes.has('data-model-pending'));
  assert.ok(f.elements.dustAiStatus.textContent.startsWith('dustAiStatusError|'));
  f.loads.length = 0;
  assert.equal(c.aiBrushTakesStroke(), false, 'a stroke is refused with the reason');
  assert.ok(f.toasts.at(-1).startsWith('dustAiStatusError|'));
  assert.equal(f.loads.length, 0, 'and loads nothing on its own');
  // The brush unchecked: neither state is shown.
  f.elements.aiBrushEnabled.checked = false;
  c.updateAiRepairUI();
  assert.equal(f.attributes.size, 0);
}

console.log('AI refresh settle: a released model is loaded by the dust brush and its queue drains (a failed load drains it too), so a switch keeps the settled view and history; the repair-stroke mask goes with the photo; an armed AI brush shows no busy cursor after a release and takes its first stroke');
