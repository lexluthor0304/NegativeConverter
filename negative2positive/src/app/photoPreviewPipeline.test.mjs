import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { downsampleImageDataForMaxDim } from './imageDataOps.js';
import { createAdjustedPhotoPreview } from './photoPreview.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';

// Execute the real orchestration with actual downsampling/final adjustments.
// Only expensive conversion, Lensfun and AI operations are substituted. Their
// argument records pin the coordinate space, precision and call ordering.
class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
globalThis.ImageData = TestImageData;
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function processFileWithSettings(');
assert.ok(start >= 0);
const end = source.indexOf('\n    }', start);
const runtime = source.slice(start, end + '\n    }'.length);
const noop = () => {};
const identity = Uint8Array.from({ length: 256 }, (_, value) => value);

function fixture({ lens = false, brush = false, dust = false, width = 600, height = 400 } = {}) {
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < plane.length; i += 4) {
    plane[i] = 0x1234; plane[i + 1] = 0x5678; plane[i + 2] = 0x9abc; plane[i + 3] = 65535;
  }
  const image = new TestImageData(Uint8ClampedArray.from(plane, value => value >>> 8), width, height);
  image.__image16 = { width, height, data: plane };
  const mapping = { maps: { gridWidth: 2, gridHeight: 2, step: width,
    geometry: new Float32Array([0, 0, width, 0, 0, height, width, height]) }, includeTca: false };
  const corrected = new TestImageData(image.data, width, height);
  corrected.__image16 = image.__image16;
  if (lens) Object.defineProperty(corrected, '__lensMapping', { value: mapping });
  const file = { name: 'fixture.png', size: image.data.byteLength };
  const settings = {
    filmType: 'color', autoFrameMeta: {}, filmEdge: { checked: true },
    rotationAngle: 0, mirrored: false, cropRegion: null,
    lensCorrection: { enabled: lens },
    repairStrokes: brush ? [{ size: 0.02, points: [{ x: 0.25, y: 0.5 }] }] : [],
    curves: { r: identity, g: identity, b: identity }
  };
  const calls = { conversions: [], dust: [], brushes: [], adjustments: [], previews: [], downsample: [], decoded: 0 };
  const context = vm.createContext({
    state: { fileQueue: [{ file, settings }], dustRemoval: { enabled: dust, strength: 3, maxParticleSize: 40 }, exportFormat: 'png' },
    createPerfTrace: () => ({ mark: noop, end: noop }),
    getImageDataPixelCount: image => image.width * image.height,
    loadFileToImageData: async () => { calls.decoded++; return image; },
    assertRepairCurrent: isCurrent => { if (!isCurrent()) throw Object.assign(new Error('stale'), { name: 'AbortError' }); },
    sanitizeSettings: settings => structuredClone(settings),
    applyGeometryChainToImageData: () => image, exportGeometrySteps: {},
    applyLensCorrectionWithSettings: async () => corrected,
    downsampleImageDataForMaxDim: (source, max) => {
      calls.downsample.push([source.width, source.height, max]);
      return downsampleImageDataForMaxDim(source, max);
    },
    buildRouterSettings: settings => settings,
    getColorAnalysisSample: () => image,
    convertFrameOffMainThread: async request => {
      calls.conversions.push(request);
      return request.imageData;
    },
    detectDustOffMainThread: async (source, options) => {
      calls.dust.push({ source, options });
      return { mask: new Uint8Array(source.width * source.height), particleCount: 0 };
    },
    withAiRepairTurn: work => work(),
    inpaintManualBrush: async (source, settings, base, lensMapping) => {
      calls.brushes.push({ source, settings, base, lensMapping });
      return source;
    },
    buildAdjustmentSettings: settings => settings,
    createAdjustedPhotoPreview: (source, settings, options) => {
      calls.previews.push({ source, options });
      return createAdjustedPhotoPreview(source, settings, options);
    },
    applyAdjustmentsWithSettings: async (source, settings, options) => {
      calls.adjustments.push({ source, options });
      const output = new TestImageData(new Uint8ClampedArray(source.data.length), source.width, source.height);
      (options.bitDepth === 16 ? applyPreparedAdjustmentsToBuffer16 : applyPreparedAdjustmentsToBuffer)(source, settings, output);
      return output;
    },
    safeStorageGet: () => 'off'
  });
  vm.runInContext(runtime, context);
  return { context, calls, image, corrected, mapping, settings, file };
}

// Regression: early downsampling loses the non-enumerable native Lensfun map.
// Keep native geometry through conversion and brush repair for this combination;
// only the final adjusted preview may shrink it.
{
  const f = fixture({ lens: true, brush: true, dust: true });
  const result = await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [600, 400],
    'lens-mapped repairs must convert at the mapping native dimensions');
  assert.equal(request.options.preview, false, 'native repairs must not enter a preview conversion path');
  assert.equal(request.imageData.__image16, f.image.__image16, 'native conversion receives the original precision');
  assert.equal(f.calls.brushes[0].lensMapping, f.mapping, 'repair receives the native lens-coordinate mapping');
  assert.equal(f.calls.brushes[0].source.width, 600);
  assert.equal(f.calls.brushes[0].base, f.image);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40, 'native repair keeps native dust size');
  assert.equal(f.calls.downsample.length, 0, 'do not discard mapping before conversion/repair');
  assert.equal(f.calls.previews[0].source.width, 600);
  assert.deepEqual([result.width, result.height], [288, 192]);
  assert.equal(f.calls.adjustments.length, 0, 'no separate full-frame adjustment pass for a thumbnail');
}

// Ordinary thumbnails retain the small-conversion path, including lens-only or
// brush-only photos. Dust size follows the actual post-crop/lens dimensions.
for (const options of [{}, { lens: true }, { brush: true }]) {
  const f = fixture({ ...options, dust: true });
  const result = await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  const request = f.calls.conversions[0];
  assert.deepEqual([request.imageData.width, request.imageData.height], [200, 133]);
  assert.equal(request.options.preview, true);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 13,
    '40 native pixels scale to round(40 * 133 / 400), not 40 preview pixels');
  assert.deepEqual([result.width, result.height], [200, 133]);
  assert.equal(f.calls.adjustments.length, 0);
  if (options.brush) assert.equal(f.calls.brushes[0].source.width, 200);
}

{
  const f = fixture({ dust: true });
  await f.context.processFileWithSettings(f.file, f.settings, {
    previewMaxDimension: 12, dustRemoval: { enabled: true, strength: 7, maxParticleSize: 6 }
  });
  assert.equal(f.calls.dust[0].options.strength, 7);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 3, 'preview scaling retains the existing three-pixel floor');
}

// No resize means no dust-size change (including callers with a small source).
{
  const f = fixture({ dust: true, width: 12, height: 8 });
  await f.context.processFileWithSettings(f.file, f.settings, { previewMaxDimension: 288 });
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40);
}

// Default full-resolution exports keep the existing precision/dimensions and
// native repair mapping. Real prepared 16-bit adjustments pin every sample.
for (const bitDepth of [8, 16]) {
  const f = fixture({ lens: true, brush: true, dust: true, width: 24, height: 16 });
  const planeBefore = f.image.__image16.data.slice();
  const bridge = {};
  const result = await f.context.processFileWithSettings(f.file, f.settings, { bitDepth, bridge });
  assert.equal(f.calls.conversions[0].imageData, f.corrected);
  assert.equal(f.calls.conversions[0].options.preview, false);
  assert.equal(f.calls.conversions[0].options.forceFullProcess, true);
  assert.equal(f.calls.downsample.length, 0);
  assert.equal(f.calls.previews.length, 0);
  assert.equal(f.calls.adjustments[0].options.bitDepth, bitDepth);
  assert.equal(f.calls.adjustments[0].options.bridge, bridge);
  assert.equal(f.calls.brushes[0].lensMapping, f.mapping);
  assert.equal(f.calls.dust[0].options.maxParticleSize, 40);
  assert.deepEqual([result.width, result.height], [24, 16]);
  if (bitDepth === 16) assert.deepEqual(result.__image16.data, planeBefore);
  assert.deepEqual(f.image.__image16.data, planeBefore, 'source precision is never modified');
  assert.deepEqual(result.data, f.image.data, 'identity final adjustments preserve all RGBA8 samples');
}

console.log('photoPreviewPipeline tests passed');
