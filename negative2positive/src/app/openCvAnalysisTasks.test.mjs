// Standalone Node test for openCvAnalysisTasks.js (#245) - run with:
// node negative2positive/src/app/openCvAnalysisTasks.test.mjs
//
// The page's OpenCV analyses now run in the auto-frame worker on inputs the
// page builds. With the real opencv-js build, every worker entry point (the
// message as postMessage would transfer it, the task, the reply cloned back)
// must give exactly what the functions gave before the split:
// - Apply Crop's crop-area points (hits, misses, a rotated 16-bit frame
//   sampled by the geometry core, a real 8-bit strip fixture);
// - the expired rescue's spatial maps and the analysis built from them, on a
//   16-bit plane, sliced or not;
// - lab match's homography and warped reference, and a bracket pair's
//   homography.
// The page-side fallback runner is checked with fake workers.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let cv = require('@techstark/opencv-js');
if (cv && typeof cv.then === 'function') cv = await cv;
if (cv && !cv.Mat && cv.default) cv = cv.default;
assert.ok(cv && cv.Mat, 'opencv-js loads in Node');
globalThis.cv = cv;
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
    this.data = data; this.width = width; this.height = height;
  }
};

const {
  runOpenCvAnalysisTask, createOpenCvTaskRunner, cropDetectionMessage, expiredSpatialMessage, alignmentMessage,
  isOpenCvAnalysisType, alignAndWarp
} = await import('./openCvAnalysisTasks.js');
const { buildCropDetectionInput, detectCropAreaInRegion, detectCropImageArea } = await import('./cropColorAnalysis.js');
const {
  sampleExpiredSpatialInput, sampleExpiredSpatialInputSliced, measureExpiredSpatialMaps, measureExpiredSpatialMapsFromSample,
  expiredAnalysisFromMaps
} = await import('./expiredRescueOpenCv.js');
const { sampleAlignmentGray, alignmentSide } = await import('./imageAlignment.js');
const { planGeometry, renderGeometry, applyRotationToImageData, rotatedDimensions } = await import('./imageGeometry.js');
const { downsampleImageDataForMaxPixels } = await import('./imageDataOps.js');
const { AUTO_FRAME_FORMAT_RATIOS } = await import('./autoFrameFormats.js');
const {
  analyzeExpiredFilm, buildExpiredSpatialStage, fitExpiredSpatial, sanitizeExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS
} = await import('../pipeline/expiredRescue.js');
const reference = await import('./openCvAnalysis.reference.mjs');
const headAlignment = await import('./multiShot.reference.mjs');

// A worker round trip: the request and the reply are structured-cloned with
// their transfer lists, as postMessage does.
async function viaWorker(type, { payload, transfers }) {
  const message = structuredClone({ ...payload, type, id: 1 }, { transfer: transfers });
  for (const buffer of transfers) assert.equal(buffer.byteLength, 0, `${type}: the page's buffers are transferred, not copied`);
  const { result, transfers: back } = runOpenCvAnalysisTask(message);
  return structuredClone(result, { transfer: back });
}

const targets = Object.entries(AUTO_FRAME_FORMAT_RATIOS).map(([key, ratio]) => ({ key, ratio }));

function make(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...pixel(x, y), 255], (y * width + x) * 4);
  return new ImageData(data, width, height);
}

// ---------------------------------------------------------------------------
// detect-crop-area
// ---------------------------------------------------------------------------
{
  const cases = [];
  // A dark 3:2 frame on a light rebate: the window search hits.
  const rebate = [238, 160, 100], dark = [95, 55, 30];
  const strip = make(1800, 1200, (x, y) => (x >= 240 && x < 1560 && y >= 160 && y < 1040)
    ? dark.map(c => c + ((x * 7 + y * 13) & 31)) : rebate);
  cases.push({ label: 'hit', image: strip, crop: { left: 250, top: 170, width: 1300, height: 860 } });
  // A smooth gradient with no edges: every search misses.
  const smooth = make(1500, 1000, (x, y) => { const v = 60 + 100 * Math.sin(x / 700) * Math.cos(y / 900); return [v, v * .8, v * .6]; });
  cases.push({ label: 'miss', image: smooth, crop: { left: 100, top: 100, width: 1200, height: 800 } });
  // A frame larger than 1 MP: the input is point-sampled first.
  const wide = make(2600, 1600, (x, y) => (x >= 300 && x < 2300 && y >= 150 && y < 1483)
    ? dark.map(c => c + ((x * 5 + y * 11) & 31)) : rebate);
  cases.push({ label: 'sampled', image: wide, crop: { left: 310, top: 160, width: 1980, height: 1310 } });
  // A real 8-bit strip fixture (UPNG-decoded), cropped around one frame.
  // Its miss runs the line search (seconds in Node), so it runs twice only.
  const UPNG = require('upng-js');
  const png = UPNG.decode(readFileSync(new URL('../../test-fixtures/negative-strip-dx.png', import.meta.url)));
  const fixture = new ImageData(new Uint8ClampedArray(UPNG.toRGBA8(png)[0]), png.width, png.height);
  cases.push({ label: 'strip fixture', image: fixture, crop: { left: 470, top: 110, width: 460, height: 430 }, workerOnly: true });

  // Apply's sample of a rotated, mirrored 16-bit frame, built by the geometry
  // core from the base (renderFrameSample), 8-bit only.
  const W = 1700, H = 1100;
  const base16 = new Uint16Array(W * H * 4);
  const base8 = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 200 && x < 1500 && y >= 150 && y < 950;
    const v = inside ? [24000 + ((x * 31 + y * 17) % 4000), 14000, 8000] : [61000, 41000, 26000];
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) { base16[o + c] = v[c]; base8[o + c] = v[c] >>> 8; }
    base16[o + 3] = 65535; base8[o + 3] = 255;
  }
  const base = new ImageData(base8, W, H);
  base.__image16 = { width: W, height: H, data: base16 };
  const geometry = { rotationAngle: 1.7, mirrored: true };
  const frame = rotatedDimensions(W, H, geometry.rotationAngle);
  const total = frame.width * frame.height;
  const step = total > 1000000 ? Math.ceil(Math.sqrt(total / 1000000)) : 1;
  const sample = renderGeometry(base, planGeometry(base, geometry, { step }), { with16: false });
  const rotated = applyRotationToImageData(base, geometry.rotationAngle);
  const mirroredFrame = new ImageData(new Uint8ClampedArray(rotated.data), rotated.width, rotated.height);
  for (let y = 0; y < rotated.height; y++) for (let x = 0; x < rotated.width; x++) {
    const a = (y * rotated.width + x) * 4, b = (y * rotated.width + rotated.width - 1 - x) * 4;
    for (let c = 0; c < 4; c++) mirroredFrame.data[a + c] = rotated.data[b + c];
  }
  assert.deepEqual(sample.data, downsampleImageDataForMaxPixels(mirroredFrame, 1000000).data, 'the core sample is the full frame downsampled');
  cases.push({ label: 'rotated 16-bit', image: frame, preview: sample, crop: { left: 180, top: 170, width: 1330, height: 830 } });

  let hits = 0;
  for (const { label, image, crop, preview = null, workerOnly = false } of cases) {
    const expected = reference.detectCropImageArea(image, crop, targets, { preview });
    if (!workerOnly) {
      const composed = detectCropImageArea(image, crop, targets, { preview });
      assert.deepEqual(composed, expected, `${label}: detectCropImageArea == reference`);
      const onPage = detectCropAreaInRegion(buildCropDetectionInput(image, crop, { preview }), targets);
      assert.deepEqual(onPage, expected, `${label}: page fallback == reference`);
    }
    const input = buildCropDetectionInput(image, crop, { preview });
    assert.equal(input.region.__image16, undefined, `${label}: the region carries no 16-bit plane`);
    const reply = await viaWorker('detect-crop-area', cropDetectionMessage(input, targets));
    assert.deepEqual(reply.points, expected, `${label}: worker == reference`);
    if (expected) hits++;
    if (label === 'miss') assert.equal(expected, null, 'the smooth frame misses');
    if (label === 'hit') assert.ok(expected, 'the strip frame hits');
  }
  assert.ok(hits >= 2, `hits and misses are both covered (${hits} hits)`);
}

// ---------------------------------------------------------------------------
// expired-spatial-maps and the analysis built on it
// ---------------------------------------------------------------------------
{
  const W = 3000, H = 2000;
  const plane = new Uint16Array(W * H * 4);
  const eight = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const scene = 65535 * ((x * 7 + y * 3) % 40) / 39;
    const fog = 9000 * (1 - x / W) + 2500;
    const v = [Math.min(65535, scene * 0.7 + fog), Math.min(65535, scene * 0.72 + fog * 0.9), Math.min(65535, scene * 0.65 + fog * 1.2)];
    for (let c = 0; c < 3; c++) { plane[o + c] = Math.round(v[c]); eight[o + c] = plane[o + c] >>> 8; }
    plane[o + 3] = (x < 40 && y < 40) ? 0 : 65535;
    eight[o + 3] = 255;
  }
  const image = new ImageData(eight, W, H);
  image.__image16 = { width: W, height: H, data: plane };
  const settings = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, semanticMap: null };
  for (const options of [{ borderBuffer: 0.1 }, { region: { left: 300, top: 200, width: 2400, height: 1500 }, borderBuffer: 0.1 },
    { borderBuffer: 0.05, placement: { left: 0.1, top: 0.05, width: 0.8, height: 0.9 } }]) {
    const label = JSON.stringify(options);
    const expected = reference.measureExpiredSpatialMaps(image, options);
    assert.ok(expected, `${label}: maps`);
    assert.deepEqual(measureExpiredSpatialMaps(image, options), expected, `${label}: composed == reference`);
    const input = sampleExpiredSpatialInput(image, options);
    let yields = 0;
    let clock = 0;
    const sliced = await sampleExpiredSpatialInputSliced(image, options, { pause: async () => { yields++; }, now: () => (clock += 5), sliceMs: 12 });
    assert.ok(yields > 10, `${label}: the slices yield (${yields})`);
    assert.deepEqual(sliced, input, `${label}: sliced sample == whole sample`);
    assert.ok(input.rgba.byteLength + input.lum.byteLength < 200_000, 'only a small sample crosses');
    const reply = await viaWorker('expired-spatial-maps', expiredSpatialMessage(sliced));
    assert.deepEqual(reply.maps, expected, `${label}: worker maps == reference`);
    assert.deepEqual(measureExpiredSpatialMapsFromSample(sampleExpiredSpatialInput(image, options)), expected, `${label}: page fallback == reference`);

    // The analysis main.js stores in state.expiredAnalysis, before and after.
    const sample = { image, options, placement: options.placement || { left: 0, top: 0, width: 1, height: 1 } };
    const headAnalysis = (() => {
      const maps = reference.measureExpiredSpatialMaps(sample.image, { ...sample.options, placement: sample.placement });
      const spatial = maps ? fitExpiredSpatial(maps) : null;
      if (!spatial) return null;
      const stage = buildExpiredSpatialStage({ ...sanitizeExpiredRescueParams(settings), expiredEnabled: true, expiredLocalContrast: 0, expiredAnalysis: { spatial } });
      const analysis = analyzeExpiredFilm(sample.image, { ...sample.options, anchors: settings.semanticMap, placement: sample.placement, spatial: stage });
      return analysis ? { ...analysis, spatial } : null;
    })();
    const splitMaps = (await viaWorker('expired-spatial-maps', expiredSpatialMessage(
      sampleExpiredSpatialInput(sample.image, { ...sample.options, placement: sample.placement })))).maps;
    assert.ok(headAnalysis, `${label}: analysis`);
    assert.deepEqual(expiredAnalysisFromMaps(splitMaps, sample, settings), headAnalysis, `${label}: expiredAnalysis == reference`);
  }
  // Superseded between slices: no sample.
  let calls = 0;
  let clock = 0;
  assert.equal(await sampleExpiredSpatialInputSliced(image, {}, { pause: async () => {}, isCurrent: () => ++calls < 3, now: () => (clock += 20) }), null);
  // An 8-bit processed image (no plane) goes through the same halves.
  const small = new ImageData(new Uint8ClampedArray(eight.subarray(0, W * 400 * 4)), W, 400);
  assert.deepEqual((await viaWorker('expired-spatial-maps', expiredSpatialMessage(sampleExpiredSpatialInput(small, {})))).maps,
    reference.measureExpiredSpatialMaps(small, {}), '8-bit plane');
  assert.equal(sampleExpiredSpatialInput(new ImageData(new Uint8ClampedArray(4 * 4 * 4), 4, 4), {}), null, 'too small to measure');
}

// ---------------------------------------------------------------------------
// estimate-alignment: lab match (with the warp) and a bracket pair
// ---------------------------------------------------------------------------
{
  const W = 480, H = 320;
  const texture = (x, y) => {
    let v = 128 + 60 * Math.sin(x / 23) * Math.cos(y / 17) + 40 * Math.sin((x + y) / 9);
    for (const [cx, cy, r] of [[120, 90, 40], [330, 210, 55], [400, 70, 25], [80, 250, 30]]) {
      if (Math.hypot(x - cx, y - cy) < r) v = 40 + (cx + cy) % 90;
    }
    if (x % 40 < 3 || y % 40 < 3) v = 230;
    return v;
  };
  const ours = make(W, H, (x, y) => { const v = texture(x, y); return [v, v * 0.9, v * 0.8]; });
  // The lab's scan: smaller, shifted and slightly rotated, different colour.
  const labW = 360, labH = 240;
  const lab = make(labW, labH, (x, y) => {
    const u = x / 0.75, v = y / 0.75;
    const rad = 1.5 * Math.PI / 180;
    const sx = (u - W / 2) * Math.cos(rad) - (v - H / 2) * Math.sin(rad) + W / 2 + 6;
    const sy = (u - W / 2) * Math.sin(rad) + (v - H / 2) * Math.cos(rad) + H / 2 - 4;
    const t = texture(Math.round(sx), Math.round(sy));
    return [t * 1.05, t * 0.95, t * 0.7];
  });
  const expectedAlignment = headAlignment.estimateAlignment(ours, lab, { maxSide: 1000 });
  assert.ok(expectedAlignment, 'the lab pair aligns');
  const expectedWarp = headAlignment.warpImageData(lab, expectedAlignment.homography, W, H);
  const side = alignmentSide(ours, lab, 1000);
  const message = alignmentMessage(sampleAlignmentGray(ours, side), sampleAlignmentGray(lab, side), { warp: { image: lab, width: W, height: H } });
  assert.notEqual(message.payload.warp.image.data.buffer, lab.data.buffer, 'the reference is copied: the unaligned fallback keeps it');
  const reply = await viaWorker('estimate-alignment', message);
  assert.deepEqual(reply.alignment, expectedAlignment, 'lab match: worker homography == reference');
  assert.deepEqual([reply.warped.width, reply.warped.height], [W, H]);
  assert.ok(Buffer.from(reply.warped.data.buffer).equals(Buffer.from(expectedWarp.data.buffer)), 'lab match: warped pixels == reference');
  const page = alignAndWarp({ reference: sampleAlignmentGray(ours, side), moving: sampleAlignmentGray(lab, side), warp: { image: lab, width: W, height: H } });
  assert.deepEqual(page.alignment, expectedAlignment, 'page fallback homography');
  assert.ok(Buffer.from(page.warped.data.buffer).equals(Buffer.from(expectedWarp.data.buffer)), 'page fallback warp');

  // A bracket pair: same size, shifted; homography only.
  const shifted = make(W, H, (x, y) => { const v = texture(x + 5, y - 3) * 0.6; return [v, v, v]; });
  const bracket = headAlignment.estimateAlignment(ours, shifted, { maxSide: 1000 });
  assert.ok(bracket, 'the bracket pair aligns');
  const bracketSide = alignmentSide(ours, shifted, 1000);
  const bracketReply = await viaWorker('estimate-alignment', alignmentMessage(sampleAlignmentGray(ours, bracketSide), sampleAlignmentGray(shifted, bracketSide)));
  assert.deepEqual(bracketReply.alignment, bracket, 'bracket: worker homography == reference');
  assert.equal(bracketReply.warped, null);

  // A failed match is reported, not thrown (the page warned and compared unaligned).
  const flat = make(64, 64, () => [128, 128, 128]);
  const none = await viaWorker('estimate-alignment', alignmentMessage(sampleAlignmentGray(flat, 64), sampleAlignmentGray(flat, 64), { warp: { image: flat, width: 64, height: 64 } }));
  assert.deepEqual(none, { alignment: null, warped: null });
}

// Unknown request types fail loudly (they used to fall through to analyze-frame).
assert.throws(() => runOpenCvAnalysisTask({ type: 'analyse-frame' }), /Unknown analysis request/);
assert.equal(isOpenCvAnalysisType('detect-crop-area'), true);
assert.equal(isOpenCvAnalysisType('analyze-frame'), false);

// ---------------------------------------------------------------------------
// The page-side runner: worker first, the page's OpenCV only on failure
// ---------------------------------------------------------------------------
{
  const warnings = [];
  let loads = 0;
  const makeRunner = runInWorker => createOpenCvTaskRunner({
    runInWorker, ensureOpenCvReady: async () => { loads++; return true; }, warn: (...args) => warnings.push(args[0])
  });
  const task = (calls) => ({
    build: () => { calls.push('build'); return { data: new Uint8Array(8) }; },
    toMessage: input => ({ payload: { data: input.data }, transfers: [input.data.buffer] }),
    fromWorker: result => { calls.push('worker'); return result; },
    onMainThread: input => { calls.push('page'); assert.equal(input.data.byteLength, 8, 'the page gets intact input'); return 'page'; }
  });

  // Worker success, a null result included: the page never loads OpenCV.
  let calls = [];
  let run = makeRunner(async () => null);
  assert.equal(await run('detect-crop-area', task(calls)), null);
  assert.deepEqual(calls, ['build', 'worker']);
  assert.equal(loads, 0);

  // The factory throws before anything is sent: fall back on the same input.
  calls = [];
  run = makeRunner(async () => { throw new Error('Worker is not defined'); });
  assert.equal(await run('detect-crop-area', task(calls)), 'page');
  assert.deepEqual(calls, ['build', 'page']);
  assert.equal(await run('detect-crop-area', task([])), 'page');
  assert.equal(await run('estimate-alignment', task([])), 'page');
  assert.equal(warnings.length, 2, 'one warning per feature per session');
  assert.equal(run.stats.fallback, 3);

  // A crash after the transfer: the input is built again for the page.
  calls = [];
  run = makeRunner(async (type, payload, transfers) => {
    structuredClone(payload, { transfer: transfers });
    throw new Error('Auto-frame worker crashed');
  });
  assert.equal(await run('expired-spatial-maps', task(calls)), 'page');
  assert.deepEqual(calls, ['build', 'build', 'page']);

  // The analysis itself failed in the worker: that is the result.
  calls = [];
  run = makeRunner(async () => { const error = new Error('cv exception'); error.workerReported = true; throw error; });
  await assert.rejects(run('detect-crop-area', task(calls)), /cv exception/);
  assert.deepEqual(calls, ['build']);

  // Nothing to measure: no request.
  run = makeRunner(async () => assert.fail('no request without input'));
  assert.equal(await run('expired-spatial-maps', { ...task([]), build: async () => null }), null);

  // OpenCV cannot load on the page either.
  const failing = createOpenCvTaskRunner({ runInWorker: async () => { throw new Error('gone'); }, ensureOpenCvReady: async () => false, warn: () => {} });
  await assert.rejects(failing('detect-crop-area', task([])), /OpenCV is not available/);
}

console.log('openCvAnalysisTasks tests passed');
