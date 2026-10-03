import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRepairStamps } from './repairReuse.js';
import { markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers } from './planeRelease.js';

// Real single/batch callers, shared dust pass and inpainter; only decoding,
// inference and encoding leaves are deterministic 64x40 stand-ins.
const source = readFileSync(process.env.NC229_CALLER_SOURCE || new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
};
const names = ['processFileWithSettings', 'removeFrameDust', 'inpaintForCommit', 'aiRepairReady', 'aiRepairLoadArgs',
  'settleAiRepairModel', 'loadAiRepairForExport', 'prepareCurrentImageForExport', 'renderCurrentImageDataForExport',
  'dustMaskHasPixels', 'commitDustPass', 'dustPassUsesAi', 'getDustSource', 'currentRepairRecipe', 'stampRepairResult'];
function image() {
  const width = 64, height = 40, data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 65535 : 10003 + i % 47000;
  return { width, height, data: Uint8ClampedArray.from(data, v => v >>> 8), __image16: { width, height, data } };
}
function fixture({ ai = true, failure = 'load', provider = 'wasm', fallbackFails = false, particles = 1 } = {}) {
  const clean = image(), telea = image(), learned = image(), file = { name: 'small.png', size: 1 };
  telea.data[0] = 1; telea.__image16.data[0] = 257;
  learned.data[0] = 71; learned.__image16.data[0] = 18341;
  const mask = new Uint8Array(clean.width * clean.height); mask[0] = particles ? 1 : 0;
  const state = { fileQueue: [{ file }], autoFrame: { enabled: false }, repairStrokes: [], currentStep: 3,
    originalImageData: clean, conversionSourceImageData: clean, processedImageData: clean, processedImageDataIsPreview: false,
    dustRemoval: { ai, enabled: true, strength: 3, maxParticleSize: 40, mask, revision: 1, cleanSource: clean, inpaintedImageData: null } };
  const aiRepair = { status: failure === 'load' ? 'idle' : 'ready', released: failure === 'load', revision: 7,
    sourceRef: 'chosen-model.onnx', prefer: provider, provider, error: '', run: failure === 'load' ? null : () => {} };
  const calls = { loads: [], telea: 0, inference: 0, encoded: 0, commits: 0 };
  const settings = { filmType: 'color', positiveMode: 'correct', autoFrameMeta: {}, filmEdge: { checked: true },
    rotationAngle: 0, mirrored: false, cropRegion: null, repairStrokes: [], wbUserOverride: true, lensCorrection: { enabled: false } };
  const target = { state, aiRepair, coreReprocessToken: 1, aiRepairLoadWatcher: null, DEFAULT_MODEL_URL: '/default.onnx',
    dustAiRefresh: { rects: [] }, repairStamps: createRepairStamps(), dustPassCache: null,
    markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers,
    console: { warn() {}, error() {} },
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw new DOMException('superseded', 'AbortError'); },
    getInterpolatedText: (_key, _values, fallback) => fallback,
    loadAiRepairModel: async (url, options) => {
      calls.loads.push({ url, options: structuredClone(options) });
      if (failure === 'load' || fallbackFails) Object.assign(aiRepair, { status: 'error', error: 'fixture model unavailable', run: null, released: false });
      else {
        if (options.prefer !== aiRepair.provider) aiRepair.revision++;
        Object.assign(aiRepair, { status: 'ready', provider: options.prefer, run: () => {}, released: false });
      }
    },
    inpaintDustOffMainThread: async () => { calls.telea++; return telea; },
    countAiRepairRun: work => work(), withAiRepairTurn: work => work(),
    inpaintWithModel: async () => {
      calls.inference++;
      if (failure === 'inference' || aiRepair.provider === 'webgpu') throw new Error('fixture inference failed');
      return { imageData: learned, tiles: 1, blocks: [] };
    },
    detectDustOffMainThread: async () => ({ mask, particleCount: particles }),
    loadFileToImageData: async () => clean, sanitizeSettings: value => structuredClone(value), withPendingEdits: (_item, settings) => settings,
    renderGeometryChain: async value => value, applyLensCorrectionWithSettings: async value => value,
    convertFrameOffMainThread: async ({ imageData }) => imageData, buildRouterSettings: value => value,
    applyAdjustmentsWithSettings: async value => { calls.encoded++; return value; },
    createPerfTrace: () => ({ mark() {}, end() {} }), getImageDataPixelCount: value => value.width * value.height,
    frameWantsAutoWhiteBalance: () => false,
    getCurrentExportImageData: async () => { calls.encoded++; return state.processedImageData; },
    applyDustResultToState: () => { calls.commits++; state.processedImageData = state.dustRemoval.inpaintedImageData; },
    inpaintManualBrush: async value => value, dustMaskInfo: () => null,
    ensureFullResolutionReadyForExport: async () => {}, ensureRepairsReadyForExport: async () => {} };
  const context = vm.createContext(new Proxy(target, { has: () => true, get: (t, key) => key in t ? t[key] : key in globalThis ? globalThis[key] : () => {} }));
  vm.runInContext(names.map(fn).join('\n'), context);
  return { context, state, settings, file, aiRepair, calls, clean, telea, learned };
}
const pixels = value => [Array.from(value.data), Array.from(value.__image16.data)];
const selected = process.argv[2] || 'all';

if (selected === 'all' || selected === 'batch') {
  for (const bitDepth of [8, 16]) {
    const f = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.context.processFileWithSettings(f.file, f.settings, { bitDepth, silent: true, dustRemoval: { ...f.state.dustRemoval } }),
        /AI repair model.*(unavailable|could not be loaded)|fixture model unavailable/, `batch ${bitDepth}-bit attempt ${attempt}: required AI must fail`);
    }
    assert.equal(f.calls.loads.length, 1, 'failed model is not repeatedly fetched');
    assert.deepEqual([f.calls.telea, f.calls.encoded, f.calls.commits], [0, 0, 0], 'no fallback pixels reach adjustment/encoding');
  }
  console.log('aiExportFailurePaths: two consecutive real batch failures at 8 and 16 bits reject without TELEA/encoding');
}
if (selected === 'all' || selected === 'single') {
  const f = fixture({ failure: 'inference' });
  const original = pixels(f.clean);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.context.renderCurrentImageDataForExport({ format: 'tiff', bitDepth: 16 }),
      /AI repair model.*(unavailable|could not be loaded)|fixture inference failed/, 'single ready-model inference failure must stop export');
  }
  assert.deepEqual([f.calls.telea, f.calls.encoded, f.calls.commits], [0, 0, 0]);
  assert.deepEqual(pixels(f.clean), original, 'editor samples are preserved');
  console.log('aiExportFailurePaths: real single preparation rejects ready-model inference failure and retry without commit/encoding');
}
if (selected === 'all' || selected === 'preview-stamp') {
  // The ordinary detection preview may have committed TELEA after a model
  // failure. Its matching stamp must not satisfy an AI-selected export.
  const preview = fixture();
  await preview.context.settleAiRepairModel({ load: true });
  preview.state.dustRemoval.inpaintedImageData = preview.telea;
  preview.state.processedImageData = preview.telea;
  preview.context.stampRepairResult(preview.telea, preview.context.currentRepairRecipe());
  assert.equal(preview.context.repairStamps.matches(preview.telea, preview.context.currentRepairRecipe()), true);
  await assert.rejects(preview.context.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 }), /AI repair model.*could not be loaded/,
    'a matching TELEA preview stamp cannot satisfy required AI');
  assert.deepEqual([preview.calls.telea, preview.calls.encoded, preview.calls.commits], [0, 0, 0]);
  console.log('aiExportFailurePaths: matching TELEA preview stamp cannot satisfy required AI export');
}
if (selected === 'all' || selected === 'controls') {
  for (const bitDepth of [8, 16]) {
    const f = fixture({ ai: false });
    const result = await f.context.processFileWithSettings(f.file, f.settings, { bitDepth, dustRemoval: { ...f.state.dustRemoval } });
    assert.deepEqual(pixels(result), pixels(f.telea), 'plain non-AI dust retains exact 8/16 samples');
    assert.deepEqual([f.calls.loads.length, f.calls.inference, f.calls.telea], [0, 0, 1]);
  }
  for (const fallbackFails of [false, true]) {
    const f = fixture({ failure: 'gpu', provider: 'webgpu', fallbackFails });
    const pending = f.context.processFileWithSettings(f.file, f.settings, { bitDepth: 16, dustRemoval: { ...f.state.dustRemoval } });
    if (fallbackFails) await assert.rejects(pending, /fixture inference failed|AI repair model.*(unavailable|could not be loaded)/);
    else {
      const result = await pending;
      assert.deepEqual(pixels(result), pixels(f.learned), 'successful WASM retry preserves its exact 8/16 samples');
      assert.equal(f.aiRepair.revision, 8, 'provider change has a different cache revision');
    }
    assert.equal(f.calls.telea, 0, 'failed/successful WASM retry never exports TELEA with AI selected');
    assert.equal(f.calls.loads[0].url, 'chosen-model.onnx');
    assert.deepEqual(f.calls.loads[0].options, { prefer: 'wasm', refresh: false });
  }
  const clean = fixture({ particles: 0 });
  assert.deepEqual(pixels(await clean.context.processFileWithSettings(clean.file, clean.settings, { bitDepth: 16 })), pixels(clean.clean));
  assert.deepEqual([clean.calls.loads.length, clean.calls.telea, clean.calls.inference], [0, 0, 0], 'empty dust needs no model');
  console.log('aiExportFailurePaths: AI-off TELEA, empty masks, chosen-model WASM retry and provider revision retain pixel/cache semantics');
}
