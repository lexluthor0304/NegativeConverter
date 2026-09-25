// The export branch of processFileWithSettings (no previewMaxDimension, no
// tileMaxDimension) must behave exactly as it did before #247: the same
// stage calls with the same arguments, the same returned pixels (8 and 16
// bits), the same prepared settings and recipe writes. The function as #251
// left it (processFileWithSettings.reference.mjs) and the current one run
// side by side against the same deterministic stages; the current one uses
// its real helpers from main.js.
// Run with: node negative2positive/src/app/processFileWithSettings.parity.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import v8 from 'node:v8';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { applyGeometryChainToImageData, applyRotationToImageData, mirrorImageDataHorizontal, sanitizeCropRect, normalizeAngleDegrees, rotatedDimensions } = await import('./imageGeometry.js');
const { cropImageDataRegion, downsampleImageDataForMaxDim } = await import('./imageDataOps.js');
const { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } = await import('./adjustmentPipeline.js');
const { markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers, releaseOwnedPlanes, configurePlaneRelease } = await import('./planeRelease.js');
const { reducedTileGeometry, renderReducedGeometry, tileGeometryKey } = await import('./reducedGeometry.js');
const { HEAD_PROCESS_FILE_WITH_SETTINGS } = await import('./processFileWithSettings.reference.mjs');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
const current = ['processFileWithSettings', 'removeFrameDust', 'frameWantsAutoWhiteBalance', 'applyFrameAutoWhiteBalance',
  'applyFrameExpiredAnalysis', 'resolveLensCorrection', 'lensCorrectionActive', 'tileRecipeSettled', 'perPhotoSettingsFallback',
  'expiredImportKeepsFullFrame', 'renderPreviewFromWorkingImage', 'tileAnalysisReference'].map(functionSource).join('\n');

const exportSteps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? cropImageDataRegion(image, rect) : image;
  }
};
const digest = image => image ? createHash('sha256').update(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength))
  .update(image.__image16 ? Buffer.from(image.__image16.data.buffer) : Buffer.alloc(0)).digest('hex').slice(0, 16) : null;
const describe = image => image ? `${image.width}x${image.height}:${digest(image)}` : null;

function makeBase(width, height, seed) {
  let s = seed;
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i + c] = 3000 + s % 60000; }
    data[i + 3] = 65535;
  }
  const image = new ImageData(Uint8ClampedArray.from(data, v => v >>> 8), width, height);
  image.__image16 = { width, height, data };
  return image;
}

// A deterministic stand-in for every leaf stage, recording its arguments.
function stages(log, { automatic }) {
  const invert = (image, settings) => {
    const data16 = new Uint16Array(image.__image16.data.length);
    const gain = 1 + (Number(settings.coreExposure) || 0) / 100;
    for (let i = 0; i < data16.length; i += 4) {
      for (let c = 0; c < 3; c++) data16[i + c] = Math.min(65535, Math.round((65535 - image.__image16.data[i + c]) * gain));
      data16[i + 3] = 65535;
    }
    const out = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), image.width, image.height);
    out.__image16 = { width: image.width, height: image.height, data: data16 };
    out.__analysisPreview = downsampleImageDataForMaxDim(out, 16);
    return out;
  };
  const brighten = (image, amount) => {
    const out = new ImageData(image.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + amount))), image.width, image.height);
    if (image.__image16) out.__image16 = { ...image.__image16, data: image.__image16.data.map((v, i) => (i % 4 === 3 ? v : Math.min(65535, v + amount * 257))) };
    return out;
  };
  const record = (name, value) => { log.push(`${name}:${JSON.stringify(value)}`); };
  return {
    renderGeometryChain: async (image, geometry, options) => {
      record('geometry', { image: describe(image), geometry, bands: options.maxInFlight ?? null });
      return applyGeometryChainToImageData(image, geometry, exportSteps);
    },
    applyLensCorrectionWithSettings: async (image, settings) => {
      record('lens', { image: describe(image), enabled: Boolean(settings.lensCorrection?.enabled) });
      return settings.lensCorrection?.enabled ? brighten(image, 1) : image;
    },
    buildRouterSettings: (settings, base) => ({ coreExposure: settings.coreExposure, filmType: settings.filmType, base: [base.width, base.height] }),
    getColorAnalysisSample: (settings, base) => ({ ref: describe(base), area: settings.autoFrameMeta?.imageArea || null }),
    detectDustOffMainThread: async (image, options, _unused, _isCurrent, worker) => {
      record('dust', { image: describe(image), options, worker: worker ?? null });
      return { mask: new Uint8Array(image.width * image.height), particleCount: 2 };
    },
    inpaintForCommit: async (image, _mask, _isCurrent, worker, options) => {
      record('inpaint', { image: describe(image), worker: worker ?? null, options });
      return brighten(image, 3);
    },
    inpaintManualBrush: async (image, settings, base, mapping, _isCurrent, options) => {
      record('brush', { image: describe(image), strokes: settings.repairStrokes.length, base: [base.width, base.height], mapping: mapping ?? null, options });
      return brighten(image, 5);
    },
    withAiRepairTurn: work => work(),
    usesSilverCoreConversion: settings => settings.engine !== 'legacy',
    sanitizePresetType: type => type,
    resolveAnalysisRegion: (settings, base) => settings.autoFrameMeta?.imageArea ? { left: 0.1, top: 0.1, width: 0.8, height: 0.8, base: [base.width, base.height] } : null,
    analysisPixelBounds: (width, height, roi, border) => ({ left: Math.floor(width * roi.left), top: Math.floor(height * roi.top), width: Math.floor(width * roi.width), height: Math.floor(height * roi.height), border }),
    cropImageData: (image, rect) => { record('wbCrop', rect); return cropImageDataRegion(image, rect); },
    estimateAutoWhiteBalance: (image, options) => {
      record('wb', { image: describe(image), options: options ?? null });
      return { wbR: 1 + image.data[0] / 1000, wbG: 1, wbB: 1 - image.data[1] / 1000, confidence: 'high' };
    },
    measureExpiredAnalysisForExport: async (image, settings, base) => {
      record('expired', { image: describe(image), base: [base.width, base.height] });
      return { fog: image.data[2] };
    },
    applyExpiredAnalysisDefaults: (settings, analysis) => { settings.expiredAnalysis = analysis; },
    applyAdjustmentsWithSettings: async (image, settings, options) => {
      record('adjust', { image: describe(image), bitDepth: options.bitDepth, bridge: Boolean(options.bridge) });
      const output = new ImageData(new Uint8ClampedArray(image.data.length), image.width, image.height);
      const lut = Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, v + 9));
      const prepared = { ...settings, saturation: 20, vibrance: 15, curves: { r: lut, g: lut, b: lut } };
      (options.bitDepth === 16 ? applyPreparedAdjustmentsToBuffer16 : applyPreparedAdjustmentsToBuffer)(image, prepared, output);
      return output;
    },
    buildAdjustmentSettings: settings => settings,
    convertFrameOffMainThread: async request => {
      record('convert', { image: describe(request.imageData), settings: request.settings, options: { ...request.options, analysisImageData: request.options.analysisImageData }, role: request.sourceRole });
      return invert(request.imageData, request.settings);
    },
    automaticItem: automatic
  };
}

function run(fn, { base, saved, options, dust, automatic }) {
  const log = [];
  const file = { name: 'frame.dng', size: 1 };
  const item = { file, settings: saved ? structuredClone(saved) : null, automaticSettings: automatic, studioColors: { coreExposure: 7 } };
  const context = vm.createContext({
    // A photo left inside a two-stage window (#255): none here.
    pendingGeometryEdits: () => null, withPendingEdits: (item, settings) => settings,
    state: { fileQueue: [item], dustRemoval: { enabled: dust, strength: 4, maxParticleSize: 30 }, autoFrame: { enabled: true },
      importFilmTypeAuto: true, lensCorrection: { enabled: false } },
    ...stages(log, { automatic }),
    createPerfTrace: () => ({ mark: (stage, extra) => log.push(`mark:${stage}:${JSON.stringify(extra)}`), end: () => {} }),
    getImageDataPixelCount: image => image.width * image.height,
    // `halfSize: false` is the loader's default: the export branch never asks for one.
    loadFileToImageData: async (_file, { halfSize = false, ...options }) => {
      log.push(`load:${JSON.stringify(halfSize ? { ...options, halfSize } : options)}`);
      return base;
    },
    assertRepairCurrent: () => {},
    sanitizeSettings: (settings, options) => ({ ...(options.fallbackSettings?.lensCorrection ? { lensCorrection: options.fallbackSettings.lensCorrection } : {}), ...structuredClone(settings) }),
    createDefaultSettings: (image, queued) => ({ filmType: 'color', coreExposure: 2, defaultsFor: [image.width, image.height, Boolean(queued)] }),
    mergeStudioColors: (target, colors) => ({ ...target, ...colors }),
    analyzeStudioImportFrame: async (image, settings, options) => {
      log.push(`frame:${JSON.stringify({ image: describe(image), allowCrop: options.allowCrop, silent: options.silent })}`);
      return { ...settings, autoFrameMeta: { imageArea: [{ x: 0.1, y: 0.1 }] }, ...(options.allowCrop ? { rotationAngle: 0.8, cropRegion: { left: 4, top: 3, width: 50, height: 30 } } : {}) };
    },
    expiredImportKeepsFullFrame: settings => Boolean(settings.expiredEnabled) && settings.filmType === 'positive',
    // Frame and film edge in one request, then folded into the recipe (#251).
    runImportDetections: async (image, options) => {
      log.push(`detect:${JSON.stringify({ image: describe(image), ...options, reload: typeof options.reload })}`);
      return { image, detection: { result: null }, read: { result: null } };
    },
    mergeImportFilmEdge: async (image, settings, read, options) => {
      log.push(`edge:${JSON.stringify({ image: describe(image), read, options })}`);
      return { settings: { ...settings, filmEdge: { checked: true } } };
    },
    learnedImportSettings: async settings => ({ ...settings, learned: true }),
    settleImportFilmType: (_item, settings) => ({ ...settings, settled: true }),
    cloneSettings: settings => structuredClone(settings),
    normalizeAngleDegrees, rotatedDimensions, hasExactPlane16: image => Boolean(image?.__image16),
    sanitizeCropRegionForImage: sanitizeCropRect, downsampleImageDataForMaxDim,
    reducedTileGeometry, renderReducedGeometry, tileGeometryKey,
    sampleAnalysisArea: () => null, TILE_ANALYSIS_REFERENCE_PIXELS: 16384,
    createAdjustedPhotoPreview: () => { throw new Error('no preview on the export branch'); },
    markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers, releaseOwnedPlanes,
    isConversionInputLost: (err) => Boolean(err) && err.code === 'INPUT_LOST',
    convertFrameWithRouter: async () => { throw new Error('no main-thread conversion here'); }
  });
  // #251's in-place analysis-region sample, real in both runs.
  vm.runInContext(`${functionSource('analysisRegionSample')}\n${fn}`, context);
  return { context, item, log, file };
}

const recipes = {
  plain: { filmType: 'color', coreExposure: 5, autoFrameMeta: { imageArea: [{ x: 0.1, y: 0.1 }] }, filmEdge: { checked: true },
    rotationAngle: 0, mirrored: false, cropRegion: null, repairStrokes: [], lensCorrection: { enabled: false } },
  geometry: { filmType: 'color', coreExposure: -3, autoFrameMeta: {}, filmEdge: { checked: true }, rotationAngle: 1.7, mirrored: true,
    cropRegion: { left: 6, top: 4, width: 48, height: 30 }, repairStrokes: [{ size: 1, points: [] }], lensCorrection: { enabled: true, selectedLens: { handle: 3 } } },
  expired: { filmType: 'color', expiredEnabled: true, autoFrameMeta: {}, filmEdge: { checked: true }, rotationAngle: 90, mirrored: false,
    cropRegion: null, repairStrokes: [], lensCorrection: { enabled: false } },
  bw: { filmType: 'bw', autoFrameMeta: null, filmEdge: null, rotationAngle: 0, cropRegion: null, repairStrokes: [], lensCorrection: { enabled: false } }
};
let cases = 0;
for (const [label, saved] of [...Object.entries(recipes), ['no recipe', null]]) {
  for (const options of [{ bitDepth: 8 }, { bitDepth: 16, bridge: {} }, { stage: 'processed', dustWorker: 'w', geometryBands: 2 },
    { stage: 'source' }, { bitDepth: 8, silent: true, updateItemSettings: false, dustRemoval: { enabled: true, strength: 9 } }]) {
    for (const dust of [false, true]) for (const automatic of [false, true]) {
      const base = makeBase(64, 40, cases + 1);
      const args = { base, saved, options, dust, automatic };
      const head = run(HEAD_PROCESS_FILE_WITH_SETTINGS, args);
      const now = run(current, args);
      const prepared = [];
      const call = async r => {
        const result = await r.context.processFileWithSettings(r.file, saved ? structuredClone(saved) : null,
          { ...options, onPreparedSettings: settings => prepared.push(JSON.stringify(settings)) });
        return result?.processed ? { processed: describe(result.processed), settings: JSON.stringify(result.settings) }
          : result?.source ? { source: describe(result.source), settings: JSON.stringify(result.settings) }
          : { adjusted: describe(result) };
      };
      const label2 = `${label} ${JSON.stringify(options)} dust=${dust} auto=${automatic}`;
      const a = await call(head);
      const b = await call(now);
      assert.deepEqual(b, a, `${label2}: result`);
      assert.deepEqual(now.log, head.log, `${label2}: stage calls and arguments`);
      assert.deepEqual(JSON.stringify(now.item.settings), JSON.stringify(head.item.settings), `${label2}: recipe write`);
      assert.equal(prepared.length, options.stage === 'source' ? 0 : 2);
      if (prepared.length) assert.equal(prepared[1], prepared[0], `${label2}: prepared settings`);
      cases++;
    }
  }
}
console.log(`processFileWithSettings parity: ${cases} export-branch cases match HEAD (calls, pixels, settings)`);

// #256: a batch export's options change no stage call, no pixel and no
// setting: `releaseEarly` (the base and the working plane are released once
// the conversion resolves), a base decoded ahead (`sourceOwned`: no load of
// its own), the learning barrier and the base-ready signal. A conversion
// that lost a derived working plane is rebuilt from the retained base with
// the same geometry and converted by the fallback: the same pixels.
configurePlaneRelease({ engine: 'none' });
let batchCases = 0;
for (const [label, saved] of [...Object.entries(recipes), ['no recipe', null]]) {
  for (const prepared of [false, true]) for (const lose of [false, true]) for (const dust of [false, true]) for (const automatic of [false, true]) {
    const seed = 900 + batchCases;
    const headOptions = { stage: 'processed', dustWorker: 'w', geometryBands: 2 };
    const head = run(HEAD_PROCESS_FILE_WITH_SETTINGS, { base: makeBase(64, 40, seed), saved, options: headOptions, dust, automatic });
    const nowBase = makeBase(64, 40, seed);
    const now = run(current, { base: nowBase, saved, options: headOptions, dust, automatic });
    const ownedPlanes = [];
    let barrierCalls = 0;
    let baseReady = 0;
    let lost = 0;
    let fallbacks = 0;
    const convertAsBefore = now.context.convertFrameOffMainThread;
    if (lose) {
      now.context.convertFrameOffMainThread = async (request) => {
        if (request.sourceRole === 'derived' && !lost) {
          lost += 1;
          request.imageData.__image16.data = new Uint16Array(0);
          const err = new Error('lane crashed after the transfer');
          err.code = 'INPUT_LOST';
          throw err;
        }
        return convertAsBefore(request);
      };
    }
    const label2 = `${label} batch prepared=${prepared} lose=${lose} dust=${dust} auto=${automatic}`;
    const a = await head.context.processFileWithSettings(head.file, saved ? structuredClone(saved) : null, { ...headOptions });
    const b = await now.context.processFileWithSettings(now.file, saved ? structuredClone(saved) : null, {
      ...headOptions, releaseEarly: true, ownedPlanes,
      learningBarrier: async () => { barrierCalls += 1; },
      onBaseReady: () => { baseReady += 1; },
      convertFallback: async (request) => { fallbacks += 1; return convertAsBefore(request); },
      ...(prepared ? { sourceImageData: nowBase, sourceOwned: true } : {})
    });
    assert.equal(describe(b.processed), describe(a.processed), `${label2}: pixels`);
    assert.equal(JSON.stringify(b.settings), JSON.stringify(a.settings), `${label2}: settings`);
    assert.deepEqual(JSON.stringify(now.item.settings), JSON.stringify(head.item.settings), `${label2}: recipe write`);
    const expected = prepared ? head.log.filter(line => !line.startsWith('load:')) : head.log;
    if (lost) {
      // The rebuild repeats the geometry and lens calls of the first pass.
      const convertAt = expected.findIndex(line => line.startsWith('convert:'));
      const rebuild = expected.filter(line => line.startsWith('geometry:') || line.startsWith('lens:'));
      const redone = [...expected.slice(0, convertAt), ...rebuild,
        ...expected.slice(convertAt).map(line => line.startsWith('convert:') ? line.replace(/,"role":"derived"\}$/, '}') : line)];
      assert.deepEqual(now.log, redone, `${label2}: rebuilt from the base`);
      assert.equal(fallbacks, 1);
    } else {
      assert.deepEqual(now.log, expected, `${label2}: stage calls and arguments`);
      assert.equal(fallbacks, 0);
    }
    assert.equal(barrierCalls, saved ? 0 : 1, `${label2}: the barrier guards the learned defaults`);
    assert.equal(baseReady, 1);
    // Released before the stages after the conversion: neither the base nor
    // a geometry output stays in the frame's owned planes.
    assert.ok(!ownedPlanes.some(plane => sharesPlaneBuffers(plane, nowBase)), `${label2}: base released`);
    assert.ok(ownedPlanes.includes(b.processed) || !ownedPlanes.length, `${label2}: later planes stay the caller's`);
    batchCases++;
  }
}
console.log(`processFileWithSettings batch options: ${batchCases} cases match HEAD`);

// #256 acceptance: once the conversion has resolved, the frame's decoded base
// and its working planes (geometry and lens outputs) hold no memory, before
// dust removal, repairs, auto WB and the encode run. The probe runs in the
// dust stage, which follows the conversion.
// - Released the WebKit way (transfer(0)), every one of their buffers is
//   detached: the backing stores are gone whatever still points at them.
// - Only dropped (an engine without transfer), the base, the geometry output
//   and the lens output are unreachable (a FinalizationRegistry probe after
//   full collections, --expose-gc through v8 flags). A suspended async frame
//   keeps its registers, so the lists that held the planes are emptied and
//   walked in callbacks, never in a loop variable of the frame.
{
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  for (const engine of ['webkit', 'none']) {
    configurePlaneRelease({ engine });
    const collected = new Set();
    const registry = new FinalizationRegistry((name) => collected.add(name));
    const buffers = [];
    const probe = run(current, { base: null, saved: recipes.geometry, options: {}, dust: true, automatic: false });
    const watch = (name, image) => {
      if (engine === 'none') registry.register(image, name);
      else buffers.push([name, image.data.buffer], [`${name}16`, image.__image16.data.buffer]);
      return image;
    };
    const geometryStage = probe.context.renderGeometryChain;
    probe.context.renderGeometryChain = async (...args) => watch('geometry', await geometryStage(...args));
    const lensStage = probe.context.applyLensCorrectionWithSettings;
    probe.context.applyLensCorrectionWithSettings = async (...args) => watch('lens', await lensStage(...args));
    const dustStage = probe.context.detectDustOffMainThread;
    let atDust = null;
    probe.context.detectDustOffMainThread = async (...args) => {
      for (let i = 0; i < 4; i++) {
        gc();
        await new Promise(resolve => setImmediate(resolve));
      }
      atDust = engine === 'none'
        ? [...collected].sort()
        : buffers.filter(([, buffer]) => !buffer.detached).map(([name]) => name);
      return dustStage(...args);
    };
    const result = await probe.context.processFileWithSettings(probe.file, structuredClone(recipes.geometry), {
      stage: 'processed', releaseEarly: true, ownedPlanes: [], sourceImageData: watch('base', makeBase(64, 40, 4242)), sourceOwned: true
    });
    assert.ok(result.processed);
    if (engine === 'none') assert.deepEqual(atDust, ['base', 'geometry', 'lens'], 'unreachable after the conversion');
    else assert.deepEqual(atDust, [], 'every buffer of the base and the working planes is released after the conversion');
  }
  configurePlaneRelease({ engine: 'none' });
  console.log('processFileWithSettings releaseEarly: the base and working planes are released after the conversion');
}
