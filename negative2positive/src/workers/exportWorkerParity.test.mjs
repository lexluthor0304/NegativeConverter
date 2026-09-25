// Standalone Node test: the export worker's 16-bit results are bit-identical
// to the main-thread path they replace (#240). Run with:
// node negative2positive/src/workers/exportWorkerParity.test.mjs
//
// The real exportWorker.js handler runs in-process behind the real bridge.
// Every message crosses a structured clone with its transfer list, both ways,
// so a settings field that does not survive the clone shows up here. The
// references are frozen copies of the main-thread code at HEAD 1703835.
import assert from 'node:assert/strict';

import { applyAdjustmentsToPixels16, downconvertPlane16 } from './pixelAdjustments16.js';
import { computeAdjustmentParams } from './pixelAdjustments.js';
import { analyzeExpiredFilm, EXPIRED_RESCUE_DEFAULTS, EXPIRED_SPATIAL_VERSION } from '../pipeline/expiredRescue.js';

// Browsers reject a buffer of the wrong length; so does this stub.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    if (data.length !== 4 * width * height) throw new DOMException('bad length', 'IndexSizeError');
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

// One in-process worker: exportWorker.js installs `self.onmessage` and posts
// through `self.postMessage`.
let activeWorker = null;
const workerPosts = [];
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers = []) {
    workerPosts.push({ type: message.type, buffers: transfers.map((buffer) => buffer.byteLength) });
    const cloned = structuredClone(message, { transfer: transfers });
    const target = activeWorker;
    queueMicrotask(() => target && target.onmessage && target.onmessage({ data: cloned }));
  }
};
await import('./exportWorker.js');

class InProcessWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    activeWorker = this;
  }

  postMessage(message, transfers = []) {
    const received = structuredClone(message, { transfer: transfers });
    queueMicrotask(() => self.onmessage({ data: received }));
  }

  terminate() {
    if (activeWorker === this) activeWorker = null;
  }
}

const { createExportWorkerBridge } = await import('./workerBridge.js');
const { requestExportGainMap } = await import('../app/exportGainMap.js');
const { applyPreparedAdjustmentsToPlane16 } = await import('../app/adjustmentPipeline.js');
const { markOwnedPlanes, configurePlaneRelease } = await import('../app/planeRelease.js');
const bridge = createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });

// ------------------------------------------ frozen references (HEAD 1703835)

function frozenApplyPreparedAdjustmentsToBuffer16(imageData, adjustmentSettings, output) {
  const plane = imageData.__image16;
  const params = computeAdjustmentParams(adjustmentSettings, { width: plane.width, height: plane.height });
  const out16 = new Uint16Array(plane.data.length);
  applyAdjustmentsToPixels16(plane.data, out16, plane.width * plane.height, params, 'full', null, 500000, null);
  downconvertPlane16(out16, output.data);
  output.__image16 = { width: plane.width, height: plane.height, data: out16 };
}

const frozenClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const frozenLinear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const frozenLuminance = (data, i, scale) => 0.2126 * frozenLinear(data[i] / scale) + 0.7152 * frozenLinear(data[i + 1] / scale) + 0.0722 * frozenLinear(data[i + 2] / scale);
function frozenComputeGainMap(sdr, plane16, { step = 4 } = {}) {
  const width = Math.ceil(sdr.width / step), height = Math.ceil(sdr.height / step);
  if (!plane16 || plane16.width !== sdr.width || plane16.height !== sdr.height || plane16.data.length !== sdr.data.length) return null;
  const gains = new Float32Array(width * height);
  let max = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let a = 0, b = 0, count = 0;
    for (let yy = y * step; yy < Math.min((y + 1) * step, sdr.height); yy++) for (let xx = x * step; xx < Math.min((x + 1) * step, sdr.width); xx++) {
      const i = (yy * sdr.width + xx) * 4;
      a += frozenLuminance(sdr.data, i, 255); b += frozenLuminance(plane16.data, i, 65535); count++;
    }
    const gain = frozenClamp(Math.log2((b / count + 1 / 64) / (a / count + 1 / 64)), 0, 3);
    gains[y * width + x] = gain; max = Math.max(max, gain);
  }
  const gainMax = Math.max(max, 0.001);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gains.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(gains[i] / gainMax * 255); data[i * 4 + 3] = 255;
  }
  return { width, height, data, gainMax, gainMin: 0 };
}

// --------------------------------------------------------------- the frame

// Not a multiple of 4 in either direction, so the map's edge blocks are partial.
const W = 45;
const H = 31;
function makeProcessed() {
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const plane = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    // A warm diagonal ramp with fog-like lift on the left and some grain.
    const t = (x / (W - 1)) * 0.7 + (y / (H - 1)) * 0.3;
    const lift = 0.12 * (1 - x / (W - 1));
    const grain = ((next() >>> 20) - 2048) * 2;
    const v = (lift + (1 - lift) * t) * 65535;
    plane[o] = Math.max(0, Math.min(65535, Math.round(v * 1.0 + grain)));
    plane[o + 1] = Math.max(0, Math.min(65535, Math.round(v * 0.86 + grain)));
    plane[o + 2] = Math.max(0, Math.min(65535, Math.round(v * 0.7 + grain)));
    plane[o + 3] = 65535;
  }
  const data = downconvertPlane16(plane, new Uint8ClampedArray(plane.length));
  const image = new ImageData(data, W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}

const linearCurve = () => Uint8Array.from({ length: 256 }, (_, v) => v);
const sCurve = () => Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
// The shape buildAdjustmentSettings hands the export: every control plus the
// unrelated per-file fields that also cross the structured clone.
const base = {
  curves: { r: linearCurve(), g: linearCurve(), b: linearCurve() },
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0,
  saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1,
  look: null,
  ...EXPIRED_RESCUE_DEFAULTS,
  expiredAnalysis: null,
  cropRegion: { left: 2, top: 1, width: 40, height: 28 },
  rotationAngle: 0.4,
  mirrored: false,
  filmType: 'color',
  frameMetadata: { frame: '12A', notes: 'parity' }
};

const measured = analyzeExpiredFilm(makeProcessed(), { borderBuffer: 0 });
assert.ok(measured, 'the synthetic frame yields an expired-film measurement');
const spatial = {
  version: EXPIRED_SPATIAL_VERSION,
  fraction: { left: 0.05, top: 0.1, width: 0.9, height: 0.8 },
  gridWidth: 4,
  gridHeight: 3,
  fog: {
    coefficients: [
      [0.18, -0.12, 0.02, 0.03, -0.01, 0.01],
      [0.16, -0.1, 0.01, 0.02, 0, 0.02],
      [0.2, -0.14, 0.03, 0.04, -0.02, 0]
    ],
    offset: [0.02, 0.03, 0.01],
    amplitude: [0.12, 0.1, 0.14]
  },
  mean: [0.31, 0.42, 0.5, 0.58, 0.35, 0.44, 0.52, 0.61, 0.38, 0.47, 0.55, 0.66]
};

const recipes = {
  identity: { ...base },
  'separable curve/WB': {
    ...base,
    curves: { r: sCurve(), g: linearCurve(), b: sCurve() },
    exposure: 0.3, contrast: 12, temperature: 10, tint: -5, wbR: 1.08, wbG: 1, wbB: 0.94, cyan: 4, magenta: -3, yellow: 2
  },
  'HSL + highlights/shadows': { ...base, highlights: -20, shadows: 15, saturation: 10, vibrance: 25, contrast: 6 },
  look: {
    ...base,
    look: {
      matrix: [1.05, 0.02, -0.04, -0.03, 1, 0.05, 0, -0.02, 1.12],
      offset: [-6, 4, 9],
      curves: { r: sCurve(), g: linearCurve(), b: linearCurve() }
    }
  },
  'expired rescue + spatial fog': {
    ...base,
    expiredEnabled: true, expiredLevels: 80, expiredNeutralize: 100, expiredCrossover: 60,
    expiredBrightness: 10, expiredContrast: 20, expiredUnevenFog: 100, expiredLocalContrast: 40,
    expiredAnalysis: { ...measured, spatial }
  }
};

{
  const params = computeAdjustmentParams(recipes['expired rescue + spatial fog'], { width: W, height: H });
  assert.ok(params.doRescue && params.doRescueSpatial, 'the rescue recipe exercises the spatial fog stage');
  assert.ok(computeAdjustmentParams(recipes['HSL + highlights/shadows']).doHsl);
  assert.ok(computeAdjustmentParams(recipes.look).doLookMatrix);
}

function sameSamples(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  assert.equal(actual.constructor, expected.constructor, `${label}: type`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: sample ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

for (const [name, settings] of Object.entries(recipes)) {
  const processed = makeProcessed();
  const planeBefore = processed.__image16.data.slice();

  // Main-thread reference.
  const reference = new ImageData(new Uint8ClampedArray(processed.data.length), W, H);
  frozenApplyPreparedAdjustmentsToBuffer16(processed, settings, reference);

  // applyAdjustments16 through the bridge, with and without the mirror.
  const adjusted = await bridge.workerApplyAdjustments16(processed, settings, 'full');
  assert.ok(adjusted, `${name}: the worker's 16-bit result is used`);
  sameSamples(adjusted.__image16.data, reference.__image16.data, `${name}: __image16`);
  sameSamples(adjusted.data, reference.data, `${name}: data8`);
  const planeOnly = await bridge.workerApplyAdjustments16(processed, settings, 'full', { planeOnly: true });
  assert.ok(!('data' in planeOnly), `${name}: planeOnly has no mirror`);
  sameSamples(planeOnly.__image16.data, reference.__image16.data, `${name}: planeOnly __image16`);
  // The main-thread plane-only sibling agrees too.
  sameSamples(applyPreparedAdjustmentsToPlane16(processed, settings).data, reference.__image16.data, `${name}: plane-only fallback`);
  sameSamples(processed.__image16.data, planeBefore, `${name}: the source plane is never written`);

  // gainMap16 against the main-thread map of the reference plane. The SDR
  // frame is any 8-bit frame of the size; use the reference mirror nudged so
  // the map is not all zero.
  const sdrBytes = Uint8ClampedArray.from(reference.data, (v, i) => (i % 4 === 3 ? 255 : v - ((i >> 2) % 3)));
  const sdr = new ImageData(sdrBytes, W, H);
  const expectedMap = frozenComputeGainMap(sdr, reference.__image16);
  assert.ok(expectedMap.gainMax > 0.001, `${name}: a non-trivial map`);
  workerPosts.length = 0;
  const map = await bridge.workerGainMap16(processed, sdr, settings);
  assert.ok(map, `${name}: gainMap16 returned a map`);
  assert.equal(map.width, expectedMap.width);
  assert.equal(map.height, expectedMap.height);
  assert.ok(Object.is(map.gainMax, expectedMap.gainMax), `${name}: gainMax ${map.gainMax} vs ${expectedMap.gainMax}`);
  assert.equal(map.gainMin, expectedMap.gainMin);
  sameSamples(map.data, expectedMap.data, `${name}: map bytes`);
  const replies = workerPosts.filter((post) => post.type !== 'progress');
  assert.deepEqual(replies, [{ type: 'gainMapResult', buffers: [expectedMap.data.length] }], `${name}: only the map comes back, never a 16-bit plane`);

  // Transfer mode gives the same map and consumes the plane.
  const owned = markOwnedPlanes(makeProcessed());
  const transferred = await bridge.workerGainMap16(owned, sdr, settings, { transferPlane: true });
  sameSamples(transferred.data, expectedMap.data, `${name}: transferred map bytes`);
  assert.equal(owned.__image16.data.byteLength, 0, `${name}: the transferred plane is consumed`);

  // The request main.js makes, worker path and main-thread fallback.
  const viaWorker = await requestExportGainMap({
    processed, sdr, adjustmentSettings: settings, workers: bridge,
    adjustPlane16: () => assert.fail('the worker path needs no fallback')
  });
  sameSamples(viaWorker.data, expectedMap.data, `${name}: requestExportGainMap via the worker`);
  const noWorker = { isWorkerAvailable: () => false, workerGainMap16: () => assert.fail('no worker') };
  const viaFallback = await requestExportGainMap({
    processed, sdr, adjustmentSettings: settings, workers: noWorker,
    adjustPlane16: async (prepared) => ({ width: W, height: H, __image16: applyPreparedAdjustmentsToPlane16(processed, prepared) })
  });
  assert.ok(Object.is(viaFallback.gainMax, expectedMap.gainMax));
  sameSamples(viaFallback.data, expectedMap.data, `${name}: requestExportGainMap main-thread fallback`);
}

{
  // A worker error hands a transferred plane back intact.
  const owned = markOwnedPlanes(makeProcessed());
  const before = owned.__image16.data.slice();
  const sdr = new ImageData(new Uint8ClampedArray(owned.data), W, H);
  // Settings the worker cannot use (no curves) make it throw after receipt.
  const result = await bridge.workerGainMap16(owned, sdr, { ...recipes.identity, curves: null }, { transferPlane: true });
  assert.equal(result, null, 'a worker error resolves null');
  sameSamples(owned.__image16.data, before, 'the returned plane is re-attached with its samples');
}

{
  // A worker that fails falls back to the main thread, with identical bytes.
  const failing = { isWorkerAvailable: () => true, workerGainMap16: async () => null };
  const processed = makeProcessed();
  const settings = recipes['HSL + highlights/shadows'];
  const reference = new ImageData(new Uint8ClampedArray(processed.data.length), W, H);
  frozenApplyPreparedAdjustmentsToBuffer16(processed, settings, reference);
  const sdr = new ImageData(new Uint8ClampedArray(reference.data), W, H);
  const map = await requestExportGainMap({
    processed, sdr, adjustmentSettings: settings, workers: failing,
    adjustPlane16: async (prepared) => ({ width: W, height: H, __image16: applyPreparedAdjustmentsToPlane16(processed, prepared) })
  });
  const expected = frozenComputeGainMap(sdr, reference.__image16);
  sameSamples(map.data, expected.data, 'fallback after a worker failure');

  // The fallback's own adjusted plane is released once the map exists (#250).
  configurePlaneRelease({ engine: 'webkit' });
  let high = null;
  const released = await requestExportGainMap({
    processed, sdr, adjustmentSettings: settings, workers: failing,
    adjustPlane16: async (prepared) => {
      high = { width: W, height: H, __image16: markOwnedPlanes(applyPreparedAdjustmentsToPlane16(processed, prepared)) };
      return high;
    }
  });
  sameSamples(released.data, expected.data, 'the map is computed before the release');
  assert.equal(high.__image16.data.byteLength, 0, 'the fallback plane is released');
  assert.equal(processed.__image16.data.length, W * H * 4, 'the source plane is not');
  configurePlaneRelease();

  // Inputs that never produced a map still produce none, without any pass.
  const mismatched = await requestExportGainMap({
    processed, sdr: new ImageData(new Uint8ClampedArray(16), 2, 2), adjustmentSettings: settings, workers: failing,
    adjustPlane16: () => assert.fail('no pass for mismatched inputs')
  });
  assert.equal(mismatched, null);
  const planeless = await requestExportGainMap({
    processed: new ImageData(new Uint8ClampedArray(processed.data), W, H), sdr, adjustmentSettings: settings, workers: failing,
    adjustPlane16: () => assert.fail('no pass without a plane')
  });
  assert.equal(planeless, null);

  // A lost input rejects, and an unawaited request never surfaces an
  // unhandled rejection.
  const lostError = Object.assign(new Error('lost'), { name: 'ExportInputLostError' });
  const lost = requestExportGainMap({
    processed, sdr, adjustmentSettings: settings,
    workers: { isWorkerAvailable: () => true, workerGainMap16: async () => { throw lostError; } },
    adjustPlane16: () => assert.fail('a lost plane is not a fallback')
  });
  await assert.rejects(lost, (err) => err === lostError);
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  requestExportGainMap({
    processed, sdr, adjustmentSettings: settings,
    workers: { isWorkerAvailable: () => true, workerGainMap16: async () => { throw lostError; } },
    adjustPlane16: async () => null
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0, 'the pending map always has a rejection handler');
}

bridge.terminateWorker();
console.log('exportWorkerParity.test.mjs passed: applyAdjustments16 and gainMap16 are bit-identical to the main-thread path');
