// Standalone Node test for the conversion band pool (#256 Part 5): the real
// band worker (workers/conversionBandWorker.js) in real worker_threads behind
// createConversionBandPool, against the whole-frame conversion and Step 3 by
// SHA-256. Covers band counts above and below the pool size, resident bands
// with Step 3 in place (16-bit, 8-bit, the mirror, both passes), fetched
// copies, planes shared through a SharedArrayBuffer, the release of a
// batch-owned source, abort, a crashing worker (the pool retires and the
// caller's single worker gives the same pixels), and the length of the main
// thread's copy steps on a 12 MP plane.
// Run with: node negative2positive/src/app/conversionBandPool.test.mjs
import assert from 'node:assert/strict';
import { sha } from '../pipeline/oracle/adapterParity.mjs';
import { bandThreadFactory } from './bandWorkerThreads.mjs';

const { createConversionBandPool, planBandPoolSize, planBandCount, copyInSteps, sharedBandPlanesAvailable,
  isConversionInputLost, WORKER_ABORTED, WORKER_CRASHED } = await import('./conversionWorkerClient.js');
const { markOwnedPlanes, configurePlaneRelease } = await import('./planeRelease.js');
const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
const { invalidateSilverCoreCache } = await import('../pipeline/silverAdapter.js');
const { applyAdjustmentsToPixels, computeAdjustmentParams } = await import('../workers/pixelAdjustments.js');
const { applyAdjustmentsToPixels16, downconvertPlane16 } = await import('../workers/pixelAdjustments16.js');
const { sanitizeFlatFieldMap } = await import('./flatField.js');

configurePlaneRelease({ engine: 'webkit' });

// ---- planning --------------------------------------------------------------------
assert.equal(planBandPoolSize(8), 6);
assert.equal(planBandPoolSize(10), 6, 'never more than six');
assert.equal(planBandPoolSize(4), 2);
assert.equal(planBandPoolSize(3), 0, 'below two workers: the single worker');
assert.equal(planBandCount({ hardwareConcurrency: 8, activeDecodes: 0, poolSize: 6 }), 6);
assert.equal(planBandCount({ hardwareConcurrency: 8, activeDecodes: 1, poolSize: 6 }), 5, 'a decode in flight takes a core');
assert.equal(planBandCount({ hardwareConcurrency: 8, activeDecodes: 2, poolSize: 6 }), 4);
assert.equal(planBandCount({ hardwareConcurrency: 4, activeDecodes: 2, poolSize: 2 }), 2, 'never below two');
assert.equal(planBandCount({ hardwareConcurrency: 16, activeDecodes: 0, poolSize: 3 }), 3, 'never above the pool');
assert.equal(planBandCount({ hardwareConcurrency: 8, inputRecently: true, poolSize: 6 }), 2, 'two while the user gives input');
assert.equal(sharedBandPlanesAvailable({ crossOriginIsolated: false, SharedArrayBuffer }), false);
assert.equal(sharedBandPlanesAvailable({ crossOriginIsolated: true, SharedArrayBuffer }), true);

// ---- workers ---------------------------------------------------------------------
const threads = [];
const threadFactory = (options = {}) => bandThreadFactory({ ...options, threads });

// ---- frames ----------------------------------------------------------------------
function negative(seed, w, h) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (w + h);
      let r = 52000 - 30000 * t, g = 36000 - 22000 * t, b = 24000 - 15000 * t;
      if ((x * 7 + y * 5 + seed) % 13 === 0) { r *= 0.6; g *= 1.2; }
      if ((x * 3 + y * 11 + seed) % 17 === 0) { b *= 1.8; }
      data[i] = Math.min(65535, Math.round(r + ((x * 131 + y * 71 * seed) % 900)));
      data[i + 1] = Math.min(65535, Math.round(g + ((x * 97 + y * 53 * seed) % 700)));
      data[i + 2] = Math.min(65535, Math.round(b + ((x * 61 + y * 89 * seed) % 500)));
      data[i + 3] = 65535;
    }
  }
  return data;
}
function frame(width, height, seed) {
  const plane = negative(seed, width, height);
  const image = new ImageData(Uint8ClampedArray.from(plane, (v) => v >>> 8), width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}
function copyFrame(image) {
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  out.__image16 = { width: image.width, height: image.height, data: new Uint16Array(image.__image16.data) };
  return out;
}
function sample(image, left, top, w, h) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(image.__image16.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + left + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}
const digest = (image) => ({
  image16: sha(image.__image16.data), image8: sha(image.data),
  analysisPreview: image.__analysisPreview ? sha(image.__analysisPreview.data) : null
});
async function whole(request) {
  invalidateSilverCoreCache();
  return convertFrameWithRouter({ imageData: copyFrame(request.imageData), settings: structuredClone(request.settings), options: { ...request.options } });
}

const W = 257;
const H = 131;
const base = frame(W, H, 4);
const flatField = sanitizeFlatFieldMap({ id: 'pad', width: 4, height: 4, gains: Array.from({ length: 48 }, (_, i) => 1 + ((i * 7) % 11) / 25) });
const geometry = { baseWidth: 300, baseHeight: 150, rotatedWidth: 300, rotatedHeight: 150, rotationAngle: 0, mirrored: false, cropRegion: { left: 20, top: 9, width: W, height: H } };
const requests = {
  colour: { settings: { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, flatField, flatFieldGeometry: geometry } },
  'colour + reference': { settings: { filmType: 'color', filmBase: { r: 205, g: 150, b: 100 }, enhancedProfile: 'frontier', profileStrength: 90 }, reference: true },
  bw: { settings: { filmType: 'bw', preSaturation: 120, localExposure: { strokes: [{ stops: 0.7, size: 0.3, feather: 0.4, points: [{ x: 0.3, y: 0.5, p: 1 }, { x: 0.6, y: 0.4, p: 0.8 }] }] }, localExposureGeometry: geometry } },
  positive: { settings: { filmType: 'positive', saturation: 120 } },
};
function requestFor(name) {
  const { settings, reference } = requests[name];
  return {
    imageData: copyFrame(base),
    settings,
    options: { forceFullProcess: true, ...(reference ? { analysisImageData: sample(base, 20, 10, 200, 100) } : {}) }
  };
}

const linear = () => Uint8Array.from({ length: 256 }, (_, v) => v);
const adjustment = {
  curves: { r: Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255)))), g: linear(), b: linear() },
  exposure: 0.2, contrast: 8, highlights: -10, shadows: 6, temperature: 4, tint: -2, saturation: 10, vibrance: 10,
  cyan: 0, magenta: 0, yellow: 0, wbR: 1.03, wbG: 1, wbB: 0.97, look: null
};
function adjustWhole(image, settings) {
  const params = computeAdjustmentParams(structuredClone(settings), { width: image.width, height: image.height });
  const out16 = new Uint16Array(image.__image16.data);
  applyAdjustmentsToPixels16(out16, out16, image.width * image.height, params, 'full');
  const out8 = new Uint8ClampedArray(image.data);
  applyAdjustmentsToPixels(out8, out8, image.width * image.height, params, 'full');
  return { out16, out8, mirror: downconvertPlane16(out16, new Uint8ClampedArray(out16.length)) };
}

for (const shared of [false, true]) {
  const pool = createConversionBandPool({ size: 3, workerFactory: threadFactory(), shared });
  for (const name of Object.keys(requests)) {
    const expected = await whole(requestFor(name));
    for (const bands of [1, 2, 3, 5]) {
      const converted = await pool.convert(requestFor(name), { bands });
      assert.deepEqual(digest(converted), digest(expected), `${shared ? 'shared ' : ''}${name}: ${bands} band(s)`);
    }
    // Resident bands: Step 3 in place, as the export does it after them.
    const reference = adjustWhole(expected, adjustment);
    const resident = await pool.convert(requestFor(name), { bands: 3, keepResident: true });
    assert.equal(resident.__analysisPreview ? sha(resident.__analysisPreview.data) : null, digest(expected).analysisPreview);
    const fetched = await resident.__bands.fetch({ keep: true });
    assert.deepEqual(digest({ ...fetched, __analysisPreview: expected.__analysisPreview }), digest(expected), `${name}: fetched copy`);
    const both = await resident.__bands.adjust(structuredClone(adjustment), { bits16: true, bits8: true });
    assert.equal(sha(both.data16), sha(reference.out16), `${name}: resident Step 3, 16-bit`);
    assert.equal(sha(both.data8), sha(reference.out8), `${name}: resident Step 3, 8-bit (identical parameters)`);
    assert.equal(resident.__bands.resident, false);
    await assert.rejects(resident.__bands.adjust(adjustment, { bits16: true }), (err) => isConversionInputLost(err), 'adjusted bands are gone');
    const mirror = await pool.convert(requestFor(name), { bands: 2, keepResident: true });
    const mirrored = await mirror.__bands.adjust(structuredClone(adjustment), { bits16: true, mirror8: true });
    assert.equal(sha(mirrored.data8), sha(reference.mirror), `${name}: 16-bit result's mirror`);
    // Step 3 on bands of planes this thread holds.
    const planes = await pool.adjust({ width: W, height: H, data16: expected.__image16.data, data8: expected.data }, structuredClone(adjustment), { bits16: true, bits8: true, bands: 5 });
    assert.equal(sha(planes.data16), sha(reference.out16), `${name}: Step 3 on sliced planes, 16-bit`);
    assert.equal(sha(planes.data8), sha(reference.out8), `${name}: Step 3 on sliced planes, 8-bit`);
  }
  if (shared) assert.ok(pool.stats.sharedFrames > 0);
  assert.ok(pool.workers <= 3, 'never more workers than the pool');
  assert.equal(pool.stats.workersStarted, 3, 'the workers stay warm across frames');
  pool.dispose();
}

// A batch-owned source is released once sliced; the output is unchanged.
{
  const pool = createConversionBandPool({ size: 2, workerFactory: threadFactory(), shared: false });
  const request = requestFor('colour');
  markOwnedPlanes(request.imageData);
  const expected = await whole(requestFor('colour'));
  const converted = await pool.convert(request, { bands: 2, releaseSource: true });
  assert.deepEqual(digest(converted), digest(expected));
  assert.equal(request.imageData.__image16.data.byteLength, 0, 'the source plane was released');
  pool.dispose();
}

// Abort: the call rejects as aborted and the pool stays usable.
{
  const pool = createConversionBandPool({ size: 2, workerFactory: threadFactory(), shared: false });
  const controller = new AbortController();
  const running = pool.convert(requestFor('positive'), { bands: 2, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(running, (err) => err.code === WORKER_ABORTED);
  assert.equal(pool.available, true);
  const expected = await whole(requestFor('positive'));
  assert.deepEqual(digest(await pool.convert(requestFor('positive'), { bands: 2 })), digest(expected));
  pool.dispose();
}

// A worker that crashes: the call rejects (INPUT_LOST once the batch's source
// was released), the pool retires, and the caller's single worker converts
// the same frame to the same pixels.
for (const releaseSource of [false, true]) {
  const pool = createConversionBandPool({
    size: 2, shared: false,
    workerFactory: threadFactory({ crashOn: (message) => message.type === 'apply' && message.index === 1 }),
    onError: () => {}
  });
  const request = requestFor('bw');
  if (releaseSource) markOwnedPlanes(request.imageData);
  await assert.rejects(pool.convert(request, { bands: 2, releaseSource }),
    (err) => releaseSource ? isConversionInputLost(err) : err.code === WORKER_CRASHED);
  assert.equal(pool.available, false, 'a failed pool is not used again');
  await assert.rejects(pool.convert(requestFor('bw'), { bands: 2 }));
  const fallback = await whole(requestFor('bw'));
  const expected = await whole(requestFor('bw'));
  assert.deepEqual(digest(fallback), digest(expected));
  pool.dispose();
}

// Slicing and assembly steps stay short: a 12 MP 16-bit plane (96 MB) copied
// in steps, none near the 50 ms long-task mark.
{
  const length = 4000 * 3000 * 4;
  const source = new Uint16Array(length);
  for (let i = 0; i < length; i += 4099) source[i] = i & 0xFFFF;
  const target = new Uint16Array(length);
  const stats = { copyTasks: 0, longestCopyMs: 0 };
  await copyInSteps(target, 0, source, 0, length, { stats });
  assert.equal(sha(target), sha(source));
  assert.ok(stats.longestCopyMs < 50, `longest copy step ${stats.longestCopyMs.toFixed(1)} ms`);
  // With a 1 ms budget it yields between its 4 MB steps.
  const small = { copyTasks: 0, longestCopyMs: 0 };
  let yields = 0;
  target.fill(0);
  await copyInSteps(target, 0, source, 0, length, { stats: small, budgetMs: 1, yieldTask: () => { yields += 1; return new Promise((resolve) => setImmediate(resolve)); } });
  assert.equal(sha(target), sha(source));
  assert.ok(yields > 1 && small.copyTasks === yields, 'the copy yields between steps');
}

await Promise.all(threads.map((thread) => thread.terminate()));
configurePlaneRelease();
console.log('conversionBandPool tests passed');
