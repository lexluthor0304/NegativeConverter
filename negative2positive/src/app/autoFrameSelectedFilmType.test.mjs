// Auto Frame Selected uses the same defaults/film-type gate as import, even
// when an unset B&W frame's light-source cast fails the preview chroma gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createAutoFrameWorkerClient } from './autoFrameWorkerClient.js';
import { runImportAnalyses } from './autoFrameExecution.js';
import { runImportRequest } from '../workers/autoFrameImportTask.js';
import { detectFrameAndRotation } from './autoFrameAnalyzer.js';
import { areaResizeToMaxSide, blockChromaP95, planLineSearch } from './autoFramePreview.js';
import { applyRotationToImageData, planGeometry, renderGeometry, rotatedDimensions, normalizeAngleDegrees } from './imageGeometry.js';
import { selectExportSamples, encodePng16Blob } from '../workers/imageEncoders.js';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { cachedAutoDetectFilmBase, cachedDetectFilmType, carryFilmStats } from './filmStatsCache.js';
import { detectedImportSettings } from './filmTypeDetection.js';
import { sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';
import { sanitizeFrameMetadata } from './analogMetadata.js';
import { AUTO_FRAME_FORMAT_RATIOS, AUTO_FRAME_DEFAULT_120_FORMATS, canAutoApplyImportFrame } from './autoFrameFormats.js';
import { imageAreaFromDetection } from './analysisRegion.js';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }\n', match.index) + 6);
}
function fixture() {
  const width = 900, height = 600, data = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(data.length);
  const rad = 2 * Math.PI / 180;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - width / 2, dy = y - height / 2;
    const u = dx * Math.cos(rad) + dy * Math.sin(rad), v = -dx * Math.sin(rad) + dy * Math.cos(rad);
    const grey = Math.abs(u) < 270 && Math.abs(v) < 180 ? 50 + ((x + y) % 100) : 200;
    const rgb = [grey * 1.08, grey, grey * 1.23];
    const at = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { data16[at + c] = Math.round(rgb[c] * 257); data[at + c] = data16[at + c] >>> 8; }
    data[at + 3] = 255; data16[at + 3] = 65535;
  }
  return Object.assign(new ImageData(data, width, height), { __image16: { width, height, data: data16 } });
}
const observed = [];
const client = createAutoFrameWorkerClient({ workerFactory: () => ({
  postMessage(message, transfers = []) {
    const received = structuredClone(message, { transfer: transfers });
    observed.push(received.frame?.frameFilmType);
    queueMicrotask(async () => {
      const { reply, transfers: moved } = await runImportRequest(received, { loadCv: async () => {}, detect: detectFrameAndRotation,
        rotate: applyRotationToImageData, readEdge: async () => null });
      this.onmessage?.({ data: structuredClone({ id: received.id, result: reply }, { transfer: moved }) });
    });
  }, terminate() {}
}) });
const item = { selected: true, file: { name: 'cast-bw.png' }, settings: null };
const state = { currentStep: 1, fileQueue: [item], importFilmTypeAuto: true, filmType: 'color', positiveMode: 'correct',
  autoFrame: { enabled: true, onImport: true, highConfidence: .72, minConfidence: .55, marginRatio: .02,
    deterministicPreview: true, neutralLineSearch: true, lowConfidenceBehavior: 'suggest', rotate180Default: false } };
const defaults = [], requests = [];
let releases = 0;
const context = vm.createContext({
  state, console, Worker: function Worker() {}, OffscreenCanvas: function OffscreenCanvas() {},
  Uint8Array, Uint8ClampedArray, Uint16Array, Date,
  sanitizeFilmTypeOverride, cachedAutoDetectFilmBase, cachedDetectFilmType, detectedImportSettings, carryFilmStats,
  EXPIRED_RESCUE_DEFAULTS, sanitizeFrameMetadata, normalizeAngleDegrees, rotatedDimensions,
  AUTO_FRAME_MAX_SIDE: 1600, AUTO_FRAME_FORMAT_RATIOS, AUTO_FRAME_DEFAULT_120_FORMATS,
  AUTO_FRAME_SCORE_WEIGHTS: { area: .18, rectangularity: .20, orthogonality: .14, parallelism: .10, edgeSupport: .18, centerPrior: .08, aspect: .12 },
  createPerfTrace: () => ({ end() {} }), recordPerfStages() {}, canAutoApplyImportFrame, imageAreaFromDetection,
  runImportAnalyses, analyzeFrameInWorker: client, ensureOpenCvReady: async () => true,
  analyzeFrameOnMainThread: () => { throw new Error('the worker should answer'); },
  readFilmEdge: async () => null, withDetectionOverlay: (_silent, run) => run(),
  createFrameClaim: () => ({ release() { releases++; } }),
  loadFileToImageData: async () => fixture(),
  importUserEdited: () => false, importFilmTypeRoll: () => null,
  document: { getElementById: () => null }, i18n: { en: {} }, currentLang: 'en',
  showBatchProgress() {}, updateBatchProgress() {}, updateFileListUI() {}, appAlert() {}, getCurrentQueueItem: () => null,
  withPendingEdits: (_item, settings) => settings, cloneSettings: structuredClone
});
vm.runInContext(['getImageDataPixelCount', 'clampBetween', 'sanitizeNumeric', 'makeLinearCurveLut',
  'createDefaultLensCorrectionSettings', 'autoDetectFilmBase', 'defaultFilmBaseBuffer', 'defaultSettingsInputs', 'createDefaultSettings',
  'settleImportFilmType', 'autoFrameAnalyzerOptions', 'runImportDetections', 'autoFrameEffectiveAngle', 'rotate180CropRegion',
  'analyzeStudioImportFrame', 'applyAutoFrameToSelected'].map(functionSource).join('\n'), context);
const createDefaults = context.createDefaultSettings;
context.createDefaultSettings = (...args) => {
  const value = createDefaults(...args); defaults.push(structuredClone(value)); return value;
};
const run = context.runImportDetections;
context.runImportDetections = (image, options) => { requests.push(options.frameFilmType); return run(image, options); };
const original = fixture();
const preview = areaResizeToMaxSide(original, 1600);
assert.ok(blockChromaP95(preview) >= 10, 'this cast does not qualify for the preview-only grey gate');
assert.equal(cachedDetectFilmType(original).filmType, 'bw', '#231 still types the coherent cast as B&W');
assert.equal(planLineSearch(preview, { enabled: true }).record.reason, 'colour', 'omitting the film type searches RGB');
await context.applyAutoFrameToSelected();
assert.equal(releases, 1);
assert.deepEqual(requests, ['bw'], 'Selected passes its own default film type before detection');
assert.equal(observed[0], 'bw', 'the actual worker request receives the type');
assert.equal(planLineSearch(preview, { enabled: true, filmType: observed[0] }).record.reason, 'bw-film');
assert.equal(defaults.length, 2, 'defaults are measured before and after the transferred frame returns');
assert.deepEqual(defaults[0], defaults[1], 'carried statistics give identical defaults after detection');
assert.ok(item.settings?.cropRegion, 'Selected found a real crop');
const importDefaults = createDefaults(original, item);
const imported = await context.analyzeStudioImportFrame(original, importDefaults);
assert.deepEqual(JSON.parse(JSON.stringify(item.settings.cropRegion)), JSON.parse(JSON.stringify(imported.cropRegion)), 'import and Selected crop equally');
assert.equal(item.settings.rotationAngle, imported.rotationAngle);
// The exact geometry and conversion stages used by exports, both 8/16-bit.
const render = settings => convertFrameWithRouter({ imageData: renderGeometry(original, planGeometry(original, settings)), settings });
const selectedExport = await render(item.settings), importExport = await render(imported);
const sha = samples => createHash('sha256').update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex');
assert.deepEqual([selectedExport.width, selectedExport.height], [importExport.width, importExport.height]);
for (const bitDepth of [8, 16]) {
  const selectedSamples = selectExportSamples(selectedExport, bitDepth), importSamples = selectExportSamples(importExport, bitDepth);
  assert.equal(selectedSamples.sampleBits, bitDepth);
  assert.equal(sha(selectedSamples.samples), sha(importSamples.samples), `export samples equal after Selected/import (${bitDepth}-bit)`);
}
const pako = createRequire(import.meta.url)('pako');
const encode = frame => encodePng16Blob(selectExportSamples(frame, 16).samples, frame.width, frame.height, pako).arrayBuffer();
assert.equal(sha(new Uint8Array(await encode(selectedExport))), sha(new Uint8Array(await encode(importExport))), 'PNG16 exports are identical');
// Saved/manual settings still supply this frame's type instead of defaults.
item.settings = { ...item.settings, filmType: 'positive', filmTypeSource: 'manual' };
await context.applyAutoFrameToSelected();
assert.equal(requests.at(-1), 'positive');
client.dispose();
console.log('autoFrameSelectedFilmType: cast B&W defaults, bw-film gate, crop/export parity and saved type');
