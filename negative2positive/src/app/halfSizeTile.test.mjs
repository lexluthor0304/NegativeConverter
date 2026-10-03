// R1-080: exercise the loader, held roll caller and canonical tile/cache
// orchestration, not just a size helper. Every fixture is at most 240x160.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { knownImageDimensions, rememberImageDimensions, resolveHalfDecodeFullSize } from './imageDimensions.js';
import { createThumbnailSourceCache } from './thumbnailSources.js';
import { reducedTileGeometry, renderReducedGeometry, reducedGeometryExact, tileGeometryKey } from './reducedGeometry.js';
import { planGeometry, renderGeometry, sanitizeCropRect } from './imageGeometry.js';
import { markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers } from './planeRelease.js';
import { buildRollSample } from './rollSample.js';
import { createExactGeometry } from './provisionalPhoto.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const source = readFileSync(process.env.NC229_ROLL_SIZING_MAIN || new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match && name === 'reconcileHalfSizeImage') return '';
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }\n', match.index) + 6);
}
const fullSize = { width: 240, height: 160 };
const crop = { left: 60, top: 40, width: 96, height: 64 };
function pixels(width = 240, height = 160) {
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = x * (240 / width) * 256 + 17;
    data[i + 1] = y * (160 / height) * 256 + 29;
    data[i + 2] = 30123; data[i + 3] = 65535;
  }
  return Object.assign(new ImageData(Uint8ClampedArray.from(data, v => v >>> 8), width, height), {
    __image16: { width, height, data }
  });
}
const recipe = { filmType: 'positive', rotationAngle: 0, mirrored: false, cropRegion: crop,
  filmEdge: { checked: true }, lensCorrection: { enabled: false }, repairStrokes: [] };
const scenarios = [
  { name: 'unshrunk false 480x320 tag', width: 240, height: 160, tag: { width: 480, height: 320 } },
  { name: 'genuine half without metadata or tag', width: 120, height: 80 },
  { name: 'genuine half with misleading metadata/tag', width: 120, height: 80, tag: { width: 480, height: 320 } },
  { name: 'unshrunk mismatched metadata', width: 240, height: 160 },
  { name: 'unknown shrinkage without remembered full size', width: 120, height: 80, unknown: true, remember: false },
  { name: 'neither full nor half of remembered size', width: 100, height: 70, unknown: true }
];

function harness(scene, { held = false } = {}) {
  const file = { name: 'frame.nef', size: 8, arrayBuffer: async () => new ArrayBuffer(8) };
  if (scene.remember !== false) rememberImageDimensions(file, fullSize);
  const item = { file, settings: structuredClone(recipe), automaticSettings: false };
  const calls = [], rendered = [], samples = [];
  let adapterDone = 0, claimReleases = 0;
  const cache = createThumbnailSourceCache();
  const make = () => {
    const image = pixels(scene.width, scene.height);
    if (scene.tag) Object.assign(image, { __fullSize: { ...scene.tag }, __decodeScale: .5 });
    if (scene.unknown) image.__halfSizeUncertain = true;
    return image;
  };
  const adapter = { analysis: { complete: true }, done() { adapterDone++; },
    held: { width: scene.width, height: scene.height, async sample(settings, options) {
      samples.push(options);
      return { sample: buildRollSample(make(), settings, { ...options, sanitizeCrop: sanitizeCropRect }) };
    } }
  };
  const context = vm.createContext({
    console, DOMException, state: { fileQueue: [{ file: { name: 'other.nef' } }, item], currentFileIndex: 0,
      autoFrame: { enabled: true }, dustRemoval: { enabled: false } },
    defaultFilmBaseBuffer: () => 10,
    createExactGeometry, twoStageDiagnostics: { stage1: [] }, noteTwoStageEvent() {}, reportFullDecodeFailure() {},
    knownImageDimensions, rememberImageDimensions, resolveHalfDecodeFullSize,
    createFrameClaim: () => ({ release() { claimReleases++; } }), memoryRuntime: {},
    sharedPlanesAvailable: () => false, isRawLikeFileName: name => /\.nef$/i.test(name),
    loadRawImageData: async (_buffer, _name, options) => {
      calls.push(options);
      if (!options.halfSize) return pixels();
      if (!held) return make();
      return { held: true, width: scene.width, height: scene.height,
        ...(scene.tag ? { fullSize: { ...scene.tag } } : {}), ...(scene.unknown ? { halfSizeUncertain: true } : {}) };
    },
    settleRollFrameClaim() {}, photoSessions: { hasRoomFor: () => false },
    createPerfTrace: () => ({ mark() {}, end() {} }), getImageDataPixelCount: image => image.width * image.height,
    assertRepairCurrent: valid => assert.ok(valid()), pendingGeometryEdits: () => null,
    markOwnedPlanes, planeBuffersOf, sharesPlaneBuffers, reducedTileGeometry, renderReducedGeometry, reducedGeometryExact, tileGeometryKey,
    sanitizeCropRegionForImage: sanitizeCropRect, sanitizeSettings: settings => structuredClone(settings),
    perPhotoSettingsFallback: () => ({}), lensCorrectionActive: () => false, expiredImportKeepsFullFrame: () => false,
    renderGeometryChain: async (image, geometry) => renderGeometry(image, planGeometry(image, geometry)),
    applyLensCorrectionWithSettings: async image => image,
    tileAnalysisReference: () => null, getColorAnalysisSample: () => null,
    renderPreviewFromWorkingImage: async image => { rendered.push(image); return image; },
    thumbnailSources: cache, STUDIO_TILE_PREVIEW_MAX: 288, automaticRollRevision: 0,
    automaticRollImportRunning: false, studioAutoFrameRunning: false,
    getCurrentQueueItem: () => null, photoSettingsKey: entry => JSON.stringify(entry.settings),
    backgroundConvert() {}, backgroundAnalyzers: () => null, keepWatchRollSample() {}, updateFileThumbnail() {},
    thumbnailDataUrl: image => `pixels:${image.__image16.data[0]},${image.__image16.data[1]}`
  });
  vm.runInContext(['reconcileHalfSizeImage', 'loadFileToImageData', 'openHalfSizeTileDecode', 'decodeRollFrame',
    'decodeRollFrameOnPage', 'processFileWithSettings', 'tileRecipeSettled', 'tileSourceFor', 'renderTileFromSource',
    'canDecodeTileHalfSize', 'beginLaneTile', 'beginProvisionalPhoto'].map(functionSource).join('\n'), context);
  return { context, item, file, calls, cache, rendered, samples, adapter, make,
    adapterDone: () => adapterDone, claimReleases: () => claimReleases };
}
function assertCrop(image, half, label) {
  const step = half ? 2 : 1;
  assert.deepEqual([image.width, image.height], [96 / step, 64 / step], `${label}: crop dimensions`);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    assert.deepEqual(Array.from(image.__image16.data.subarray(i, i + 4)),
      [(60 + x * step) * 256 + 17, (40 + y * step) * 256 + 29, 30123, 65535], `${label}: full-coordinate pixel ${x},${y}`);
  }
}
for (const scene of scenarios) {
  if (process.env.NC229_ROLL_SIZING_CASE && !scene.name.includes(process.env.NC229_ROLL_SIZING_CASE)) continue;
  const f = harness(scene);
  const tile = f.context.beginLaneTile(f.item);
  assert.equal(tile.halfSize, true);
  const lease = f.context.openHalfSizeTileDecode(f.item, null);
  const { base } = await lease.result;
  await tile.run(base, async () => {});
  const half = scene.width === 120 && !scene.unknown;
  console.log(`${scene.name}: tile=${f.rendered.at(-1).width}x${f.rendered.at(-1).height}, first=${f.item.thumbnail}`);
  assertCrop(f.rendered.at(-1), half, scene.name);
  assert.deepEqual(f.calls[0].knownFullSize, scene.remember === false ? null : fullSize,
    'the actual decoder receives earlier full-decode evidence');
  if (scene.unknown) assert.deepEqual(f.calls.map(call => Boolean(call.halfSize)), [true, false], 'ambiguous shrinkage retries full size');
  else if (half) assert.deepEqual(JSON.parse(JSON.stringify(base.__fullSize)), fullSize, 'known half gets full units without a metadata tag');
  else {
    assert.equal(base.__fullSize, undefined, 'unshrunk output clears false size tags');
    assert.equal(base.__decodeScale, undefined);
  }
  assert.deepEqual(knownImageDimensions(f.file), fullSize, 'a small decode never overwrites the known full dimensions');
  f.context.beginProvisionalPhoto({ file: f.file, fileName: f.file.name, plan: { width: 480, height: 320 } }, base, 1, f.item);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.state.provisional.fullSize)), fullSize,
    'the provisional-photo caller does not reinfer units from its misleading planning header');
  assert.equal(f.item.thumbnailKind, 'processed');
  // Reopening and changing only colour uses the retained canonical source.
  f.item.settings.coreExposure = 1;
  const reopened = f.context.beginLaneTile(f.item);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.source.baseSize)), fullSize, 'retained tile keeps full crop units');
  await reopened.run(null, async () => {});
  assertCrop(f.rendered.at(-1), half, `${scene.name}: reopened`);
  assert.equal(f.calls.length, scene.unknown ? 2 : 1, 'reopened tile does not decode again');
  // The export chain keeps every low bit of the original full plane.
  const exported = await f.context.processFileWithSettings(f.file, recipe, { stage: 'source', sourceImageData: pixels() });
  assertCrop(exported.source, false, `${scene.name}: full export source`);

  if (!scene.unknown) {
    const shared = harness(scene);
    await shared.context.beginLaneTile(shared.item).run(shared.make(), async () => {});
    assertCrop(shared.rendered.at(-1), half, `${scene.name}: supplied shared base`);
    assert.equal(shared.calls.length, 0, 'shared base uses the same reconciliation without a decode');
  }
  const h = harness(scene, { held: true });
  const decoded = await h.context.decodeRollFrame(h.file, {
    frames: { frame: () => h.adapter }, options: { half: true }, optionsKey: 'fixed', signal: null
  });
  assert.deepEqual(h.calls[0].knownFullSize, scene.remember === false ? null : fullSize, 'held caller forwards full evidence');
  if (scene.unknown) {
    assert.equal(h.adapterDone(), 1, 'ambiguous held frame is released before full-page recovery');
    assert.deepEqual(h.calls.map(call => Boolean(call.halfSize)), [true, false]);
    assert.equal(decoded.half, undefined, 'the full recovery never uses the stale half analysis');
    await h.context.beginLaneTile(h.item).run(decoded.base, async () => {});
    assertCrop(h.rendered.at(-1), false, 'held recovery tile');
  } else {
    assert.deepEqual(decoded.fullSize && JSON.parse(JSON.stringify(decoded.fullSize)), half ? fullSize : null);
    const sample = (await decoded.held.sample(recipe, { tileMax: 288, fullSize: decoded.fullSize || fullSize })).sample;
    assertCrop(sample.__tileWorking, half, 'held worker sample/tile');
  }
}
// A source retained before the reliable full decode cannot keep stale units
// on reopening: its already-cropped pixels need regeneration, not retagging.
if (!process.env.NC229_ROLL_SIZING_CASE) {
  const f = harness(scenarios[0]);
  const falseSize = { width: 480, height: 320 };
  const geometry = { rotationAngle: 0, mirrored: false, cropRegion: crop };
  const wrong = renderReducedGeometry(pixels(), geometry, { step: 1, fullWidth: falseSize.width, fullHeight: falseSize.height });
  f.cache.put(f.item, { working: wrong, baseSize: falseSize, geometryKey: tileGeometryKey(recipe, falseSize) });
  const reopened = f.context.beginLaneTile(f.item);
  assert.equal(reopened.source, null, 'a full decode disproves the retained source geometry on reopen');
  assert.equal(f.cache.has(f.item), false, 'the stale cropped source is invalidated');
  const { base } = await f.context.openHalfSizeTileDecode(f.item, null).result;
  await reopened.run(base, async () => {});
  assertCrop(f.rendered.at(-1), false, 'reopened stale source is regenerated from the correct coordinates');
}
console.log('halfSizeTile: page, held, supplied, ambiguous recovery, reopened cache and exact full export crop');
